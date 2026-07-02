import { describe, it, expect } from 'vitest'
import { applyDamage } from '../src/resolution/damage.js'
import type { GameState, TankState } from '../src/types/state.js'

function createState(tanks: TankState[]): GameState {
  return {
    turn: 1,
    currentPlayerIndex: 0,
    tanks,
    flares: [],
    terrain: [],
    rulesVersion: 'v1',
  }
}

describe('applyDamage — HP reduction', () => {
  it('reduces HP by damage amount', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 5, maxHp: 5, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState } = applyDamage(state, 't1', 'firer', 2)
    expect(newState.tanks[0].hp).toBe(3)
  })

  it('does not reduce below 0 (non-eliminating)', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState } = applyDamage(state, 't1', 'firer', 1)
    expect(newState.tanks[0].hp).toBe(0)
  })

  it('reduces HP of correct tank', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 5, maxHp: 5, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 3, maxHp: 3, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState } = applyDamage(state, 't2', 'firer', 1)
    expect(newState.tanks[0].hp).toBe(5)
    expect(newState.tanks[1].hp).toBe(2)
  })
})

describe('applyDamage — elimination', () => {
  it('eliminates tank when HP reaches 0', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState, eliminated } = applyDamage(state, 't1', 'firer', 1)
    expect(eliminated).toBe('t1')
    expect(newState.tanks[0].alive).toBe(false)
  })

  it('returns null when tank not eliminated', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 5, maxHp: 5, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { eliminated } = applyDamage(state, 't1', 'firer', 1)
    expect(eliminated).toBeNull()
  })

  it('does not re-eliminate already dead tank', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { eliminated } = applyDamage(state, 't1', 'firer', 1)
    expect(eliminated).toBeNull()
  })

  it('handles damage exceeding HP', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState, eliminated } = applyDamage(state, 't1', 'firer', 5)
    expect(eliminated).toBe('t1')
    expect(newState.tanks[0].hp).toBe(0)
  })
})

describe('applyDamage — firer stats', () => {
  it('increments firer hitsLanded and damageDealt', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 5, maxHp: 5, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 'firer', position: { x: 0, y: 0 }, hp: 5, maxHp: 5, alive: true, facing: 90, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState } = applyDamage(state, 't1', 'firer', 3)
    expect(newState.tanks[1].hitsLanded).toBe(1)
    expect(newState.tanks[1].damageDealt).toBe(3)
  })

  it('caps damageDealt at target HP (overkill)', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 'firer', position: { x: 0, y: 0 }, hp: 5, maxHp: 5, alive: true, facing: 90, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState } = applyDamage(state, 't1', 'firer', 10)
    expect(newState.tanks[1].damageDealt).toBe(2)
    expect(newState.tanks[1].hitsLanded).toBe(1)
  })
})

describe('applyDamage — unknown tank', () => {
  it('returns unchanged state for unknown tank', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const { newState, eliminated } = applyDamage(state, 'unknown', 'firer', 1)
    expect(newState.tanks[0].hp).toBe(2)
    expect(eliminated).toBeNull()
  })
})

describe('applyDamage — immutability', () => {
  it('does not mutate input state', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
    ])
    const originalHp = state.tanks[0].hp
    applyDamage(state, 't1', 'firer', 1)
    expect(state.tanks[0].hp).toBe(originalHp)
  })
})