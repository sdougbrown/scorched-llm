import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Cell, Coordinate, Direction } from '../types/coords.js'
import { DIRECTION_DELTAS, euclidean } from '../geometry/coords.js'

const DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const MAX_SHELL_RANGE = 10

interface Memory {
  knownCells: Map<string, Cell>
  lastSeenEnemy: { id: string; position: Coordinate; hp: number; turn: number } | null
  flareCursor: number
}

function key(coord: Coordinate): string {
  return `${coord.x},${coord.y}`
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function shellFor(from: Coordinate, to: Coordinate): { angle: number; power: number } | null {
  const distance = euclidean(from, to)
  if (distance < 1 || distance > MAX_SHELL_RANGE) return null

  return {
    angle: bearing(from, to),
    power: distance,
  }
}

function chebyshev(a: Coordinate, b: Coordinate): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

function observe(memory: Memory, worldview: WorldView): void {
  for (const cell of worldview.localScan) {
    memory.knownCells.set(key(cell.coord), cell)
  }
  for (const visible of worldview.flaredCells) {
    memory.knownCells.set(key(visible.cell.coord), visible.cell)
  }

  const visibleEnemies = worldview.visibleEnemies ?? []
  if (visibleEnemies.length > 0) {
    const closest = visibleEnemies
      .slice()
      .sort((a, b) => {
        const hpDelta = a.hp - b.hp
        if (hpDelta !== 0) return hpDelta
        return euclidean(worldview.position, a.position) - euclidean(worldview.position, b.position)
      })[0]
    memory.lastSeenEnemy = {
      id: closest.id,
      position: { ...closest.position },
      hp: closest.hp,
      turn: worldview.turn,
    }
  }
}

function knownBounds(memory: Memory, worldview: WorldView): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  const coords = [
    worldview.position,
    ...Array.from(memory.knownCells.values()).map((cell) => cell.coord),
  ]

  return {
    minX: Math.min(...coords.map((coord) => coord.x)),
    maxX: Math.max(...coords.map((coord) => coord.x)),
    minY: Math.min(...coords.map((coord) => coord.y)),
    maxY: Math.max(...coords.map((coord) => coord.y)),
  }
}

function isOpenKnown(memory: Memory, coord: Coordinate): boolean {
  return memory.knownCells.get(key(coord))?.terrain === 'open'
}

function pathIsOpen(memory: Memory, from: Coordinate, dir: Direction, distance: number): boolean {
  const delta = DIRECTION_DELTAS[dir]
  for (let step = 1; step <= distance; step++) {
    const coord = { x: from.x + delta.dx * step, y: from.y + delta.dy * step }
    if (!isOpenKnown(memory, coord)) return false
  }
  return true
}

function bestMove(
  memory: Memory,
  worldview: WorldView,
  mode: 'close' | 'evade',
): { direction: Direction; distance: number } | null {
  const enemy = memory.lastSeenEnemy?.position
  const bounds = knownBounds(memory, worldview)
  const candidates: Array<{ direction: Direction; distance: number; score: number }> = []
  const maxDistance = Math.min(2, worldview.remainingActions > 1 ? 2 : 1)

  for (const direction of DIRECTIONS) {
    const delta = DIRECTION_DELTAS[direction]
    for (let distance = maxDistance; distance >= 1; distance--) {
      if (!pathIsOpen(memory, worldview.position, direction, distance)) continue

      const pos = {
        x: worldview.position.x + delta.dx * distance,
        y: worldview.position.y + delta.dy * distance,
      }
      const edgeSlack = Math.min(
        pos.x - bounds.minX,
        bounds.maxX - pos.x,
        pos.y - bounds.minY,
        bounds.maxY - pos.y,
      )
      const enemyTerm = enemy == null
        ? -euclidean(pos, {
            x: (bounds.minX + bounds.maxX) / 2,
            y: (bounds.minY + bounds.maxY) / 2,
          })
        : mode === 'close'
          ? -euclidean(pos, enemy)
          : euclidean(pos, enemy) + (chebyshev(pos, enemy) <= 2 ? -20 : 0)
      const flarePenalty = worldview.inEnemyFlare.length > 0 ? distance * 2 : 0
      candidates.push({
        direction,
        distance,
        score: enemyTerm + edgeSlack * 0.25 + flarePenalty,
      })
    }
  }

  const best = candidates.sort((a, b) => b.score - a.score)[0]
  if (best == null) return null
  return { direction: best.direction, distance: best.distance }
}

function directionToward(from: Coordinate, to: Coordinate): Direction {
  const dx = Math.sign(to.x - from.x)
  const dy = Math.sign(to.y - from.y)
  return DIRECTIONS.find((dir) => {
    const delta = DIRECTION_DELTAS[dir]
    return delta.dx === dx && delta.dy === dy
  }) ?? 'N'
}

function flare(memory: Memory, worldview: WorldView): { direction: Direction; range: number } {
  if (memory.lastSeenEnemy != null) {
    return {
      direction: directionToward(worldview.position, memory.lastSeenEnemy.position),
      range: Math.min(5, Math.max(1, Math.round(euclidean(worldview.position, memory.lastSeenEnemy.position)))),
    }
  }

  const bounds = knownBounds(memory, worldview)
  const center = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
  const scoutOrder: Direction[] = [
    directionToward(worldview.position, center),
    'NE',
    'SE',
    'SW',
    'NW',
    'N',
    'E',
    'S',
    'W',
  ]
  const direction = scoutOrder[memory.flareCursor % scoutOrder.length]
  memory.flareCursor++
  return { direction, range: 1 }
}

export function createGpt55Agent(tankId: string): TankAgent {
  const memory: Memory = {
    knownCells: new Map(),
    lastSeenEnemy: null,
    flareCursor: 0,
  }

  return {
    name: `gpt-5.5-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      observe(memory, worldview)

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      const calls: ToolCall[] = []
      const visibleEnemies = (worldview.visibleEnemies ?? []).slice().sort((a, b) => {
        const hpDelta = a.hp - b.hp
        if (hpDelta !== 0) return hpDelta
        return euclidean(worldview.position, a.position) - euclidean(worldview.position, b.position)
      })

      const target = visibleEnemies[0]
      const visibleShot = target == null ? null : shellFor(worldview.position, target.position)
      if (visibleShot != null) {
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', ...visibleShot },
        })
      } else if (
        memory.lastSeenEnemy != null &&
        worldview.turn - memory.lastSeenEnemy.turn <= 2
      ) {
        const staleShot = shellFor(worldview.position, memory.lastSeenEnemy.position)
        if (staleShot != null) {
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', ...staleShot },
          })
        }
      } else {
        const scout = flare(memory, worldview)
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', ...scout },
        })
      }

      if (worldview.remainingActions > calls.length) {
        const tooClose =
          memory.lastSeenEnemy != null &&
          euclidean(worldview.position, memory.lastSeenEnemy.position) <= 5
        const move = bestMove(
          memory,
          worldview,
          visibleShot != null || tooClose || worldview.inEnemyFlare.length > 0
            ? 'evade'
            : 'close',
        )
        if (move != null) {
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', ...move },
          })
        }
      }

      if (calls.length === 0) {
        calls.push({ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } })
      }

      return calls
    },
  }
}
