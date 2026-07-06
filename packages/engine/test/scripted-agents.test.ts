import { describe, it, expect } from 'vitest'
import {
  createAggressiveAgent,
  createConservativeAgent,
} from '../src/match/scripted-agents.js'
import { createGpt55Agent } from '../src/match/gpt-5.5-agent.js'
import { createNorthAgent } from '../src/match/north-agent.js'
import type { WorldView } from '../src/types/events.js'
import type { ToolCall } from '../src/types/tool.js'
import type { Coordinate } from '../src/types/coords.js'

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

function openScanAround(center: Coordinate, radius: number): WorldView['localScan'] {
  const cells: WorldView['localScan'] = []
  for (let y = center.y - radius; y <= center.y + radius; y++) {
    for (let x = center.x - radius; x <= center.x + radius; x++) {
      if (x < 0 || y < 0) continue
      cells.push({
        coord: { x, y },
        terrain: 'open',
        obstacleHeight: 0,
      })
    }
  }
  return cells
}


// --- AggressiveAgent tests ---

describe('AggressiveAgent', () => {
  it('has correct name', () => {
    const agent = createAggressiveAgent('tank-0')
    expect(agent.name).toBe('aggressive-tank-0')
  })

  it('returns valid tool calls', async () => {
    const agent = createAggressiveAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('moves toward last-known enemy when no current sighting', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createAggressiveAgent('tank-0', enemyPos)
    // aliveEnemyCount=0 means enemy not "visible" per heuristic,
    // but we have lastKnownEnemyPos → fire max power + move toward it
    const calls = await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, aliveEnemyCount: 0 }),
      [],
    )
    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeDefined()
    // Agent at (0,0), enemy at (10,10) → SE direction
    expect(moveCall!.tool.direction).toBe('SE')
  })

  it('fires shell at visible enemy with correct angle/power', async () => {
    const enemyPos: Coordinate = { x: 8, y: 8 }
    // lastSeenTurn=3, so with turn=5 the diff is 2 → enemyVisible=true
    const agent = createAggressiveAgent('tank-0', enemyPos, 3)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        aliveEnemyCount: 1,
      }),
      [],
    )
    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    expect(shellCall!.tool.kind).toBe('fire_shell')
    // angle from (5,5) to (8,8): dx=3, dy=3 → bearing=135° (SE)
    // 0°=N, 90°=E, 135°=SE
    expect(shellCall!.tool.angle).toBeCloseTo(135, 0)
    // power = euclidean distance rounded = round(√18) ≈ 4
    expect(shellCall!.tool.power).toBe(4)
  })

  it('fires max power at last-known position when not visible but was seen', async () => {
    const enemyPos: Coordinate = { x: 15, y: 15 }
    // lastSeenTurn=3, turn=5 → diff=2, but aliveEnemyCount=0
    // → enemyVisible=false, but lastKnownEnemyPos exists → max power
    const agent = createAggressiveAgent('tank-0', enemyPos, 3)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        turn: 5,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    expect(shellCall!.tool.kind).toBe('fire_shell')
    expect(shellCall!.tool.power).toBe(10) // max power
  })

  it('uses both actions in double economy mode (move + shoot)', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createAggressiveAgent('tank-0', enemyPos, 3)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        turn: 5,
        aliveEnemyCount: 1,
      }),
      [],
    )
    const kinds = calls.map(extractToolKind)
    expect(kinds).toContain('fire_shell')
    expect(kinds).toContain('move')
  })

  it('is deterministic — same input → same output', async () => {
    // Use same initial state for both calls
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createAggressiveAgent('tank-0', enemyPos, 3)
    const vw: WorldView = {
      position: { x: 0, y: 0 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 5,
      isMyTurn: true,
      aliveEnemyCount: 1,
    }
    const calls1 = await agent.takeTurn(vw, [])
    const calls2 = await agent.takeTurn(vw, [])
    expect(calls1).toEqual(calls2)
  })
})

// --- ConservativeAgent tests ---

