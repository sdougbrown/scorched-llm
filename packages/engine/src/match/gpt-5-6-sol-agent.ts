import type { Coordinate, Direction, Cell } from '../types/coords.js'
import type { WorldView } from '../types/events.js'
import type { ActionResult, ToolCall } from '../types/tool.js'
import type { MatchConfig } from '../config/schema.js'
import type {
  AgentMessage,
  AgentTurnResult,
  TankAgent,
  ToolExecutionResult,
  ToolExecutor,
  ToolSpec,
} from './fake-agents.js'
import { cellsInRadius, DIRECTION_DELTAS, euclidean } from '../geometry/coords.js'
import { supercover } from '../geometry/supercover.js'

const DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const ASSUMED_TANK_HEIGHT = 1
const ASSUMED_APEX_HEIGHT = 5

/** Optional engine facts that are not exposed in a scripted agent's worldview. */
export interface Gpt56SolAgentOptions {
  mapWidth?: number
  mapHeight?: number
  localRadius?: number
  moveMax?: number
  shellMaxRange?: number
  shellTankHeight?: number
  shellApexHeight?: number
  obstacleHeight?: number
  playerCount?: number
}

/** Extract the hidden physics limits when a tournament harness has its config. */
export function gpt56SolOptionsFromConfig(config: MatchConfig): Gpt56SolAgentOptions {
  return {
    mapWidth: config.map.width,
    mapHeight: config.map.height,
    localRadius: config.fog.localRadius,
    moveMax: config.moveMax ?? config.fog.flareRadius,
    shellMaxRange: config.shell.maxRange,
    shellTankHeight: config.shell.tankHeight,
    shellApexHeight: config.shell.apexHeight,
    obstacleHeight: config.map.obstacleHeight,
    playerCount: config.players.length,
  }
}

interface EnemyTrack {
  id: string
  position: Coordinate
  hp: number
  lastSeenTurn: number
  previousPosition?: Coordinate
  previousSeenTurn?: number
  alive: boolean
}

interface ShotPlan {
  angle: number
  power: number
  path: Coordinate[]
  score: number
  targetId?: string
}

interface MovePlan {
  direction: Direction
  distance: number
  destination: Coordinate
  score: number
}

type MoveIntent =
  | { kind: 'explore' }
  | { kind: 'pursue'; target: Coordinate }
  | { kind: 'evade'; threats: Coordinate[] }
  | { kind: 'escape-flare'; threats: Coordinate[] }
  | { kind: 'relocate' }

interface AgentMemory {
  initialized: boolean
  playerCount: number
  alivePlayerCount: number
  singleActionMode: boolean
  width: number
  height: number
  widthConfirmed: boolean
  heightConfirmed: boolean
  localRadius: number
  moveMax: number
  shellMax: number
  tankHeight: number
  apexHeight: number
  obstacleHeight: number
  moveMaxConfigured: boolean
  shellMaxConfigured: boolean
  knownCells: Map<string, Cell>
  observedTurn: Map<string, number>
  shotTurn: Map<string, number>
  shellObstacleCells: Set<string>
  positionVisits: Map<string, number>
  enemies: Map<string, EnemyTrack>
  lastAliveEnemyCount: number
  blindShotsSinceMove: number
  serial: number
}

function coordKey(coord: Coordinate): string {
  return `${coord.x},${coord.y}`
}

function sameCoord(a: Coordinate, b: Coordinate): boolean {
  return a.x === b.x && a.y === b.y
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const degrees = Math.atan2(dx, -dy) * (180 / Math.PI)
  return degrees < 0 ? degrees + 360 : degrees
}

function normalizeAngle(angle: number): number {
  const normalized = angle % 360
  return normalized < 0 ? normalized + 360 : normalized
}

function shellPath(from: Coordinate, angle: number, power: number): Coordinate[] {
  const radians = (angle * Math.PI) / 180
  const target = {
    x: Math.round(from.x + Math.sin(radians) * power),
    y: Math.round(from.y - Math.cos(radians) * power),
  }
  return supercover(from, target).slice(1)
}

function assumedShellHeight(memory: AgentMemory, index: number, sampleCount: number): number {
  if (sampleCount <= 0) return memory.tankHeight
  const progress = (index + 1) / sampleCount
  const arc = 4 * progress * (1 - progress)
  return memory.tankHeight + (memory.apexHeight - memory.tankHeight) * arc
}

function stableNoise(tankId: string, turn: number, x: number, y: number): number {
  let hash = 2166136261
  const text = `${tankId}:${turn}:${x}:${y}`
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0xffffffff
}

function parseTankIndex(id: string): number | null {
  const match = /(?:^|-)\s*(\d+)$/.exec(id)
  if (!match) return null
  const parsed = Number.parseInt(match[1], 10)
  return Number.isFinite(parsed) ? parsed : null
}

function inEstimatedBounds(memory: AgentMemory, coord: Coordinate): boolean {
  return coord.x >= 0 && coord.y >= 0 && coord.x < memory.width && coord.y < memory.height
}

