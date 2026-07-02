import { describe, it, expect } from 'vitest'
import { move } from '../src/resolution/movement.js'
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

function createTerrain(width: number, height: number, obstacles: Array<{ x: number; y: number }> = []): Cell[][] {
  const terrain: Cell[][] = []
  for (let y = 0; y < height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < width; x++) {
      const isObstacle = obstacles.some((o) => o.x === x && o.y === y)
      row.push({
        coord: { x, y },
        terrain: isObstacle ? 'obstacle' : 'open',
        obstacleHeight: isObstacle ? 10 : 0,
      })
    }
    terrain.push(row)
  }
  return terrain
}

function createState(
  tanks: TankState[],
  width = 10,
  height = 10,
  obstacles: Array<{ x: number; y: number }> = [],
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

const config = makeConfig({ moveMax: 5 })

describe('move — basic', () => {
  it('moves tank in cardinal direction', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState, result, moveCost } = move(state, config, 't1', 'N', 2, 5)
    expect(result.kind).toBe('ok')
    expect(moveCost).toBe(2)
    expect(newState.tanks[0].position).toEqual({ x: 5, y: 3 })
  })

  it('moves tank in diagonal direction', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState, result, moveCost } = move(state, config, 't1', 'NE', 3, 5)
    expect(result.kind).toBe('ok')
    expect(moveCost).toBe(3)
    expect(newState.tanks[0].position).toEqual({ x: 8, y: 2 })
  })

  it('updates facing direction', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState } = move(state, config, 't1', 'SE', 1, 5)
    expect(newState.tanks[0].facing).toBe(135)
  })

  it('returns ok with 0 cost for distance 0', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result, moveCost } = move(state, config, 't1', 'N', 0, 5)
    expect(result.kind).toBe('ok')
    expect(moveCost).toBe(0)
  })
})

describe('move — boundary', () => {
  it('blocks move out of bounds (north)', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = move(state, config, 't1', 'N', 1, 5)
    expect(result.kind).toBe('blocked')
  })

  it('blocks move out of bounds (east)', () => {
    const state = createState([{ id: 't1', position: { x: 9, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = move(state, config, 't1', 'E', 1, 5)
    expect(result.kind).toBe('blocked')
  })

  it('allows move to edge of map', () => {
    const state = createState([{ id: 't1', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = move(state, config, 't1', 'W', 9, 10)
    expect(result.kind).toBe('ok')
  })
})

describe('move — obstruction', () => {
  it('blocks move through obstacle', () => {
    const state = createState(
      [{ id: 't1', position: { x: 3, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }],
      10,
      10,
      [{ x: 4, y: 5 }],
    )
    const { result } = move(state, config, 't1', 'E', 2, 5)
    expect(result.kind).toBe('blocked')
  })

  it('allows move to cell before obstacle', () => {
    const state = createState(
      [{ id: 't1', position: { x: 3, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }],
      10,
      10,
      [{ x: 5, y: 5 }],
    )
    const { result, newState } = move(state, config, 't1', 'E', 1, 5)
    expect(result.kind).toBe('ok')
    expect(newState.tanks[0].position).toEqual({ x: 4, y: 5 })
  })
})

describe('move — occupied cell', () => {
  it('blocks move into another tank', () => {
    const state = createState([
      { id: 't1', position: { x: 3, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 4, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = move(state, config, 't1', 'E', 1, 5)
    expect(result.kind).toBe('blocked')
  })

  it('allows move past dead tank', () => {
    const state = createState([
      { id: 't1', position: { x: 3, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 4, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { result } = move(state, config, 't1', 'E', 1, 5)
    expect(result.kind).toBe('ok')
  })
})

describe('move — budget', () => {
  it('blocks when distance exceeds budget', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result } = move(state, config, 't1', 'N', 6, 5)
    expect(result.kind).toBe('blocked')
  })

  it('allows move equal to budget', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { result, moveCost } = move(state, config, 't1', 'N', 5, 5)
    expect(result.kind).toBe('ok')
    expect(moveCost).toBe(5)
  })
})

describe('move — double move', () => {
  it('two sequential moves update position correctly', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const { newState: s1 } = move(state, config, 't1', 'N', 2, 5)
    const { newState: s2, result } = move(s1, config, 't1', 'E', 3, 3)
    expect(result.kind).toBe('ok')
    expect(s2.tanks[0].position).toEqual({ x: 8, y: 3 })
  })
})

describe('move — immutability', () => {
  it('does not mutate input state', () => {
    const state = createState([{ id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 }])
    const originalPos = { ...state.tanks[0].position }
move(state, config, 't1', 'N', 2, 5)
    expect(state.tanks[0].position).toEqual(originalPos)
  })
})
