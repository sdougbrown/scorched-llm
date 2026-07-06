import { describe, it, expect } from 'vitest'
import { computeMatchResult } from '../src/result/ranking.js'
import type { GameState, TankState } from '../src/types/state.js'
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

function createState(tanks: TankState[], turn = 10): GameState {
  return {
    turn,
    currentPlayerIndex: 0,
    tanks,
    flares: [],
    terrain: [],
    rulesVersion: 'v1',
  }
}

const config = makeConfig({ shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 } })

describe('computeMatchResult — last standing', () => {
  it('returns last-standing when one survivor', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 1, hitsLanded: 1 },
    ])
    const result = computeMatchResult(state, config, 10)
    expect(result.terminationReason).toBe('last-standing')
    expect(result.placements[0].tankId).toBe('t1')
    expect(result.placements[0].rank).toBe(1)
  })

  it('includes damageDealt and hitsLanded in placements', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 5, hitsLanded: 3 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 1, hitsLanded: 1 },
    ])
    const result = computeMatchResult(state, config, 10)
    expect(result.placements[0].damageDealt).toBe(5)
    expect(result.placements[0].hitsLanded).toBe(3)
  })
})

describe('computeMatchResult — turn limit with casualties', () => {
  it('ranks living tanks above dead ones at the turn limit', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 2, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 1, hitsLanded: 1 },
      { id: 't3', position: { x: 2, y: 2 }, hp: 2, maxHp: 2, alive: true, facing: 90, damageDealt: 0, hitsLanded: 0 },
    ])
    const result = computeMatchResult(state, config, config.turnLimit)
    expect(result.terminationReason).toBe('turn-limit')
    expect(result.placements.map((p) => p.tankId)).toEqual(['t3', 't2', 't1'])
    expect(result.placements[0].rank).toBe(1)
  })
})

describe('computeMatchResult — mutual destruction', () => {
  it('returns mutual-destruction when all dead', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 0, damageDealt: 2, hitsLanded: 1 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 2, hitsLanded: 1 },
    ])
    const result = computeMatchResult(state, config, 10)
    expect(result.terminationReason).toBe('mutual-destruction')
    expect(result.placements[0].tieGroup).toBe('draw')
    expect(result.placements[1].tieGroup).toBe('draw')
  })
})

describe('computeMatchResult — turn limit', () => {
  it('returns turn-limit when turn exceeds limit', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 2 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.terminationReason).toBe('turn-limit')
  })

  it('ranks by alive status first', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 5, hitsLanded: 3 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tankId).toBe('t1')
    expect(result.placements[0].rank).toBe(1)
    expect(result.placements[1].tankId).toBe('t2')
  })

  it('ranks by HP when both alive', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tankId).toBe('t1')
    expect(result.placements[1].tankId).toBe('t2')
  })

  it('ranks by damageDealt when HP tied', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 5, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 2 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tankId).toBe('t1')
    expect(result.placements[1].tankId).toBe('t2')
  })

  it('ranks by hitsLanded when HP and damage tied', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 3 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 1 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tankId).toBe('t1')
    expect(result.placements[1].tankId).toBe('t2')
  })
})

describe('computeMatchResult — ties', () => {
  it('assigns tieGroup when stats are equal', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 2 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tieGroup).toBeDefined()
    expect(result.placements[1].tieGroup).toBe(result.placements[0].tieGroup)
    expect(result.placements[0].rank).toBe(result.placements[1].rank)
  })

  it('does not assign tieGroup when no tie', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 2 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tieGroup).toBeUndefined()
    expect(result.placements[1].tieGroup).toBeUndefined()
  })

  it('handles three-way tie', () => {
    const state = createState([
      { id: 't1', position: { x: 5, y: 5 }, hp: 1, maxHp: 2, alive: true, facing: 0, damageDealt: 3, hitsLanded: 2 },
      { id: 't2', position: { x: 10, y: 10 }, hp: 1, maxHp: 2, alive: true, facing: 180, damageDealt: 3, hitsLanded: 2 },
      { id: 't3', position: { x: 15, y: 15 }, hp: 1, maxHp: 2, alive: true, facing: 90, damageDealt: 3, hitsLanded: 2 },
    ])
    const result = computeMatchResult(state, config, 20)
    expect(result.placements[0].tieGroup).toBe(result.placements[1].tieGroup)
    expect(result.placements[1].tieGroup).toBe(result.placements[2].tieGroup)
  })
})