function typicalObstacleHeight(memory: AgentMemory): number {
  let height = memory.obstacleHeight
  for (const cell of memory.knownCells.values()) {
    if (cell.terrain === 'obstacle') height = Math.max(height, cell.obstacleHeight)
  }
  return height
}

function visibleEnemyCoordinates(view: WorldView): Set<string> {
  return new Set((view.visibleEnemies ?? []).map((enemy) => coordKey(enemy.position)))
}

function initializeMemory(memory: AgentMemory, view: WorldView): void {
  if (memory.initialized) return

  memory.initialized = true
  memory.playerCount = Math.max(memory.playerCount, view.aliveEnemyCount + 1)
  memory.alivePlayerCount = Math.max(2, view.aliveEnemyCount + 1)
  memory.singleActionMode = view.remainingActions === 1

  // These are priors for the repository's three official presets. Boundary
  // observations below replace them when a custom map exposes an edge.
  if (memory.playerCount >= 4) {
    if (!memory.widthConfirmed) memory.width = 25
    if (!memory.heightConfirmed) memory.height = 25
    if (!memory.moveMaxConfigured) memory.moveMax = 3
    if (!memory.shellMaxConfigured) memory.shellMax = 12
  } else if (memory.singleActionMode) {
    if (!memory.widthConfirmed) memory.width = 15
    if (!memory.heightConfirmed) memory.height = 15
    if (!memory.moveMaxConfigured) memory.moveMax = 2
    if (!memory.shellMaxConfigured) memory.shellMax = 10
  } else {
    if (!memory.widthConfirmed) memory.width = 20
    if (!memory.heightConfirmed) memory.height = 20
    if (!memory.moveMaxConfigured) memory.moveMax = 2
    if (!memory.shellMaxConfigured) memory.shellMax = 10
  }
}

function updateMemory(memory: AgentMemory, view: WorldView): void {
  initializeMemory(memory, view)
  memory.alivePlayerCount = Math.max(2, view.aliveEnemyCount + 1)

  for (const flare of view.activeFlares ?? []) {
    memory.playerCount = Math.max(memory.playerCount, flare.expiryTurn - flare.activatedTurn)
  }

  const visibleCoordinates = visibleEnemyCoordinates(view)
  const observedCells = [...view.localScan, ...view.flaredCells.map((visible) => visible.cell)]

  for (const cell of observedCells) {
    const key = coordKey(cell.coord)
    memory.knownCells.set(key, cell)
    memory.observedTurn.set(key, view.turn)
    if (cell.terrain === 'obstacle') memory.shellObstacleCells.add(key)
  }

  const visitKey = coordKey(view.position)
  memory.positionVisits.set(visitKey, (memory.positionVisits.get(visitKey) ?? 0) + 1)

  for (const enemy of view.visibleEnemies ?? []) {
    const enemyIndex = parseTankIndex(enemy.id)
    if (enemyIndex != null) {
      memory.playerCount = Math.max(memory.playerCount, enemyIndex + 1)
    }
    const previous = memory.enemies.get(enemy.id)
    if (previous && previous.lastSeenTurn < view.turn) {
      previous.previousPosition = { ...previous.position }
      previous.previousSeenTurn = previous.lastSeenTurn
    }
    memory.enemies.set(enemy.id, {
      id: enemy.id,
      position: { ...enemy.position },
      hp: enemy.hp,
      lastSeenTurn: view.turn,
      previousPosition: previous?.previousPosition,
      previousSeenTurn: previous?.previousSeenTurn,
      alive: true,
    })
  }

  if (view.aliveEnemyCount < memory.lastAliveEnemyCount) {
    // A vanished, zero-HP visible contact can be identified precisely. For an
    // unseen casualty, retaining tracks is safer than guessing which id died.
    for (const track of memory.enemies.values()) {
      if (track.hp <= 0 && !visibleCoordinates.has(coordKey(track.position))) {
        track.alive = false
      }
    }
  }
  memory.lastAliveEnemyCount = view.aliveEnemyCount

  const scanReach = view.localScan.reduce((largest, cell) => {
    return Math.max(
      largest,
      Math.abs(cell.coord.x - view.position.x),
      Math.abs(cell.coord.y - view.position.y),
    )
  }, 0)
  if (scanReach > 0) memory.localRadius = Math.max(memory.localRadius, scanReach)

  const localKeys = new Set(view.localScan.map((cell) => coordKey(cell.coord)))
  const reach = Math.floor(memory.localRadius)
  if (
    !memory.widthConfirmed &&
    reach > 0 &&
    !localKeys.has(coordKey({ x: view.position.x + reach, y: view.position.y }))
  ) {
    const rightmost = Math.max(...view.localScan.map((cell) => cell.coord.x))
    if (rightmost >= view.position.x) {
      memory.width = rightmost + 1
      memory.widthConfirmed = true
    }
  }
  if (
    !memory.heightConfirmed &&
    reach > 0 &&
    !localKeys.has(coordKey({ x: view.position.x, y: view.position.y + reach }))
  ) {
    const bottommost = Math.max(...view.localScan.map((cell) => cell.coord.y))
    if (bottommost >= view.position.y) {
      memory.height = bottommost + 1
      memory.heightConfirmed = true
    }
  }

  if (!memory.widthConfirmed) {
    const knownRight = observedCells.reduce(
      (largest, cell) => Math.max(largest, cell.coord.x + 1),
      memory.width,
    )
    memory.width = Math.max(memory.width, knownRight)
  }
  if (!memory.heightConfirmed) {
    const knownBottom = observedCells.reduce(
      (largest, cell) => Math.max(largest, cell.coord.y + 1),
      memory.height,
    )
    memory.height = Math.max(memory.height, knownBottom)
  }
}

