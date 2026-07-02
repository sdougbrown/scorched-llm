import type { GameState, TankState, FlareState } from '../types/state.js'
import type { Cell } from '../types/coords.js'
import type { MatchConfig } from '../config/schema.js'
import type { TurnEvent } from '../types/events.js'
import type { MatchLog } from '../types/log.js'
import { cellsInRadius } from '../geometry/coords.js'

// --- Rendering helpers ---

/**
 * Determine the character for a cell given the game state, active tank IDs,
 * and the cells revealed by the current player's local vision (fog of war).
 *
 * Characters:
 *   `.` = open terrain (known)
 *   `#` = obstacle (known)
 *   `T` = tank (known)
 *   `*` = flare center (known)
 *   `~` = flare-lit area (known)
 *   `?` = hidden (not revealed by fog/flare)
 */
function renderCell(
  x: number,
  y: number,
  terrain: Cell[][],
  tanks: TankState[],
  flares: FlareState[],
  revealed: Set<string>,
  currentPlayerIndex: number,
): string {
  const key = `${x},${y}`

  // Fog of war: unrevealed cells are hidden
  if (!revealed.has(key)) {
    return '?'
  }

  const cell = terrain[y]?.[x]
  if (!cell) return '?'

  // Check for flare center
  for (const flare of flares) {
    if (flare.targetCell.x === x && flare.targetCell.y === y) {
      return '*'
    }
  }

  // Check for flare-lit area
  for (const flare of flares) {
    const flareCells = cellsInRadius(flare.targetCell, flare.radius)
    if (flareCells.some((c) => c.x === x && c.y === y)) {
      return '~'
    }
  }

  // Check for tanks
  for (const tank of tanks) {
    if (tank.position.x === x && tank.position.y === y && tank.alive) {
      // Show own tank as 'T', enemy tanks as 'E' or a number
      const isSelf = tanks.indexOf(tank) === currentPlayerIndex
      return isSelf ? 'T' : `${tank.id === 'tank-0' ? '1' : '2'}`
    }
  }

  // Terrain
  return cell.terrain === 'obstacle' ? '#' : '.'
}

/**
 * Build a set of revealed cells based on the current player's local vision
 * and all active flares.
 */
function buildRevealedSet(
  state: GameState,
  currentPlayerIndex: number,
): Set<string> {
  const revealed = new Set<string>()
  const width = state.terrain[0]?.length ?? 0
  const height = state.terrain.length

  // All cells are revealed if there are no flares and localRadius is 0
  // Otherwise, mark cells based on flares and local scan
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Check if any flare covers this cell
      let isFlared = false
      for (const flare of state.flares) {
        const flareCells = cellsInRadius(flare.targetCell, flare.radius)
        if (flareCells.some((c) => c.x === x && c.y === y)) {
          isFlared = true
          break
        }
      }
      if (isFlared) {
        revealed.add(`${x},${y}`)
      }
    }
  }

  // Also reveal cells in local scan radius for the current player
  if (state.tanks[currentPlayerIndex]?.alive) {
    const tank = state.tanks[currentPlayerIndex]
    const localRadius = 3 // default — would come from config
    const localCells = cellsInRadius(tank.position, localRadius)
    for (const c of localCells) {
      if (c.x >= 0 && c.x < width && c.y >= 0 && c.y < height) {
        revealed.add(`${c.x},${c.y}`)
      }
    }
  }

  return revealed
}

/**
 * Format a tank's HP bar for the legend.
 */

// --- Public API ---

/**
 * Render the current game state as an ASCII grid.
 * Returns a string with the grid, tank info, and a legend.
 */
