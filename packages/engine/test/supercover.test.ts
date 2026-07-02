import { describe, it, expect } from 'vitest'
import { supercover } from '../src/geometry/supercover.js'

describe('supercover', () => {
  it('returns single cell when start equals end', () => {
    expect(supercover({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }])
  })

  it('horizontal line (0,0) → (5,0)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 5, y: 0 })
    expect(cells).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 0 },
    ])
  })

  it('vertical line (0,0) → (0,3)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 0, y: 3 })
    expect(cells).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ])
  })

  it('diagonal line (0,0) → (3,3) includes vertex cells', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 3, y: 3 })
    expect(cells.length).toBe(10)
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 3, y: 3 })
    expect(cells).toContainEqual({ x: 1, y: 1 })
    expect(cells).toContainEqual({ x: 2, y: 2 })
  })

  it('near-miss line (0,0) → (3,2)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 3, y: 2 })
    expect(cells.length).toBe(6)
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 3, y: 2 })
  })

  it('45-degree line (0,0) → (4,4)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 4, y: 4 })
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 4, y: 4 })
    expect(cells.length).toBe(13)
  })

  it('shallow slope (0,0) → (4,1)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 4, y: 1 })
    expect(cells.length).toBe(6)
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 4, y: 1 })
  })

  it('reverse direction (5,3) → (0,0) returns same cells as forward', () => {
    const forward = supercover({ x: 0, y: 0 }, { x: 5, y: 3 })
    const reverse = supercover({ x: 5, y: 3 }, { x: 0, y: 0 })
    expect(reverse.length).toBe(forward.length)
    for (const cell of forward) {
      expect(reverse).toContainEqual(cell)
    }
  })

  it('negative coordinates (−2,−2) → (2,2)', () => {
    const cells = supercover({ x: -2, y: -2 }, { x: 2, y: 2 })
    expect(cells).toContainEqual({ x: -2, y: -2 })
    expect(cells).toContainEqual({ x: 2, y: 2 })
    expect(cells).toContainEqual({ x: 0, y: 0 })
  })

  it('adjacent cells (0,0) → (1,0)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 1, y: 0 })
    expect(cells).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  })

  it('adjacent diagonal (0,0) → (1,1)', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 1, y: 1 })
    expect(cells.length).toBe(4)
    expect(cells).toContainEqual({ x: 0, y: 0 })
    expect(cells).toContainEqual({ x: 1, y: 1 })
    expect(cells).toContainEqual({ x: 0, y: 1 })
    expect(cells).toContainEqual({ x: 1, y: 0 })
  })
})
