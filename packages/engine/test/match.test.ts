import { describe, it, expect } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { alwaysPassAgent, fixtureCallAgent } from '../src/match/fake-agents.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { MatchLog } from '../src/types/log.js'
import type { ToolCall } from '../src/types/tool.js'

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
})