export function renderState(
  state: GameState,
  _config: MatchConfig,
): string {
  const width = state.terrain[0]?.length ?? 0
  const height = state.terrain.length
  const revealed = buildRevealedSet(state, state.currentPlayerIndex)

  // Header
  const lines: string[] = []
  lines.push(`=== Turn ${state.turn} ===`)
  lines.push(`Current player: tank-${state.currentPlayerIndex}`)
  lines.push('')

  // Grid
  // Find the widest tank label for column padding
  let maxTankChar = 'T'
  for (let i = 0; i < state.tanks.length; i++) {
    const t = state.tanks[i]
    if (t.alive) {
      const label = i === 0 ? 'T' : `${i + 1}`
      if (label.length > maxTankChar.length) maxTankChar = label
    }
  }

  // Column headers (x coordinates)
  const colHeader = '   ' + Array.from({ length: width }, (_, i) => String(i % 10)).join('')
  lines.push(colHeader)

  // Grid rows
  for (let y = 0; y < height; y++) {
    const rowLabel = String(y)
    const rowCells = Array.from({ length: width }, (_, x) =>
      renderCell(x, y, state.terrain, state.tanks, state.flares, revealed, state.currentPlayerIndex),
    ).join(' ')
    lines.push(`${rowLabel}  ${rowCells}`)
  }

  // Tank status
  lines.push('')
  lines.push('--- Tanks ---')
  for (let i = 0; i < state.tanks.length; i++) {
    const t = state.tanks[i]
    const status = t.alive ? 'alive' : 'destroyed'
    lines.push(`  tank-${i}: pos=(${t.position.x},${t.position.y}) ${status} HP=${t.hp}/${t.maxHp}`)
  }

  // Flares
  if (state.flares.length > 0) {
    lines.push('')
    lines.push('--- Flares ---')
    for (const f of state.flares) {
      lines.push(`  ${f.id}: pos=(${f.targetCell.x},${f.targetCell.y}) firer=tank-${state.tanks.findIndex((t) => t.id === f.firerId)} expires=turn ${f.expiryTurn}`)
    }
  }

  // Legend
  lines.push('')
  lines.push('--- Legend ---')
  lines.push('  . = open terrain')
  lines.push('  # = obstacle')
  lines.push('  T = your tank')
  lines.push('  1 / 2 = enemy tank')
  lines.push('  * = flare center')
  lines.push('  ~ = flare-lit area')
  lines.push('  ? = hidden (fog of war)')

  return lines.join('\n')
}

/**
 * Render a turn event as a human-readable string.
 */
export function renderTurn(
  turn: TurnEvent,
  config: MatchConfig,
): string {
  const lines: string[] = []

  lines.push(`--- Turn ${turn.turn} (player: ${turn.player}) ---`)

  for (const action of turn.actions) {
    switch (action.kind) {
      case 'move': {
        const tool = action.call.tool
        if (tool.kind === 'move') {
          lines.push(`  → Move ${tool.direction} × ${tool.distance}`)
          if (action.result.kind === 'ok') {
            lines.push('    ✓ OK')
          } else if (action.result.kind === 'blocked') {
            lines.push(`    ✗ Blocked: ${action.result.reason}`)
          }
        }
        break
      }
      case 'flare': {
        const tool = action.call.tool
        if (tool.kind === 'fire_flare') {
          lines.push(`  → Flare ${tool.direction} × ${tool.range}`)
          if (action.result.kind === 'ok' || action.result.kind === 'revealed') {
            lines.push(`    ✓ Revealed ${action.result.kind === 'revealed' ? action.result.cells.length : 0} cells`)
          } else if (action.result.kind === 'blocked') {
            lines.push(`    ✗ Blocked: ${action.result.reason}`)
          }
        }
        break
      }
      case 'shell': {
        const tool = action.call.tool
        if (tool.kind === 'fire_shell') {
          lines.push(`  → Shell angle=${tool.angle.toFixed(0)}° power=${tool.power}`)
          switch (action.result.kind) {
            case 'ok':
              lines.push('    ✓ OK')
              break
            case 'hit':
              lines.push(`    ✗ Hit tank-${action.result.targetId} for ${action.result.damage} damage`)
              break
            case 'miss':
              lines.push('    ✗ Miss')
              break
            case 'blocked':
              lines.push(`    ✗ Blocked: ${action.result.reason}`)
              break
          }
        }
        break
      }
      case 'pass':
        lines.push('  → Pass')
        break
      case 'invalid':
        lines.push('  → Invalid action')
        break
      case 'observation':
        lines.push('  → Observation')
        break
    }
  }

  // State snapshot
  lines.push('')
  lines.push(renderState(turn.actions[0]?.snapshot ?? {
    turn: turn.turn,
    currentPlayerIndex: 0,
    tanks: [],
    flares: [],
    terrain: [],
    rulesVersion: config.rulesVersion,
  }, config))

  return lines.join('\n')
}

/**
 * Render all turns from a match log as an array of strings, one per turn.
 */
export function renderMatch(log: MatchLog): string[] {
  const results: string[] = []

  // Header
  results.push(`Match: ${log.metadata.matchId}`)
  results.push(`Config: turnLimit=${log.config.turnLimit}, map=${log.config.map.width}×${log.config.map.height}`)
  results.push('')

  for (const turn of log.turns) {
    results.push(renderTurn(turn, log.config))
  }

  // Footer — result
  const result = log.result
  results.push('')
  results.push('=== Result ===')
  results.push(`  Termination: ${result.terminationReason}`)
  for (const placement of result.placements) {
    results.push(`  ${placement.rank}. tank-${placement.tankId.split('-')[1]} (HP: ${placement.hp}, DMG: ${placement.damageDealt}, Hits: ${placement.hitsLanded})`)
  }

  return results
}
