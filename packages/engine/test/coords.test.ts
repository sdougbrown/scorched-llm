import { describe, it, expect } from 'vitest'
import {
  manhattan,
  euclidean,
  chebyshev,
  cellsInRadius,
  DIRECTION_DELTAS,
  directionToDelta,
  inBounds,
} from '../src/geometry/coords.js'

describe('manhattan', () => {
  it('returns correct distance', () => {
    expect(manhattan({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(7)
    expect(manhattan({ x: 1, y: 2 }, { x: 1, y: 2 })).toBe(0)
    expect(manhattan({ x: 0, y: 0 }, { x: -3, y: 4 })).toBe(7)
  })
})

describe('euclidean', () => {
  it('returns correct distance', () => {
    expect(euclidean({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(euclidean({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0)
    expect(euclidean({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeCloseTo(1.41421356)
  })
})

describe('chebyshev', () => {
  it('returns correct distance', () => {
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(4)
    expect(chebyshev({ x: 0, y: 0 }, { x: 5, y: 2 })).toBe(5)
    expect(chebyshev({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0)
  })
})

describe('cellsInRadius', () => {
  it('returns center only for radius 0', () => {
    const cells = cellsInRadius({ x: 5, y: 5 }, 0)
    expect(cells).toEqual([{ x: 5, y: 5 }])
  })

  it('returns 13 cells for radius 2 centered at (3,3)', () => {
    const cells = cellsInRadius({ x: 3, y: 3 }, 2)
    expect(cells.length).toBe(13)
    expect(cells).toContainEqual({ x: 3, y: 3 })
    expect(cells).toContainEqual({ x: 1, y: 3 })
    expect(cells).toContainEqual({ x: 5, y: 3 })
    expect(cells).toContainEqual({ x: 3, y: 1 })
    expect(cells).toContainEqual({ x: 3, y: 5 })
    expect(cells).not.toContainEqual({ x: 1, y: 1 })
    expect(cells).not.toContainEqual({ x: 5, y: 5 })
  })

  it('returns 5 cells for radius 1', () => {
    const cells = cellsInRadius({ x: 0, y: 0 }, 1)
    expect(cells.length).toBe(5)
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 1, y: 0 })
    expect(cells).toContainEqual({ x: -1, y: 0 })
    expect(cells).toContainEqual({ x: 0, y: 1 })
    expect(cells).toContainEqual({ x: 0, y: -1 })
  })
})

describe('DIRECTION_DELTAS', () => {
  it('has all 8 directions', () => {
    expect(Object.keys(DIRECTION_DELTAS).length).toBe(8)
  })

  it('N moves up', () => {
    expect(DIRECTION_DELTAS['N']).toEqual({ dx: 0, dy: -1 })
  })

  it('S moves down', () => {
    expect(DIRECTION_DELTAS['S']).toEqual({ dx: 0, dy: 1 })
  })

  it('E moves right', () => {
    expect(DIRECTION_DELTAS['E']).toEqual({ dx: 1, dy: 0 })
  })

  it('W moves left', () => {
    expect(DIRECTION_DELTAS['W']).toEqual({ dx: -1, dy: 0 })
  })

  it('NE moves right and up', () => {
    expect(DIRECTION_DELTAS['NE']).toEqual({ dx: 1, dy: -1 })
  })

  it('SW moves left and down', () => {
    expect(DIRECTION_DELTAS['SW']).toEqual({ dx: -1, dy: 1 })
  })
})

describe('directionToDelta', () => {
  it('returns the same as DIRECTION_DELTAS lookup', () => {
    expect(directionToDelta('SE')).toEqual(DIRECTION_DELTAS['SE'])
    expect(directionToDelta('NW')).toEqual(DIRECTION_DELTAS['NW'])
  })
})

describe('inBounds', () => {
  it('returns true for valid coordinates', () => {
    expect(inBounds({ x: 0, y: 0 }, 10, 10)).toBe(true)
    expect(inBounds({ x: 9, y: 9 }, 10, 10)).toBe(true)
    expect(inBounds({ x: 5, y: 5 }, 10, 10)).toBe(true)
  })

  it('returns false for out-of-bounds coordinates', () => {
    expect(inBounds({ x: -1, y: 0 }, 10, 10)).toBe(false)
    expect(inBounds({ x: 10, y: 0 }, 10, 10)).toBe(false)
    expect(inBounds({ x: 0, y: -1 }, 10, 10)).toBe(false)
    expect(inBounds({ x: 0, y: 10 }, 10, 10)).toBe(false)
  })
})
