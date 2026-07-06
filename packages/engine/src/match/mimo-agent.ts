/**
 * MIMO Tank Agent — a highly tactical scripted tank for scorched-llm.
 *
 * Strategy:
 * - Aggressive early scouting with directional flares to find the enemy
 * - Once spotted, close distance and fire with precise ballistic solutions
 * - Obstacle-aware path checking for both movement and shell trajectories
 * - Predictive enemy tracking: leads shots based on observed velocity
 * - Adaptive: retreats when wounded, presses when enemy is weak
 *
 * Key design decisions:
 * - Flares every turn when blind (no reason to wait)
 * - Always moves toward strategic position (center early, enemy mid/late)
 * - Fires at last-known enemy position even from scout phase when intel is fresh
 * - Movement has multi-direction fallback so it never gets stuck
 */

import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { Coordinate, Direction } from '../types/coords.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_SHELL_RANGE = 10
const MOVE_MAX = 2 // defaults to flareRadius in duel preset
const SHELL_APEX_HEIGHT = 5
const SHELL_TANK_HEIGHT = 1

const DIRECTION_DELTAS: Record<Direction, { dx: number; dy: number }> = {
  N:  { dx:  0, dy: -1 },
  NE: { dx:  1, dy: -1 },
  E:  { dx:  1, dy:  0 },
  SE: { dx:  1, dy:  1 },
  S:  { dx:  0, dy:  1 },
  SW: { dx: -1, dy:  1 },
  W:  { dx: -1, dy:  0 },
  NW: { dx: -1, dy: -1 },
}

const ALL_DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

// ─── Geometry helpers ────────────────────────────────────────────────────────

function euclidean(a: Coordinate, b: Coordinate): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function clampMap(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(width - 1, x)),
    y: Math.max(0, Math.min(height - 1, y)),
  }
}

// ─── Known map ──────────────────────────────────────────────────────────────

interface MapCell {
  terrain: 'open' | 'obstacle'
  obstacleHeight: number
}

class KnownMap {
  cells = new Map<string, MapCell>()
  width = 20
  height = 20

  observe(cells: Array<{ coord: Coordinate; terrain: 'open' | 'obstacle'; obstacleHeight: number }>): void {
    for (const cell of cells) {
      this.cells.set(`${cell.coord.x},${cell.coord.y}`, {
        terrain: cell.terrain,
        obstacleHeight: cell.obstacleHeight,
      })
    }
  }

  get(x: number, y: number): MapCell | undefined {
    return this.cells.get(`${x},${y}`)
  }

  isPassable(x: number, y: number): boolean {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return false
    const c = this.get(x, y)
    return c === undefined || c.terrain === 'open'
  }

  isRevealed(x: number, y: number): boolean {
    return this.cells.has(`${x},${y}`)
  }
}

// ─── Shell trajectory ───────────────────────────────────────────────────────

function shellHeight(i: number, N: number): number {
  if (N <= 0) return SHELL_TANK_HEIGHT
  const progress = (i + 1) / N
  const arc = 4 * progress * (1 - progress)
  return SHELL_TANK_HEIGHT + (SHELL_APEX_HEIGHT - SHELL_TANK_HEIGHT) * arc
}

function isShellPathClear(from: Coordinate, to: Coordinate, map: KnownMap): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  if (steps === 0) return true

  for (let i = 1; i < steps; i++) {
    const t = i / steps
    const cx = Math.round(from.x + dx * t)
    const cy = Math.round(from.y + dy * t)
    if (cx < 0 || cx >= map.width || cy < 0 || cy >= map.height) continue

    const cell = map.get(cx, cy)
    if (cell && cell.terrain === 'obstacle') {
      const height = shellHeight(i, steps)
      if (height <= cell.obstacleHeight) {
        return false
      }
    }
  }
  return true
}

