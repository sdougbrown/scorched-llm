import type { WorldView } from '../types/events.js'
import type { Cell } from '../types/coords.js'
import { serializeKnownMap } from './tactical-memory.js'

/** Convert a WorldView into a structured text description for the model. */
export function serializeWorldView(view: WorldView): string {
  const lines: string[] = []

  // Header
  lines.push(`=== Turn ${view.turn} ===`)
  lines.push(`Your tank is at (${view.position.x}, ${view.position.y}), HP: ${view.hp}, facing: ${view.facing}°`)
  lines.push(`You have ${view.remainingActions} action(s) remaining this turn.`)
  lines.push('')

  // Local scan
  lines.push('Local scan (radius 3):')
  lines.push(...serializeLocalScan(view.localScan))
  lines.push('')

  // Active flares
  if (view.flaredCells.length > 0) {
    lines.push('Active flares:')
    const flareGroups: Map<string, { firerId: string; activatedTurn: number; expiryTurn: number; cells: Cell[] }> = new Map()
    for (const fc of view.flaredCells) {
      const key = `${fc.firerId}-${fc.activatedTurn}`
      if (!flareGroups.has(key)) {
        flareGroups.set(key, { firerId: fc.firerId, activatedTurn: fc.activatedTurn, expiryTurn: fc.expiryTurn, cells: [] })
      }
      flareGroups.get(key)!.cells.push(fc.cell)
    }
    for (const group of flareGroups.values()) {
      const metadata = view.activeFlares?.find((flare) =>
        flare.firerId === group.firerId &&
        flare.activatedTurn === group.activatedTurn &&
        flare.expiryTurn === group.expiryTurn)
      if (metadata != null) {
        lines.push(
          `  ${metadata.id} fired by ${group.firerId} at turn ${group.activatedTurn}: ` +
          `center (${metadata.targetCell.x},${metadata.targetCell.y}), radius ${metadata.radius}; ` +
          `expires before turn ${group.expiryTurn}.`,
        )
      } else {
        lines.push(`  Flare fired by ${group.firerId} at turn ${group.activatedTurn}; expires before turn ${group.expiryTurn}.`)
      }
      lines.push(...serializeKnownMap(group.cells).split('\n').map((line) => `    ${line}`))
    }
    lines.push('')
  }

  // Enemy flare warnings
  for (const ef of view.inEnemyFlare) {
    lines.push(`WARNING: You are inside an enemy flare fired by ${ef.firerId} (expires before turn ${ef.expiryTurn})!`)
  }

  if (view.inEnemyFlare.length > 0) {
    lines.push('')
  }

  // Enemy count
  lines.push(`Alive enemies: ${view.aliveEnemyCount}`)
  if ((view.visibleEnemies?.length ?? 0) > 0) {
    lines.push('Visible enemies:')
    for (const enemy of view.visibleEnemies ?? []) {
      lines.push(`  ${enemy.id} at (${enemy.position.x}, ${enemy.position.y}), HP: ${enemy.hp}`)
    }
  } else {
    lines.push('Visible enemies: none')
  }

  return lines.join('\n')
}

/** Serialize the local scan grid, grouping cells by row. */
function serializeLocalScan(cells: Cell[]): string[] {
  if (cells.length === 0) {
    return ['  (no cells revealed)']
  }

  // Group by Y, then by X within each row
  const rows: Map<number, Cell[]> = new Map()
  for (const cell of cells) {
    if (!rows.has(cell.coord.y)) {
      rows.set(cell.coord.y, [])
    }
    rows.get(cell.coord.y)!.push(cell)
  }

  const sortedY = [...rows.keys()].sort((a, b) => a - b)
  const result: string[] = []

  for (const y of sortedY) {
    const rowCells = rows.get(y)!.sort((a, b) => a.coord.x - b.coord.x)
    const rowStr = rowCells.map((c) => `  (${c.coord.x},${c.coord.y}) ${c.terrain}`).join('   ')
    result.push(rowStr)
  }

  return result
}