function predictedEnemyWeight(memory: AgentMemory, coord: Coordinate, turn: number): number {
  let weight = 0

  for (const track of memory.enemies.values()) {
    if (!track.alive) continue
    const elapsedRounds = Math.max(
      0,
      Math.ceil((turn - track.lastSeenTurn) / Math.max(1, memory.alivePlayerCount)),
    )
    const uncertainty = Math.max(1, elapsedRounds * memory.moveMax)
    const dx = Math.abs(coord.x - track.position.x)
    const dy = Math.abs(coord.y - track.position.y)
    const chebyshevDistance = Math.max(dx, dy)

    if (chebyshevDistance <= uncertainty) {
      weight += 4 / (1 + chebyshevDistance)
    }

    if (
      track.previousPosition &&
      track.previousSeenTurn != null &&
      track.lastSeenTurn > track.previousSeenTurn
    ) {
      const vx = Math.sign(track.position.x - track.previousPosition.x)
      const vy = Math.sign(track.position.y - track.previousPosition.y)
      const projected = {
        x: track.position.x + vx * elapsedRounds * memory.moveMax,
        y: track.position.y + vy * elapsedRounds * memory.moveMax,
      }
      const projectedDistance = Math.max(
        Math.abs(coord.x - projected.x),
        Math.abs(coord.y - projected.y),
      )
      if (projectedDistance <= uncertainty) {
        weight += 2 / (1 + projectedDistance)
      }
    }
  }

  return weight
}

function flareOriginWeight(tankId: string, view: WorldView, coord: Coordinate): number {
  let weight = 0
  for (const flare of view.activeFlares ?? []) {
    if (flare.firerId === tankId) continue
    const dx = coord.x - flare.targetCell.x
    const dy = coord.y - flare.targetCell.y
    if (dx === 0 && dy === 0) continue

    // A legal flare center is always on one of the eight movement rays from
    // its firer. The launch range is hidden, but the ray constraint is useful
    // probabilistic counter-intelligence against otherwise unseen tanks.
    if (dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) {
      const range = Math.max(Math.abs(dx), Math.abs(dy))
      weight += 3 / (1 + range * 0.08)
    }
  }
  return weight
}

function chooseTarget(
  tankId: string,
  memory: AgentMemory,
  view: WorldView,
): NonNullable<WorldView['visibleEnemies']>[number] | null {
  const candidates = (view.visibleEnemies ?? []).filter((enemy) => {
    return planVisibleShot(memory, view.position, enemy.position, enemy.id) !== null
  })
  if (candidates.length === 0) return null

  const myIndex = parseTankIndex(tankId)
  return [...candidates].sort((a, b) => {
    const score = (enemy: typeof a): number => {
      const distance = euclidean(view.position, enemy.position)
      const enemyIndex = parseTankIndex(enemy.id)
      let turnThreat = 0
      if (myIndex != null && enemyIndex != null) {
        const turnsAhead = (enemyIndex - myIndex + memory.playerCount) % memory.playerCount
        if (turnsAhead === 1) turnThreat = 35
        else if (turnsAhead === 2) turnThreat = 12
      }
      return (enemy.hp <= 1 ? 120 : 0) + turnThreat + 50 / (1 + distance)
    }
    return score(b) - score(a) || a.id.localeCompare(b.id)
  })[0]
}

