import type { Coordinate } from '../types/coords.js'

/**
 * Supercover line traversal on an integer grid.
 *
 * Returns every cell whose interior is intersected by the line segment from
 * `start` to `end`, in traversal order. Includes cells the line barely touches
 * (supercover semantics, not Bresenham).
 *
 * Tie-breaking: when the line passes exactly through a grid vertex (corner
 * where four cells meet), all four corner cells are included.
 *
 * Deterministic: same start/end → same cell list.
 */
export function supercover(start: Coordinate, end: Coordinate): Coordinate[] {
  const result: Coordinate[] = []

  if (start.x === end.x && start.y === end.y) {
    return [{ x: start.x, y: start.y }]
  }

  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)

  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      if (lineIntersectsCell(start, end, cx, cy)) {
        result.push({ x: cx, y: cy })
      }
    }
  }

  return result
}

/**
 * Check if the line segment from `s` to `e` intersects the cell square
 * centered at `(cx, cy)`, which spans `[cx-0.5, cx+0.5] x [cy-0.5, cy+0.5]`.
 *
 * Uses the Liang-Barsky line clipping algorithm.
 */
function lineIntersectsCell(s: Coordinate, e: Coordinate, cx: number, cy: number): boolean {
  const left = cx - 0.5
  const right = cx + 0.5
  const top = cy - 0.5
  const bottom = cy + 0.5

  let t0 = 0
  let t1 = 1
  const dx = e.x - s.x
  const dy = e.y - s.y

  // Liang-Barsky: parameters p[i] * t <= q[i]
  // p = [-dx, dx, -dy, dy]
  // q = [s.x - left, right - s.x, s.y - top, bottom - s.y]
  const p: number[] = [-dx, dx, -dy, dy]
  const q: number[] = [
    s.x - left,
    right - s.x,
    s.y - top,
    bottom - s.y,
  ]

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return false
    } else {
      const r = q[i] / p[i]
      if (p[i] < 0) {
        t0 = Math.max(t0, r)
      } else {
        t1 = Math.min(t1, r)
      }
    }
    if (t0 > t1) return false
  }

  return true
}