function computeFiringSolution(
  from: Coordinate,
  to: Coordinate,
  map: KnownMap,
): { angle: number; power: number } | null {
  const dist = euclidean(from, to)
  if (dist < 1 || dist > MAX_SHELL_RANGE) return null

  const angle = bearing(from, to)
  const power = Math.round(dist)

  if (isShellPathClear(from, to, map)) {
    return { angle, power }
  }

  // Try angle variations to find a path around obstacles
  for (const offset of [5, -5, 10, -10, 15, -15, 20, -20]) {
    const tryAngle = (angle + offset + 360) % 360
    const rad = (tryAngle * Math.PI) / 180
    const tryTarget: Coordinate = {
      x: Math.round(from.x + Math.sin(rad) * power),
      y: Math.round(from.y - Math.cos(rad) * power),
    }
    if (tryTarget.x < 0 || tryTarget.x >= map.width || tryTarget.y < 0 || tryTarget.y >= map.height) continue
    if (isShellPathClear(from, tryTarget, map)) {
      return { angle: tryAngle, power }
    }
  }

  // Last resort: fire anyway
  return { angle, power }
}

// ─── Movement ───────────────────────────────────────────────────────────────

function findMovableDirection(
  from: Coordinate,
  target: Coordinate,
  map: KnownMap,
  preferCloser: boolean,
): Direction | null {
  // Score each direction: prefer the one that gets closest (or farthest) to target
  // while being actually movable
  const candidates: Array<{ dir: Direction; dist: number; step: number }> = []

  for (const dir of ALL_DIRECTIONS) {
    const delta = DIRECTION_DELTAS[dir]
    for (let step = MOVE_MAX; step >= 1; step--) {
      const nx = from.x + delta.dx * step
      const ny = from.y + delta.dy * step
      if (!map.isPassable(nx, ny)) continue
      // Check all intermediate cells
      let passable = true
      for (let s = 1; s <= step; s++) {
        if (!map.isPassable(from.x + delta.dx * s, from.y + delta.dy * s)) {
          passable = false
          break
        }
      }
      if (passable) {
        candidates.push({ dir, dist: euclidean({ x: nx, y: ny }, target), step })
        break // Take longest valid step in this direction
      }
    }
  }

  if (candidates.length === 0) return null

  // Sort by distance to target
  candidates.sort((a, b) => preferCloser ? a.dist - b.dist : b.dist - a.dist)
  return candidates[0].dir
}

function findAnyMovableDirection(from: Coordinate, map: KnownMap): Direction | null {
  // Just find any direction we can move in
  for (const dir of ALL_DIRECTIONS) {
    const delta = DIRECTION_DELTAS[dir]
    for (let step = MOVE_MAX; step >= 1; step--) {
      const nx = from.x + delta.dx * step
      const ny = from.y + delta.dy * step
      if (!map.isPassable(nx, ny)) continue
      let passable = true
      for (let s = 1; s <= step; s++) {
        if (!map.isPassable(from.x + delta.dx * s, from.y + delta.dy * s)) {
          passable = false
          break
        }
      }
      if (passable) return dir
    }
  }
  return null
}

// ─── MIMO Agent ─────────────────────────────────────────────────────────────

interface MimoMemory {
  map: KnownMap
  lastKnownEnemyPos: Coordinate | null
  lastSeenTurn: number
  lastKnownEnemyHp: number
  /** Velocity tracking for prediction */
  prevEnemyPos: Coordinate | null
  prevPrevEnemyPos: Coordinate | null
  turnsSinceLastFlare: number
}

/** Compute a predicted enemy position based on velocity. */
function predictEnemyPosition(
  last: Coordinate,
  prev: Coordinate | null,
  mapWidth: number,
  mapHeight: number,
): Coordinate {
  if (!prev) return last
  const vx = last.x - prev.x
  const vy = last.y - prev.y
  return clampMap(last.x + vx, last.y + vy, mapWidth, mapHeight)
}

/** Get the best target position: prefer prediction, fall back to last known. */
function bestTarget(
  lastKnown: Coordinate | null,
  prev: Coordinate | null,
  currentTurn: number,
  lastSeenTurn: number,
): Coordinate | null {
  if (!lastKnown) return null
  const turnsSinceSeen = currentTurn - lastSeenTurn
  if (turnsSinceSeen <= 1 && prev) {
    return predictEnemyPosition(lastKnown, prev, 20, 20)
  }
  return lastKnown
}

