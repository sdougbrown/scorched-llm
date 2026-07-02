import { describe, it, expect } from 'vitest'
import { renderState, renderTurn, renderMatch } from '../src/cli/console-renderer.js'
import type { GameState, TankState, FlareState, Cell } from '../src/types/state.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { TurnEvent, ActionEvent } from '../src/types/events.js'
import type { MatchLog } from '../src/types/log.js'

// --- Helpers ---

function makeConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
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
    turnLimit: 20,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

function makeCell(x: number, y: number, terrain: 'open' | 'obstacle' = 'open'): Cell {
  return {
    coord: { x, y },
    terrain,
    obstacleHeight: terrain === 'obstacle' ? 10 : 0,
  }
}

function makeTankState(
  id: string,
  x: number,
  y: number,
  hp: number,
  maxHp: number,
  alive: boolean,
): TankState {
  return {
    id,
    position: { x, y },
    hp,
    maxHp,
    alive,
    facing: 0,
    damageDealt: 0,
    hitsLanded: 0,
  }
}

function makeSimpleTerrain(
  width: number,
  height: number,
  obstacles: Array<{ x: number; y: number }>,
): Cell[][] {
  const terrain: Cell[][] = []
  for (let y = 0; y < height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < width; x++) {
      const isObstacle = obstacles.some((o) => o.x === x && o.y === y)
      row.push(makeCell(x, y, isObstacle ? 'obstacle' : 'open'))
    }
    terrain.push(row)
  }
  return terrain
}

function fullTank(id: string, x: number, y: number): TankState {
  return makeTankState(id, x, y, 2, 2, true)
}

function fullEmptySnapshot(): GameState {
  return {
    turn: 1,
    currentPlayerIndex: 0,
    tanks: [],
    flares: [],
    terrain: [],
    rulesVersion: 'v1',
  }
}

