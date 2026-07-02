import type { Coordinate } from '../types/coords.js'

/**
 * Supercover line traversal on an integer grid.
 *
 * Returns every cell whose interior is intersected by the line segment from
 * `start` to `end`, in traversal order — the order the line passes through
 * them, starting at `start` and ending at `end`. Includes cells the line
 * barely touches (supercover semantics, not Bresenham).
 *
 * Tie-breaking: when the line passes exactly through a grid vertex (corner
 * where four cells meet), all four corner cells are included. Cells that share
 * the same parametric position (e.g. the four vertex cells) are ordered by
 * scan order (y-major within the same x) as a deterministic secondary sort.
 *
 * Deterministic: same start/end → same cell list.
 */
export function supercover(start: Coordinate, end: Coordinate): Coordinate[] {
  if (start.x === end.x && start.y === end.y) {
    return [{ x: start.x, y: start.y }]
  }

  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)

  const dx = end.x - start.x
  const dy = end.y - start.y
  const lenSq = dx * dx + dy * dy

  const hits: Array<{ cell: Coordinate; t: number }> = []

  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      const t = lineIntersectsCell(start, end, cx, cy, lenSq)
      if (t !== null) {
        hits.push({ cell: { x: cx, y: cy }, t })
      }
    }
  }

  // Sort by parametric position along the line so cells are in traversal order.
  // Secondary sort by scan order (y, then x) for determinism at vertex ties.
  hits.sort((a, b) => {
    if (Math.abs(a.t - b.t) > 1e-12) return a.t - b.t
    if (a.cell.y !== b.cell.y) return a.cell.y - b.cell.y
    return a.cell.x - b.cell.x
  })

  return hits.map((h) => h.cell)
}

/**
 * Check if the line segment from `s` to `e` intersects the cell square
 * centered at `(cx, cy)`, which spans `[cx-0.5, cx+0.5] x [cy-0.5, cy+0.5]`.
 *
 * Uses the Liang-Barsky line clipping algorithm. Returns the parametric
 * position of the intersection midpoint along the line (0 = start, 1 = end),
 * or null if no intersection.
 */
function lineIntersectsCell(
  s: Coordinate,
  e: Coordinate,
  cx: number,
  cy: number,
  lenSq: number,
): number | null {
  const left = cx - 0.5
  const right = cx + 0.5
  const top = cy - 0.5
  const bottom = cy + 0.5

  let t0 = 0
  let t1 = 1
  const dx = e.x - s.x
  const dy = e.y - s.y

  const p: number[] = [-dx, dx, -dy, dy]
  const q: number[] = [
    s.x - left,
    right - s.x,
    s.y - top,
    bottom - s.y,
  ]

  for (let i = 0; i < 4; i++) {
    if (Math.abs(p[i]) < 1e-12) {
      if (q[i] < 0) return null
    } else {
      const r = q[i] / p[i]
      if (p[i] < 0) {
        t0 = Math.max(t0, r)
      } else {
        t1 = Math.min(t1, r)
      }
    }
    if (t0 > t1) return null
  }

  // Return the midpoint of the clipped segment as the parametric position.
  const tMid = (t0 + t1) / 2
  return lenSq === 0 ? 0 : tMid
}