export function createMimoAgent(tankId: string): TankAgent {
  const memory: MimoMemory = {
    map: new KnownMap(),
    lastKnownEnemyPos: null,
    lastSeenTurn: -999,
    lastKnownEnemyHp: 2,
    prevEnemyPos: null,
    prevPrevEnemyPos: null,
    turnsSinceLastFlare: 99,
  }

  let idCounter = 0
  const nextId = (prefix: string) => `${prefix}-${tankId}-${++idCounter}`

  return {
    name: `mimo-${tankId}`,
    messages: [] as AgentMessage[],

    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      if (!worldview.isMyTurn) {
        return [{ id: nextId('pass'), tool: { kind: 'pass' } }]
      }

      // ── Update map from all visible cells ──
      memory.map.observe(worldview.localScan)
      for (const fc of worldview.flaredCells) {
        memory.map.observe([fc.cell])
      }

      // ── Update enemy tracking ──
      const visibleEnemies = worldview.visibleEnemies ?? []
      if (visibleEnemies.length > 0) {
        // Take the first (or closest) visible enemy
        const enemy = visibleEnemies[0]
        memory.prevPrevEnemyPos = memory.prevEnemyPos
        memory.prevEnemyPos = memory.lastKnownEnemyPos
        memory.lastKnownEnemyPos = { ...enemy.position }
        memory.lastKnownEnemyHp = enemy.hp
        memory.lastSeenTurn = worldview.turn
      }

      memory.turnsSinceLastFlare++

      const pos = worldview.position
      const hp = worldview.hp
      const enemyPos = memory.lastKnownEnemyPos
      const enemyRecentlySeen = memory.lastSeenTurn >= 0 && (worldview.turn - memory.lastSeenTurn) <= 3
      const enemyWounded = memory.lastKnownEnemyHp < 2
      const weAreWounded = hp < 2

      // ── Determine strategy ──
      if (enemyRecentlySeen && enemyPos) {
        // We know where the enemy is — engage!
        return engageOrKill(pos, hp, enemyPos, enemyWounded, weAreWounded, memory, calls, nextId, worldview)
      } else {
        // Don't know where enemy is — scout aggressively
        return scout(pos, hp, memory, calls, nextId, worldview)
      }
    },
  }
}

// ─── Scout Phase ────────────────────────────────────────────────────────────

function scout(
  pos: Coordinate,
  hp: number,
  memory: MimoMemory,
  calls: ToolCall[],
  nextId: (prefix: string) => string,
  worldview: WorldView,
): ToolCall[] {
  // Action 1: Always flare to scout (every turn when blind)
  if (memory.turnsSinceLastFlare >= 1) {
    const flareDir = pickScoutDirection(pos, memory)
    const flareRange = computeScoutFlareRange(pos, flareDir, memory)
    calls.push({
      id: nextId('flare'),
      tool: { kind: 'fire_flare', direction: flareDir, range: flareRange },
    })
    memory.turnsSinceLastFlare = 0
  }

  // Action 2: Move toward least-explored quadrant
  const target = pickScoutMovementTarget(pos, memory)
  const dir = findMovableDirection(pos, target, memory.map, true)
  if (dir) {
    calls.push({
      id: nextId('move'),
      tool: { kind: 'move', direction: dir, distance: MOVE_MAX },
    })
  }

  return calls.length > 0 ? calls : [{ id: nextId('pass'), tool: { kind: 'pass' } }]
}

// ─── Engage / Kill Phase ────────────────────────────────────────────────────

function engageOrKill(
  pos: Coordinate,
  hp: number,
  enemyPos: Coordinate,
  enemyWounded: boolean,
  weAreWounded: boolean,
  memory: MimoMemory,
  calls: ToolCall[],
  nextId: (prefix: string) => string,
  worldview: WorldView,
): ToolCall[] {
  const target = bestTarget(
    memory.lastKnownEnemyPos,
    memory.prevEnemyPos,
    worldview.turn,
    memory.lastSeenTurn,
  ) ?? enemyPos

  const dist = euclidean(pos, target)

  // Action 1: Fire if in range
  if (dist <= MAX_SHELL_RANGE) {
    const solution = computeFiringSolution(pos, target, memory.map)
    if (solution) {
      calls.push({
        id: nextId('shell'),
        tool: { kind: 'fire_shell', angle: solution.angle, power: solution.power },
      })
    }
  }

  // Action 2: Move tactically
  if (weAreWounded && dist < 4) {
    // Too close and wounded — retreat
    const dir = findMovableDirection(pos, target, memory.map, false) // move AWAY
    if (dir) {
      calls.push({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: MOVE_MAX } })
    }
  } else if (dist > 4 && dist <= MAX_SHELL_RANGE) {
    // Good firing range — hold position for accuracy (don't move)
  } else if (dist > MAX_SHELL_RANGE) {
    // Out of range — close distance
    const dir = findMovableDirection(pos, target, memory.map, true)
    if (dir) {
      calls.push({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: MOVE_MAX } })
    }
  } else if (dist <= 3 && !weAreWounded) {
    // Very close and healthy — maintain pressure, maybe strafe
    const dir = findAnyMovableDirection(pos, memory.map)
    if (dir) {
      calls.push({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: MOVE_MAX } })
    }
  }

  return calls.length > 0 ? calls : [{ id: nextId('pass'), tool: { kind: 'pass' } }]
}