function planVisibleShot(
  memory: AgentMemory,
  from: Coordinate,
  target: Coordinate,
  targetId?: string,
): ShotPlan | null {
  const directAngle = bearing(from, target)
  const directDistance = euclidean(from, target)
  const obstacleHeight = typicalObstacleHeight(memory)
  const powers = new Set<number>([directDistance])

  for (let power = 1; power <= memory.shellMax + 1e-9; power += 0.25) {
    powers.add(Math.round(power * 100) / 100)
  }

  let best: ShotPlan | null = null
  const angleOffsets = [0, -0.75, 0.75, -1.5, 1.5, -3, 3]

  for (const offset of angleOffsets) {
    const angle = normalizeAngle(directAngle + offset)
    for (const power of powers) {
      if (power < 1 || power > memory.shellMax + 1e-9) continue
      const path = shellPath(from, angle, power)
      const targetIndex = path.findIndex((cell) => sameCoord(cell, target))
      if (targetIndex < 0) continue

      let blocked = false
      let uncertaintyPenalty = 0
      let clearanceReward = 0

      for (let i = 0; i < targetIndex; i++) {
        const cell = path[i]
        const height = assumedShellHeight(memory, i, path.length)
        const known = memory.knownCells.get(coordKey(cell))
        const isKnownObstacle = known?.terrain === 'obstacle'
        const isLearnedObstacle = memory.shellObstacleCells.has(coordKey(cell))
        const heightNeeded = known?.obstacleHeight ?? obstacleHeight

        if ((isKnownObstacle || isLearnedObstacle) && height <= heightNeeded) {
          blocked = true
          break
        }
        if (isKnownObstacle || isLearnedObstacle) {
          clearanceReward += Math.min(3, height - heightNeeded)
        } else if (!known) {
          uncertaintyPenalty += height <= obstacleHeight ? 8 : 0.4
        }
      }
      if (blocked) continue

      // Exact power is preferred on fully known lanes. Longer trajectories are
      // selected only when their extra arc materially improves obstacle odds.
      const score =
        10_000 +
        clearanceReward * 5 -
        uncertaintyPenalty -
        Math.abs(power - directDistance) * 0.08 -
        Math.abs(offset) * 0.03
      if (best == null || score > best.score) {
        best = { angle, power, path, score, targetId }
      }
    }
  }

  return best
}

function scoreBlindPath(
  tankId: string,
  memory: AgentMemory,
  view: WorldView,
  path: Coordinate[],
  angle: number,
): number {
  let score = 0
  let survivalProbability = 1
  const obstacleHeight = typicalObstacleHeight(memory)

  for (let i = 0; i < path.length; i++) {
    const cell = path[i]
    if (!inEstimatedBounds(memory, cell)) break

    const key = coordKey(cell)
    const height = assumedShellHeight(memory, i, path.length)
    const known = memory.knownCells.get(key)
    const isObstacle = known?.terrain === 'obstacle' || memory.shellObstacleCells.has(key)
    const heightNeeded = known?.obstacleHeight ?? obstacleHeight
    if (isObstacle) {
      if (height <= heightNeeded) break
      continue
    }

    const observedAt = memory.observedTurn.get(key)
    const observationAge = observedAt == null ? Infinity : Math.max(0, view.turn - observedAt)
    const freshnessWeight =
      observedAt == null ? 1 : Math.min(1, observationAge / Math.max(2, memory.playerCount * 2))
    const firedAt = memory.shotTurn.get(key)
    const shotAge = firedAt == null ? Infinity : Math.max(0, view.turn - firedAt)
    const sweepWeight =
      firedAt == null
        ? 1
        : Math.max(0.08, Math.min(1, shotAge / Math.max(3, memory.playerCount * 3)))
    const prediction = predictedEnemyWeight(memory, cell, view.turn)
    const flareClue = observationAge === 0 ? 0 : flareOriginWeight(tankId, view, cell)

    score += survivalProbability * (freshnessWeight + prediction + flareClue) * sweepWeight

    if (!known && height <= obstacleHeight) {
      survivalProbability *= 0.9
    }
  }

  score +=
    stableNoise(tankId, view.turn, Math.round(angle * 10), Math.round(path.length * 10)) * 0.01
  return score
}

function planBlindShot(
  tankId: string,
  memory: AgentMemory,
  view: WorldView,
  from: Coordinate = view.position,
): ShotPlan | null {
  const angles = new Set<number>()
  for (let angle = 0; angle < 360; angle += 7.5) angles.add(angle)

  for (let y = 0; y < memory.height; y++) {
    for (let x = 0; x < memory.width; x++) {
      if (x === from.x && y === from.y) continue
      angles.add(Math.round(bearing(from, { x, y }) * 1000) / 1000)
    }
  }

  for (const track of memory.enemies.values()) {
    if (track.alive) angles.add(Math.round(bearing(from, track.position) * 1000) / 1000)
  }

  const powers = new Set<number>([
    memory.shellMax,
    Math.max(1, Math.round(memory.shellMax * 0.75 * 4) / 4),
    Math.max(1, Math.round(memory.shellMax * 0.5 * 4) / 4),
  ])

  let best: ShotPlan | null = null
  const seenTrajectories = new Set<string>()
  for (const angle of angles) {
    for (const power of powers) {
      const path = shellPath(from, angle, power)
      if (path.length === 0) continue
      const trajectoryKey = path.map(coordKey).join('|')
      if (seenTrajectories.has(trajectoryKey)) continue
      seenTrajectories.add(trajectoryKey)

      const score = scoreBlindPath(tankId, memory, view, path, angle)
      if (best == null || score > best.score) {
        best = { angle, power, path, score }
      }
    }
  }

  return best
}

function exposureCount(tankId: string, view: WorldView, position: Coordinate): number {
  return (view.activeFlares ?? []).filter((flare) => {
    return flare.firerId !== tankId && euclidean(position, flare.targetCell) <= flare.radius
  }).length
}

