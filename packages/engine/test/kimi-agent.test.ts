import { describe, it, expect } from 'vitest'
import { createKimiAgent } from '../src/match/kimi-agent.js'
import type { WorldView } from '../src/types/events.js'
import type { ToolCall } from '../src/types/tool.js'
import type { Cell, Coordinate } from '../src/types/coords.js'

// --- Helpers ---

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

function openScan(center: Coordinate, radius: number): Cell[] {
  const scan: Cell[] = []
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) <= radius) {
        scan.push({
          coord: { x: center.x + dx, y: center.y + dy },
          terrain: 'open',
          obstacleHeight: 0,
        })
      }
    }
  }
  return scan
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

function toolKinds(calls: ToolCall[]): string[] {
  return calls.map((c) => c.tool.kind)
}

// --- KimiAgent tests ---

describe('KimiAgent', () => {
  it('has correct name', () => {
    const agent = createKimiAgent('tank-0')
    expect(agent.name).toBe('kimi-tank-0')
  })

  it('returns valid tool calls', async () => {
    const agent = createKimiAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('fires a shell at a visible enemy and then moves', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const visible = [{ id: 'tank-1', position: { x: 8, y: 5 }, hp: 2 }]
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: visible,
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
    expect(shell!.tool.kind).toBe('fire_shell')
    // Angle from (5,5) to (8,5): dx=3, dy=0 → bearing=90° (E)
    expect(shell!.tool.angle).toBeCloseTo(90, 0)
    // Power should equal the rounded Euclidean distance (3).
    expect(shell!.tool.power).toBe(3)

    expect(firstMoveCall(calls)).toBeDefined()
  })

  it('closes distance when enemy is visible but far', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const visible = [{ id: 'tank-1', position: { x: 15, y: 5 }, hp: 2 }]
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: visible,
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    expect(move!.tool.direction).toBe('E')
  })

  it('backs away when enemy is very close', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const visible = [{ id: 'tank-1', position: { x: 6, y: 5 }, hp: 2 }]
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: visible,
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    // Enemy is east, so Kimi should move away toward W/SW/SW.  We only assert
    // it does not stay put and that the chosen direction increases distance.
    expect(['W', 'SW', 'NW']).toContain(move!.tool.direction)
  })

  it('pursues a fresh last-known position when no visible enemy', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    // First turn: see enemy, store memory.
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 10, y: 10 }, hp: 2 }],
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    // Next turn: memory is fresh (turn diff 1) but not currently visible.
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 2,
        visibleEnemies: [],
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    expect(firstMoveCall(calls)).toBeDefined()
    // Should move SE toward (10,10).
    expect(firstMoveCall(calls)!.tool.direction).toBe('SE')
  })

  it('hunts toward the opposite corner when stale/blank', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        turn: 1,
        visibleEnemies: [],
        localScan: openScan({ x: 2, y: 2 }, 3),
      }),
      [],
    )

    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    expect(move!.tool.direction).toBe('SE')
  })

  it('uses both actions to move in double economy', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        remainingActions: 2,
        visibleEnemies: [],
        localScan: openScan({ x: 2, y: 2 }, 3),
      }),
      [],
    )

    const moves = calls.filter((c) => c.tool.kind === 'move')
    expect(moves.length).toBe(2)
  })

  it('fires a probing flare when completely blind for several turns', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    // Feed turns with no vision so blindTurns accumulates.  Kimi only has
    // one action budget in single economy on these turns, so it moves but
    // the second-action flare cannot fire yet.
    for (let t = 1; t <= 5; t++) {
      await agent.takeTurn(
        makeWorldView({
          position: { x: 5, y: 5 },
          turn: t,
          remainingActions: 1,
          visibleEnemies: [],
          localScan: openScan({ x: 5, y: 5 }, 3),
        }),
        [],
      )
    }

    // Double-economy turn with budget for a move + a flare.
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 6,
        remainingActions: 2,
        visibleEnemies: [],
        localScan: openScan({ x: 5, y: 5 }, 3),
      }),
      [],
    )

    expect(firstFlareCall(calls)).toBeDefined()
  })

  it('passes when not its turn', async () => {
    const agent = createKimiAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])
    expect(toolKinds(calls)).toEqual(['pass'])
  })

  it('is deterministic with the same input', async () => {
    const agent = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const vw: WorldView = {
      position: { x: 5, y: 5 },
      hp: 2,
      facing: 0,
      localScan: openScan({ x: 5, y: 5 }, 3),
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 1,
      isMyTurn: true,
      aliveEnemyCount: 1,
      visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 5 }, hp: 2 }],
    }
    const calls1 = await agent.takeTurn(vw, [])
    // Fresh agent, same deterministic state: should reproduce the same output.
    const agent2 = createKimiAgent('tank-0', { mapWidth: 20, mapHeight: 20 })
    const calls2 = await agent2.takeTurn(vw, [])
    expect(calls1).toEqual(calls2)
  })
})
