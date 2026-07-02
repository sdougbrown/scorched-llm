import type { GameState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { Direction } from '../types/coords.js'
import type { ActionResult } from '../types/tool.js'
import { DIRECTION_DELTAS, inBounds } from '../geometry/coords.js'
import { ok, blocked } from '../action-result/index.js'

/**
 * Compute the facing angle in degrees from a compass direction.
 * 0 = North, 90 = East, 180 = South, 270 = West.
 */
function directionToBearing(dir: Direction): number {
  const bearings: Record<Direction, number> = {
    N: 0,
    NE: 45,
    E: 90,
    SE: 135,
    S: 180,
    SW: 225,
    W: 270,
    NW: 315,
  }
  return bearings[dir]
}

function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    tanks: state.tanks.map((t) => ({ ...t })),
    flares: state.flares.map((f) => ({ ...f, targetCell: { ...f.targetCell } })),
    terrain: state.terrain.map((row) =>
      row.map((cell) => ({ ...cell, coord: { ...cell.coord } })),
    ),
  }
}

export function move(
  state: GameState,
  config: MatchConfig,
  tankId: string,
  direction: Direction,
  distance: number,
  moveBudget: number,
): { newState: GameState; result: ActionResult; moveCost: number } {
  if (distance <= 0) {
    return { newState: state, result: ok(), moveCost: 0 }
  }

  if (distance > moveBudget) {
    return {
      newState: state,
      result: blocked('Insufficient movement budget'),
      moveCost: 0,
    }
  }

  const tank = state.tanks.find((t) => t.id === tankId)
  if (!tank || !tank.alive) {
    return {
      newState: state,
      result: blocked('Tank not found or not alive'),
      moveCost: 0,
    }
  }

  const delta = DIRECTION_DELTAS[direction]
  const width = state.terrain[0]?.length ?? 0
  const height = state.terrain.length

  // Validate each cell along the path
  for (let step = 1; step <= distance; step++) {
    const cx = tank.position.x + delta.dx * step
    const cy = tank.position.y + delta.dy * step

    if (!inBounds({ x: cx, y: cy }, width, height)) {
      return {
        newState: state,
        result: blocked('Move would go out of bounds'),
        moveCost: 0,
      }
    }

    const cell = state.terrain[cy][cx]
    if (cell.terrain === 'obstacle') {
      return {
        newState: state,
        result: blocked('Move blocked by obstacle'),
        moveCost: 0,
      }
    }

    const occupied = state.tanks.find(
      (t) => t.id !== tankId && t.alive && t.position.x === cx && t.position.y === cy,
    )
    if (occupied) {
      return {
        newState: state,
        result: blocked('Move blocked by another tank'),
        moveCost: 0,
      }
    }
  }

  // All cells valid — apply the move
  const newState = cloneGameState(state)
  const newTank = newState.tanks.find((t) => t.id === tankId)!
  newTank.position = {
    x: tank.position.x + delta.dx * distance,
    y: tank.position.y + delta.dy * distance,
  }
  newTank.facing = directionToBearing(direction)

  return {
    newState,
    result: ok(),
    moveCost: distance,
  }
}
