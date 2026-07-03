import type { GameState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { WorldView } from '../types/events.js'
import type { Cell } from '../types/coords.js'
import { cellsInRadius } from '../geometry/coords.js'

export function buildWorldView(
  state: GameState,
  config: MatchConfig,
  tankId: string,
  remainingActions: number,
): WorldView {
  const tank = state.tanks.find((t) => t.id === tankId)
  if (!tank) {
    throw new Error(`Tank ${tankId} not found`)
  }

  // Local scan
  const localCells = cellsInRadius(tank.position, config.fog.localRadius)
  const localScan: Cell[] = localCells
    .filter((c) => c.x >= 0 && c.x < state.terrain[0].length && c.y >= 0 && c.y < state.terrain.length)
    .map((c) => state.terrain[c.y][c.x])

  // Flared cells
  const flaredCells: Array<{
    cell: Cell
    firerId: string
    activatedTurn: number
    expiryTurn: number
  }> = []

  for (const flare of state.flares) {
    const flareCells = cellsInRadius(flare.targetCell, flare.radius)
    for (const fc of flareCells) {
      if (
        fc.x >= 0 &&
        fc.x < state.terrain[0].length &&
        fc.y >= 0 &&
        fc.y < state.terrain.length
      ) {
        flaredCells.push({
          cell: state.terrain[fc.y][fc.x],
          firerId: flare.firerId,
          activatedTurn: flare.activatedTurn,
          expiryTurn: flare.expiryTurn,
        })
      }
    }
  }

  // In enemy flare
  const inEnemyFlare: Array<{ firerId: string; expiryTurn: number }> = []
  for (const flare of state.flares) {
    if (flare.firerId === tankId) continue
    const flareCells = cellsInRadius(flare.targetCell, flare.radius)
    const isInFlare = flareCells.some(
      (c) => c.x === tank.position.x && c.y === tank.position.y,
    )
    if (isInFlare) {
      inEnemyFlare.push({
        firerId: flare.firerId,
        expiryTurn: flare.expiryTurn,
      })
    }
  }

  // Alive enemy count (exclude self)
  const aliveEnemyCount = state.tanks.filter(
    (t) => t.id !== tankId && t.alive,
  ).length
  const visibleCoordinates = new Set<string>()
  for (const cell of localScan) {
    visibleCoordinates.add(`${cell.coord.x},${cell.coord.y}`)
  }
  for (const visible of flaredCells) {
    visibleCoordinates.add(`${visible.cell.coord.x},${visible.cell.coord.y}`)
  }
  const visibleEnemies = state.tanks
    .filter(
      (other) =>
        other.id !== tankId &&
        other.alive &&
        visibleCoordinates.has(`${other.position.x},${other.position.y}`),
    )
    .map((other) => ({
      id: other.id,
      position: { ...other.position },
      hp: other.hp,
    }))

  return {
    position: { ...tank.position },
    hp: tank.hp,
    facing: tank.facing,
    localScan,
    flaredCells,
    inEnemyFlare,
    remainingActions,
    turn: state.turn,
    isMyTurn: state.tanks[state.currentPlayerIndex]?.id === tankId,
    aliveEnemyCount,
    visibleEnemies,
  }
}