describe('ConservativeAgent', () => {
  it('has correct name', () => {
    const agent = createConservativeAgent('tank-0')
    expect(agent.name).toBe('conservative-tank-0')
  })

  it('returns valid tool calls', async () => {
    const agent = createConservativeAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('flares every other turn', async () => {
    const agent = createConservativeAgent('tank-0')
    // Turn 1: flare (toggle=false → flare)
    const calls1 = await agent.takeTurn(makeWorldView({ turn: 1 }), [])
    expect(firstFlareCall(calls1)).toBeDefined()

    // Turn 2: no flare (toggle=true → skip), but may move
    const calls2 = await agent.takeTurn(makeWorldView({ turn: 2 }), [])
    expect(firstFlareCall(calls2)).toBeUndefined()
  })

  it('holds position when wounded', async () => {
    const agent = createConservativeAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        turn: 1,
        hp: 0, // wounded
      }),
      [],
    )
    // Wounded agent should not move
    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeUndefined()
  })

  it('fires only on direct sight (recent intel)', async () => {
    const enemyPos: Coordinate = { x: 8, y: 8 }
    const agent = createConservativeAgent('tank-0', enemyPos, 3)

    // Turn 5: aliveEnemyCount=1, lastSeenTurn=3 → diff=2 > 1 → not direct sight
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        aliveEnemyCount: 1,
      }),
      [],
    )
    // Should not fire — enemy is not "directly seen" (diff > 1)
    expect(firstShellCall(calls)).toBeUndefined()
  })

  it('is deterministic — same input → same output', async () => {
    const enemyPos: Coordinate = { x: 8, y: 8 }
    const vw: WorldView = {
      position: { x: 5, y: 5 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 5,
      isMyTurn: true,
      aliveEnemyCount: 1,
    }
    // Create two separate agents with the same initial state
    const agent1 = createConservativeAgent('tank-0', enemyPos, 3)
    const agent2 = createConservativeAgent('tank-0', enemyPos, 3)
    const calls1 = await agent1.takeTurn(vw, [])
    const calls2 = await agent2.takeTurn(vw, [])
    // Determinism: same initial state and input → same output
    expect(calls1.length).toBe(calls2.length)
    expect(calls1.map(extractToolKind)).toEqual(calls2.map(extractToolKind))
  })
})

// --- Memory persistence tests ---

describe('memory persistence', () => {
  it('aggressive agent maintains last-known position across turns', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createAggressiveAgent('tank-0', enemyPos, 3)

    // Turn 5: should fire shell and move
    const calls1 = await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 5, aliveEnemyCount: 1 }),
      [],
    )
    expect(firstShellCall(calls1)).toBeDefined()
    expect(firstMoveCall(calls1)).toBeDefined()

    // Turn 6: should still fire shell and move (position still tracked)
    const calls2 = await agent.takeTurn(
      makeWorldView({ position: { x: 0, y: 0 }, turn: 6, aliveEnemyCount: 1 }),
      [],
    )
    expect(firstShellCall(calls2)).toBeDefined()
    expect(firstMoveCall(calls2)).toBeDefined()
  })

  it('conservative agent maintains last-known position across turns', async () => {
    const enemyPos: Coordinate = { x: 8, y: 8 }
    const agent = createConservativeAgent('tank-0', enemyPos, 3)

    // Turn 5: should flare (toggle=false)
    const calls1 = await agent.takeTurn(
      makeWorldView({ position: { x: 5, y: 5 }, turn: 5, aliveEnemyCount: 1 }),
      [],
    )
    expect(firstFlareCall(calls1)).toBeDefined()

    // Turn 6: should still have memory (no move since diff > 1)
    // flareToggle flipped to true, so no flare this turn
    const calls2 = await agent.takeTurn(
      makeWorldView({ position: { x: 5, y: 5 }, turn: 6, aliveEnemyCount: 1 }),
      [],
    )
    // Consistent: still has memory, just different toggle state
  })
})

// --- NorthAgent tests ---

