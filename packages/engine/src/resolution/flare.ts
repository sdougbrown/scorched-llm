import type { GameState, FlareState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { Direction, Coordinate } from '../types/coords.js'
import type { ActionResult } from '../types/tool.js'
import { DIRECTION_DELTAS, inBounds, cellsInRadius } from '../geometry/coords.js'
import { revealed, blocked } from '../action-result/index.js'

let flareCounter = 0

function cloneGameState(state: GameState): GameState {
  return {
    ...state,
    tanks: state.tanks.map((t) => ({ ...t, position: { ...t.position } })),
    flares: state.flares.map((f) => ({ ...f, targetCell: { ...f.targetCell } })),
    terrain: state.terrain.map((row) =>
      row.map((cell) => ({ ...cell, coord: { ...cell.coord } })),
    ),
  }
}

export function fireFlare(
  state: GameState,
  config: MatchConfig,
  firerId: string,
  direction: Direction,
  range: number,
): { newState: GameState; result: ActionResult } {
  const firer = state.tanks.find((t) => t.id === firerId)
  if (!firer || !firer.alive) {
    return {
      newState: state,
      result: blocked('Firer not found or not alive'),
    }
  }

  const delta = DIRECTION_DELTAS[direction]
  const targetX = firer.position.x + delta.dx * range
  const targetY = firer.position.y + delta.dy * range
  const targetCell: Coordinate = { x: targetX, y: targetY }

  const width = state.terrain[0]?.length ?? 0
  const height = state.terrain.length

  if (!inBounds(targetCell, width, height)) {
    return {
      newState: state,
      result: blocked('Flare target out of bounds'),
    }
  }

  const flare: FlareState = {
    id: `flare-${++flareCounter}`,
    targetCell,
    radius: config.fog.flareRadius,
    firerId,
    activatedTurn: state.turn,
    expiryTurn: state.turn + config.fog.flareDuration === 'one-round-global'
      ? state.turn + config.turnLimit
      : state.turn + config.turnLimit,
  }

  const newState = cloneGameState(state)
  newState.flares = [...state.flares, flare]

  const revealedCells = cellsInRadius(targetCell, config.fog.flareRadius)

  return {
    newState,
    result: revealed(revealedCells),
  }
}

export function expireFlares(state: GameState, currentTurn: number): GameState {
  const activeFlares = state.flares.filter((f) => f.expiryTurn > currentTurn)
  if (activeFlares.length === state.flares.length) {
    return state
  }
  return {
    ...state,
    flares: activeFlares,
  }
}
