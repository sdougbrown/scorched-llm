import type { Coordinate, Direction } from '../types/coords.js'

/** Manhattan distance between two coordinates. */
export function manhattan(a: Coordinate, b: Coordinate): number {
  return Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
}

/** Euclidean distance between two coordinates. */
export function euclidean(a: Coordinate, b: Coordinate): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** Chebyshev distance between two coordinates. */
export function chebyshev(a: Coordinate, b: Coordinate): number {
  return Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))
}

/** All cells within Euclidean `radius` of the center. */
export function cellsInRadius(center: Coordinate, radius: number): Coordinate[] {
  const cells: Coordinate[] = []
  const radiusSquared = radius * radius
  const span = Math.ceil(radius)
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      const cx = center.x + dx
      const cy = center.y + dy
      const distSq = dx * dx + dy * dy
      if (distSq <= radiusSquared) {
        cells.push({ x: cx, y: cy })
      }
    }
  }
  return cells
}

/** Delta vectors for each compass direction. */
export const DIRECTION_DELTAS: Record<Direction, { dx: number; dy: number }> = {
  N:  { dx:  0, dy: -1 },
  NE: { dx:  1, dy: -1 },
  E:  { dx:  1, dy:  0 },
  SE: { dx:  1, dy:  1 },
  S:  { dx:  0, dy:  1 },
  SW: { dx: -1, dy:  1 },
  W:  { dx: -1, dy:  0 },
  NW: { dx: -1, dy: -1 },
}

/** Get the (dx, dy) delta for a compass direction. */
export function directionToDelta(dir: Direction): { dx: number; dy: number } {
  return DIRECTION_DELTAS[dir]
}

/** Check whether a coordinate lies within the given grid bounds. */
export function inBounds(coord: Coordinate, width: number, height: number): boolean {
  return coord.x >= 0 && coord.x < width && coord.y >= 0 && coord.y < height
}