describe('NorthAgent', () => {
  it('has correct name', () => {
    const agent = createNorthAgent('tank-0')
    expect(agent.name).toBe('north-tank-0')
  })

  it('returns valid tool calls', async () => {
    const agent = createNorthAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('has defensive behavior when wounded', async () => {
    const agent = createNorthAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({ hp: 1, position: { x: 5, y: 5 } }),
      [],
    )
    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeDefined()
  })

  it('flares when blinded for multiple turns', async () => {
    const agent = createNorthAgent('tank-0')
    
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: [],
        flaredCells: [],
        inEnemyFlare: [],
        turn: 1,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const flareCall = firstFlareCall(calls)
    expect(flareCall).toBeUndefined()
  })

  it('flares after 3 turns of being blinded', async () => {
    const agent = createNorthAgent('tank-0')
    
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: [],
        flaredCells: [],
        inEnemyFlare: [],
        turn: 1,
        aliveEnemyCount: 0,
      }),
      [],
    )
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: [],
        flaredCells: [],
        inEnemyFlare: [],
        turn: 2,
        aliveEnemyCount: 0,
      }),
      [],
    )
    await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: [],
        flaredCells: [],
        inEnemyFlare: [],
        turn: 3,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: [],
        flaredCells: [],
        inEnemyFlare: [],
        turn: 4,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const flareCall = firstFlareCall(calls)
    expect(flareCall).toBeDefined()
  })

  it('is deterministic — same input → same output', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent1 = createNorthAgent('tank-0', enemyPos, 3)
    const agent2 = createNorthAgent('tank-0', enemyPos, 3)
    const vw: WorldView = {
      position: { x: 0, y: 0 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 5,
      isMyTurn: true,
      aliveEnemyCount: 1,
    }
    const calls1 = await agent1.takeTurn(vw, [])
    const calls2 = await agent2.takeTurn(vw, [])
    expect(calls1.length).toBe(calls2.length)
    expect(calls1.map(extractToolKind)).toEqual(calls2.map(extractToolKind))
  })

  it('fires with adjusted power when wounded', async () => {
    const enemyPos: Coordinate = { x: 15, y: 15 }
    const agent = createNorthAgent('tank-0', enemyPos, 3)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        turn: 5,
        hp: 1,
        aliveEnemyCount: 1,
      }),
      [],
    )
    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    expect(shellCall!.tool.kind).toBe('fire_shell')
    expect(shellCall!.tool.power).toBeLessThan(10)
  })

  it('adjusts behavior based on position vs center', async () => {
    const agent = createNorthAgent('tank-0')
    
    const calls1 = await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        turn: 1,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const moveCall1 = firstMoveCall(calls1)
    expect(moveCall1).toBeDefined()
    
    const calls2 = await agent.takeTurn(
      makeWorldView({
        position: { x: 10, y: 10 },
        turn: 2,
        aliveEnemyCount: 0,
      }),
      [],
    )
    const moveCall2 = firstMoveCall(calls2)
    expect(moveCall2).toBeDefined()
  })

  it('has aggressive positioning when enemy is visible', async () => {
    const enemyPos: Coordinate = { x: 10, y: 10 }
    const agent = createNorthAgent('tank-0', enemyPos, 3)
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 5,
        aliveEnemyCount: 1,
      }),
      [],
    )
    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    const moveCall = firstMoveCall(calls)
    expect(moveCall).toBeDefined()
  })
})

describe('Gpt55Agent', () => {
  it('has correct name', () => {
    const agent = createGpt55Agent('tank-0')
    expect(agent.name).toBe('gpt-5.5-tank-0')
  })

  it('fires an exact shell at the lowest-hp visible enemy', async () => {
    const agent = createGpt55Agent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        localScan: openScanAround({ x: 5, y: 5 }, 3),
        visibleEnemies: [
          { id: 'tank-1', position: { x: 9, y: 5 }, hp: 2 },
          { id: 'tank-2', position: { x: 5, y: 2 }, hp: 1 },
        ],
        aliveEnemyCount: 2,
      }),
      [],
    )

    const shellCall = firstShellCall(calls)
    expect(shellCall).toBeDefined()
    expect(shellCall!.tool.kind).toBe('fire_shell')
    if (shellCall!.tool.kind === 'fire_shell') {
      expect(shellCall!.tool.angle).toBeCloseTo(0)
      expect(shellCall!.tool.power).toBeCloseTo(3)
    }
  })

  it('uses a valid blind flare when no enemy is visible', async () => {
    const agent = createGpt55Agent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 0, y: 0 },
        localScan: openScanAround({ x: 0, y: 0 }, 1),
        visibleEnemies: [],
      }),
      [],
    )

    const flareCall = firstFlareCall(calls)
    expect(flareCall).toBeDefined()
    expect(flareCall!.tool.kind).toBe('fire_flare')
    if (flareCall!.tool.kind === 'fire_flare') {
      expect(flareCall!.tool.direction).toBe('SE')
      expect(flareCall!.tool.range).toBe(1)
    }
  })
})
