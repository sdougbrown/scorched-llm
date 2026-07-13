import { describe, it, expect } from 'vitest'
import { fireBomb, bombSplashRadius } from '../src/resolution/bomb.js'
import { runMatch } from '../src/match/orchestration.js'
import { fixtureCallAgent, alwaysPassAgent } from '../src/match/fake-agents.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { GameState, TankState } from '../src/types/state.js'

function makeConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
    players: [
      { label: 'p1', startPosition: { x: 5, y: 10 } },
      { label: 'p2', startPosition: { x: 12, y: 10 } },
      { label: 'p3', startPosition: { x: 13, y: 10 } },
    ],
    fog: { localRadius: 3, flareRadius: 3, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    moveMax: 3,
    bomb: { uses: 2, maxRange: 10 },
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 10,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 5,
    ...overrides,
  }
}

function makeTank(id: string, x: number, y: number, extra: Partial<TankState> = {}): TankState {
  return {
    id, position: { x, y }, hp: 2, maxHp: 2, alive: true, facing: 0,
    damageDealt: 0, hitsLanded: 0, bombsRemaining: 2, ...extra,
  }
}

function makeState(tanks: TankState[]): GameState {
  const terrain = Array.from({ length: 20 }, (_, y) =>
    Array.from({ length: 20 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 })))
  return { turn: 0, currentPlayerIndex: 0, tanks, flares: [], terrain, rulesVersion: 'v1' }
}

describe('fireBomb', () => {
  it('splash radius is half the flare radius', () => {
    expect(bombSplashRadius(makeConfig())).toBe(1.5)
    expect(bombSplashRadius(makeConfig({ fog: { localRadius: 3, flareRadius: 6, flareDuration: 'one-round-global' } }))).toBe(3)
  })

  it('damages every living tank in the splash, including clustered enemies', () => {
    const state = makeState([
      makeTank('tank-0', 5, 10),
      makeTank('tank-1', 12, 10),
      makeTank('tank-2', 13, 10),
    ])
    // Fire due east, power 7: impact stops at tank-1 (12,10); tank-2 at distance 1 is in the 1.5 splash
    const { result } = fireBomb(state, makeConfig(), 'tank-0', 90, 7)
    expect(result.kind).toBe('splash')
    if (result.kind !== 'splash') return
    expect(result.impact).toEqual({ x: 12, y: 10 })
    expect(result.casualties.map((c) => c.targetId).sort()).toEqual(['tank-1', 'tank-2'])
    expect(result.casualties.every((c) => c.damage === 1)).toBe(true)
  })

  it('splashes the firer when it fires at point-blank range', () => {
    const state = makeState([
      makeTank('tank-0', 5, 10),
      makeTank('tank-1', 6, 10),
      makeTank('tank-2', 15, 15),
    ])
    const { result } = fireBomb(state, makeConfig(), 'tank-0', 90, 1)
    expect(result.kind).toBe('splash')
    if (result.kind !== 'splash') return
    expect(result.casualties.map((c) => c.targetId).sort()).toEqual(['tank-0', 'tank-1'])
  })

  it('detonates on obstacles like a shell', () => {
    const state = makeState([makeTank('tank-0', 5, 10), makeTank('tank-1', 15, 10)])
    state.terrain[10][7] = { coord: { x: 7, y: 10 }, terrain: 'obstacle', obstacleHeight: 10 }
    const { result } = fireBomb(state, makeConfig(), 'tank-0', 90, 9)
    expect(result.kind).toBe('splash')
    if (result.kind !== 'splash') return
    expect(result.impact).toEqual({ x: 7, y: 10 })
    expect(result.casualties).toEqual([])
  })

  it('is blocked when bombs are not configured or power exceeds maxRange', () => {
    const state = makeState([makeTank('tank-0', 5, 10), makeTank('tank-1', 15, 10)])
    const noBomb = makeConfig()
    delete (noBomb as { bomb?: unknown }).bomb
    expect(fireBomb(state, noBomb, 'tank-0', 90, 3).result.kind).toBe('blocked')
    expect(fireBomb(state, makeConfig(), 'tank-0', 90, 11).result.kind).toBe('blocked')
  })
})

describe('bomb orchestration', () => {
  it('decrements bombsRemaining, applies splash damage, and rejects use when empty', async () => {
    const config = makeConfig({ bomb: { uses: 1, maxRange: 10 }, turnLimit: 4 })
    const bomber = fixtureCallAgent('bomber', [
      { id: 'b1', tool: { kind: 'fire_bomb', angle: 90, power: 7 } },
      { id: 'b2', tool: { kind: 'fire_bomb', angle: 90, power: 7 } },
    ])
    const { log } = await runMatch(config, [bomber, alwaysPassAgent('p2'), alwaysPassAgent('p3')])

    const bombActions = log.turns.flatMap((t) => t.actions).filter((a) => a.kind === 'bomb')
    expect(bombActions.length).toBe(1)
    expect(bombActions[0].result.kind).toBe('splash')
    const after = bombActions[0].snapshot.tanks.find((t) => t.id === 'tank-0')
    expect(after?.bombsRemaining).toBe(0)
    const victims = bombActions[0].snapshot.tanks.filter((t) => t.id !== 'tank-0')
    expect(victims.every((t) => t.hp === 1)).toBe(true)

    // Second bomb attempt must be recorded invalid (no bombs remaining)
    const invalidActions = log.turns.flatMap((t) => t.actions).filter((a) => a.kind === 'invalid')
    expect(invalidActions.length).toBeGreaterThanOrEqual(1)
  })

  it('bomb and shell are mutually exclusive in one turn', async () => {
    const config = makeConfig({ turnLimit: 2 })
    const agent = fixtureCallAgent('greedy', [
      { id: 'b1', tool: { kind: 'fire_bomb', angle: 90, power: 7 } },
      { id: 's1', tool: { kind: 'fire_shell', angle: 90, power: 7 } },
    ])
    const { log } = await runMatch(config, [agent, alwaysPassAgent('p2'), alwaysPassAgent('p3')])
    const turn0 = log.turns[0]
    expect(turn0.actions.some((a) => a.kind === 'bomb')).toBe(true)
    expect(turn0.actions.some((a) => a.kind === 'shell')).toBe(false)
  })
})