function scanValue(memory: AgentMemory, position: Coordinate, turn: number): number {
  let value = 0
  for (const cell of cellsInRadius(position, memory.localRadius)) {
    if (!inEstimatedBounds(memory, cell)) continue
    const observedAt = memory.observedTurn.get(coordKey(cell))
    if (observedAt == null) value += 1
    else value += Math.min(0.35, Math.max(0, turn - observedAt) / 40)
  }
  return value
}

function exactShotWouldMeetCover(
  memory: AgentMemory,
  enemy: Coordinate,
  destination: Coordinate,
): boolean {
  const path = supercover(enemy, destination).slice(1)
  for (let i = 0; i < path.length - 1; i++) {
    const cell = memory.knownCells.get(coordKey(path[i]))
    if (
      cell?.terrain === 'obstacle' &&
      assumedShellHeight(memory, i, path.length) <= cell.obstacleHeight
    ) {
      return true
    }
  }
  return false
}

function moveCandidates(
  tankId: string,
  memory: AgentMemory,
  view: WorldView,
  intent: MoveIntent,
): MovePlan[] {
  const candidates: MovePlan[] = []
  const visiblePositions = visibleEnemyCoordinates(view)
  const center = { x: (memory.width - 1) / 2, y: (memory.height - 1) / 2 }

  for (const direction of DIRECTIONS) {
    const delta = DIRECTION_DELTAS[direction]
    for (let distance = 1; distance <= memory.moveMax; distance++) {
      let clear = true
      for (let step = 1; step <= distance; step++) {
        const cellCoord = {
          x: view.position.x + delta.dx * step,
          y: view.position.y + delta.dy * step,
        }
        if (!inEstimatedBounds(memory, cellCoord)) {
          clear = false
          break
        }
        const cell = memory.knownCells.get(coordKey(cellCoord))
        if (!cell || cell.terrain !== 'open' || visiblePositions.has(coordKey(cellCoord))) {
          clear = false
          break
        }
      }
      if (!clear) break

      const destination = {
        x: view.position.x + delta.dx * distance,
        y: view.position.y + delta.dy * distance,
      }
      const visits = memory.positionVisits.get(coordKey(destination)) ?? 0
      const exposed = exposureCount(tankId, view, destination)
      const information = scanValue(memory, destination, view.turn)
      const centerDistance = euclidean(destination, center)
      let score = -exposed * 350 - visits * 14 + distance * 0.5

      switch (intent.kind) {
        case 'explore':
          score += information * 13 - centerDistance * 0.35
          break

        case 'pursue': {
          const targetDistance = euclidean(destination, intent.target)
          score += information * 4 - targetDistance * 24
          break
        }

        case 'evade':
        case 'escape-flare': {
          const distances = intent.threats.map((threat) => euclidean(destination, threat))
          const nearest = distances.length > 0 ? Math.min(...distances) : memory.localRadius
          score += nearest * 38
          if (nearest > memory.localRadius) score += 135
          if (exposed === 0) score += intent.kind === 'escape-flare' ? 220 : 35
          for (const threat of intent.threats) {
            if (exactShotWouldMeetCover(memory, threat, destination)) score += 18
          }
          break
        }

        case 'relocate':
          // In one-hit mode, crossing into mutual local vision hands the next
          // player the first shot. Relocations therefore reveal as little new
          // ground as possible while extending blind-fire reach toward center.
          score -= information * 16 + centerDistance * 3
          score -= distance * 2
          break
      }

      score += stableNoise(tankId, view.turn, destination.x, destination.y) * 0.25
      candidates.push({ direction, distance, destination, score })
    }
  }

  return candidates.sort((a, b) => b.score - a.score || b.distance - a.distance)
}

function needsTwoMoveEscape(
  tankId: string,
  memory: AgentMemory,
  view: WorldView,
  target: NonNullable<WorldView['visibleEnemies']>[number],
): boolean {
  if (view.hp > 1 || target.hp <= 1 || view.remainingActions < 2) return false

  const threats = (view.visibleEnemies ?? []).map((enemy) => enemy.position)
  const bestOneMove = moveCandidates(tankId, memory, view, {
    kind: 'evade',
    threats,
  })[0]
  if (!bestOneMove) return false

  const captureRadius = memory.moveMax + memory.localRadius
  return threats.some((threat) => {
    const outsideCaptureEnvelope = euclidean(bestOneMove.destination, threat) > captureRadius
    const protectedByCover = exactShotWouldMeetCover(memory, threat, bestOneMove.destination)
    return !outsideCaptureEnvelope && !protectedByCover
  })
}

function freshestTrack(memory: AgentMemory): EnemyTrack | null {
  const tracks = [...memory.enemies.values()].filter((track) => track.alive)
  if (tracks.length === 0) return null
  return tracks.sort((a, b) => b.lastSeenTurn - a.lastSeenTurn || a.id.localeCompare(b.id))[0]
}