function makeWorldView(overrides: Partial<import('../src/types/events.js').WorldView> = {}): import('../src/types/events.js').WorldView {
  return {
    position: { x: 0, y: 0 },
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

// --- renderState tests ---

describe('renderState', () => {
  it('produces a grid for known state', () => {
    const terrain = makeSimpleTerrain(5, 5, [{ x: 2, y: 2 }])
    const tanks: TankState[] = [
      fullTank('tank-0', 0, 0),
      fullTank('tank-1', 4, 4),
    ]
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks,
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('=== Turn 1 ===')
    expect(output).toContain('tank-0')
    expect(output).toContain('tank-1')
  })

  it('shows T for current player tank', () => {
    const terrain = makeSimpleTerrain(3, 3, [])
    const tanks: TankState[] = [
      fullTank('tank-0', 0, 0),
      fullTank('tank-1', 2, 2),
    ]
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks,
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('T')
  })

  it('shows # for obstacles', () => {
    const terrain = makeSimpleTerrain(3, 3, [{ x: 1, y: 1 }])
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks: [fullTank('tank-0', 0, 0)],
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('#')
  })

  it('shows * for flare center', () => {
    const terrain = makeSimpleTerrain(5, 5, [])
    const flares: FlareState[] = [
      {
        id: 'flare-1',
        targetCell: { x: 3, y: 3 },
        radius: 2,
        firerId: 'tank-0',
        activatedTurn: 1,
        expiryTurn: 5,
      },
    ]
    const state: GameState = {
      turn: 2,
      currentPlayerIndex: 0,
      tanks: [fullTank('tank-0', 0, 0)],
      flares,
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('*')
  })

  it('shows ? for hidden (fog of war) cells', () => {
    const terrain = makeSimpleTerrain(5, 5, [])
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks: [fullTank('tank-0', 0, 0)],
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('?')
  })

  it('includes tank status section', () => {
    const terrain = makeSimpleTerrain(3, 3, [])
    const tanks: TankState[] = [
      fullTank('tank-0', 0, 0),
      { ...fullTank('tank-1', 2, 2), hp: 1, alive: false },
    ]
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks,
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('--- Tanks ---')
    expect(output).toContain('HP=2/2')
    expect(output).toContain('HP=1/2')
  })

  it('includes legend', () => {
    const terrain = makeSimpleTerrain(3, 3, [])
    const state: GameState = {
      turn: 1,
      currentPlayerIndex: 0,
      tanks: [fullTank('tank-0', 0, 0)],
      flares: [],
      terrain,
      rulesVersion: 'v1',
    }
    const output = renderState(state, makeConfig())
    expect(output).toContain('--- Legend ---')
    expect(output).toContain('open terrain')
    expect(output).toContain('obstacle')
    expect(output).toContain('flare')
    expect(output).toContain('fog')
  })
})

// --- renderTurn tests ---

describe('renderTurn', () => {
  it('renders turn header', () => {
    const config = makeConfig()
    const turn: TurnEvent = {
      turn: 1,
      player: 'tank-0',
      actions: [],
      worldview: makeWorldView(),
    }
    const output = renderTurn(turn, config)
    expect(output).toContain('--- Turn 1')
    expect(output).toContain('tank-0')
  })

  it('renders pass action', () => {
    const config = makeConfig()
    const action: ActionEvent = {
      kind: 'pass',
      call: { id: 'pass-1', tool: { kind: 'pass' } },
      result: { kind: 'ok' },
      snapshot: fullEmptySnapshot(),
    }
    const turn: TurnEvent = {
      turn: 1,
      player: 'tank-0',
      actions: [action],
      worldview: makeWorldView(),
    }
    const output = renderTurn(turn, config)
    expect(output).toContain('→ Pass')
  })

  it('renders move action', () => {
    const config = makeConfig()
    const action: ActionEvent = {
      kind: 'move',
      call: { id: 'move-1', tool: { kind: 'move', direction: 'E', distance: 2 } },
      result: { kind: 'ok' },
      snapshot: fullEmptySnapshot(),
    }
    const turn: TurnEvent = {
      turn: 1,
      player: 'tank-0',
      actions: [action],
      worldview: makeWorldView(),
    }
    const output = renderTurn(turn, config)
    expect(output).toContain('→ Move E')
    expect(output).toContain('× 2')
  })

  it('renders shell hit', () => {
    const config = makeConfig()
    const action: ActionEvent = {
      kind: 'shell',
      call: { id: 'shell-1', tool: { kind: 'fire_shell', angle: 90, power: 5 } },
      result: { kind: 'hit', targetId: 'tank-1', damage: 1 },
      snapshot: fullEmptySnapshot(),
    }
    const turn: TurnEvent = {
      turn: 1,
      player: 'tank-0',
      actions: [action],
      worldview: makeWorldView(),
    }
    const output = renderTurn(turn, config)
    expect(output).toContain('→ Shell')
    expect(output).toContain('Hit')
    expect(output).toContain('damage')
  })

  it('renders flare action', () => {
    const config = makeConfig()
    const action: ActionEvent = {
      kind: 'flare',
      call: { id: 'flare-1', tool: { kind: 'fire_flare', direction: 'N', range: 5 } },
      result: { kind: 'revealed', cells: [{ coord: { x: 0, y: -1 }, terrain: 'open', obstacleHeight: 0 }] },
      snapshot: fullEmptySnapshot(),
    }
    const turn: TurnEvent = {
      turn: 1,
      player: 'tank-0',
      actions: [action],
      worldview: makeWorldView(),
    }
    const output = renderTurn(turn, config)
    expect(output).toContain('→ Flare')
  })
})

// --- renderMatch tests ---

describe('renderMatch', () => {
  it('produces one string per turn', () => {
    const config = makeConfig()
    const turns: TurnEvent[] = [
      {
        turn: 1,
        player: 'tank-0',
        actions: [{ kind: 'move', call: { id: 'm1', tool: { kind: 'move', direction: 'E', distance: 1 } }, result: { kind: 'ok' }, snapshot: fullEmptySnapshot() }],
        worldview: makeWorldView({ turn: 1 }),
      },
      {
        turn: 2,
        player: 'tank-1',
        actions: [{ kind: 'pass', call: { id: 'p1', tool: { kind: 'pass' } }, result: { kind: 'ok' }, snapshot: fullEmptySnapshot() }],
        worldview: makeWorldView({ turn: 2 }),
      },
    ]
    const log: MatchLog = {
      schemaVersion: 'v1',
      metadata: { matchId: 'test-match', createdAt: new Date().toISOString(), promptVersion: 'v1', adapterVersions: {} },
      config,
      initialState: {
        turn: 0, currentPlayerIndex: 0, tanks: [fullTank('tank-0', 0, 0), fullTank('tank-1', 10, 10)], flares: [], terrain: makeSimpleTerrain(20, 20, []), rulesVersion: 'v1',
      },
      turns,
      result: { terminationReason: 'turn-limit', placements: [] },
    }
    const output = renderMatch(log)
    const turnLines = output.filter((s) => s.includes('--- Turn'))
    expect(turnLines.length).toBe(2)
  })

  it('includes result footer', () => {
    const config = makeConfig()
    const log: MatchLog = {
      schemaVersion: 'v1',
      metadata: { matchId: 'test-match', createdAt: new Date().toISOString(), promptVersion: 'v1', adapterVersions: {} },
      config,
      initialState: fullEmptySnapshot(),
      turns: [],
      result: { terminationReason: 'turn-limit', placements: [] },
    }
    const output = renderMatch(log)
    const fullOutput = output.join('\n')
    expect(fullOutput).toContain('=== Result ===')
    expect(fullOutput).toContain('turn-limit')
  })

  it('includes match header', () => {
    const config = makeConfig()
    const log: MatchLog = {
      schemaVersion: 'v1',
      metadata: { matchId: 'abc-123', createdAt: new Date().toISOString(), promptVersion: 'v1', adapterVersions: {} },
      config,
      initialState: fullEmptySnapshot(),
      turns: [],
      result: { terminationReason: 'turn-limit', placements: [] },
    }
    const output = renderMatch(log)
    const fullOutput = output.join('\n')
    expect(fullOutput).toContain('Match: abc-123')
  })
})
