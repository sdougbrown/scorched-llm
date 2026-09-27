import { describe, it, expect, vi } from 'vitest'
import { createJevAgent } from '../src/jev-agent.js'
import type { DecisionAnswer, DecisionClient, DecisionQuestion, DecisionResponse } from '../src/jev-client.js'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { MatchConfig, PlayerSpec } from '@scorched-llm/engine'
import type { ToolExecutionResult, ToolExecutor } from '@scorched-llm/engine'
import { PRESETS } from '@scorched-llm/engine'
import { DIRECTION_DELTAS } from '@scorched-llm/engine'

// --- Helpers ---

function makeConfig(): MatchConfig {
  const players: PlayerSpec[] = [
    { label: 'tank-0', startPosition: 'random', scripted: 'jev' },
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

interface RecordedAsk {
  state: unknown
  questions: Record<string, DecisionQuestion>
}

/** Scripted decision client: pops one answer-set per ask, recording calls. */
function makeFakeClient(script: Array<Record<string, DecisionAnswer>>): DecisionClient & { asks: RecordedAsk[] } {
  const asks: RecordedAsk[] = []
  let i = 0
  return {
    id: 'fake-jev',
    asks,
    async ask(state, questions): Promise<DecisionResponse> {
      asks.push({ state, questions })
      const answers = script[Math.min(i, script.length - 1)]
      i++
      return {
        answers,
        usage: { model: 'fake-jev', inputTokens: 100, outputTokens: 10, costUsd: 0.0000042, latencyMs: 5 },
      }
    },
  }
}

/** Minimal executeTool mock: applies moves, decrements remainingActions,
 * ends the turn at zero. */
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
    if (tool.kind === 'fire_shell') {
      cw = { ...cw, remainingActions: cw.remainingActions - 1 }
      return { result: { kind: 'miss' }, worldview: cw, turnEnded: cw.remainingActions <= 0 }
    }
    if (tool.kind === 'fire_flare') {
      cw = { ...cw, remainingActions: cw.remainingActions - 1 }
      return { result: { kind: 'revealed', cells: [] }, worldview: cw, turnEnded: cw.remainingActions <= 0 }
    }
    return { result: { kind: 'ok' }, worldview: cw, turnEnded: false }
  }
}

function firstCall(calls: ToolCall[], kind: string): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === kind)
}

// --- Tests ---

