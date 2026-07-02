import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMatchLoader } from '../src/match-loader.js'
import { loadMatchLogFromFile } from '../src/log-loader.js'
import type { MatchLog } from '@scorched-llm/engine'

vi.mock('../src/log-loader.js', () => ({
  loadMatchLogFromFile: vi.fn(),
}))

function makeValidLog(overrides?: Partial<MatchLog>): MatchLog {
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

// jsdom doesn't provide DataTransfer or DragEvent natively
class MockDataTransfer {
  _files: File[] = []
  get items() {
    return {
      add: (f: File) => { this._files.push(f) },
      get length() { return this._files.length },
    }
  }
  get files(): FileList {
    return Object.assign(this._files, { length: this._files.length }) as unknown as FileList
  }
}

class MockDragEvent extends Event {
  dataTransfer: MockDataTransfer | null
  constructor(type: string, init?: { bubbles?: boolean; dataTransfer?: MockDataTransfer }) {
    super(type, init)
    this.dataTransfer = init?.dataTransfer ?? new MockDataTransfer()
  }
}

describe('createMatchLoader', () => {
  let onLoad: ReturnType<typeof vi.fn>
  let container: HTMLElement

  beforeEach(() => {
    vi.clearAllMocks()
    onLoad = vi.fn()
    container = createMatchLoader(onLoad)
  })

  it('creates element with correct class', () => {
    expect(container.className).toBe('match-loader')
  })

  it('has drop zone, file input, loading and error elements', () => {
    const dropZone = container.querySelector('.match-loader__drop-zone')
    const fileInput = container.querySelector('.match-loader__input')
    const loadingEl = container.querySelector('.match-loader__loading')
    const errorEl = container.querySelector('.match-loader__error')

    expect(dropZone).not.toBeNull()
    expect(fileInput).not.toBeNull()
    expect(loadingEl).not.toBeNull()
    expect(errorEl).not.toBeNull()
  })

  it('file picker button click opens file input', () => {
    const dropZone = container.querySelector('.match-loader__drop-zone')!
    const fileInput = container.querySelector<HTMLInputElement>('.match-loader__input')!

    const spy = vi.spyOn(fileInput, 'click')
    dropZone.click()

    expect(spy).toHaveBeenCalled()
  })

  it('file input change triggers load -> calls onLoad callback with parsed log', async () => {
    const log = makeValidLog()
    const mockFile = new File([JSON.stringify(log)], 'test.json', { type: 'application/json' })

    vi.mocked(loadMatchLogFromFile).mockResolvedValueOnce(log)

    const fileInput = container.querySelector<HTMLInputElement>('.match-loader__input')!
    Object.defineProperty(fileInput, 'files', { value: [mockFile], writable: false })

    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    // Wait for async handler to settle
    await vi.waitFor(() => {
      expect(onLoad).toHaveBeenCalled()
    }, { timeout: 5000 })
  })

  it('drag and drop triggers load -> calls onLoad callback', async () => {
    const log = makeValidLog()
    const mockFile = new File([JSON.stringify(log)], 'test.json', { type: 'application/json' })

    vi.mocked(loadMatchLogFromFile).mockResolvedValueOnce(log)

    const dropZone = container.querySelector('.match-loader__drop-zone')!

    // Simulate drag over to set state
    const dragOverEvent = new MockDragEvent('dragover', { bubbles: true })
    dropZone.dispatchEvent(dragOverEvent)
    expect(dropZone.classList.contains('drag-over')).toBe(true)

    // Simulate drop
    const dataTransfer = new MockDataTransfer()
    dataTransfer.items.add(mockFile)
    const dropEvent = new MockDragEvent('drop', { bubbles: true, dataTransfer })
    dropZone.dispatchEvent(dropEvent)

    expect(dropZone.classList.contains('drag-over')).toBe(false)

    await vi.waitFor(() => {
      expect(onLoad).toHaveBeenCalled()
    }, { timeout: 5000 })
  })

  it('loading state shows "Loading..." text', () => {
    const log = makeValidLog()
    const mockFile = new File([JSON.stringify(log)], 'test.json', { type: 'application/json' })

    let __resolvePromise: (val: MatchLog) => void
    const promise = new Promise<MatchLog>((r) => { __resolvePromise = r })
    vi.mocked(loadMatchLogFromFile).mockReturnValueOnce(promise)

    const fileInput = container.querySelector<HTMLInputElement>('.match-loader__input')!
    Object.defineProperty(fileInput, 'files', { value: [mockFile], writable: false })

    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    const loadingEl = container.querySelector('.match-loader__loading')!
    expect(loadingEl.textContent).toBe('Loading...')
    expect(loadingEl.hasAttribute('hidden')).toBe(false)
  })

  it('error state shows error message on invalid file', async () => {
    const log = makeValidLog()
    const mockFile = new File([JSON.stringify(log)], 'test.json', { type: 'application/json' })

    vi.mocked(loadMatchLogFromFile).mockRejectedValueOnce(new Error('Invalid match log'))

    const fileInput = container.querySelector<HTMLInputElement>('.match-loader__input')!
    Object.defineProperty(fileInput, 'files', { value: [mockFile], writable: false })

    fileInput.dispatchEvent(new Event('change', { bubbles: true }))

    // Wait for async handler to settle
    await vi.waitFor(() => {
      const errorEl = container.querySelector('.match-loader__error')!
      expect(errorEl.hasAttribute('hidden')).toBe(false)
      expect(errorEl.textContent).toContain('Error:')
    }, { timeout: 5000 })
  })
})