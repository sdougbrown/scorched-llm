import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS, cellsInRadius } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

type TankIntel = {
  id: string
  position: Coordinate
  hp: number
  lastSeenTurn: number
}

type KnownCell = Cell

type AgentConfig = {
  shellMaxRange: number
  moveMax: number
  flareMaxRange: number
  flareRadius: number
}

type CandidateShot = {
  target: TankIntel
  angle: number
  power: number
  score: number
}

const DEFAULT_CONFIG: AgentConfig = {
  shellMaxRange: 10,
  moveMax: 5,
  flareMaxRange: 5,
  flareRadius: 2,
}

const DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

function key(coord: Coordinate): string {
  return `${coord.x},${coord.y}`
}

function cloneCoordinate(coord: Coordinate): Coordinate {
  return { x: coord.x, y: coord.y }
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function shellHeight(i: number, total: number, apexHeight: number, tankHeight: number): number {
  if (total <= 0) return tankHeight
  const progress = (i + 1) / total
  return tankHeight + (apexHeight - tankHeight) * (4 * progress * (1 - progress))
}

function cellsFromWorldview(worldview: WorldView): Cell[] {
  const merged = new Map<string, Cell>()
  for (const cell of worldview.localScan) merged.set(key(cell.coord), cell)
  for (const entry of worldview.flaredCells) merged.set(key(entry.cell.coord), entry.cell)
  return [...merged.values()]
}

function bestDirectionToward(from: Coordinate, target: Coordinate): Direction {
  let best = 'N' as Direction
  let bestScore = Infinity
  for (const dir of DIRECTIONS) {
    const delta = DIRECTION_DELTAS[dir]
    const score = euclidean(
      { x: from.x + delta.dx, y: from.y + delta.dy },
      target,
    )
    if (score < bestScore) {
      best = dir
      bestScore = score
    }
  }
  return best
}

function onSameRay(from: Coordinate, to: Coordinate): { direction: Direction; range: number } | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (dx === 0 && dy === 0) return null
  for (const dir of DIRECTIONS) {
    const delta = DIRECTION_DELTAS[dir]
    if (delta.dx === 0 && dx !== 0) continue
    if (delta.dy === 0 && dy !== 0) continue

    const stepsX = delta.dx === 0 ? null : dx / delta.dx
    const stepsY = delta.dy === 0 ? null : dy / delta.dy
    const steps = stepsX ?? stepsY
    if (steps == null || !Number.isInteger(steps) || steps <= 0) continue
    const expectedY = delta.dy * steps
    const expectedX = delta.dx * steps
    if (expectedX === dx && expectedY === dy) {
      return { direction: dir, range: steps }
    }
  }
  return null
}

