import { describe, it, expect } from 'vitest'
import { aggregateLogs } from '../src/cli/aggregate.js'
import type { MatchLog } from '../src/types/log.js'
import type { TurnEvent } from '../src/types/events.js'
import type { SeatAssignment } from '../src/cli/aggregate.js'
import type { GameState } from '../src/types/state.js'

const EMPTY_SNAPSHOT: GameState = {
  turn: 0,
  currentPlayerIndex: 0,
  tanks: [],
  flares: [],
  terrain: [],
  rulesVersion: '',
}

function buildMatchLog(overrides?: Partial<MatchLog>): MatchLog {
  return {
    schemaVersion: 'v1',
    metadata: {
      matchId: '1',
      createdAt: '2024-01-01T00:00:00.000Z',
      promptVersion: 'v1',
      adapterVersions: {},
    },
    config: {
      rulesVersion: 'v1',
      seed: 42,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'A', startPosition: { x: 0, y: 0 }, scripted: 'aggressive' as const },
        { label: 'B', startPosition: { x: 19, y: 19 }, scripted: 'conservative' as const },
      ],
      fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' as const },
      actionEconomy: 'double' as const,
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
      lethality: { hitsToKill: 2 },
      turnLimit: 50,
      perTurnTimeoutMs: 30000,
      maxToolCallsPerTurn: 3,
    },
    initialState: {
      turn: 0,
      currentPlayerIndex: 0,
      tanks: [
        { id: 'tank-0', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'tank-1', position: { x: 19, y: 19 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [],
      terrain: [],
      rulesVersion: 'v1',
    },
    turns: [],
    result: {
      terminationReason: 'last-standing' as const,
      placements: [
        { tankId: 'tank-0', rank: 1, hp: 2, damageDealt: 10, hitsLanded: 3 },
        { tankId: 'tank-1', rank: 2, hp: 0, damageDealt: 5, hitsLanded: 1 },
      ],
    },
    ...overrides,
  }
}

function buildTurn(overrides?: Partial<TurnEvent>): TurnEvent {
  return {
    turn: 1,
    player: 'tank-0',
    actions: [],
    worldview: {
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
    },
    ...overrides,
  }
}

describe('aggregateLogs', () => {
  it('aggregates basic stats for multiple matches', () => {
    const log1 = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      config: { seed: 100 },
      result: {
        terminationReason: 'last-standing',
        placements: [
          { tankId: 'tank-0', rank: 1, hp: 2, damageDealt: 10, hitsLanded: 3 },
          { tankId: 'tank-1', rank: 2, hp: 0, damageDealt: 5, hitsLanded: 1 },
        ],
      },
    })

    const log2 = buildMatchLog({
      metadata: { matchId: '2', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      config: { seed: 200 },
      result: {
        terminationReason: 'last-standing',
        placements: [
          { tankId: 'tank-0', rank: 2, hp: 0, damageDealt: 4, hitsLanded: 1 },
          { tankId: 'tank-1', rank: 1, hp: 2, damageDealt: 8, hitsLanded: 2 },
        ],
      },
    })

    const seat1: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const seat2: SeatAssignment = { matchId: 2, seatAssignment: { 0: 'B', 1: 'A' } }

    const summary = aggregateLogs([log1, log2], [seat1, seat2], 'duel')

    expect(summary.perPlayer['A']).toBeDefined()
    expect(summary.perPlayer['B']).toBeDefined()
    expect(summary.perPlayer['A'].matchCount).toBe(2)
    expect(summary.perPlayer['B'].matchCount).toBe(2)
    expect(summary.perPlayer['A'].winCount).toBe(2)
    expect(summary.perPlayer['B'].winCount).toBe(0)
    expect(summary.perPlayer['A'].placementDistribution[1]).toBe(2)
    expect(summary.perPlayer['A'].placementDistribution[2]).toBeUndefined()
    expect(summary.perPlayer['A'].totalDamageDealt).toBe(18)
    expect(summary.perPlayer['A'].totalHitsLanded).toBe(5)
    expect(summary.perPlayer['B'].totalDamageDealt).toBe(9)
    expect(summary.perPlayer['B'].totalHitsLanded).toBe(2)
  })

  it('counts invalid action calls', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      turns: [
        buildTurn({
          player: 'tank-0',
          actions: [
            { kind: 'invalid', call: { id: 'c1', tool: { kind: 'pass' } }, result: { kind: 'invalid', reason: 'test' }, snapshot: EMPTY_SNAPSHOT },
          ],
        }),
        buildTurn({
          player: 'tank-0',
          actions: [
            { kind: 'invalid', call: { id: 'c2', tool: { kind: 'pass' } }, result: { kind: 'invalid', reason: 'test' }, snapshot: EMPTY_SNAPSHOT },
            { kind: 'move', call: { id: 'c3', tool: { kind: 'move', direction: 0, distance: 1 } }, result: { kind: 'ok' }, snapshot: EMPTY_SNAPSHOT },
          ],
        }),
      ],
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const summary = aggregateLogs([log], [seat], 'duel')

    expect(summary.perPlayer['A'].totalInvalidCalls).toBe(2)
    expect(summary.perPlayer['B'].totalInvalidCalls).toBe(0)
  })

  it('accumulates modelTrace stats', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      turns: [
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            latencyMs: 200,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 200,
            tokensOut: 100,
            costUsd: 0.002,
            latencyMs: 300,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-1',
          modelTrace: {
            toolCalls: [],
            tokensIn: 150,
            tokensOut: 75,
            costUsd: 'unknown',
            latencyMs: 150,
            finishReason: 'stop',
          },
        }),
      ],
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const summary = aggregateLogs([log], [seat], 'duel')

    expect(summary.perPlayer['A'].totalTokensIn).toBe(300)
    expect(summary.perPlayer['A'].totalTokensOut).toBe(150)
    expect(summary.perPlayer['A'].totalKnownCostUsd).toBe(0.003)
    expect(summary.perPlayer['A'].avgLatencyMs).toBe(250)
    expect(summary.perPlayer['A'].medianLatencyMs).toBe(250)

    expect(summary.perPlayer['B'].totalTokensIn).toBe(150)
    expect(summary.perPlayer['B'].totalTokensOut).toBe(75)
    expect(summary.perPlayer['B'].totalKnownCostUsd).toBe(0)
    expect(summary.perPlayer['B'].unknownCostMatchCount).toBe(1)
    expect(summary.perPlayer['B'].avgLatencyMs).toBe(150)
    expect(summary.perPlayer['B'].medianLatencyMs).toBe(150)
  })

  it('handles missing modelTrace without errors', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      turns: [
        buildTurn({ player: 'tank-0' }),
        buildTurn({ player: 'tank-1' }),
      ],
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const summary = aggregateLogs([log], [seat], 'duel')

    expect(summary.perPlayer['A'].totalTokensIn).toBe(0)
    expect(summary.perPlayer['A'].totalTokensOut).toBe(0)
    expect(summary.perPlayer['A'].totalKnownCostUsd).toBe(0)
    expect(summary.perPlayer['A'].avgLatencyMs).toBe(0)
    expect(summary.perPlayer['A'].medianLatencyMs).toBe(0)
  })

  it('passes reconciliation on clean logs', () => {
    const log1 = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      config: { seed: 100 },
      result: {
        terminationReason: 'last-standing',
        placements: [
          { tankId: 'tank-0', rank: 1, hp: 2, damageDealt: 10, hitsLanded: 3 },
          { tankId: 'tank-1', rank: 2, hp: 0, damageDealt: 5, hitsLanded: 1 },
        ],
      },
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }

    expect(() => aggregateLogs([log1], [seat], 'duel')).not.toThrow()

    const summary = aggregateLogs([log1], [seat], 'duel')
    expect(summary.reconciliation.matchCountMatches).toBe(true)
    expect(summary.reconciliation.damageMatches).toBe(true)
    expect(summary.reconciliation.hitsMatches).toBe(true)
  })

  it('throws on reconciliation failure with tampered damage', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      result: {
        terminationReason: 'last-standing',
        placements: [
          { tankId: 'tank-0', rank: 1, hp: 2, damageDealt: 10, hitsLanded: 3 },
          { tankId: 'tank-1', rank: 2, hp: 0, damageDealt: 5, hitsLanded: 1 },
        ],
      },
    })

    const tamperedLog = {
      ...log,
      result: {
        ...log.result,
        placements: log.result.placements.map((p) => ({ ...p, damageDealt: p.damageDealt * 2 })),
      },
    }

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }

    const summary = aggregateLogs([tamperedLog], [seat], 'duel')
    expect(summary.reconciliation.damageMatches).toBe(true)

    const logWithExtraPlayer = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      result: {
        terminationReason: 'last-standing',
        placements: [
          { tankId: 'tank-0', rank: 1, hp: 2, damageDealt: 10, hitsLanded: 3 },
          { tankId: 'tank-1', rank: 2, hp: 0, damageDealt: 5, hitsLanded: 1 },
          { tankId: 'tank-2', rank: 3, hp: 0, damageDealt: 99, hitsLanded: 0 },
        ],
      },
    })

    expect(() => aggregateLogs([logWithExtraPlayer], [seat], 'duel')).toThrow(/Reconciliation failed/)
  })

  it('does not count rank 1 with tieGroup as a win', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      result: {
        terminationReason: 'mutual-destruction',
        placements: [
          { tankId: 'tank-0', rank: 1, hp: 1, damageDealt: 5, hitsLanded: 2, tieGroup: 'A' },
          { tankId: 'tank-1', rank: 1, hp: 1, damageDealt: 5, hitsLanded: 2, tieGroup: 'A' },
        ],
      },
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const summary = aggregateLogs([log], [seat], 'duel')

    expect(summary.perPlayer['A'].winCount).toBe(0)
    expect(summary.perPlayer['B'].winCount).toBe(0)
    expect(summary.perPlayer['A'].placementDistribution[1]).toBe(1)
    expect(summary.perPlayer['B'].placementDistribution[1]).toBe(1)
  })

  it('counts unique matches with unknown cost', () => {
    const log1 = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      config: { seed: 100 },
      turns: [
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 'unknown',
            latencyMs: 100,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 'unknown',
            latencyMs: 100,
            finishReason: 'stop',
          },
        }),
      ],
    })

    const log2 = buildMatchLog({
      metadata: { matchId: '2', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      config: { seed: 200 },
      turns: [
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 100,
            tokensOut: 50,
            costUsd: 0.001,
            latencyMs: 100,
            finishReason: 'stop',
          },
        }),
      ],
    })

    const seat1: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const seat2: SeatAssignment = { matchId: 2, seatAssignment: { 0: 'A', 1: 'B' } }

    const summary = aggregateLogs([log1, log2], [seat1, seat2], 'duel')
    expect(summary.perPlayer['A'].unknownCostMatchCount).toBe(1)
  })

  it('computes median latency correctly for even number of values', () => {
    const log = buildMatchLog({
      metadata: { matchId: '1', createdAt: '2024-01-01T00:00:00.000Z', promptVersion: 'v1', adapterVersions: {} },
      turns: [
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 10,
            tokensOut: 10,
            costUsd: 0.001,
            latencyMs: 100,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 10,
            tokensOut: 10,
            costUsd: 0.001,
            latencyMs: 200,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 10,
            tokensOut: 10,
            costUsd: 0.001,
            latencyMs: 300,
            finishReason: 'stop',
          },
        }),
        buildTurn({
          player: 'tank-0',
          modelTrace: {
            toolCalls: [],
            tokensIn: 10,
            tokensOut: 10,
            costUsd: 0.001,
            latencyMs: 400,
            finishReason: 'stop',
          },
        }),
      ],
    })

    const seat: SeatAssignment = { matchId: 1, seatAssignment: { 0: 'A', 1: 'B' } }
    const summary = aggregateLogs([log], [seat], 'duel')

    expect(summary.perPlayer['A'].medianLatencyMs).toBe(250)
    expect(summary.perPlayer['A'].avgLatencyMs).toBe(250)
  })
})
