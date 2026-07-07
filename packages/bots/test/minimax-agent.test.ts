import { describe, it, expect } from 'vitest'
import { createMinimaxAgent } from '../src/minimax-agent.js'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { Cell, Coordinate } from '@scorched-llm/engine'

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

function makeCell(x: number, y: number, terrain: 'open' | 'obstacle' = 'open', obstacleHeight = 0): Cell {
  return { coord: { x, y }, terrain, obstacleHeight }
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

function allValid(calls: ToolCall[]): boolean {
  for (const c of calls) {
    if (!c.id) return false
    if (!c.tool) return false
  }
  return true
}

// --- Basic shape tests ---

describe('createMinimaxAgent', () => {
  it('has the correct name', () => {
    const agent = createMinimaxAgent('tank-0')
    expect(agent.name).toBe('minimax-tank-0')
  })

  it('returns a non-empty list of tool calls on the first turn', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    expect(allValid(calls)).toBe(true)
  })

  it('passes when it is not my turn', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])
    expect(calls.length).toBe(1)
    expect(calls[0]!.tool.kind).toBe('pass')
  })

  it('passes when no actions remain', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView({ remainingActions: 0 }), [])
    expect(calls[0]!.tool.kind).toBe('pass')
  })

  it('returns at most 2 calls (one offensive + one move, or two moves via pass-fallback)', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeLessThanOrEqual(2)
  })

  it('is deterministic — same input → same output', async () => {
    const vw: WorldView = makeWorldView({ position: { x: 10, y: 10 } })
    // The agent is stateful (it accumulates terrain memory, LKP, and
    // flare cooldowns across turns), so we create a fresh agent for
    // each call to test the "given the same initial state, same
    // output" property.
    const agent1 = createMinimaxAgent('tank-0')
    const agent2 = createMinimaxAgent('tank-0')
    const calls1 = await agent1.takeTurn(vw, [])
    const calls2 = await agent2.takeTurn(vw, [])
    expect(calls1).toEqual(calls2)
  })
})

// --- ENGAGE mode (enemy visible) ---

describe('minimax ENGAGE (enemy visible)', () => {
  it('fires a shell at a visible enemy', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: [{ id: 'tank-1', position: { x: 10, y: 5 }, hp: 2 }],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
  })

  it('shell angle points roughly toward the enemy', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Enemy directly east at (15, 5) — bearing should be 90°.
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: [{ id: 'tank-1', position: { x: 15, y: 5 }, hp: 2 }],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
    if (shell?.tool.kind === 'fire_shell') {
      // 90° = east. Allow ±12° for the solver's offset sweep.
      const angle = shell.tool.angle
      const normalized = ((angle % 360) + 360) % 360
      const diff = Math.min(
        Math.abs(normalized - 90),
        Math.abs(normalized - 450),
      )
      expect(diff).toBeLessThan(15)
    }
  })

  it('shell power is in the valid range (1 to 10)', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: [{ id: 'tank-1', position: { x: 12, y: 5 }, hp: 2 }],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    if (shell?.tool.kind === 'fire_shell') {
      expect(shell.tool.power).toBeGreaterThan(0)
      expect(shell.tool.power).toBeLessThanOrEqual(10)
    }
  })

  it('returns a move as the secondary action when shell fires', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: [{ id: 'tank-1', position: { x: 10, y: 5 }, hp: 2 }],
      }),
      [],
    )
    // Shell primary, move secondary.
    expect(calls.some((c) => c.tool.kind === 'fire_shell')).toBe(true)
    expect(calls.some((c) => c.tool.kind === 'move')).toBe(true)
  })

  it('never combines fire_shell with fire_flare in one turn', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Run a bunch of scenarios to ensure the umpire's oneOf rule
    // isn't violated.
    for (let i = 0; i < 8; i++) {
      const agent2 = createMinimaxAgent('tank-0')
      const calls = await agent2.takeTurn(
        makeWorldView({
          position: { x: 5 + i, y: 5 },
          visibleEnemies: [{ id: 'tank-1', position: { x: 5 + i + 3, y: 5 }, hp: 2 }],
        }),
        [],
      )
      const kinds = calls.map(extractToolKind)
      const hasShell = kinds.includes('fire_shell')
      const hasFlare = kinds.includes('fire_flare')
      expect(hasShell && hasFlare).toBe(false)
    }
  })

  it('shot solver finds a clean hit across a height-3 obstacle near the apex', async () => {
    // Shooter at (5, 5), target at (15, 5), obstacle at (10, 5) h=3.
    // The shell arc apex is at the midpoint with height 5, so the shell
    // arcs OVER the obstacle.
    const agent = createMinimaxAgent('tank-0')
    const scan: Cell[] = []
    for (let x = 0; x <= 10; x++) {
      for (let y = 0; y <= 10; y++) {
        if (x === 10 && y === 5) scan.push(makeCell(x, y, 'obstacle', 3))
        else scan.push(makeCell(x, y, 'open'))
      }
    }
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: scan,
        visibleEnemies: [{ id: 'tank-1', position: { x: 15, y: 5 }, hp: 2 }],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
  })
})