function explorationIntent(memory: AgentMemory, view: WorldView): MoveIntent {
  const track = freshestTrack(memory)
  if (track && view.turn - track.lastSeenTurn <= memory.playerCount * 3) {
    return { kind: 'pursue', target: track.position }
  }
  return { kind: 'explore' }
}

function makeCallId(memory: AgentMemory, tankId: string, turn: number, kind: string): string {
  return `gpt5-6-sol-${tankId}-${turn}-${kind}-${memory.serial++}`
}

function markShot(
  memory: AgentMemory,
  plan: ShotPlan,
  result: ActionResult,
  turn: number,
  hitCoordinate?: Coordinate,
): void {
  let stopAt: string | null = null
  if (result.kind === 'obstacle-hit') {
    stopAt = coordKey(result.coordinate)
    memory.shellObstacleCells.add(stopAt)
  } else if (result.kind === 'hit' && hitCoordinate) {
    stopAt = coordKey(hitCoordinate)
  }

  for (const cell of plan.path) {
    const key = coordKey(cell)
    memory.shotTurn.set(key, turn)
    if (key === stopAt) break
  }
}

function learnLimits(memory: AgentMemory, result: ActionResult): void {
  if (result.kind !== 'blocked' && result.kind !== 'invalid') return

  const shellMatch = /between\s+1\s+and\s+(\d+(?:\.\d+)?)/i.exec(result.reason)
  if (shellMatch) {
    memory.shellMax = Math.max(1, Number(shellMatch[1]))
  }

  const moveMatch = /maximum\s+of\s+(\d+)/i.exec(result.reason)
  if (moveMatch) {
    memory.moveMax = Math.max(1, Number.parseInt(moveMatch[1], 10))
  }
}

async function executeMove(
  tankId: string,
  memory: AgentMemory,
  initialView: WorldView,
  executeTool: ToolExecutor,
  calls: ToolCall[],
  intent: MoveIntent,
): Promise<ToolExecutionResult | null> {
  let view = initialView
  const rejected = new Set<string>()

  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = moveCandidates(tankId, memory, view, intent).find((candidate) => {
      return !rejected.has(`${candidate.direction}:${candidate.distance}`)
    })
    if (!plan) return null

    const call: ToolCall = {
      id: makeCallId(memory, tankId, view.turn, 'move'),
      tool: {
        kind: 'move',
        direction: plan.direction,
        distance: plan.distance,
      },
    }
    calls.push(call)
    const execution = await executeTool(call)
    learnLimits(memory, execution.result)
    updateMemory(memory, execution.worldview)

    if (execution.result.kind === 'ok') {
      memory.blindShotsSinceMove = 0
      return execution
    }
    rejected.add(`${plan.direction}:${plan.distance}`)
    view = execution.worldview
    if (execution.turnEnded || (view.visibleEnemies?.length ?? 0) > 0) return execution
  }

  return null
}

async function executeShot(
  tankId: string,
  memory: AgentMemory,
  initialView: WorldView,
  executeTool: ToolExecutor,
  calls: ToolCall[],
  target?: NonNullable<WorldView['visibleEnemies']>[number],
): Promise<ToolExecutionResult | null> {
  let view = initialView
  let latestExecution: ToolExecutionResult | null = null

  for (let attempt = 0; attempt < 2; attempt++) {
    const plan = target
      ? planVisibleShot(memory, view.position, target.position, target.id)
      : planBlindShot(tankId, memory, view)
    if (!plan) return latestExecution

    const call: ToolCall = {
      id: makeCallId(memory, tankId, view.turn, target ? 'kill' : 'sweep'),
      tool: { kind: 'fire_shell', angle: plan.angle, power: plan.power },
    }
    calls.push(call)
    const aliveEnemyCountBeforeShot = view.aliveEnemyCount
    const execution = await executeTool(call)
    latestExecution = execution
    learnLimits(memory, execution.result)
    const shellExecuted = execution.result.kind !== 'blocked' && execution.result.kind !== 'invalid'
    if (shellExecuted) {
      const result = execution.result
      const visibleHit =
        result.kind === 'hit'
          ? view.visibleEnemies?.find((enemy) => enemy.id === result.targetId)
          : undefined
      const inferredHitCoordinate = result.kind === 'hit' ? visibleHit?.position : undefined
      markShot(memory, plan, result, view.turn, inferredHitCoordinate)
      if (!target) memory.blindShotsSinceMove++
    }
    updateMemory(memory, execution.worldview)

    if (shellExecuted) {
      if (execution.result.kind === 'hit') {
        const hitResult = execution.result
        const visibleAfterHit = execution.worldview.visibleEnemies?.find(
          (enemy) => enemy.id === hitResult.targetId,
        )
        const track = memory.enemies.get(hitResult.targetId)
        if (track && visibleAfterHit) {
          // updateMemory consumed the authoritative post-action worldview.
          // Do not subtract damage a second time from a surviving contact.
          track.hp = visibleAfterHit.hp
          track.alive = true
        } else if (track && execution.worldview.aliveEnemyCount < aliveEnemyCountBeforeShot) {
          track.hp = 0
          track.alive = false
        } else if (track) {
          // A blind hit has no post-hit contact record, so its stale track does
          // need the action result applied once.
          track.hp = Math.max(0, track.hp - hitResult.damage)
          if (track.hp === 0) track.alive = false
        }
      }
      return execution
    }

    view = execution.worldview
    if (execution.turnEnded) return execution
  }

  return latestExecution
}

