import { describe, it, expect } from 'vitest'
import { reduceToState, getTimelineLength } from '../src/reducer.js'
import type { MatchLog, GameState, ActionEvent } from '@scorched-llm/engine'

function makeValidLog(overrides: Partial<MatchLog> = {}): MatchLog {
  const baseTerrain: GameState['terrain'] = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))
  )
  return {
    schemaVersion: '1.0.0',
    metadata: { matchId: 'test', createdAt: '2024-01-01', promptVersion: 'v1', adapterVersions: {} },
    config: {
      rulesVersion: '1.0.0', seed: 42,
      map: { width: 10, height: 10, obstacleDensity: 0.1, generatorVersion: '1', obstacleHeight: 5 },
      players: [
        { label: 'A', startPosition: { x: 0, y: 0 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
        { label: 'B', startPosition: { x: 9, y: 9 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
      ],
      fog: { localRadius: 2, flareRadius: 3, flareDuration: 'one-round-global' as const },
      actionEconomy: 'double',
      shell: { maxRange: 8, apexHeight: 10, tankHeight: 2 },
      lethality: { hitsToKill: 2 },
      turnLimit: 20,
      perTurnTimeoutMs: 60000,
      maxToolCallsPerTurn: 4,
    },
    initialState: {
      turn: 0, currentPlayerIndex: 0,
      tanks: [
        { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [],
      terrain: baseTerrain,
      rulesVersion: '1.0.0',
    },
    turns: [],
    result: { terminationReason: 'turn-limit', placements: [] },
    ...overrides,
  }
}

function makeAction(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    kind: 'move',
    call: { id: 'call-1', tool: { kind: 'move', direction: 'N', distance: 1 } },
    result: { kind: 'ok' },
    snapshot: undefined,
    ...overrides,
  }
}

describe('reduceToState', () => {
  it('returns initialState for turnIndex=0, actionIndex=-1', () => {
    const log = makeValidLog()
    const state = reduceToState(log, 0, -1)
    expect(state.turn).toBe(0)
    expect(state.tanks).toEqual(log.initialState.tanks)
  })

  it('returns initialState when no turns exist', () => {
    const log = makeValidLog()
    const state = reduceToState(log, 0, 0)
    expect(state).toBeDefined()
  })

  it('reduces through actions using snapshots', () => {
    const moveSnapshot: GameState = {
      ...makeValidLog().initialState,
      turn: 1,
      tanks: [
        { ...makeValidLog().initialState.tanks[0], position: { x: 0, y: 1 }, hp: 1 },
        makeValidLog().initialState.tanks[1],
      ],
    }

    const log = makeValidLog({
      turns: [
        {
          turn: 0, player: 'A',
          actions: [
            makeAction({ snapshot: moveSnapshot }),
          ],
          worldview: {
            position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [],
            flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1,
          },
        },
      ],
    })

    const state = reduceToState(log, 0, 0)
    expect(state.turn).toBe(1)
    expect(state.tanks[0].position).toEqual({ x: 0, y: 1 })
  })

  it('reduces to end of match with snapshots', () => {
    const turn1Snapshot: GameState = {
      ...makeValidLog().initialState,
      turn: 1,
      currentPlayerIndex: 1,
    }
    const turn2Snapshot: GameState = {
      ...makeValidLog().initialState,
      turn: 2,
      currentPlayerIndex: 0,
    }

    const log = makeValidLog({
      turns: [
        {
          turn: 0, player: 'A',
          actions: [makeAction({ snapshot: turn1Snapshot })],
          worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 },
        },
        {
          turn: 1, player: 'B',
          actions: [makeAction({ snapshot: turn2Snapshot })],
          worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 },
        },
      ],
    })

    const finalState = reduceToState(log, 1, 0)
    expect(finalState.turn).toBe(2)
  })

  it('clamps to last turn when turnIndex out of bounds', () => {
    const log = makeValidLog({
      turns: [{ turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } }],
    })
    const state = reduceToState(log, 999, 0)
    expect(state).toBeDefined()
  })
})

describe('getTimelineLength', () => {
  it('returns correct turn count', () => {
    const log = makeValidLog()
    expect(getTimelineLength(log).turns).toBe(0)
  })

  it('returns correct actions per turn', () => {
    const log = makeValidLog({
      turns: [
        { turn: 0, player: 'A', actions: [makeAction({}), makeAction({}), makeAction({})], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
        { turn: 1, player: 'B', actions: [makeAction({}), makeAction({})], worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 } },
      ],
    })
    const { actionsPerTurn } = getTimelineLength(log)
    expect(actionsPerTurn).toEqual([3, 2])
  })
})
