import { describe, it, expect } from 'vitest'
import { fireShell } from '../src/resolution/shell.js'
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

function createTerrain(
  width: number,
  height: number,
  obstacles: Array<{ x: number; y: number; height?: number }> = [],
): Cell[][] {
  const terrain: Cell[][] = []
  for (let y = 0; y < height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < width; x++) {
      const obs = obstacles.find((o) => o.x === x && o.y === y)
      row.push({
        coord: { x, y },
        terrain: obs ? 'obstacle' : 'open',
        obstacleHeight: obs ? (obs.height ?? 10) : 0,
      })
    }
    terrain.push(row)
  }
  return terrain
}

function createState(
  tanks: TankState[],
  width = 20,
  height = 20,
  obstacles: Array<{ x: number; y: number; height?: number }> = [],
): GameState {
  return {
    turn: 1,
    currentPlayerIndex: 0,
    tanks,
    flares: [],
    terrain: createTerrain(width, height, obstacles),
    rulesVersion: 'v1',
  }
}

const config = makeConfig({ shell: { maxRange: 15, apexHeight: 5, tankHeight: 1 } })

describe('fireShell — hit', () => {
  it('hits a tank in the line of fire', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 90, 5)
    expect(result.kind).toBe('hit')
    expect(result.targetId).toBe('t2')
  })

  it('returns damage of 1', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 90, 5)
    expect(result.damage).toBe(1)
  })

  it('hits tank at various angles', () => {
    // North (0°)
    const stateN = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result: rN } = fireShell(stateN, config, 't1', 0, 5)
    expect(rN.kind).toBe('hit')

    // South (180°)
    const stateS = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 15 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result: rS } = fireShell(stateS, config, 't1', 180, 5)
    expect(rS.kind).toBe('hit')

    // West (270°)
    const stateW = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 90, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result: rW } = fireShell(stateW, config, 't1', 270, 5)
    expect(rW.kind).toBe('hit')
  })
})

describe('fireShell — miss', () => {
  it('misses when no tank in trajectory', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 15, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 90, 3)
    expect(result.kind).toBe('miss')
  })

  it('misses when shell goes out of bounds', () => {
    const state = createState([
      { id: 't1', position: { x: 1, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 0, 12)
    expect(result.kind).toBe('miss')
  })
})

describe('fireShell — obstacle blocks', () => {
  it('blocks when obstacle is in path and tall enough', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 3, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      20,
      20,
      [{ x: 6, y: 10, height: 5 }],
    )
    const { result } = fireShell(state, config, 't1', 90, 7)
    expect(result.kind).toBe('blocked')
  })

  it('overflies obstacle when shell height is sufficient', () => {
    const state = createState(
      [
        { id: 't1', position: { x: 3, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      20,
      20,
      [{ x: 6, y: 10, height: 1 }],
    )
    const { result } = fireShell(state, config, 't1', 90, 7)
    expect(result.kind).toBe('hit')
  })
})

describe('fireShell — shooter excluded', () => {
  it('does not hit the shooter', () => {
    const state = createState([
      { id: 't1', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 90, 5)
    expect(result.kind).toBe('miss')
  })
})

describe('fireShell — trajectory', () => {
  it('returns sampled cells', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { trajectory } = fireShell(state, config, 't1', 90, 5)
    expect(trajectory.sampledCells.length).toBeGreaterThan(0)
  })

  it('returns impact point on hit', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { trajectory } = fireShell(state, config, 't1', 90, 5)
    expect(trajectory.impactPoint).toEqual({ x: 10, y: 10 })
  })
})

describe('fireShell — boundary', () => {
  it('blocks invalid power values', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result: rLow } = fireShell(state, config, 't1', 90, 0)
    expect(rLow.kind).toBe('blocked')
    const { result: rHigh } = fireShell(state, config, 't1', 90, 20)
    expect(rHigh.kind).toBe('blocked')
  })

  it('blocks when firer is dead', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = fireShell(state, config, 't1', 90, 5)
    expect(result.kind).toBe('blocked')
  })
})

describe('fireShell — immutability', () => {
  it('does not mutate input state', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const originalHp = state.tanks[1].hp
    fireShell(state, config, 't1', 90, 5)
    expect(state.tanks[1].hp).toBe(originalHp)
  })
})