function planLegacyTurn(tankId: string, memory: AgentMemory, view: WorldView): ToolCall[] {
  if (!view.isMyTurn) {
    return [
      {
        id: makeCallId(memory, tankId, view.turn, 'pass'),
        tool: { kind: 'pass' },
      },
    ]
  }

  const target = chooseTarget(tankId, memory, view)
  if (target) {
    const shot = planVisibleShot(memory, view.position, target.position, target.id)
    if (!shot) return []
    const calls: ToolCall[] = [
      {
        id: makeCallId(memory, tankId, view.turn, 'kill'),
        tool: { kind: 'fire_shell', angle: shot.angle, power: shot.power },
      },
    ]
    if (view.remainingActions > 1) {
      const move = moveCandidates(tankId, memory, view, {
        kind: 'evade',
        threats: (view.visibleEnemies ?? []).map((enemy) => enemy.position),
      })[0]
      if (move) {
        calls.push({
          id: makeCallId(memory, tankId, view.turn, 'move'),
          tool: {
            kind: 'move',
            direction: move.direction,
            distance: move.distance,
          },
        })
      }
    }
    return calls
  }

  if (memory.singleActionMode) {
    const shot = planBlindShot(tankId, memory, view)
    return shot
      ? [
          {
            id: makeCallId(memory, tankId, view.turn, 'sweep'),
            tool: { kind: 'fire_shell', angle: shot.angle, power: shot.power },
          },
        ]
      : []
  }

  const move = moveCandidates(tankId, memory, view, explorationIntent(memory, view))[0]
  const calls: ToolCall[] = []
  let firingPosition = view.position
  if (move) {
    calls.push({
      id: makeCallId(memory, tankId, view.turn, 'move'),
      tool: {
        kind: 'move',
        direction: move.direction,
        distance: move.distance,
      },
    })
    firingPosition = move.destination
  }
  if (calls.length < view.remainingActions) {
    const shot = planBlindShot(tankId, memory, view, firingPosition)
    if (shot) {
      calls.push({
        id: makeCallId(memory, tankId, view.turn, 'sweep'),
        tool: { kind: 'fire_shell', angle: shot.angle, power: shot.power },
      })
    }
  }
  return calls
}

