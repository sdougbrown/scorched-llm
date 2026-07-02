import { describe, it, expect } from 'vitest'
import { createTimeline } from '../src/timeline.js'
import type { MatchLog, ActionEvent } from '@scorched-llm/engine'

function makeValidLog(overrides: Partial<MatchLog> = {}): MatchLog {
  const baseTerrain = Array.from({ length: 10 }, (_, y) =>
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

function makeAction(): ActionEvent {
  return {
    kind: 'move',
    call: { id: 'call-1', tool: { kind: 'move', direction: 'N', distance: 1 } },
    result: { kind: 'ok' },
    snapshot: undefined,
  }
}

describe('createTimeline', () => {
  it('position 0 is initial state', () => {
    const log = makeValidLog()
    const timeline = createTimeline(log)
    const pos = timeline.seek(0)
    expect(pos.turn).toBe(0)
    expect(pos.action).toBe(-1)
  })

  it('seek to end of timeline', () => {
    const log = makeValidLog({
      turns: [
        { turn: 0, player: 'A', actions: [makeAction(), makeAction()], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      ],
    })
    const timeline = createTimeline(log)
    // 1 initial + 2 actions = 3 positions (0, 1, 2)
    expect(timeline.length()).toBe(3)
    const endPos = timeline.seek(2)
    expect(endPos.turn).toBe(0)
    expect(endPos.action).toBe(1)
  })

  it('length calculation is correct', () => {
    const log = makeValidLog({
      turns: [
        { turn: 0, player: 'A', actions: [makeAction()], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
        { turn: 1, player: 'B', actions: [makeAction(), makeAction(), makeAction()], worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 } },
      ],
    })
    const timeline = createTimeline(log)
    // 1 initial + 1 + 3 = 5
    expect(timeline.length()).toBe(5)
  })

  it('seek clamps to valid range', () => {
    const log = makeValidLog()
    const timeline = createTimeline(log)
    const pos = timeline.seek(-5)
    expect(pos.turn).toBe(0)
    expect(pos.action).toBe(-1)
  })

  it('next advances position', () => {
    const log = makeValidLog({
      turns: [
        { turn: 0, player: 'A', actions: [makeAction(), makeAction()], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      ],
    })
    const timeline = createTimeline(log)
    let pos = timeline.seek(0)
    expect(pos.action).toBe(-1)

    pos = timeline.next()
    expect(pos.action).toBe(0)

    pos = timeline.next()
    expect(pos.action).toBe(1)

    pos = timeline.next()
    expect(pos.action).toBe(1) // wraps to last
  })

  it('prev goes backward', () => {
    const log = makeValidLog({
      turns: [
        { turn: 0, player: 'A', actions: [makeAction(), makeAction()], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      ],
    })
    const timeline = createTimeline(log)
    let pos = timeline.seek(2)
    expect(pos.action).toBe(1)

    pos = timeline.prev()
    expect(pos.action).toBe(0)

    pos = timeline.prev()
    expect(pos.action).toBe(-1)

    pos = timeline.prev()
    expect(pos.action).toBe(-1) // wraps to 0
  })

  it('empty log has length 1 (initial only)', () => {
    const log = makeValidLog()
    const timeline = createTimeline(log)
    expect(timeline.length()).toBe(1)
  })
})
