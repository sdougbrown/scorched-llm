import { describe, it, expect } from 'vitest'
import { buildWorldView } from '../src/worldview/build.js'
import type { GameState, TankState, FlareState } from '../src/types/state.js'
import type { Cell } from '../src/types/coords.js'
import type { MatchConfig } from '../src/config/schema.js'

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
    turnLimit: 20,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

function createTerrain(width: number, height: number): Cell[][] {
  const terrain: Cell[][] = []
  for (let y = 0; y < height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < width; x++) {
      row.push({ coord: { x, y }, terrain: 'open', obstacleHeight: 0 })
    }
    terrain.push(row)
  }
  return terrain
}

function createState(
  tanks: TankState[],
  flares: FlareState[] = [],
  turn = 1,
  currentPlayerIndex = 0,
  width = 20,
  height = 20,
): GameState {
  return {
    turn,
    currentPlayerIndex,
    tanks,
    flares,
    terrain: createTerrain(width, height),
    rulesVersion: 'v1',
  }
}

const config = makeConfig({ shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 } })

describe('buildWorldView — basic', () => {
  it('returns tank position, hp, and facing', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 45, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.position).toEqual({ x: 10, y: 10 })
    expect(view.hp).toBe(3)
    expect(view.facing).toBe(45)
  })

  it('returns turn number and remaining actions', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.turn).toBe(1)
    expect(view.remainingActions).toBe(2)
  })

  it('returns isMyTurn true when it is the tank turn', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      [],
      1,
      0,
    )
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.isMyTurn).toBe(true)
  })

  it('returns isMyTurn false when it is not the tank turn', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      [],
      1,
      1,
    )
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.isMyTurn).toBe(false)
  })
})

describe('buildWorldView — local scan', () => {
  it('includes cells within local radius', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.localScan.length).toBeGreaterThan(0)
    // radius 3 → at least 1 cell (center)
    expect(view.localScan.some((c) => c.coord.x === 10 && c.coord.y === 10)).toBe(true)
  })

  it('excludes out-of-bounds cells from local scan', () => {
    const state = createState(
      [{ id: 't1', position: { x: 1, y: 1 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }],
      [],
      1,
      0,
      10,
      10,
    )
    const view = buildWorldView(state, config, 't1', 2)
    for (const cell of view.localScan) {
      expect(cell.coord.x).toBeGreaterThanOrEqual(0)
      expect(cell.coord.y).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('buildWorldView — flared cells', () => {
  it('includes cells revealed by active flares', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      [{ id: 'f1', targetCell: { x: 15, y: 15 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 20 }],
    )
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.flaredCells.length).toBeGreaterThan(0)
    const hasTarget = view.flaredCells.some((fc) => fc.cell.coord.x === 15 && fc.cell.coord.y === 15)
    expect(hasTarget).toBe(true)
  })

  it('includes flare metadata', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      ],
      [{ id: 'f1', targetCell: { x: 10, y: 10 }, radius: 2, firerId: 't1', activatedTurn: 5, expiryTurn: 25 }],
    )
    const view = buildWorldView(state, config, 't1', 2)
    const entry = view.flaredCells.find((fc) => fc.cell.coord.x === 10 && fc.cell.coord.y === 10)
    expect(entry).toBeDefined()
    expect(entry!.firerId).toBe('t1')
    expect(entry!.activatedTurn).toBe(5)
    expect(entry!.expiryTurn).toBe(25)
  })
})

describe('buildWorldView — in enemy flare', () => {
  it('detects when tank is in enemy flare', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      [{ id: 'f1', targetCell: { x: 10, y: 10 }, radius: 2, firerId: 't2', activatedTurn: 1, expiryTurn: 20 }],
    )
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.inEnemyFlare.length).toBe(1)
    expect(view.inEnemyFlare[0].firerId).toBe('t2')
  })

  it('does not detect own flare as enemy flare', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      [{ id: 'f1', targetCell: { x: 10, y: 10 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 20 }],
    )
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.inEnemyFlare.length).toBe(0)
  })

  it('returns empty when not in any enemy flare', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.inEnemyFlare.length).toBe(0)
  })
})

describe('buildWorldView — hidden enemies', () => {
  it('does not include enemy tank position unless flared', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    // The worldview does not include enemy positions directly
    expect(view).not.toHaveProperty('enemyPositions')
  })

  it('counts alive enemies correctly', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 15, y: 15 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      { id: 't3', position: { x: 5, y: 5 }, hp: 0, maxHp: 3, alive: false, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const view = buildWorldView(state, config, 't1', 2)
    expect(view.aliveEnemyCount).toBe(1)
  })
})
