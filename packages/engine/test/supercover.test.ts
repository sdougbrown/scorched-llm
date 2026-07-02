import { describe, it, expect } from 'vitest'
import { supercover } from '../src/geometry/supercover.js'

describe('supercover', () => {
  it('returns single cell when start equals end', () => {
    expect(supercover({ x: 2, y: 2 }, { x: 2, y: 2 })).toEqual([{ x: 2, y: 2 }])
  })

  it('horizontal line (0,0) → (5,0) in traversal order', () => {
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

  it('vertical line (0,0) → (0,3) in traversal order', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 0, y: 3 })
    expect(cells).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: 2 },
      { x: 0, y: 3 },
    ])
  })

  it('diagonal line (0,0) → (3,3) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 3, y: 3 })
    expect(cells.length).toBe(10)
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 3, y: 3 })
    expect(cells).toContainEqual({ x: 1, y: 1 })
    expect(cells).toContainEqual({ x: 2, y: 2 })
  })

  it('near-miss line (0,0) → (3,2) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 3, y: 2 })
    expect(cells.length).toBe(6)
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 3, y: 2 })
  })

  it('45-degree line (0,0) → (4,4) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 4, y: 4 })
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 4, y: 4 })
    expect(cells.length).toBe(13)
  })

  it('shallow slope (0,0) → (4,1) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 4, y: 1 })
    expect(cells.length).toBe(6)
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 4, y: 1 })
  })

  it('reverse direction (5,3) → (0,0) starts and ends at the reversed endpoints', () => {
    const reverse = supercover({ x: 5, y: 3 }, { x: 0, y: 0 })
    expect(reverse[0]).toEqual({ x: 5, y: 3 })
    expect(reverse[reverse.length - 1]).toEqual({ x: 0, y: 0 })
    const forward = supercover({ x: 0, y: 0 }, { x: 5, y: 3 })
    expect(reverse.length).toBe(forward.length)
    for (const cell of forward) {
      expect(reverse).toContainEqual(cell)
    }
  })

  it('steeper slope (0,0) → (2,5) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 2, y: 5 })
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 2, y: 5 })
  })

  it('negative coordinates (−2,−2) → (2,2) starts and ends correctly', () => {
    const cells = supercover({ x: -2, y: -2 }, { x: 2, y: 2 })
    expect(cells[0]).toEqual({ x: -2, y: -2 })
    expect(cells[cells.length - 1]).toEqual({ x: 2, y: 2 })
    expect(cells).toContainEqual({ x: 0, y: 0 })
  })

  it('adjacent cells (0,0) → (1,0) in order', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 1, y: 0 })
    expect(cells).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  })

  it('adjacent diagonal (0,0) → (1,1) starts and ends correctly', () => {
    const cells = supercover({ x: 0, y: 0 }, { x: 1, y: 1 })
    expect(cells.length).toBe(4)
    expect(cells[0]).toEqual({ x: 0, y: 0 })
    expect(cells[cells.length - 1]).toEqual({ x: 1, y: 1 })
    expect(cells).toContainEqual({ x: 0, y: 1 })
    expect(cells).toContainEqual({ x: 1, y: 0 })
  })
})