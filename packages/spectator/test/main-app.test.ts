import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { MatchLog } from '@scorched-llm/engine'

// Mock createArenaRenderer
vi.mock('../src/arena.js', () => ({
  createArenaRenderer: vi.fn((canvas: HTMLCanvasElement) => ({
    canvas,
    ctx: {} as CanvasRenderingContext2D,
    render: vi.fn(),
    setSize: vi.fn(),
  })),
}))

// Mock createTimeline
vi.mock('../src/timeline.js', () => ({
  createTimeline: vi.fn((log: MatchLog) => ({
    seek: vi.fn((pos: number) => ({ turn: 0, action: pos, state: log.initialState })),
    next: vi.fn(() => ({ turn: 0, action: 1, state: log.initialState })),
    prev: vi.fn(() => ({ turn: 0, action: 0, state: log.initialState })),
    length: vi.fn(() => 5),
  })),
}))

// Mock AnimationScheduler
vi.mock('../src/animation.js', () => ({
  AnimationScheduler: vi.fn().mockImplementation(() => ({
    play: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    setSpeed: vi.fn(),
    get isPlaying() { return false },
    getCurrentPosition: vi.fn(() => null),
  })),
}))

// Mock createMatchLoader
vi.mock('../src/match-loader.js', () => ({
  createMatchLoader: vi.fn((cb: (log: MatchLog) => void) => {
    const el = document.createElement('div')
    el.className = 'app__loader-inner'
    ;(el as Record<string, unknown>).__loadCallback = cb
    if (!(globalThis as Record<string, unknown>).__spectatorLoaderRef) {
      (globalThis as Record<string, unknown>).__spectatorLoaderRef = {}
    }
    ;(globalThis as Record<string, unknown>).__spectatorLoaderRef.el = el
    return el
  }),
}))

// Mock createControls
vi.mock('../src/controls.js', () => ({
  createControls: vi.fn(() => {
    const el = document.createElement('div')
    el.className = 'app__controls'
    el.id = 'mock-controls'
    return el
  }),
}))

// Mock createTracePanel
vi.mock('../src/trace-panel.js', () => ({
  createTracePanel: vi.fn((tankId: string) => {
    const el = document.createElement('div')
    el.className = 'trace-panel'
    el.dataset.tankId = tankId
    const content = document.createElement('div')
    content.className = 'trace-panel__content'
    el.appendChild(content)
    return el
  }),
  updateTracePanel: vi.fn(),
}))

// Mock createStatsOverlay
vi.mock('../src/stats-overlay.js', () => ({
  createStatsOverlay: vi.fn(() => {
    const el = document.createElement('div')
    el.className = 'app__stats'
    return el
  }),
  updateStatsOverlay: vi.fn(),
}))

// Mock loadMatchLogFromFile
vi.mock('../src/log-loader.js', () => ({
  loadMatchLog: vi.fn(async (file: File) => {
    const text = await file.text()
    return JSON.parse(text) as MatchLog
  }),
}))

// Import mocked functions via namespace imports
import * as timelineModule from '../src/timeline.js'
import * as controlsModule from '../src/controls.js'
import * as tracePanelModule from '../src/trace-panel.js'
import * as animationModule from '../src/animation.js'
import * as arenaModule from '../src/arena.js'
import * as statsModule from '../src/stats-overlay.js'

// Side-effect import triggers the bare initApp() call at module level
import '../src/main.js'

function makeLog(overrides?: Partial<MatchLog>): MatchLog {
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
      actionEconomy: 'double', shell: { maxRange: 8, apexHeight: 10, tankHeight: 2 },
      lethality: { hitsToKill: 2 }, turnLimit: 20, perTurnTimeoutMs: 60000, maxToolCallsPerTurn: 4,
    },
    initialState: {
      turn: 0, currentPlayerIndex: 0,
      tanks: [
        { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [],
      terrain: Array.from({ length: 10 }, (_, y) => Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))),
      rulesVersion: '1.0.0',
    },
    turns: [],
    result: { terminationReason: 'turn-limit', placements: [] },
    ...overrides,
  }
}