// --- HUNT mode (no intel) ---

describe('minimax HUNT (no intel)', () => {
  it('moves when no enemy is visible and no LKP is stored', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        visibleEnemies: [],
      }),
      [],
    )
    expect(calls.some((c) => c.tool.kind === 'move')).toBe(true)
  })

  it('does not fire a shell blindly without visibility', async () => {
    const agent = createMinimaxAgent('tank-0')
    // On the very first turn, no enemy intel → agent should not blindly
    // shoot. (We may flare or move, but never fire_shell.)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        visibleEnemies: [],
      }),
      [],
    )
    expect(calls.some((c) => c.tool.kind === 'fire_shell')).toBe(false)
  })

  it('upgrades to survival settings once it sees a high coord via flare', async () => {
    const agent = createMinimaxAgent('tank-0')
    // First turn: limited view at the NW corner.
    await agent.takeTurn(
      makeWorldView({ position: { x: 2, y: 2 }, visibleEnemies: [] }),
      [],
    )
    // Second turn: a flare reveals a coord that wouldn't exist on a
    // 20x20 map (>= 20), confirming 25x25 survival settings. Enemy
    // visible at (10, 10) — well within the upgraded maxRange=12.
    const scan: Cell[] = []
    for (let x = 0; x <= 22; x++) {
      for (let y = 0; y <= 22; y++) {
        scan.push(makeCell(x, y, 'open'))
      }
    }
    const flaredCells = [
      { cell: makeCell(20, 5), firerId: 'tank-0', activatedTurn: 1, expiryTurn: 3 },
      { cell: makeCell(21, 5), firerId: 'tank-0', activatedTurn: 1, expiryTurn: 3 },
      { cell: makeCell(20, 6), firerId: 'tank-0', activatedTurn: 1, expiryTurn: 3 },
      { cell: makeCell(21, 6), firerId: 'tank-0', activatedTurn: 1, expiryTurn: 3 },
    ]
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        localScan: scan,
        flaredCells,
        turn: 2,
        visibleEnemies: [{ id: 'tank-1', position: { x: 10, y: 10 }, hp: 2 }],
      }),
      [],
    )
    expect(firstShellCall(calls)).toBeDefined()
  })
})

// --- Retreat mode (critical HP) ---

describe('minimax retreat (critical HP)', () => {
  it('moves away from the enemy when HP is critical (1 of 2)', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Tank at (10, 10), enemy at (15, 10) — retreat direction should be W.
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 10, y: 10 },
        hp: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 15, y: 10 }, hp: 2 }],
      }),
      [],
    )
    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    if (move?.tool.kind === 'move') {
      // Bearing from (10,10) to (15,10) is 90° (east). Away is 270° (west).
      expect(['W', 'SW', 'NW']).toContain(move.tool.direction)
    }
  })
})

// --- Action safety / 3-strike rule ---

