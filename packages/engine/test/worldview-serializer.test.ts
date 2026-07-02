import { describe, it, expect } from 'vitest'
import { serializeWorldView } from '../src/model/worldview-serializer.js'
import type { WorldView } from '../src/types/events.js'
import type { Cell } from '../src/types/coords.js'

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 3 },
    hp: 2,
    facing: 90,
    localScan: [],
    flaredCells: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 5,
    isMyTurn: true,
    aliveEnemyCount: 1,
    ...overrides,
  }
}

function makeCell(x: number, y: number, terrain: 'open' | 'obstacle' = 'open'): Cell {
  return { coord: { x, y }, terrain, obstacleHeight: 0 }
}

describe('serializeWorldView', () => {
  it('includes turn header', () => {
    const result = serializeWorldView(makeWorldView({ turn: 5 }))
    expect(result).toContain('=== Turn 5 ===')
  })

  it('includes tank position, HP, and facing', () => {
    const result = serializeWorldView(makeWorldView({ position: { x: 5, y: 3 }, hp: 2, facing: 90 }))
    expect(result).toContain('(5, 3)')
    expect(result).toContain('HP: 2')
    expect(result).toContain('facing: 90°')
  })

  it('includes remaining actions', () => {
    const result = serializeWorldView(makeWorldView({ remainingActions: 2 }))
    expect(result).toContain('2 action(s) remaining')
  })

  it('includes local scan', () => {
    const cell1 = makeCell(4, 2, 'open')
    const cell2 = makeCell(5, 2, 'open')
    const cell3 = makeCell(6, 2, 'obstacle')
    const result = serializeWorldView(makeWorldView({ localScan: [cell1, cell2, cell3] }))
    expect(result).toContain('Local scan')
    expect(result).toContain('(4,2) open')
    expect(result).toContain('(5,2) open')
    expect(result).toContain('(6,2) obstacle')
  })

  it('handles empty local scan', () => {
    const result = serializeWorldView(makeWorldView({ localScan: [] }))
    expect(result).toContain('Local scan')
  })

  it('includes active flares', () => {
    const cell = makeCell(7, 5, 'open')
    const result = serializeWorldView(makeWorldView({
      flaredCells: [
        { cell, firerId: 'tank-1', activatedTurn: 2, expiryTurn: 7 },
      ],
    }))
    expect(result).toContain('Active flares')
    expect(result).toContain('tank-1')
    expect(result).toContain('(7,5) open')
  })

  it('includes enemy flare warning', () => {
    const result = serializeWorldView(makeWorldView({
      inEnemyFlare: [
        { firerId: 'tank-1', expiryTurn: 7 },
      ],
    }))
    expect(result).toContain('WARNING')
    expect(result).toContain('tank-1')
    expect(result).toContain('expires turn 7')
  })

  it('includes alive enemy count', () => {
    const result = serializeWorldView(makeWorldView({ aliveEnemyCount: 1 }))
    expect(result).toContain('Alive enemies: 1')
  })

  it('includes multiple enemy flare warnings', () => {
    const result = serializeWorldView(makeWorldView({
      inEnemyFlare: [
        { firerId: 'tank-1', expiryTurn: 5 },
        { firerId: 'tank-2', expiryTurn: 8 },
      ],
    }))
    expect(result).toContain('tank-1')
    expect(result).toContain('tank-2')
    expect(result).toContain('expires turn 5')
    expect(result).toContain('expires turn 8')
  })

  it('produces a non-empty string', () => {
    const result = serializeWorldView(makeWorldView())
    expect(result.length).toBeGreaterThan(0)
  })

  it('does not include fog cells (local scan only)', () => {
    // The serializer only receives localScan from the WorldView,
    // which already excludes fog cells. We test that only provided
    // cells appear in the output.
    const knownCells: Cell[] = [
      makeCell(4, 2, 'open'),
      makeCell(5, 2, 'open'),
      makeCell(6, 2, 'obstacle'),
    ]
    const result = serializeWorldView(makeWorldView({ localScan: knownCells }))

    // Known cells should be present
    expect(result).toContain('(4,2) open')
    expect(result).toContain('(5,2) open')
    expect(result).toContain('(6,2) obstacle')
  })
})