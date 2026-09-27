import { describe, it, expect } from 'vitest'
import { createJevRawAgent } from '../src/jev-raw-agent.js'
import { createJevGreedyAgent } from '../src/jev-greedy-agent.js'
import type { DecisionAnswer, DecisionClient, DecisionQuestion, DecisionResponse } from '../src/jev-client.js'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { MatchConfig, PlayerSpec } from '@scorched-llm/engine'
import type { ToolExecutionResult, ToolExecutor } from '@scorched-llm/engine'
import { PRESETS } from '@scorched-llm/engine'
import { DIRECTION_DELTAS } from '@scorched-llm/engine'

function makeConfig(): MatchConfig {
  const players: PlayerSpec[] = [
    { label: 'tank-0', startPosition: 'random', scripted: 'jev-raw' },
    { label: 'tank-1', startPosition: 'random', scripted: 'conservative' },
  ]
  return PRESETS.duel(1, players)
}

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: [],
    flaredCells: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 1,
    isMyTurn: true,
    aliveEnemyCount: 1,
    ...overrides,
  }
}

function choiceAnswer(choice: string, probability = 0.9): DecisionAnswer {
  return { type: 'choice', choice, confidence: probability, probabilities: { [choice]: probability } }
}

function makeFakeClient(script: Array<Record<string, DecisionAnswer>>): DecisionClient & { asks: Array<{ state: unknown; questions: Record<string, DecisionQuestion> }> } {
  const asks: Array<{ state: unknown; questions: Record<string, DecisionQuestion> }> = []
  let i = 0
  return {
    id: 'fake-jev-raw',
    asks,
    async ask(state, questions): Promise<DecisionResponse> {
      asks.push({ state, questions })
      const answers = script[Math.min(i, script.length - 1)]
      i++
      return {
        answers,
        usage: { model: 'fake-jev-raw', inputTokens: 100, outputTokens: 10, costUsd: 0.0000042, latencyMs: 5 },
      }
    },
  }
}

function makeExecuteToolMock(initial: WorldView): ToolExecutor {
  let cw: WorldView = { ...initial }
  return async (call: ToolCall): Promise<ToolExecutionResult> => {
    const tool = call.tool
    if (tool.kind === 'move') {
      const delta = DIRECTION_DELTAS[tool.direction]
      cw = {
        ...cw,
        position: { x: cw.position.x + delta.dx * tool.distance, y: cw.position.y + delta.dy * tool.distance },
        remainingActions: cw.remainingActions - 1,
      }
      return { result: { kind: 'ok' }, worldview: cw, turnEnded: cw.remainingActions <= 0 }
    }
    if (tool.kind !== 'pass') {
      cw = { ...cw, remainingActions: cw.remainingActions - 1 }
      return { result: { kind: 'miss' }, worldview: cw, turnEnded: cw.remainingActions <= 0 }
    }
    return { result: { kind: 'ok' }, worldview: cw, turnEnded: false }
  }
}

function firstCall(calls: ToolCall[], kind: string): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === kind)
}

describe('JevRawAgent', () => {
  it('has correct name and passes when not my turn', async () => {
    const agent = createJevRawAgent('tank-0', makeConfig(), { client: makeFakeClient([]) })
    expect(agent.name).toBe('jev-raw-tank-0')
    const calls = (await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])) as ToolCall[]
    expect(calls[0].tool.kind).toBe('pass')
  })

  it('resolves fire recursively: sector, refine, power', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_shell') },
      { sector: choiceAnswer('NE') },
      { refine: choiceAnswer('center') },
      { power: choiceAnswer('4') },
    ])
    const agent = createJevRawAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({
      visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 2 }, hp: 2 }],
      remainingActions: 1,
    })
    const result = await agent.takeTurn(initial, [], makeExecuteToolMock(initial)) as { toolCalls: ToolCall[] }
    const shell = firstCall(result.toolCalls, 'fire_shell')
    if (shell?.tool.kind !== 'fire_shell') throw new Error('expected a shell call')
    // NE center = 45 degrees; power copied as chosen.
    expect(shell.tool.angle).toBe(45)
    expect(shell.tool.power).toBe(4)
    // Three dependent asks: intent, sector, refine, power = 4 total.
    expect(client.asks.length).toBe(4)
    // Refine question must be sector-specific.
    const refineQ = client.asks[2].questions.refine
    if (refineQ.type !== 'choice') throw new Error('expected choice')
    expect(refineQ.criteria.center).toContain('NE')
  })

  it('passes when an answer is off the offered option set (legality only)', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move') },
      { direction: choiceAnswer('NNW') },
    ])
    const agent = createJevRawAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(
      makeWorldView({ remainingActions: 1 }),
      [],
      makeExecuteToolMock(makeWorldView()),
    ) as { toolCalls: ToolCall[] }
    expect(firstCall(result.toolCalls, 'pass')).toBeDefined()
  })

  it('resolves flare with legal in-bounds ranges only', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_flare') },
      { flare_direction: choiceAnswer('W') },
      { flare_range: choiceAnswer('10') },
    ])
    const agent = createJevRawAgent('tank-0', makeConfig(), { client })
    // Tank at x=10: W can reach exactly 10 cells before the boundary.
    const result = await agent.takeTurn(
      makeWorldView({ position: { x: 10, y: 5 }, remainingActions: 1 }),
      [],
      makeExecuteToolMock(makeWorldView()),
    ) as { toolCalls: ToolCall[] }
    const flare = firstCall(result.toolCalls, 'fire_flare')
    if (flare?.tool.kind !== 'fire_flare') throw new Error('expected a flare call')
    expect(flare.tool.direction).toBe('W')
    expect(flare.tool.range).toBe(10)
    // The offered range criteria must exclude out-of-bounds ranges.
    const rangeQ = client.asks[2].questions.flare_range
    if (rangeQ.type !== 'choice') throw new Error('expected choice')
    expect(Object.keys(rangeQ.criteria)).not.toContain('11')
  })

  it('does not offer tactical verdicts in move criteria', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move') },
      { direction: choiceAnswer('N') },
      { distance: choiceAnswer('1') },
    ])
    const agent = createJevRawAgent('tank-0', makeConfig(), { client })
    await agent.takeTurn(
      makeWorldView({ remainingActions: 1, visibleEnemies: [{ id: 'tank-1', position: { x: 5, y: 2 }, hp: 2 }] }),
      [],
      makeExecuteToolMock(makeWorldView()),
    )
    const dirQ = client.asks[1].questions.direction
    if (dirQ.type !== 'choice') throw new Error('expected choice')
    // Neutral descriptions only: no recommended/retreat/likely language.
    for (const text of Object.values(dirQ.criteria)) {
      expect(text).not.toMatch(/recommended|retreat|likely|toward the enemy/)
    }
  })
})

describe('JevGreedyAgent boxed-in regression', () => {
  it('passes instead of crashing when every direction is blocked', async () => {
    const COMPASS_DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
    const obstacles = COMPASS_DIRS.map((d) => {
      const delta = DIRECTION_DELTAS[d]
      return { coord: { x: 5 + delta.dx, y: 5 + delta.dy }, terrain: 'obstacle' as const, obstacleHeight: 9 }
    })
    const client = makeFakeClient([])
    const agent = createJevGreedyAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(
      makeWorldView({ remainingActions: 1, localScan: obstacles }),
      [],
      makeExecuteToolMock(makeWorldView()),
    ) as { toolCalls: ToolCall[] }
    expect(firstCall(result.toolCalls, 'pass')).toBeDefined()
  })
})