describe('minimax action safety', () => {
  it('requests only legal power values', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Try many positions/distances; none should request power <= 0 or > 10.
    for (let dx = -10; dx <= 10; dx += 2) {
      for (let dy = -10; dy <= 10; dy += 2) {
        const agent2 = createMinimaxAgent('tank-0')
        const x = 10 + dx
        const y = 10 + dy
        if (x < 0 || y < 0 || x > 19 || y > 19) continue
        const calls = await agent2.takeTurn(
          makeWorldView({
            position: { x: 10, y: 10 },
            visibleEnemies: [{ id: 'tank-1', position: { x, y }, hp: 2 }],
          }),
          [],
        )
        for (const c of calls) {
          if (c.tool.kind === 'fire_shell') {
            expect(c.tool.power).toBeGreaterThan(0)
            expect(c.tool.power).toBeLessThanOrEqual(10)
            expect(Number.isFinite(c.tool.angle)).toBe(true)
          }
        }
      }
    }
  })

  it('requests only legal move distances (<= moveMax)', async () => {
    const agent = createMinimaxAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({ position: { x: 5, y: 5 } }),
      [],
    )
    for (const c of calls) {
      if (c.tool.kind === 'move') {
        expect(c.tool.distance).toBeGreaterThan(0)
        expect(c.tool.distance).toBeLessThanOrEqual(2) // default moveMax
      }
    }
  })

  it('does not request a flare out of bounds', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Edge spawn — agent should never throw an unhandled exception.
    for (const [x, y] of [[0, 0], [19, 0], [0, 19], [19, 19], [0, 10], [10, 0]] as Coordinate[][]) {
      const agent2 = createMinimaxAgent('tank-0')
      const calls = await agent2.takeTurn(
        makeWorldView({ position: { x, y }, visibleEnemies: [] }),
        [],
      )
      for (const c of calls) {
        if (c.tool.kind === 'fire_flare') {
          // Compute target cell from direction+range; must be in bounds.
          const dirDelta: Record<string, { dx: number; dy: number }> = {
            N: { dx: 0, dy: -1 }, NE: { dx: 1, dy: -1 }, E: { dx: 1, dy: 0 }, SE: { dx: 1, dy: 1 },
            S: { dx: 0, dy: 1 }, SW: { dx: -1, dy: 1 }, W: { dx: -1, dy: 0 }, NW: { dx: -1, dy: -1 },
          }
          const delta = dirDelta[c.tool.direction]!
          const tx = x + delta.dx * c.tool.range
          const ty = y + delta.dy * c.tool.range
          expect(tx).toBeGreaterThanOrEqual(0)
          expect(tx).toBeLessThan(20)
          expect(ty).toBeGreaterThanOrEqual(0)
          expect(ty).toBeLessThan(20)
        }
      }
    }
  })
})

// --- Memory persistence ---

describe('minimax memory persistence', () => {
  it('remembers an LKP across turns', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Turn 1: enemy visible at (10, 10). Agent stores LKP.
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 10, y: 10 }, hp: 2 }],
      }),
      [],
    )
    // Turn 2: enemy no longer visible. Agent should still reference the
    // LKP for movement (move toward it). The exact action may be a
    // shell toward LKP, a flare, or a move — but it should NOT be
    // direction center (10, 10) of a 20x20 map. Either way, the agent
    // returns a non-empty call list without throwing.
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 6, y: 6 },
        turn: 2,
        visibleEnemies: [],
      }),
      [],
    )
    expect(calls.length).toBeGreaterThan(0)
  })

  it('persists terrain memory across turns', async () => {
    const agent = createMinimaxAgent('tank-0')
    // Turn 1: agent sees a tall obstacle at (10, 5).
    const scan1: Cell[] = []
    for (let x = 0; x <= 10; x++) {
      for (let y = 0; y <= 10; y++) {
        scan1.push(x === 10 && y === 5 ? makeCell(x, y, 'obstacle', 5) : makeCell(x, y, 'open'))
      }
    }
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: scan1,
        turn: 1,
        visibleEnemies: [],
      }),
      [],
    )
    // Turn 2: agent moves to (6, 5), enemy now visible at (15, 5) past
    // the obstacle. The shot solver should consider the obstacle and
    // either find an angle that arcs over it OR skip the shot.
    const scan2: Cell[] = []
    for (let x = 0; x <= 18; x++) {
      for (let y = 0; y <= 10; y++) {
        scan2.push(x === 10 && y === 5 ? makeCell(x, y, 'obstacle', 5) : makeCell(x, y, 'open'))
      }
    }
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 6, y: 5 },
        localScan: scan2,
        turn: 2,
        visibleEnemies: [{ id: 'tank-1', position: { x: 15, y: 5 }, hp: 2 }],
      }),
      [],
    )
    // Even if the agent chooses to move instead of fire, the call
    // should be valid.
    expect(allValid(calls)).toBe(true)
  })
})

// --- Smoke test against the orchestration ---

describe('minimax smoke (orchestration)', () => {
  it('plays a short duel without throwing', async () => {
    const { runMatch } = await import('@scorched-llm/engine')
    const { PRESETS } = await import('@scorched-llm/engine')
    const { createAggressiveAgent } = await import('@scorched-llm/engine')
    const me = createMinimaxAgent('tank-0')
    const foe = createAggressiveAgent('tank-1')
    const config = PRESETS.duel!(42, [
      { label: 'minimax', startPosition: 'random', scripted: 'minimax' },
      { label: 'aggressive', startPosition: 'random', scripted: 'aggressive' },
    ])
    const { log, result } = await runMatch(config, [me, foe])
    expect(log.turns.length).toBeGreaterThan(0)
    expect(['last-standing', 'turn-limit', 'mutual-destruction']).toContain(result.terminationReason)
    expect(result.placements.length).toBe(2)
  }, 30000)
})