describe('JevAgent', () => {
  it('has correct name', () => {
    const agent = createJevAgent('tank-0', makeConfig(), { client: makeFakeClient([]) })
    expect(agent.name).toBe('jev-tank-0')
  })

  it('passes when it is not my turn', async () => {
    const client = makeFakeClient([])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const calls = (await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])) as ToolCall[]
    expect(calls).toHaveLength(1)
    expect(calls[0].tool.kind).toBe('pass')
    expect(client.asks).toHaveLength(0)
  })

  it('fires a shell with the exact precomputed angle and power of the chosen candidate', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('c0') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 3,
        visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
      }),
      [],
      makeExecuteToolMock(makeWorldView()),
    ) as { toolCalls: ToolCall[] }

    const shell = firstCall(result.toolCalls, 'fire_shell')
    expect(shell).toBeDefined()
    if (shell?.tool.kind !== 'fire_shell') throw new Error('unreachable')
    // Exact solution from (5,5) to (8,8): SE (y grows downward) = 135deg,
    // distance sqrt(18).
    expect(shell.tool.angle).toBeCloseTo(135, 5)
    expect(shell.tool.power).toBeCloseTo(Math.sqrt(18), 5)
  })

  it('repositions when the shot question answers hold', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('hold') },
      { direction: choiceAnswer('N') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({ visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }], remainingActions: 1 })
    const result = await agent.takeTurn(initial, [], makeExecuteToolMock(initial)) as { toolCalls: ToolCall[] }
    expect(firstCall(result.toolCalls, 'fire_shell')).toBeUndefined()
    expect(firstCall(result.toolCalls, 'move')).toBeDefined()
  })

  it('passes when the intent probability is below the gate', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move', 0.2), posture: { type: 'score', score: 1.0, confidence: 0.5 } },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(makeWorldView(), [], makeExecuteToolMock(makeWorldView())) as { toolCalls: ToolCall[] }
    expect(firstCall(result.toolCalls, 'pass')).toBeDefined()
  })

  it('moves in the chosen direction for the computed clearance', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('NE'), distance: choiceAnswer('2') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const executor = makeExecuteToolMock(makeWorldView())
    const result = await agent.takeTurn(makeWorldView({ remainingActions: 1 }), [], executor) as { toolCalls: ToolCall[] }
    const move = firstCall(result.toolCalls, 'move')
    expect(move).toBeDefined()
    if (move?.tool.kind !== 'move') throw new Error('unreachable')
    expect(move.tool.direction).toBe('NE')
    // Distance is folded into the direction choice: full known clearance.
    expect(move.tool.distance).toBeGreaterThanOrEqual(1)
  })

  it('falls back to a code-computed direction when the direction answer is unusable', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('nope') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(makeWorldView({ remainingActions: 1 }), [], makeExecuteToolMock(makeWorldView())) as { toolCalls: ToolCall[] }
    const move = firstCall(result.toolCalls, 'move')
    expect(move).toBeDefined()
    if (move?.tool.kind !== 'move') throw new Error('expected a move call')
    expect(move.tool.distance).toBeGreaterThanOrEqual(1)
  })

  it('fires a flare toward the information goal with code-computed deep range', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_flare'), posture: { type: 'score', score: 1.0, confidence: 0.8 } },
      // Tank (5,5), no target seen: the goal is exploration waypoint (3,3),
      // i.e. NW. Only directions within 90 degrees of the goal are offered.
      { flare_direction: choiceAnswer('NW') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const result = await agent.takeTurn(makeWorldView({ remainingActions: 1 }), [], makeExecuteToolMock(makeWorldView())) as { toolCalls: ToolCall[] }
    const flare = firstCall(result.toolCalls, 'fire_flare')
    if (flare?.tool.kind !== 'fire_flare') throw new Error('expected a flare call')
    expect(flare.tool.direction).toBe('NW')
    // Blind flares go as deep as the map allows: (5,5) + NW reaches (0,0).
    expect(flare.tool.range).toBe(5)
  })

  it('flags under_attack in state after taking unseen damage', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('N') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({ hp: 2, remainingActions: 1 })
    const executor = makeExecuteToolMock(initial)
    await agent.takeTurn(initial, [], executor)
    await agent.takeTurn(makeWorldView({ hp: 1, remainingActions: 1 }), [], executor)

    // asks[0] = healthy turn intent ask, asks[2] = wounded turn intent ask.
    const healthy = (client.asks[0].state as { threats: { under_attack: boolean } }).threats
    const wounded = (client.asks[2].state as { threats: { under_attack: boolean; under_attack_note: string | null } }).threats
    expect(healthy.under_attack).toBe(false)
    expect(wounded.under_attack).toBe(true)
    expect(wounded.under_attack_note).toContain('unseen enemy')
  })

  it('offers a self-ring flare when under attack with no sighting', async () => {
    const client = makeFakeClient([
      // Turn 1 (healthy): move.
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('N') },
      // Turn 2 (wounded, blind): flare — the self-ring mode must engage.
      { intent: choiceAnswer('fire_flare'), posture: { type: 'score', score: 0.5, confidence: 0.8 } },
      { flare_direction: choiceAnswer('E') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({ hp: 2, remainingActions: 1 })
    const executor = makeExecuteToolMock(initial)
    await agent.takeTurn(initial, [], executor)
    const result = await agent.takeTurn(
      makeWorldView({ hp: 1, remainingActions: 1 }),
      [],
      executor,
    ) as { toolCalls: ToolCall[] }

    const flareAsk = client.asks[3]
    const flareQ = flareAsk.questions.flare_direction
    if (flareQ.type !== 'choice') throw new Error('expected choice question')
    // All 8 directions offered (no bearing filter in self-ring mode), and
    // the criteria describe the self-area ring, not a corridor.
    expect(Object.keys(flareQ.criteria)).toHaveLength(8)
    expect(Object.values(flareQ.criteria)[0]).toContain('hidden shooter')
    // Ring range is short, not a deep corridor flare.
    const flare = firstCall(result.toolCalls, 'fire_flare')
    if (flare?.tool.kind !== 'fire_flare') throw new Error('expected a flare call')
    expect(flare.tool.range).toBe(3)
  })

  it('executes move-then-shell through the executor as actions remain', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('N'), distance: choiceAnswer('3') },
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('c0') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({
      position: { x: 5, y: 5 },
      turn: 2,
      visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
    })
    const executor = vi.fn(makeExecuteToolMock(initial))
    const result = await agent.takeTurn(initial, [], executor) as { toolCalls: ToolCall[]; executed: boolean }

    expect(result.executed).toBe(true)
    expect(executor).toHaveBeenCalledTimes(2)
    expect(result.toolCalls[0].tool.kind).toBe('move')
    expect(result.toolCalls[1].tool.kind).toBe('fire_shell')
    // The shell was decided against the post-move worldview, so the harness
    // must have asked stage 1 again after the move executed.
    expect(client.asks.length).toBeGreaterThanOrEqual(3)
  })

  it('returns a plain call array in static mode (no executor)', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('c0') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const calls = (await agent.takeTurn(
      makeWorldView({ visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }] }),
      [],
    )) as ToolCall[]
    expect(Array.isArray(calls)).toBe(true)
    expect(firstCall(calls, 'fire_shell')).toBeDefined()
  })

  it('aggregates usage into the model trace', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('c0') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const initial = makeWorldView({ visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }], remainingActions: 1 })
    const result = await agent.takeTurn(
      initial,
      [],
      makeExecuteToolMock(initial),
    ) as { modelTrace?: { tokensIn: number; costUsd: number | 'unknown'; latencyMs: number; assistantText?: string } }

    expect(result.modelTrace).toBeDefined()
    // Two asks (intent + shot) at 100 input tokens each.
    expect(result.modelTrace?.tokensIn).toBe(200)
    expect(typeof result.modelTrace?.costUsd).toBe('number')
    expect(result.modelTrace?.assistantText).toContain('intent=fire_shell')
  })

  it('describes move directions with clearance and relation in the question', async () => {
    const client = makeFakeClient([
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('N'), distance: choiceAnswer('1') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    await agent.takeTurn(
      makeWorldView({ remainingActions: 1, visibleEnemies: [{ id: 'tank-1', position: { x: 5, y: 2 }, hp: 2 }] }),
      [],
      makeExecuteToolMock(makeWorldView()),
    )

    const moveAsk = client.asks[1]
    const dirQ = moveAsk.questions.direction
    if (dirQ.type !== 'choice') throw new Error('expected choice question')
    // Enemy due north of (5,5): N should be described as toward the enemy.
    expect(dirQ.criteria.N).toContain('directly toward the enemy')
    expect(dirQ.criteria.N).toMatch(/path clear for \d+ cells?/)
    // Due south should be described as away.
    expect(dirQ.criteria.S).toContain('directly away from the enemy')
  })

  it('offers a not-verified memory shot on a later blind turn', async () => {
    const client = makeFakeClient([
      // Turn 1: see the enemy, choose to move (memory seeded via absorb).
      { intent: choiceAnswer('move'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { direction: choiceAnswer('N'), distance: choiceAnswer('1') },
      // Turn 7: enemy long gone from view; candidate must come from memory.
      { intent: choiceAnswer('fire_shell'), posture: { type: 'score', score: 2.0, confidence: 0.8 } },
      { shot: choiceAnswer('c0') },
    ])
    const agent = createJevAgent('tank-0', makeConfig(), { client })
    const turn1 = makeWorldView({ turn: 1, remainingActions: 1, visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }] })
    const executor = makeExecuteToolMock(turn1)
    await agent.takeTurn(turn1, [], executor)
    const result = await agent.takeTurn(
      makeWorldView({ turn: 7, remainingActions: 1 }),
      [],
      executor,
    ) as { toolCalls: ToolCall[] }

    // Turn 1 consumes two asks (intent + direction/distance); turn 7 adds
    // the blind-shot intent ask and the shot ask.
    const shotAsk = client.asks[3]
    const shotQ = shotAsk.questions.shot
    if (shotQ.type !== 'choice') throw new Error('expected choice question')
    const candidate = Object.values(shotQ.criteria).find((d) => d.includes("last-known position"))
    expect(candidate).toBeDefined()
    expect(candidate).toContain('seen 6 turns ago')
    expect(candidate).toContain('arc not verified')
    expect(candidate).toContain('likely misses')
    const shell = firstCall(result.toolCalls, 'fire_shell')
    expect(shell).toBeDefined()
    if (shell?.tool.kind !== 'fire_shell') throw new Error('unreachable')
    expect(shell.tool.power).toBeCloseTo(Math.sqrt(18), 5)
  })
})
