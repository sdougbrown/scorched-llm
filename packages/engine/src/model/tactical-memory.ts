import type { ToolCall, ActionResult } from '../types/tool.js'
import type { Cell } from '../types/coords.js'
import type { WorldView } from '../types/events.js'

interface Sighting {
  turn: number
  x: number
  y: number
  hp: number
}

interface PositionRecord {
  turn: number
  x: number
  y: number
}

interface ActionRecord {
  turn: number
  call: string
  result: string
}

interface ExposureRecord {
  turn: number
  firerId: string
  expiryTurn: number
}

const MAX_SIGHTINGS_PER_ENEMY = 24
const MAX_POSITIONS = 40
const MAX_ACTIONS = 60
const MAX_EXPOSURES = 20

function pushBounded<T>(items: T[], item: T, max: number): void {
  items.push(item)
  if (items.length > max) items.splice(0, items.length - max)
}

function formatCall(call: ToolCall): string {
  switch (call.tool.kind) {
    case 'move':
      return `move(${call.tool.direction},${call.tool.distance})`
    case 'fire_flare':
      return `fire_flare(${call.tool.direction},${call.tool.range})`
    case 'fire_shell':
      return `fire_shell(angle=${call.tool.angle},power=${call.tool.power})`
    case 'fire_bomb':
      return `fire_bomb(angle=${call.tool.angle},power=${call.tool.power})`
    case 'look':
      return 'look()'
    case 'known_map':
      return 'known_map()'
    case 'pass':
      return 'pass()'
  }
}

function formatResult(result: ActionResult): string {
  switch (result.kind) {
    case 'ok':
      return 'ok'
    case 'blocked':
      return `blocked:${result.reason}`
    case 'invalid':
      return `invalid:${result.reason}`
    case 'miss':
      return 'miss'
    case 'obstacle-hit':
      return `obstacle-hit@(${result.coordinate.x},${result.coordinate.y})`
    case 'hit':
      return `hit:${result.targetId},damage=${result.damage}`
    case 'revealed':
      return `revealed:${result.cells.length}-cells`
    case 'splash':
      return `splash@(${result.impact.x},${result.impact.y}):${result.casualties.map((c) => c.targetId + '-' + c.damage).join(',')}`
  }
}

function ranges(values: number[]): string {
  if (values.length === 0) return ''
  const sorted = [...new Set(values)].sort((a, b) => a - b)
  const output: string[] = []
  let start = sorted[0]
  let end = sorted[0]
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) {
      end = sorted[i]
      continue
    }
    output.push(start === end ? `${start}` : `${start}-${end}`)
    start = sorted[i]
    end = sorted[i]
  }
  output.push(start === end ? `${start}` : `${start}-${end}`)
  return output.join(',')
}

export function serializeKnownMap(cells: Cell[]): string {
  if (cells.length === 0) return 'No known cells.'
  const rows = new Map<number, Cell[]>()
  for (const cell of cells) {
    const row = rows.get(cell.coord.y) ?? []
    row.push(cell)
    rows.set(cell.coord.y, row)
  }

  const lines = [`Known cells: ${cells.length}. Rows list known x-ranges and obstacles.`]
  for (const [y, row] of [...rows.entries()].sort(([a], [b]) => a - b)) {
    const obstacles = row
      .filter((cell) => cell.terrain === 'obstacle')
      .sort((a, b) => a.coord.x - b.coord.x)
      .map((cell) => `${cell.coord.x}(h${cell.obstacleHeight})`)
    lines.push(
      `- y=${y}: x=${ranges(row.map((cell) => cell.coord.x))}` +
      (obstacles.length > 0 ? `; obstacles=${obstacles.join(',')}` : ''),
    )
  }
  return lines.join('\n')
}

export class TacticalMemory {
  private sightings = new Map<string, Sighting[]>()
  private positions: PositionRecord[] = []
  private actions: ActionRecord[] = []
  private exposures: ExposureRecord[] = []
  private knownMap: Cell[] = []

  observe(worldview: WorldView): void {
    const previousPosition = this.positions.at(-1)
    if (
      previousPosition == null ||
      previousPosition.x !== worldview.position.x ||
      previousPosition.y !== worldview.position.y ||
      previousPosition.turn !== worldview.turn
    ) {
      pushBounded(this.positions, {
        turn: worldview.turn,
        x: worldview.position.x,
        y: worldview.position.y,
      }, MAX_POSITIONS)
    }

    for (const enemy of worldview.visibleEnemies ?? []) {
      const sightings = this.sightings.get(enemy.id) ?? []
      const previous = sightings.at(-1)
      if (
        previous == null ||
        previous.turn !== worldview.turn ||
        previous.x !== enemy.position.x ||
        previous.y !== enemy.position.y ||
        previous.hp !== enemy.hp
      ) {
        pushBounded(sightings, {
          turn: worldview.turn,
          x: enemy.position.x,
          y: enemy.position.y,
          hp: enemy.hp,
        }, MAX_SIGHTINGS_PER_ENEMY)
        this.sightings.set(enemy.id, sightings)
      }
    }

    for (const exposure of worldview.inEnemyFlare) {
      const previous = this.exposures.at(-1)
      if (
        previous?.turn !== worldview.turn ||
        previous?.firerId !== exposure.firerId ||
        previous?.expiryTurn !== exposure.expiryTurn
      ) {
        pushBounded(this.exposures, {
          turn: worldview.turn,
          firerId: exposure.firerId,
          expiryTurn: exposure.expiryTurn,
        }, MAX_EXPOSURES)
      }
    }
  }

  recordAction(
    turn: number,
    call: ToolCall,
    result: ActionResult,
    worldview: WorldView,
    knownMap?: Cell[],
  ): void {
    pushBounded(this.actions, {
      turn,
      call: formatCall(call),
      result: formatResult(result),
    }, MAX_ACTIONS)
    if (knownMap != null) this.knownMap = knownMap.map((cell) => ({
      ...cell,
      coord: { ...cell.coord },
    }))
    this.observe(worldview)
  }

  render(): string {
    const lines = [
      'TACTICAL MEMORY',
      'Deterministic summary of history older than the recent verbatim turns.',
    ]

    lines.push('', 'Enemy sightings:')
    if (this.sightings.size === 0) {
      lines.push('- none')
    } else {
      for (const [enemyId, sightings] of [...this.sightings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`- ${enemyId}: ${sightings.map((s) =>
          `T${s.turn} (${s.x},${s.y}) HP${s.hp}`).join(' -> ')}`)
      }
    }

    lines.push('', 'Own positions:')
    lines.push(this.positions.length === 0
      ? '- none'
      : `- ${this.positions.map((p) => `T${p.turn} (${p.x},${p.y})`).join(' -> ')}`)

    lines.push('', 'Actions and outcomes:')
    if (this.actions.length === 0) {
      lines.push('- none')
    } else {
      for (const action of this.actions) {
        lines.push(`- T${action.turn}: ${action.call} => ${action.result}`)
      }
    }

    lines.push('', 'Enemy flare exposure:')
    if (this.exposures.length === 0) {
      lines.push('- none')
    } else {
      for (const exposure of this.exposures) {
        lines.push(`- T${exposure.turn}: visible in ${exposure.firerId} flare until T${exposure.expiryTurn}`)
      }
    }

    lines.push('', 'Latest known map:', serializeKnownMap(this.knownMap))
    return lines.join('\n')
  }
}
