import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LiveWatcher } from '../src/live-watcher.js'
import type { MatchLog } from '@scorched-llm/engine'

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

  it('does not call onUpdate when turns unchanged', async () => {
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

    // Advance through all intervals until completion (consecutiveNoChange reaches 2)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(watcher.isComplete).toBe(true)
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

  it('detects completion when turns stop growing (2 consecutive identical polls)', async () => {
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

    // Advance through all intervals until completion (3 polls with no change after initial)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 4)

    expect(watcher.isComplete).toBe(true)
    expect(watcher.status).toBe('complete')
    expect(onComplete).toHaveBeenCalled()
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
      return { ok: true, text: () => Promise.resolve(JSON.stringify(makeValidLog({ turns: Array(turns).fill(null).map((_, j) => ({
        turn: j, player: j % 2 === 0 ? 'A' : 'B', actions: [], worldview: { position: { x: 0, y: 0 }, hp: 2, facing: 0, localScan: [], flaredCells: [], inEnemyFlare: [], remainingActions: 2, turn: j, isMyTurn: j % 2 === 0, aliveEnemyCount: 1 } } as any)) }))) }
    })

    const watcher = new LiveWatcher('/api/match', onUpdate, onComplete)
    watcher.start()

    // Advance past initial poll (drains all pending timers including cascaded .then() schedules)
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 20)

    // Should have seen updates as turns grew across cascaded polls, then completion
    expect(onUpdate).toHaveBeenCalledTimes(5)
    expect(watcher.status).toBe('complete')
    expect(onComplete).toHaveBeenCalledTimes(1)

    vi.restoreAllMocks()
    vi.useRealTimers()
  })
})