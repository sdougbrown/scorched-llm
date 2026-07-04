import { describe, it, expect, beforeEach } from 'vitest'
import { createArenaRenderer } from '../src/arena.js'
import type { GameState, MatchConfig } from '@scorched-llm/engine'

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

function makeState(overrides: Partial<GameState> = {}): GameState {
  const baseTerrain = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))
  )
  return {
    turn: 0,
    currentPlayerIndex: 0,
    tanks: [
      { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
      { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
    ],
    flares: [],
    terrain: baseTerrain,
    rulesVersion: '1.0.0',
    ...overrides,
  }
}

function createMockCanvas(): HTMLCanvasElement & { _mockCtx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas') as HTMLCanvasElement & { _mockCtx: CanvasRenderingContext2D }
  canvas.width = 800
  canvas.height = 800
  // Create a mock context with all needed methods
  const mockCtx = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    fillText: vi.fn(),
    beginPath: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    quadraticCurveTo: vi.fn(),
    closePath: vi.fn(),
    setLineDash: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    scale: vi.fn(),
    rotate: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 0 }),
    getImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    putImageData: vi.fn(),
    createImageData: vi.fn().mockReturnValue({ data: new Uint8ClampedArray(4) }),
    drawImage: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    createLinearGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    createRadialGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
    createPattern: vi.fn().mockReturnValue(null),
    createConicGradient: vi.fn().mockReturnValue({ addColorStop: vi.fn() }),
  } as unknown as CanvasRenderingContext2D
  canvas.getContext = vi.fn().mockReturnValue(mockCtx)
  canvas._mockCtx = mockCtx
  return canvas
}

describe('createArenaRenderer', () => {
  let renderer: ReturnType<typeof createArenaRenderer>
  let canvas: HTMLCanvasElement & { _mockCtx: CanvasRenderingContext2D }
  let config: MatchConfig
  let state: GameState

  beforeEach(() => {
    canvas = createMockCanvas()
    renderer = createArenaRenderer(canvas)
    config = makeConfig()
    state = makeState()
  })

  it('renders without throwing', () => {
    expect(() => renderer.render(state, config)).not.toThrow()
  })

  it('renders with options', () => {
    expect(() => renderer.render(state, config, { showFog: false, showTrajectories: true, animate: false })).not.toThrow()
  })

  it('setSize updates canvas dimensions', () => {
    renderer.setSize(640, 480)
    expect(canvas.width).toBe(640)
    expect(canvas.height).toBe(480)
  })

  it('auto-scales cell size based on canvas dimensions', () => {
    renderer.setSize(400, 400)
    renderer.render(state, config)
    expect(canvas._mockCtx.clearRect).toHaveBeenCalled()
  })

  it('renders with fog dimming', () => {
    renderer.render(state, config, { showFog: true, showTrajectories: false, animate: false })
    expect(canvas._mockCtx.fillRect).toHaveBeenCalled()
  })

  it('renders with tanks in various states', () => {
    const tankState = makeState({
      tanks: [
        { id: 'A', position: { x: 5, y: 5 }, hp: 2, maxHp: 2, alive: true, facing: 90, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 5, y: 5 }, hp: 0, maxHp: 2, alive: false, facing: 270, damageDealt: 2, hitsLanded: 1 },
      ],
    })
    expect(() => renderer.render(tankState, config)).not.toThrow()
  })

  it('animates a tank transitioning from alive to destroyed', () => {
    renderer.render(state, config, { animate: true })
    const destroyedState = makeState({
      tanks: [
        state.tanks[0],
        { ...state.tanks[1], hp: 0, alive: false },
      ],
    })

    renderer.render(destroyedState, config, { animate: true })

    expect(canvas._mockCtx.save).toHaveBeenCalled()
    expect(canvas._mockCtx.fillText).toHaveBeenCalledWith(
      'B DESTROYED', expect.any(Number), expect.any(Number),
    )
  })

  it('shows a persistent wreck without animating when seeking directly', () => {
    const destroyedState = makeState({
      tanks: [
        state.tanks[0],
        { ...state.tanks[1], hp: 0, alive: false },
      ],
    })

    renderer.render(destroyedState, config, { animate: false })

    expect(canvas._mockCtx.fillText).toHaveBeenCalledWith(
      'B', expect.any(Number), expect.any(Number),
    )
    expect(canvas._mockCtx.save).not.toHaveBeenCalled()
  })

  it('renders with flares', () => {
    const flareState = makeState({
      flares: [
        { id: 'f1', targetCell: { x: 5, y: 5 }, radius: 3, firerId: 'A', activatedTurn: 0, expiryTurn: 5 },
      ],
    })
    expect(() => renderer.render(flareState, config)).not.toThrow()
  })

  it('renders with obstacles', () => {
    const obstacleState = makeState({
      terrain: Array.from({ length: 10 }, (_, y) =>
        Array.from({ length: 10 }, (_, x) => ({
          coord: { x, y },
          terrain: x === 5 && y === 5 ? 'obstacle' as const : 'open' as const,
          obstacleHeight: x === 5 && y === 5 ? 5 : 0,
        }))
      ),
    })
    expect(() => renderer.render(obstacleState, config)).not.toThrow()
  })

  it('ctx is accessible', () => {
    expect(renderer.ctx).toBeDefined()
  })
})