export function createGpt54Agent(
  tankId: string,
  config: Partial<AgentConfig> = {},
): TankAgent {
  const rules = { ...DEFAULT_CONFIG, ...config }
  const knownCells = new Map<string, KnownCell>()
  const visits = new Map<string, number>()
  const enemyMemory = new Map<string, TankIntel>()

  function remember(worldview: WorldView): void {
    for (const cell of cellsFromWorldview(worldview)) {
      knownCells.set(key(cell.coord), cell)
    }
    visits.set(key(worldview.position), (visits.get(key(worldview.position)) ?? 0) + 1)
    for (const enemy of worldview.visibleEnemies ?? []) {
      enemyMemory.set(enemy.id, {
        id: enemy.id,
        position: cloneCoordinate(enemy.position),
        hp: enemy.hp,
        lastSeenTurn: worldview.turn,
      })
    }
    for (const [enemyId, intel] of enemyMemory) {
      if (intel.hp <= 0) enemyMemory.delete(enemyId)
    }
  }

  function isBlockedCell(coord: Coordinate): boolean {
    const cell = knownCells.get(key(coord))
    return cell?.terrain === 'obstacle'
  }

  function estimateExploration(coord: Coordinate): number {
    let unknown = 0
    for (const neighbor of cellsInRadius(coord, 3)) {
      if (!knownCells.has(key(neighbor))) unknown++
    }
    return unknown
  }

  function enemyFlarePenalty(coord: Coordinate, worldview: WorldView): number {
    let penalty = 0
    for (const flare of worldview.activeFlares ?? []) {
      if (flare.firerId === tankId) continue
      if (euclidean(coord, flare.targetCell) <= flare.radius + 0.01) {
        penalty += 8
      }
    }
    return penalty
  }

  function lineSeemsClear(from: Coordinate, to: Coordinate): boolean {
    const path = supercover(from, to).slice(1)
    for (let i = 0; i < path.length; i++) {
      const cell = knownCells.get(key(path[i]))
      if (cell?.terrain === 'obstacle') {
        const height = shellHeight(i, path.length, 5, 1)
        if (height <= cell.obstacleHeight) return false
      }
    }
    return true
  }

  function selectTarget(worldview: WorldView): TankIntel | null {
    const visible = worldview.visibleEnemies ?? []
    if (visible.length > 0) {
      const ranked = [...visible].sort((a, b) => {
        if (a.hp !== b.hp) return a.hp - b.hp
        return euclidean(worldview.position, a.position) - euclidean(worldview.position, b.position)
      })
      return {
        id: ranked[0].id,
        position: cloneCoordinate(ranked[0].position),
        hp: ranked[0].hp,
        lastSeenTurn: worldview.turn,
      }
    }

    const remembered = [...enemyMemory.values()].sort((a, b) => {
      if (a.lastSeenTurn !== b.lastSeenTurn) return b.lastSeenTurn - a.lastSeenTurn
      return euclidean(worldview.position, a.position) - euclidean(worldview.position, b.position)
    })
    return remembered[0] ?? null
  }

  function buildShot(from: Coordinate, target: TankIntel, worldview: WorldView): CandidateShot | null {
    const distance = euclidean(from, target.position)
    if (distance > rules.shellMaxRange + 0.5) return null
    if (!lineSeemsClear(from, target.position)) return null

    const power = Math.max(1, Math.min(rules.shellMaxRange, Math.round(distance)))
    const score =
      (target.hp === 1 ? 50 : 0) +
      (worldview.turn - target.lastSeenTurn <= 0 ? 20 : 0) -
      distance
    return {
      target,
      angle: bearing(from, target.position),
      power,
      score,
    }
  }

  function reachableMoves(worldview: WorldView): Array<{ direction: Direction; distance: number; destination: Coordinate }> {
    const options: Array<{ direction: Direction; distance: number; destination: Coordinate }> = []
    for (const dir of DIRECTIONS) {
      const delta = DIRECTION_DELTAS[dir]
      for (let distance = 1; distance <= rules.moveMax; distance++) {
        const destination = {
          x: worldview.position.x + delta.dx * distance,
          y: worldview.position.y + delta.dy * distance,
        }
        let blocked = false
        for (let step = 1; step <= distance; step++) {
          const probe = {
            x: worldview.position.x + delta.dx * step,
            y: worldview.position.y + delta.dy * step,
          }
          if (isBlockedCell(probe)) {
            blocked = true
            break
          }
        }
        if (blocked) break
        options.push({ direction: dir, distance, destination })
      }
    }
    return options
  }

  function bestMove(worldview: WorldView, target: TankIntel | null): { direction: Direction; distance: number } | null {
    const moves = reachableMoves(worldview)
    if (moves.length === 0) return null

    let best: { direction: Direction; distance: number } | null = null
    let bestScore = -Infinity

    for (const move of moves) {
      const destinationKey = key(move.destination)
      const visitedPenalty = (visits.get(destinationKey) ?? 0) * 1.5
      const explorationBonus = estimateExploration(move.destination) * 0.4
      const flarePenalty = enemyFlarePenalty(move.destination, worldview)
      let score = explorationBonus - visitedPenalty - flarePenalty

      if (target) {
        const shot = buildShot(move.destination, target, worldview)
        if (shot) score += 80 + shot.score
        score -= euclidean(move.destination, target.position) * 1.1
      } else {
        const center = { x: worldview.position.x + 0, y: worldview.position.y + 0 }
        score -= euclidean(move.destination, center) * 0.05
      }

      if (score > bestScore) {
        bestScore = score
        best = { direction: move.direction, distance: move.distance }
      }
    }
    return best
  }

  function buildFlare(worldview: WorldView, target: TankIntel | null): ToolCall | null {
    if (target) {
      const exact = onSameRay(worldview.position, target.position)
      if (exact && exact.range <= rules.flareMaxRange) {
        return {
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: exact.direction, range: exact.range },
        }
      }

      let best: { direction: Direction; range: number; distance: number } | null = null
      for (const dir of DIRECTIONS) {
        const delta = DIRECTION_DELTAS[dir]
        for (let range = 1; range <= rules.flareMaxRange; range++) {
          const targetCell = {
            x: worldview.position.x + delta.dx * range,
            y: worldview.position.y + delta.dy * range,
          }
          const distance = euclidean(targetCell, target.position)
          if (best == null || distance < best.distance) {
            best = { direction: dir, range, distance }
          }
        }
      }
      if (best) {
        return {
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: best.direction, range: best.range },
        }
      }
    }

    const exploratoryDir = bestDirectionToward(worldview.position, { x: 10, y: 10 })
    return {
      id: `flare-${worldview.turn}`,
      tool: { kind: 'fire_flare', direction: exploratoryDir, range: rules.flareMaxRange },
    }
  }

  return {
    name: `gpt-5.4-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      remember(worldview)
      const target = selectTarget(worldview)
      const calls: ToolCall[] = []

      if (target) {
        const immediateShot = buildShot(worldview.position, target, worldview)
        if (immediateShot) {
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', angle: immediateShot.angle, power: immediateShot.power },
          })
          const moveAfterShot = bestMove(worldview, target)
          if (moveAfterShot && worldview.remainingActions > 1) {
            calls.push({
              id: `move-${worldview.turn}`,
              tool: { kind: 'move', direction: moveAfterShot.direction, distance: moveAfterShot.distance },
            })
          }
          return calls
        }

        const moveToShot = bestMove(worldview, target)
        if (moveToShot) {
          const delta = DIRECTION_DELTAS[moveToShot.direction]
          const movedPosition = {
            x: worldview.position.x + delta.dx * moveToShot.distance,
            y: worldview.position.y + delta.dy * moveToShot.distance,
          }
          const movedShot = buildShot(movedPosition, target, worldview)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: moveToShot.direction, distance: moveToShot.distance },
          })
          if (movedShot && worldview.remainingActions > 1) {
            calls.push({
              id: `shell-${worldview.turn}`,
              tool: { kind: 'fire_shell', angle: movedShot.angle, power: movedShot.power },
            })
            return calls
          }
        }

        const noVisibleEnemies = (worldview.visibleEnemies?.length ?? 0) === 0
        const flare = buildFlare(worldview, target)
        if (flare && worldview.remainingActions > 1 && noVisibleEnemies) {
          calls.push(flare)
          const huntMove = bestMove(worldview, target)
          if (huntMove) {
            calls.push({
              id: `move-${worldview.turn}`,
              tool: { kind: 'move', direction: huntMove.direction, distance: huntMove.distance },
            })
          }
          return calls
        }
      }

      const movement = bestMove(worldview, target)
      if (movement) {
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: movement.direction, distance: movement.distance },
        })
      }

      if ((worldview.visibleEnemies?.length ?? 0) === 0) {
        const flare = buildFlare(worldview, target)
        if (flare && calls.length < worldview.remainingActions) {
          calls.unshift(flare)
        }
      }

      if (calls.length === 0) {
        calls.push({ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } })
      }

      return calls
    },
  }
}
