import { describe, it, expect } from 'vitest'
import { createSonnetAgent } from '../src/sonnet-agent.js'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { Coordinate } from '@scorched-llm/engine'
import type { MatchConfig, PlayerSpec } from '@scorched-llm/engine'
import { PRESETS } from '@scorched-llm/engine'
import { DIRECTION_DELTAS } from '@scorched-llm/engine'
import type { AgentTurnResult, ToolExecutionResult, ToolExecutor } from '@scorched-llm/engine'

// --- Helpers ---

function makeConfig(): MatchConfig {
  const players: PlayerSpec[] = [
    { label: 'tank-0', startPosition: 'random', scripted: 'sonnet' },
    { label: 'tank-1', startPosition: 'random', scripted: 'sonnet' },
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

function extractToolKind(call: ToolCall): string {
  return call.tool.kind
}

function firstShellCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'fire_shell')
}

function firstMoveCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'move')
}

function firstFlareCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'fire_flare')
}

/** Minimal executeTool mock: applies moves to position, decrements
 * remainingActions on every costly action, and ends the turn at zero. */
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

// --- Basic contract ---

describe('SonnetAgent', () => {
  it('has correct name', () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    expect(agent.name).toBe('sonnet-tank-0')
  })

  it('returns valid tool calls in static mode (no executeTool)', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(makeWorldView(), [])) as ToolCall[]
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('passes when it is not my turn', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])) as ToolCall[]
    expect(calls).toHaveLength(1)
    expect(calls[0].tool.kind).toBe('pass')
  })

  // --- Precise fire control ---

  it('fires a shell with exact (non-rounded) angle and power at a visible enemy', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        aliveEnemyCount: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
      }),
      [],
    )) as ToolCall[]

    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    // dx=3, dy=3 -> bearing 135 (SE), power = sqrt(18) exactly, not rounded to 4
    expect(shellCall!.tool.angle).toBeCloseTo(135, 5)
    expect(shellCall!.tool.power).toBeCloseTo(Math.sqrt(18), 5)
    expect(shellCall!.tool.power).not.toBe(4)
  })

  it('performs shoot-and-scoot: fires then moves away in the same turn (static mode)', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        remainingActions: 2,
        aliveEnemyCount: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
      }),
      [],
    )) as ToolCall[]

    const kinds = calls.map(extractToolKind)
    expect(kinds[0]).toBe('fire_shell')
    expect(kinds).toContain('move')
  })

  it('performs shoot-and-scoot via the adaptive executeTool path', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const initial = makeWorldView({
      position: { x: 5, y: 5 },
      turn: 5,
      remainingActions: 2,
      aliveEnemyCount: 1,
      visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
    })
    const exec = makeExecuteToolMock(initial)
    const result = (await agent.takeTurn(initial, [], exec)) as AgentTurnResult
    expect(result.executed).toBe(true)
    const kinds = result.toolCalls.map(extractToolKind)
    expect(kinds[0]).toBe('fire_shell')
    expect(kinds).toContain('move')
  })

  it('does not fire when the only known shot is blocked by an observed obstacle', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        // Single action slot: with the direct shot blocked, the only thing
        // it can do is reposition — no room left this turn to re-check line
        // of sight and fire from a new spot.
        remainingActions: 1,
        aliveEnemyCount: 1,
        // Enemy due east at max range (10); the shell's arc is lowest right
        // next to the shooter, so an obstacle there reliably blocks the shot.
        visibleEnemies: [{ id: 'tank-1', position: { x: 15, y: 5 }, hp: 2 }],
        localScan: [{ coord: { x: 6, y: 5 }, terrain: 'obstacle', obstacleHeight: 3 }],
      }),
      [],
    )) as ToolCall[]

    expect(firstShellCall(calls)).toBeUndefined()
    expect(firstMoveCall(calls)).toBeDefined()
  })

  // --- Obstacle-aware movement ---

  it('avoids a known-obstructed direction when exploring blind', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        turn: 1,
        remainingActions: 2,
        aliveEnemyCount: 1,
        // First cell of the SE approach toward the nearest waypoint is blocked.
        localScan: [{ coord: { x: 1, y: 1 }, terrain: 'obstacle', obstacleHeight: 3 }],
      }),
      [],
    )) as ToolCall[]

    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeDefined()
    expect(moveCall!.tool.direction).not.toBe('SE')
  })

  // --- Blind exploration / flare probing ---

  it('probes with a flare on the first blind turn', async () => {
    const agent = createSonnetAgent('tank-0', makeConfig())
    const calls = (await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 1, remainingActions: 2, aliveEnemyCount: 1 }),
      [],
    )) as ToolCall[]
    expect(firstFlareCall(calls)).toBeDefined()
  })

  // --- Memory / last-known position ---

  it('moves toward a recently-seen (non-stale) last-known enemy position', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createSonnetAgent('tank-0', makeConfig(), enemyPos, 3)
    const calls = (await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 5, aliveEnemyCount: 1 }),
      [],
    )) as ToolCall[]
    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeDefined()
    expect(moveCall!.tool.direction).toBe('SE')
  })

  it('maintains last-known enemy position across turns', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createSonnetAgent('tank-0', makeConfig(), enemyPos, 3)

    const calls1 = (await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 5, aliveEnemyCount: 1 }),
      [],
    )) as ToolCall[]
    expect(firstMoveCall(calls1)).toBeDefined()

    const calls2 = (await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 6, aliveEnemyCount: 1 }),
      [],
    )) as ToolCall[]
    expect(firstMoveCall(calls2)).toBeDefined()
  })

  // --- Determinism ---

  it('is deterministic — same input -> same output', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const config = makeConfig()
    const vw: WorldView = makeWorldView({ position: { x: 0, y: 0 }, turn: 5, aliveEnemyCount: 1 })

    const agent1 = createSonnetAgent('tank-0', config, enemyPos, 3)
    const agent2 = createSonnetAgent('tank-0', config, enemyPos, 3)
    const calls1 = (await agent1.takeTurn(vw, [])) as ToolCall[]
    const calls2 = (await agent2.takeTurn(vw, [])) as ToolCall[]

    expect(calls1.map(extractToolKind)).toEqual(calls2.map(extractToolKind))
    expect(calls1).toEqual(calls2)
  })
})