// ─── Flare Strategy ─────────────────────────────────────────────────────────

function pickScoutDirection(pos: Coordinate, memory: MimoMemory): Direction {
  // Compute a "heat map" of unrevealed cells in each direction
  // Prefer directions that lead to the most unrevealed territory
  const center: Coordinate = { x: 10, y: 10 }
  const dirScores: Array<{ dir: Direction; unrevealed: number; distToCenter: number }> = []

  for (const dir of ALL_DIRECTIONS) {
    const delta = DIRECTION_DELTAS[dir]
    let unrevealed = 0

    // Sample cells at ranges 3-6 in this direction (flare landing zones)
    for (let range = 3; range <= 6; range++) {
      const lx = pos.x + delta.dx * range
      const ly = pos.y + delta.dy * range
      if (lx < 0 || lx >= 20 || ly < 0 || ly >= 20) continue
      // Count unrevealed cells in flare radius around landing point
      for (let dx = -2; dx <= 2; dx++) {
        for (let dy = -2; dy <= 2; dy++) {
          if (dx * dx + dy * dy > 4) continue
          const tx = lx + dx
          const ty = ly + dy
          if (tx < 0 || tx >= 20 || ty < 0 || ty >= 20) continue
          if (!memory.map.isRevealed(tx, ty)) unrevealed++
        }
      }
    }

    const targetX = pos.x + delta.dx * 5
    const targetY = pos.y + delta.dy * 5
    const distToCenter = euclidean(
      { x: Math.max(0, Math.min(19, targetX)), y: Math.max(0, Math.min(19, targetY)) },
      center,
    )
    dirScores.push({ dir, unrevealed, distToCenter })
  }

  // Prefer directions with more unrevealed cells; break ties by preferring
  // directions that point toward the map center (since the enemy likely isn't
  // in a corner they've been pushed toward)
  dirScores.sort((a, b) => {
    if (b.unrevealed !== a.unrevealed) return b.unrevealed - a.unrevealed
    return a.distToCenter - b.distToCenter
  })

  return dirScores[0].dir
}

function computeScoutFlareRange(pos: Coordinate, dir: Direction, memory: MimoMemory): number {
  const delta = DIRECTION_DELTAS[dir]
  // Find the maximum range that stays in bounds
  let maxRange = 1
  for (let r = 1; r <= 8; r++) {
    const cx = pos.x + delta.dx * r
    const cy = pos.y + delta.dy * r
    if (cx < 0 || cx >= memory.map.width || cy < 0 || cy >= memory.map.height) break
    maxRange = r
  }
  // Prefer range 3-5 for good coverage without self-reveal
  return Math.max(3, Math.min(5, maxRange))
}

function pickScoutMovementTarget(pos: Coordinate, memory: MimoMemory): Coordinate {
  // Divide map into 4 quadrants and count revealed cells in each
  const quadrants = [
    { x: 5, y: 5, revealed: 0 },   // NW
    { x: 15, y: 5, revealed: 0 },  // NE
    { x: 5, y: 15, revealed: 0 },  // SW
    { x: 15, y: 15, revealed: 0 }, // SE
  ]

  for (const [key] of memory.map.cells) {
    const [x, y] = key.split(',').map(Number)
    if (x < 10 && y < 10) quadrants[0].revealed++
    else if (x >= 10 && y < 10) quadrants[1].revealed++
    else if (x < 10 && y >= 10) quadrants[2].revealed++
    else quadrants[3].revealed++
  }

  // Move toward the quadrant with fewest revealed cells
  quadrants.sort((a, b) => a.revealed - b.revealed)
  return quadrants[0]
}
