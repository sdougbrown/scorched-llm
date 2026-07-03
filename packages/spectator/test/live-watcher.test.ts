import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LiveWatcher } from '../src/live-watcher.js'
import type { MatchLog, TurnEvent } from '@scorched-llm/engine'

const POLL_INTERVAL = 1500

function makeValidLog(overrides: Partial<MatchLog> = {}): MatchLog {
  const baseTerrain = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))
  )
  return {
    schemaVersion: 'v1',
    metadata: { matchId: 'test', createdAt: '2024-01-01', promptVersion: 'v1', adapterVersions: {} },
    config: {
      rulesVersion: 'v1', seed: 42,
      map: { width: 10, height: 10, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 5 },
      players: [
        { label: 'A', startPosition: { x: 0, y: 0 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
        { label: 'B', startPosition: { x: 9, y: 9 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
      ],
      fog: { localRadius: 2, flareRadius: 3, flareDuration: 'one-round-global' as const },
      actionEconomy: 'double', shell: { maxRange: 8, apexHeight: 10, tankHeight: 2 },
      lethality: { hitsToKill: 2 }, turnLimit: 20, perTurnTimeoutMs: 60000, maxToolCallsPerTurn: 4,
    },
    initialState: {
      turn: 0, currentPlayerIndex: 0,
      tanks: [
        { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [], terrain: baseTerrain, rulesVersion: 'v1',
    },
    turns: [],
    result: { terminationReason: 'in-progress', placements: [] },
    ...overrides,
  }
}

describe('LiveWatcher — basic lifecycle', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let callCount: number

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    callCount = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts in disconnected state', () => {
    const watcher = new LiveWatcher('/api/match', vi.fn(), vi.fn())
    expect(watcher.status).toBe('disconnected')
    expect(watcher.isComplete).toBe(false)
  })

  it('status becomes connecting after start', () => {
    const watcher = new LiveWatcher('/api/match', vi.fn(), vi.fn())
    watcher.start()
    expect(watcher.status).toBe('connecting')
  })

  it('status becomes polling after first successful fetch', async () => {
    const log = makeValidLog({ turns: [{ turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } }] })
    fetchMock.mockImplementation(async () => {
      callCount++
      // First fetch returns 0 turns (simulates initial connection), subsequent return full log
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(log)) }
    })

    const watcher = new LiveWatcher('/api/match', vi.fn(), vi.fn())
    watcher.start()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    expect(watcher.status).toBe('polling')
  })

  it('stop resets to disconnected', async () => {
    const log = makeValidLog({ turns: [{ turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } }] })
    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(log)) }
    })

    const watcher = new LiveWatcher('/api/match', vi.fn(), vi.fn())
    watcher.start()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    expect(watcher.status).toBe('polling')

    watcher.stop()
    expect(watcher.status).toBe('disconnected')
  })
})

describe('LiveWatcher — polling behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let callCount: number

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    callCount = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('renders the initial state before any turns complete', async () => {
    const onUpdate = vi.fn()
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify(makeValidLog())),
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, vi.fn())
    watcher.start()

    await vi.advanceTimersByTimeAsync(0)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onUpdate.mock.calls[0][0].turns).toHaveLength(0)
  })

  it('publishes thinking-state changes without a completed turn', async () => {
    const onUpdate = vi.fn()
    const waiting = makeValidLog()
    const thinking = makeValidLog({
      liveState: { status: 'thinking', turn: 1, player: 'A' },
    })
    fetchMock
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(JSON.stringify(waiting)) })
      .mockResolvedValue({ ok: true, text: () => Promise.resolve(JSON.stringify(thinking)) })

    const watcher = new LiveWatcher('/api/match', onUpdate, vi.fn())
    watcher.start()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)

    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onUpdate.mock.calls[1][0].liveState?.player).toBe('A')
  })

  it('does not call onUpdate again when turns are unchanged', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    const log2turns = makeValidLog({ turns: [
      { turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      { turn: 1, player: 'B', actions: [], worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 } },
    ]})

    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(log2turns)) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(watcher.isComplete).toBe(false)
  })

  it('stops polling after onComplete', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    const logLastStanding = makeValidLog({ result: { terminationReason: 'last-standing', placements: [] } })

    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(logLastStanding)) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    // Advance past initial poll then completion poll
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)

    expect(onComplete).toHaveBeenCalled()
    expect(watcher.isComplete).toBe(true)
    expect(watcher.status).toBe('complete')
  })

  it('continues polling across terminal matches in a live batch', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()
    const firstMatch = makeValidLog({
      metadata: { matchId: '1', createdAt: '2024-01-01', promptVersion: 'v1', adapterVersions: {} },
      result: { terminationReason: 'last-standing', placements: [] },
      liveBatchState: { currentMatch: 1, totalMatches: 2, status: 'running' },
    })
    const secondMatch = makeValidLog({
      metadata: { matchId: '2', createdAt: '2024-01-01', promptVersion: 'v1', adapterVersions: {} },
      result: { terminationReason: 'turn-limit', placements: [] },
      liveBatchState: { currentMatch: 2, totalMatches: 2, status: 'running' },
    })

    fetchMock
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(JSON.stringify(firstMatch)) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(JSON.stringify(secondMatch)) })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)

    expect(onUpdate).toHaveBeenCalledTimes(2)
    expect(onUpdate.mock.calls[1][0].metadata.matchId).toBe('2')
    expect(onComplete).not.toHaveBeenCalled()
    expect(watcher.status).toBe('polling')
  })
})

