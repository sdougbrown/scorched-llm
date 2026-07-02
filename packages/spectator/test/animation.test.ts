import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AnimationScheduler } from '../src/animation.js'
import type { Timeline, TimelinePosition } from '../src/timeline.js'
import type { ArenaRenderer } from '../src/arena.js'
import type { MatchConfig } from '@scorched-llm/engine'

function makeMockTimeline(): Timeline {
  return {
    seek: vi.fn((pos: number) => ({ turn: 0, action: pos, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '1.0.0' } })),
    next: vi.fn(() => ({ turn: 0, action: 0, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '1.0.0' } })),
    prev: vi.fn(() => ({ turn: 0, action: 0, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '1.0.0' } })),
    length: vi.fn(() => 5),
  }
}

function makeMockRenderer(): ArenaRenderer {
  return {
    canvas: {} as HTMLCanvasElement,
    ctx: {} as CanvasRenderingContext2D,
    render: vi.fn(),
    setSize: vi.fn(),
  }
}

function makeConfig(): MatchConfig {
  return {
    rulesVersion: '1.0.0',
    seed: 42,
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
  }
}

describe('AnimationScheduler', () => {
  let scheduler: AnimationScheduler
  let mockTimeline: Timeline
  let mockRenderer: ArenaRenderer
  let config: MatchConfig

  beforeEach(() => {
    vi.useFakeTimers()
    // Mock performance.now so the timing check passes on first call
    vi.spyOn(performance, 'now').mockReturnValue(1000)
    scheduler = new AnimationScheduler()
    mockTimeline = makeMockTimeline()
    mockRenderer = makeMockRenderer()
    config = makeConfig()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is not playing initially', () => {
    expect(scheduler.isPlaying).toBe(false)
  })

  it('play starts playing and calls render', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    expect(scheduler.isPlaying).toBe(true)
    expect(mockRenderer.render).toHaveBeenCalled()
  })

  it('pause stops playing', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    scheduler.pause()
    expect(scheduler.isPlaying).toBe(false)
  })

  it('resume continues playing', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    scheduler.pause()
    scheduler.resume()
    expect(scheduler.isPlaying).toBe(true)
  })

  it('stop resets everything', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    scheduler.stop()
    expect(scheduler.isPlaying).toBe(false)
  })

  it('setSpeed changes FPS', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    scheduler.setSpeed(60)
    expect(scheduler.isPlaying).toBe(true)
  })

  it('getCurrentPosition returns timeline position', () => {
    scheduler.play(mockTimeline, mockRenderer, config, 10)
    const pos = scheduler.getCurrentPosition()
    expect(pos).not.toBeNull()
  })

  it('getCurrentPosition returns null when stopped', () => {
    expect(scheduler.getCurrentPosition()).toBeNull()
  })
})
