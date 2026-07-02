import { describe, it, expect } from 'vitest'
import { fireFlare, expireFlares } from '../src/resolution/flare.js'
import type { GameState, TankState } from '../src/types/state.js'
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

function createState(tanks: TankState[], turn = 1, width = 10, height = 10): GameState {
  return {
    turn,
    currentPlayerIndex: 0,
    tanks,
    flares: [],
    terrain: createTerrain(width, height),
    rulesVersion: 'v1',
  }
}

const config = makeConfig({})

describe('fireFlare — activation', () => {
  it('creates a flare at the correct target cell', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState, result } = fireFlare(state, config, 't1', 'N', 3)
    expect(result.kind).toBe('revealed')
    expect(newState.flares.length).toBe(1)
    expect(newState.flares[0].targetCell).toEqual({ x: 5, y: 2 })
  })

  it('sets flare radius from config', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState } = fireFlare(state, config, 't1', 'N', 3)
    expect(newState.flares[0].radius).toBe(2)
  })

  it('sets expiryTurn correctly', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }], 5)
    const { newState } = fireFlare(state, config, 't1', 'N', 3)
    expect(newState.flares[0].activatedTurn).toBe(5)
    expect(newState.flares[0].expiryTurn).toBe(25)
  })

  it('returns revealed cells within flare radius', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = fireFlare(state, config, 't1', 'N', 3)
    expect(result.kind).toBe('revealed')
    // radius 2 → 13 cells (center + 8 ring 1 + 4 ring 2)
    expect(result.cells.length).toBe(13)
  })

  it('blocks when target is out of bounds', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = fireFlare(state, config, 't1', 'N', 10)
    expect(result.kind).toBe('blocked')
  })

  it('blocks when firer is dead', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = fireFlare(state, config, 't1', 'N', 3)
    expect(result.kind).toBe('blocked')
  })
})

describe('fireFlare — multiple flares', () => {
  it('accumulates flares on the state', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState: s1 } = fireFlare(state, config, 't1', 'N', 2)
    const { newState: s2 } = fireFlare(s1, config, 't1', 'E', 2)
    expect(s2.flares.length).toBe(2)
  })
})

describe('expireFlares', () => {
  it('removes expired flares', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    state.flares = [
      { id: 'f1', targetCell: { x: 5, y: 3 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 10 },
      { id: 'f2', targetCell: { x: 7, y: 5 }, radius: 2, firerId: 't1', activatedTurn: 5, expiryTurn: 25 },
    ]
    const newState = expireFlares(state, 10)
    expect(newState.flares.length).toBe(1)
    expect(newState.flares[0].id).toBe('f2')
  })

  it('keeps flares that have not expired', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    state.flares = [
      { id: 'f1', targetCell: { x: 5, y: 3 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 10 },
    ]
    const newState = expireFlares(state, 9)
    expect(newState.flares.length).toBe(1)
  })

  it('removes all flares when all expired', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    state.flares = [
      { id: 'f1', targetCell: { x: 5, y: 3 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 5 },
      { id: 'f2', targetCell: { x: 7, y: 5 }, radius: 2, firerId: 't1', activatedTurn: 3, expiryTurn: 8 },
    ]
    const newState = expireFlares(state, 10)
    expect(newState.flares.length).toBe(0)
  })

  it('removes flare even if firer is dead', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    state.flares = [
      { id: 'f1', targetCell: { x: 5, y: 3 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 5 },
    ]
    const newState = expireFlares(state, 6)
    expect(newState.flares.length).toBe(0)
  })

  it('returns unchanged state when no flares expire', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    state.flares = [
      { id: 'f1', targetCell: { x: 5, y: 3 }, radius: 2, firerId: 't1', activatedTurn: 1, expiryTurn: 10 },
    ]
    const newState = expireFlares(state, 5)
    expect(newState).toBe(state)
  })
})

describe('fireFlare — immutability', () => {
  it('does not mutate input state', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const originalFlareCount = state.flares.length
    fireFlare(state, config, 't1', 'N', 3)
    expect(state.flares.length).toBe(originalFlareCount)
  })
})