async function takeInteractiveTurn(
  tankId: string,
  memory: AgentMemory,
  initialView: WorldView,
  executeTool: ToolExecutor,
): Promise<AgentTurnResult> {
  const calls: ToolCall[] = []
  let view = initialView

  if (!view.isMyTurn) {
    const call: ToolCall = {
      id: makeCallId(memory, tankId, view.turn, 'pass'),
      tool: { kind: 'pass' },
    }
    calls.push(call)
    await executeTool(call)
    return { toolCalls: calls, executed: true }
  }

  const initialTarget = chooseTarget(tankId, memory, view)
  if (initialTarget) {
    const threats = (view.visibleEnemies ?? []).map((enemy) => ({
      ...enemy.position,
    }))
    if (needsTwoMoveEscape(tankId, memory, view, initialTarget)) {
      const firstEscape = await executeMove(tankId, memory, view, executeTool, calls, {
        kind: 'evade',
        threats,
      })
      if (firstEscape?.result.kind === 'ok') {
        view = firstEscape.worldview
        if (!firstEscape.turnEnded && view.remainingActions > 0) {
          await executeMove(tankId, memory, view, executeTool, calls, {
            kind: 'evade',
            threats,
          })
        }
        return { toolCalls: calls, executed: true }
      }
    }

    const shot = await executeShot(tankId, memory, view, executeTool, calls, initialTarget)
    if (!shot || shot.turnEnded) return { toolCalls: calls, executed: true }
    view = shot.worldview
    const shotRejected = shot.result.kind === 'blocked' || shot.result.kind === 'invalid'

    if (view.remainingActions > 0) {
      const reposition = await executeMove(
        tankId,
        memory,
        view,
        executeTool,
        calls,
        shotRejected
          ? { kind: 'pursue', target: initialTarget.position }
          : { kind: 'evade', threats },
      )
      if (
        shotRejected &&
        reposition?.result.kind === 'ok' &&
        !reposition.turnEnded &&
        reposition.worldview.remainingActions > 0
      ) {
        view = reposition.worldview
        const reacquiredTarget = chooseTarget(tankId, memory, view)
        if (reacquiredTarget) {
          await executeShot(tankId, memory, view, executeTool, calls, reacquiredTarget)
        } else {
          await executeMove(tankId, memory, view, executeTool, calls, {
            kind: 'pursue',
            target: initialTarget.position,
          })
        }
      }
    }
    return { toolCalls: calls, executed: true }
  }

  if (memory.singleActionMode) {
    if (view.inEnemyFlare.length > 0) {
      const threats = [...memory.enemies.values()]
        .filter((track) => track.alive)
        .map((track) => track.position)
      const escaped = await executeMove(tankId, memory, view, executeTool, calls, {
        kind: 'escape-flare',
        threats,
      })
      if (escaped) return { toolCalls: calls, executed: true }
    }

    if (memory.blindShotsSinceMove >= 8) {
      const relocated = await executeMove(tankId, memory, view, executeTool, calls, {
        kind: 'relocate',
      })
      if (relocated) return { toolCalls: calls, executed: true }
    }

    await executeShot(tankId, memory, view, executeTool, calls)
    return { toolCalls: calls, executed: true }
  }

  const exposureThreats = [...memory.enemies.values()]
    .filter((track) => track.alive)
    .map((track) => track.position)
  const firstIntent: MoveIntent =
    view.inEnemyFlare.length > 0
      ? { kind: 'escape-flare', threats: exposureThreats }
      : view.hp <= 1 && exposureThreats.length > 0
        ? { kind: 'evade', threats: exposureThreats }
        : explorationIntent(memory, view)

  const movement = await executeMove(tankId, memory, view, executeTool, calls, firstIntent)
  if (movement) {
    view = movement.worldview
    if (movement.turnEnded) return { toolCalls: calls, executed: true }
  }

  const acquiredTarget = chooseTarget(tankId, memory, view)
  if (acquiredTarget && view.remainingActions > 0) {
    const acquiredShot = await executeShot(tankId, memory, view, executeTool, calls, acquiredTarget)
    if (
      acquiredShot &&
      !acquiredShot.turnEnded &&
      acquiredShot.worldview.remainingActions > 0 &&
      (acquiredShot.result.kind === 'blocked' || acquiredShot.result.kind === 'invalid')
    ) {
      await executeMove(tankId, memory, acquiredShot.worldview, executeTool, calls, {
        kind: 'pursue',
        target: acquiredTarget.position,
      })
    }
    return { toolCalls: calls, executed: true }
  }

  if (view.remainingActions > 0 && view.inEnemyFlare.length > 0) {
    const secondEscape = await executeMove(tankId, memory, view, executeTool, calls, {
      kind: 'escape-flare',
      threats: exposureThreats,
    })
    if (secondEscape?.turnEnded || secondEscape?.result.kind === 'ok') {
      return { toolCalls: calls, executed: true }
    }
  }

  if (view.remainingActions > 0) {
    await executeShot(tankId, memory, view, executeTool, calls)
  }
  return { toolCalls: calls, executed: true }
}

/**
 * A deterministic combat agent tuned to the engine rather than to prose play.
 *
 * It uses the executor callback to react after movement, retains a probabilistic
 * tactical map, fires exact obstacle-aware trajectories at contacts, evades
 * after shooting, and sweeps unseen cells with non-repeating shell lanes. It
 * deliberately avoids self-serving flares: a flare occupies the shell slot and
 * expires before its firer acts again under the current turn schedule.
 */
export function createGpt56SolAgent(tankId: string, options: Gpt56SolAgentOptions = {}): TankAgent {
  const tankIndex = parseTankIndex(tankId)
  const memory: AgentMemory = {
    initialized: false,
    playerCount: Math.max(2, options.playerCount ?? 0, (tankIndex ?? 0) + 1),
    alivePlayerCount: 2,
    singleActionMode: false,
    width: options.mapWidth ?? 20,
    height: options.mapHeight ?? 20,
    widthConfirmed: options.mapWidth !== undefined,
    heightConfirmed: options.mapHeight !== undefined,
    localRadius: options.localRadius ?? 0,
    moveMax: options.moveMax ?? 2,
    shellMax: options.shellMaxRange ?? 10,
    tankHeight: options.shellTankHeight ?? ASSUMED_TANK_HEIGHT,
    apexHeight: options.shellApexHeight ?? ASSUMED_APEX_HEIGHT,
    obstacleHeight: options.obstacleHeight ?? 3,
    moveMaxConfigured: options.moveMax !== undefined,
    shellMaxConfigured: options.shellMaxRange !== undefined,
    knownCells: new Map(),
    observedTurn: new Map(),
    shotTurn: new Map(),
    shellObstacleCells: new Set(),
    positionVisits: new Map(),
    enemies: new Map(),
    lastAliveEnemyCount: Number.POSITIVE_INFINITY,
    blindShotsSinceMove: 0,
    serial: 0,
  }

  return {
    name: `gpt5.6-sol-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      updateMemory(memory, worldview)
      if (!executeTool) return planLegacyTurn(tankId, memory, worldview)
      return takeInteractiveTurn(tankId, memory, worldview, executeTool)
    },
  }
}

/** Filename-shaped alias for harnesses that preserve every model token. */
export const createGpt5_6SolAgent = createGpt56SolAgent

export default createGpt56SolAgent
