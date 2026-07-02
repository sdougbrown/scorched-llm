import type { WorldView } from '../types/events.js'
import type { Cell } from '../types/coords.js'

/** Convert a WorldView into a structured text description for the model. */
export function serializeWorldView(view: WorldView): string {
  const lines: string[] = []

  // Header
  lines.push(`=== Turn ${view.turn} ===`)
  lines.push(`Your tank is at (${view.position.x}, ${view.position.y}), HP: ${view.hp}/${view.hp}, facing: ${view.facing}°`)
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
      lines.push(`  Flare fired by ${group.firerId} at turn ${group.activatedTurn}, active until turn ${group.expiryTurn}`)
      const visibleCells = group.cells.slice(0, 20)
      for (const cell of visibleCells) {
        lines.push(`    (${cell.coord.x},${cell.coord.y}) ${cell.terrain}`)
      }
      if (group.cells.length > 20) {
        lines.push(`    ... and ${group.cells.length - 20} more cells`)
      }
    }
    lines.push('')
  }

  // Enemy flare warnings
  for (const ef of view.inEnemyFlare) {
    lines.push(`WARNING: You are inside an enemy flare fired by ${ef.firerId} (expires turn ${ef.expiryTurn})!`)
  }

  if (view.inEnemyFlare.length > 0) {
    lines.push('')
  }

  // Enemy count
  lines.push(`Alive enemies: ${view.aliveEnemyCount}`)

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