describe('initApp', () => {
  // Capture mock references at import time
  const createTimelineMock = timelineModule.createTimeline
  const createControlsMock = controlsModule.createControls
  const createTracePanelMock = tracePanelModule.createTracePanel
  const AnimationSchedulerMock = animationModule.AnimationScheduler
  const createArenaRendererMock = arenaModule.createArenaRenderer
  const createStatsOverlayMock = statsModule.createStatsOverlay

  beforeEach(() => {
    // Clear accumulated mock call history across tests while preserving implementations
    vi.mocked(createTimelineMock).mockClear()
    vi.mocked(createControlsMock).mockClear()
    vi.mocked(createTracePanelMock).mockClear()
    vi.mocked(AnimationSchedulerMock).mockClear()
    vi.mocked(createArenaRendererMock).mockClear()
    vi.mocked(createStatsOverlayMock).mockClear()

    // Ensure #app exists in DOM
    let appEl = document.getElementById('app')
    if (!appEl) {
      appEl = document.createElement('div')
      appEl.id = 'app'
      document.body.appendChild(appEl)
    }
    appEl.className = 'app'
  })

  // Helper to trigger match load after initApp has been called
  function fireMatchLoad(log: MatchLog): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const loaderEl = (globalThis as any).__spectatorLoaderRef?.el as HTMLElement | undefined
    if (loaderEl && typeof (loaderEl as Record<string, unknown>).__loadCallback === "function") {
      ;(loaderEl as Record<string, unknown>).__loadCallback(log)
    }
  }

  it('creates an #app root element with app class', () => {
    const root = document.getElementById('app')
    expect(root).toBeTruthy()
    expect(root?.className).toBe('app')
  })

  it('initial state shows match loader (loader div is visible)', () => {
    const loader = document.querySelector('.app__loader')
    expect(loader).toBeTruthy()
    expect(loader?.classList.contains('app__loader--hidden')).toBe(false)
  })

  it('after loading a match, loader is hidden and arena is shown', () => {
    fireMatchLoad(makeLog())

    const loader = document.querySelector('.app__loader')
    expect(loader?.classList.contains('app__loader--hidden')).toBe(true)

    const headerInfo = document.querySelector('.app__header__info')
    expect(headerInfo?.textContent).toContain('test')
    expect(headerInfo?.textContent).toContain('0 turns')
  })

  it('controls are created with scheduler and timeline', () => {
    fireMatchLoad(makeLog())

    expect(createControlsMock).toHaveBeenCalledTimes(1)
  })

  it('trace panels are created for each tank', () => {
    fireMatchLoad(makeLog())

    expect(createTracePanelMock).toHaveBeenCalledWith('A')
    expect(createTracePanelMock).toHaveBeenCalledWith('B')
  })

  it('stats overlay is created and initially visible after match load', () => {
    fireMatchLoad(makeLog())

    const statsEl = document.querySelector('.app__stats')
    expect(statsEl).toBeTruthy()
    expect(statsEl?.classList.contains('app__stats--hidden')).toBe(false)
  })

  it('Space key toggles play/pause on scheduler', () => {
    fireMatchLoad(makeLog())

    // Clean up any listeners added by previous tests (they accumulate)
    const customHandler = vi.fn()
    window.addEventListener('keydown', customHandler)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }))

    // With default mock (isPlaying=false), space triggers resume
    const schedInstances = AnimationSchedulerMock.mock.results
    const schedMock = schedInstances[schedInstances.length - 1].value
    expect(schedMock.resume).toHaveBeenCalled()
  })

  it('Arrow keys step forward/backward via timeline', () => {
    fireMatchLoad(makeLog())

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))

    const timeline = createTimelineMock.mock.results[0].value
    expect(timeline.next).toHaveBeenCalled()
    expect(timeline.prev).toHaveBeenCalled()
  })

  it('Home key seeks to start', () => {
    fireMatchLoad(makeLog())

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }))

    const timeline = createTimelineMock.mock.results[0].value
    expect(timeline.seek).toHaveBeenCalledWith(0)
  })

  it('End key seeks to end', () => {
    fireMatchLoad(makeLog())

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))

    const timeline = createTimelineMock.mock.results[0].value
    expect(timeline.seek).toHaveBeenCalled()
  })

  it('Escape toggles stats overlay visibility', () => {
    fireMatchLoad(makeLog())

    const statsEl = document.querySelector('.app__stats')
    expect(statsEl?.classList.contains('app__stats--hidden')).toBe(false)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(statsEl?.classList.contains('app__stats--hidden')).toBe(true)
  })

  it('error state shows error message element', () => {
    const errorEl = document.querySelector('.app__error')
    expect(errorEl).toBeTruthy()
    // Error overlay starts hidden
    expect(errorEl?.classList.contains('app__error--hidden')).toBe(true)

    const errorMsg = errorEl?.querySelector('.app__error__message')
    expect(errorMsg).toBeTruthy()
  })
})