import { describe, it, expect } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { alwaysPassAgent, fixtureCallAgent } from '../src/match/fake-agents.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { MatchLog } from '../src/types/log.js'
import type { ToolCall } from '../src/types/tool.js'
import type { Model, ModelRequest, NormalizedModelResponse } from '../src/model/types.js'
import { ModelBackedTankAgent } from '../src/model/tank-agent.js'

function makeConfig(overrides: Partial<MatchConfig>): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    moveMax: 5,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 10,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

function assertLog(log: MatchLog): void {
  expect(log.schemaVersion).toBe('v1')
  expect(log.metadata.matchId).toBeDefined()
  expect(log.metadata.createdAt).toBeDefined()
  expect(log.config).toBeDefined()
  expect(log.initialState).toBeDefined()
  expect(Array.isArray(log.turns)).toBe(true)
  expect(log.result).toBeDefined()
}

describe('runMatch — basic orchestration', () => {
  it('runs to completion with AlwaysPassAgents', async () => {
    const config = makeConfig({ turnLimit: 10 })
    const agent1 = alwaysPassAgent('p1')
    const agent2 = alwaysPassAgent('p2')
    const { log } = await runMatch(config, [agent1, agent2])
    expect(log.turns.length).toBe(10)
  })

  it('produces valid log structure', async () => {
    const config = makeConfig({ turnLimit: 5 })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    assertLog(log)
  })

  it('produces correct terminal result for turn limit', async () => {
    const config = makeConfig({ turnLimit: 7 })
    const { result } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    expect(result.terminationReason).toBe('turn-limit')
  })

  it('creates initial state with correct tank HP', async () => {
    const config = makeConfig({ turnLimit: 5 })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    for (const tank of log.initialState.tanks) {
      expect(tank.hp).toBe(2)
      expect(tank.maxHp).toBe(2)
    }
  })

  it('places four symmetric spawns at mirrored anchors on open terrain', async () => {
    const players = Array.from({ length: 4 }, (_, i) => ({
      label: `p${i + 1}`,
      startPosition: 'random' as const,
      scripted: 'conservative' as const,
    }))
    const config = makeConfig({
      spawnStrategy: 'symmetric',
      map: { width: 25, height: 25, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
      players,
      turnLimit: 1,
    })
    const agents = players.map((player) => alwaysPassAgent(player.label))

    const { log } = await runMatch(config, agents)

    expect(log.initialState.tanks.map((tank) => tank.position)).toEqual([
      { x: 3, y: 3 },
      { x: 21, y: 3 },
      { x: 21, y: 21 },
      { x: 3, y: 21 },
    ])
  })

  it('spread spawns space many tanks farther apart than plain random', async () => {
    const makePlayers = (n: number) => Array.from({ length: n }, (_, i) => ({
      label: `p${i + 1}`,
      startPosition: 'random' as const,
      scripted: 'conservative' as const,
    }))
    const base = {
      map: { width: 40, height: 40, obstacleDensity: 0.12, generatorVersion: 'v1', obstacleHeight: 3 },
      players: makePlayers(22),
      turnLimit: 1,
    }
    const minPairwise = (tanks: Array<{ position: { x: number; y: number } }>) => {
      let min = Infinity
      for (let i = 0; i < tanks.length; i++) {
        for (let j = i + 1; j < tanks.length; j++) {
          const d = Math.hypot(
            tanks[i].position.x - tanks[j].position.x,
            tanks[i].position.y - tanks[j].position.y,
          )
          if (d < min) min = d
        }
      }
      return min
    }

    const agents = () => base.players.map((player) => alwaysPassAgent(player.label))
    const spread = await runMatch(makeConfig({ ...base, spawnStrategy: 'spread' }), agents())
    const random = await runMatch(makeConfig({ ...base, spawnStrategy: 'random' }), agents())

    const spreadMin = minPairwise(spread.log.initialState.tanks)
    expect(spreadMin).toBeGreaterThanOrEqual(4)
    expect(spreadMin).toBeGreaterThan(minPairwise(random.log.initialState.tanks))
  })

  it('has correct player count in turns', async () => {
    const config = makeConfig({ turnLimit: 6 })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    const tankIds = new Set(log.initialState.tanks.map((t) => t.id))
    for (const turn of log.turns) {
      expect(tankIds.has(turn.player)).toBe(true)
    }
  })

  it('turns are sequential', async () => {
    const config = makeConfig({ turnLimit: 8 })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    for (let i = 0; i < log.turns.length; i++) {
      expect(log.turns[i].turn).toBe(i + 1)
    }
  })

  it('players rotate round-robin', async () => {
    const config = makeConfig({ turnLimit: 6 })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    const tankIds = log.initialState.tanks.map((t) => t.id)
    for (let i = 0; i < log.turns.length; i++) {
      const expectedIndex = i % 2
      expect(log.turns[i].player).toBe(tankIds[expectedIndex])
    }
  })

  it('expires a flare before the firer next scheduled turn', async () => {
    const config = makeConfig({
      turnLimit: 3,
      actionEconomy: 'single',
      map: { width: 20, height: 20, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
      players: [
        { label: 'p1', startPosition: { x: 5, y: 5 } },
        { label: 'p2', startPosition: { x: 15, y: 15 } },
      ],
    })
    const firer = fixtureCallAgent('p1', [
      { id: 'flare-1', tool: { kind: 'fire_flare', direction: 'N', range: 2 } },
      { id: 'pass-1', tool: { kind: 'pass' } },
    ])

    const { log } = await runMatch(config, [firer, alwaysPassAgent('p2')])

    expect(log.turns[0].actions[0].snapshot.flares[0].expiryTurn).toBe(3)
    expect(log.turns[1].worldview.activeFlares).toHaveLength(1)
    expect(log.turns[2].turn).toBe(3)
    expect(log.turns[2].worldview.activeFlares).toEqual([])
    expect(log.turns[2].worldview.flaredCells).toEqual([])
  })

  it('publishes the current thinking player before awaiting the agent', async () => {
    const updates: MatchLog[] = []
    const config = makeConfig({ turnLimit: 1 })

    await runMatch(
      config,
      [alwaysPassAgent('p1'), alwaysPassAgent('p2')],
      (log) => updates.push(structuredClone(log)),
    )

    expect(updates).toContainEqual(expect.objectContaining({
      liveState: { status: 'thinking', turn: 1, player: 'tank-0' },
    }))
  })

  it('single action economy produces one pass', async () => {
    const config = makeConfig({ turnLimit: 5, actionEconomy: 'single' })
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    for (const turn of log.turns) {
      const actionEvents = turn.actions.filter((a) => a.kind === 'pass')
      expect(actionEvents.length).toBe(1)
    }
  })

  it('two-player match with double economy produces two passes', async () => {
    // With double economy (budget=2), an agent returning 2 pass calls should
    // produce 2 pass actions in a single turn. We give each agent enough
    // scripted calls for all their turns. Excluding the final turn because
    // checkTermination fires after each action and may short-circuit when
    // turnCursor >= turnLimit on the very last turn.
    const passCalls: ToolCall[] = Array.from({ length: 14 }, (_, i) => ({
      id: `pass-${i + 1}`,
      tool: { kind: 'pass' as const },
    }))
    const p1 = fixtureCallAgent('p1', passCalls)
    const p2 = fixtureCallAgent('p2', passCalls)
    const config = makeConfig({ turnLimit: 8, actionEconomy: 'double' })
    const { log } = await runMatch(config, [p1, p2])

    // All turns except the terminal one get full budget of 2 passes
    for (let i = 0; i < log.turns.length - 1; i++) {
      const actionEvents = log.turns[i].actions.filter((a) => a.kind === 'pass')
      expect(actionEvents.length).toBe(2)
    }
  })

  it('allows two maximum-distance moves in double-action mode', async () => {
    const config = makeConfig({
      turnLimit: 2,
      moveMax: 3,
      map: { width: 20, height: 20, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
    })
    const mover = fixtureCallAgent('p1', [
      { id: 'move-1', tool: { kind: 'move', direction: 'E', distance: 3 } },
      { id: 'move-2', tool: { kind: 'move', direction: 'E', distance: 3 } },
      { id: 'flare-1', tool: { kind: 'fire_flare', direction: 'E', range: 5 } },
    ])

    const { log } = await runMatch(config, [mover, alwaysPassAgent('p2')])

    expect(log.turns[0].actions.map((action) => action.call.id)).toEqual(['move-1', 'move-2'])
    expect(log.turns[0].actions.map((action) => action.result.kind)).toEqual(['ok', 'ok'])
    expect(log.turns[0].actions[1].snapshot.tanks[0].position).toEqual({ x: 6, y: 0 })
  })

  it('rejects a single move beyond the per-action maximum', async () => {
    const config = makeConfig({
      turnLimit: 2,
      moveMax: 3,
      map: { width: 20, height: 20, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
    })
    const mover = fixtureCallAgent('p1', [
      { id: 'move-1', tool: { kind: 'move', direction: 'E', distance: 6 } },
    ])

    const { log } = await runMatch(config, [mover, alwaysPassAgent('p2')])

    expect(log.turns[0].actions[0].result).toEqual({
      kind: 'invalid',
      reason: 'Move distance exceeds per-action maximum of 3',
    })
  })
})

describe('runMatch — model agent protocol', () => {
  it('executes calls incrementally, feeds results back, and records an aggregate trace', async () => {
    const requests: ModelRequest[] = []
    const responses: NormalizedModelResponse[] = [
      {
        toolCalls: [{ id: 'look-1', name: 'look', arguments: {} }],
        tokensIn: 10,
        tokensOut: 2,
        costUsd: 0.01,
        latencyMs: 4,
        finishReason: 'tool_calls',
      },
      {
        toolCalls: [{ id: 'pass-1', name: 'pass', arguments: {} }],
        tokensIn: 12,
        tokensOut: 3,
        costUsd: 0.02,
        latencyMs: 6,
        finishReason: 'stop',
      },
    ]
    const model: Model = {
      query: async (request) => {
        requests.push(structuredClone(request))
        return responses.shift()!
      },
    }
    const config = makeConfig({
      turnLimit: 2,
      actionEconomy: 'single',
      map: { width: 8, height: 8, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'p1', startPosition: { x: 1, y: 1 } },
        { label: 'p2', startPosition: { x: 2, y: 1 } },
      ],
    })
    const agent = new ModelBackedTankAgent('p1', model, 'system', 3)

    const { log } = await runMatch(config, [agent, alwaysPassAgent('p2')])

    expect(requests).toHaveLength(2)
    const toolResult = requests[1].messages.at(-1)
    expect(toolResult?.role).toBe('tool')
    expect(toolResult?.content).toContain('"toolCallId":"look-1"')
    const wrappedResult = JSON.parse(toolResult!.content) as { content: string }
    const resultContent = JSON.parse(wrappedResult.content) as { worldview: { visibleEnemies: unknown[] } }
    expect(resultContent.worldview.visibleEnemies).toHaveLength(1)
    expect(log.turns[0].actions.map((action) => action.call.id)).toEqual(['look-1', 'pass-1'])
    expect(log.turns[0].modelTrace).toMatchObject({
      tokensIn: 22,
      tokensOut: 5,
      costUsd: 0.03,
      latencyMs: 10,
      finishReason: 'stop',
    })

    const moveSchema = requests[0].tools.find((tool) => tool.name === 'move')?.parameters
    expect(moveSchema).toMatchObject({
      type: 'object',
      required: ['direction', 'distance'],
      additionalProperties: false,
    })
  })
})