describe('LiveWatcher — error handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let callCount: number

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    callCount = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries silently on fetch failure', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    fetchMock.mockRejectedValue(new Error('network error'))

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    // Advance past initial poll (fails) + retry (fails)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2)
    expect(watcher.status).toBe('connecting')
    expect(onUpdate).not.toHaveBeenCalled()
    expect(onComplete).not.toHaveBeenCalled()
  })

  it('recovers after successful fetch following errors', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    const log = makeValidLog({ turns: [
      { turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      { turn: 1, player: 'B', actions: [], worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 } },
    ]})

    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        throw new Error('network error')
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(log)) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    // First interval: fetch #1 fails, schedules retry (still connecting)
    await vi.advanceTimersByTimeAsync(0)
    expect(watcher.status).toBe('connecting')

    // Second interval: fetch #2 succeeds → status becomes polling
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    expect(watcher.status).toBe('polling')
  })
})

describe('LiveWatcher — completion detection', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let callCount: number

  beforeEach(() => {
    vi.useFakeTimers()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    callCount = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects completion via terminationReason', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    const logMutualDestruction = makeValidLog({ result: { terminationReason: 'mutual-destruction', placements: [] } })

    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(logMutualDestruction)) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    await vi.runOnlyPendingTimersAsync()

    expect(watcher.isComplete).toBe(true)
    expect(watcher.status).toBe('complete')
    expect(onComplete).toHaveBeenCalled()
  })

  it('does not complete when turns stop growing but match has not terminated', async () => {
    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    const log3turns = makeValidLog({ turns: [
      { turn: 0, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 0, isMyTurn: true, aliveEnemyCount: 1 } },
      { turn: 1, player: 'B', actions: [], worldview: { position: { x: 9, y: 9 }, hp: 2, facing: 180, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 1, isMyTurn: true, aliveEnemyCount: 1 } },
      { turn: 2, player: 'A', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: 2, isMyTurn: true, aliveEnemyCount: 1 } },
    ]})

    fetchMock.mockImplementation(async () => {
      callCount++
      if (callCount === 1) {
        return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog())) }
      }
      return { ok: true, text: () => Promise.resolve(JSON.stringify(log3turns)) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 4)

    expect(watcher.isComplete).toBe(false)
    expect(watcher.status).toBe('polling')
    expect(onComplete).not.toHaveBeenCalled()
  })
})

// Separate describe block for the cascade test to avoid timer pollution from other tests
describe('LiveWatcher — cascade polling', () => {
  it('calls onUpdate when new turns arrive (cascade)', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const onUpdate = vi.fn()
    const onComplete = vi.fn()

    let idx = 0
    fetchMock.mockImplementation(async () => {
      const i = idx++
      const turns = [2, 4, 6, 8, 10][i] || 10
      const isLast = turns >= 10
      return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog({
        turns: Array(turns).fill(null).map((_, j) => ({
          turn: j, player: j % 2 === 0 ? 'A' : 'B', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: j, isMyTurn: j % 2 === 0, aliveEnemyCount: 1 } } as TurnEvent)
        ),
        result: isLast ? { terminationReason: 'last-standing', placements: [{ tankId: 'A', rank: 1, hp: 2, damageDealt: 0, hitsLanded: 0 }] } : { terminationReason: 'turn-limit', placements: [] },
      }))) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 20)

    expect(onUpdate).toHaveBeenCalledTimes(3)
    expect(watcher.status).toBe('complete')
    expect(onComplete).toHaveBeenCalledTimes(1)

    vi.restoreAllMocks()
    vi.useRealTimers()
  })
})
