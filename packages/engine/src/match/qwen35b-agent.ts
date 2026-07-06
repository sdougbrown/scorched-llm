import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS } from '../geometry/coords.js'

/**
 * Persistent memory for the qwen35b agent.
 */
interface QwenMemory {
  sightings: Array<{ turn: number; x: number; y: number; hp: number; id: string }>
  lastKnownEnemyPos: Coordinate | null
  lastSeenTurn: number
  enemyTrend: { dx: number; dy: number } | null
  turnsBlind: number
  inEnemyFlare: boolean
}

// ── Geometry helpers ──────────────────────────────────────────────────────────

function bestDirectionTo(
  from: Coordinate,
  target: Coordinate,
  maxDist: number,
): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestDist = Infinity
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let dirBestDist = Infinity
    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step
      const d = euclidean({ x: cx, y: cy }, target)
      if (d < dirBestDist) dirBestDist = d
    }
    if (dirBestDist < bestDist) { bestDist = dirBestDist; best = dir }
  }
  return best
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return dirs[Math.round(b / 45) % 8]
}

function dist(a: Coordinate, b: Coordinate): number {
  return euclidean(a, b)
}

// ── Qwen35B Agent ─────────────────────────────────────────────────────────────

/**
 * Qwen35B Tank Agent — aggressive hunter.
 *
 * Key design: shell + move every turn when we have any intel.
 * Flare only when completely blind (no last known position).
 * Always move to improve position.
 */
export function createQwen35BAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: QwenMemory = {
    sightings: [],
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
    enemyTrend: null,
    turnsBlind: lastKnownEnemyPos === undefined ? 0 : 0,
    inEnemyFlare: false,
  }

  return {
    name: `qwen35b-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // ── Update memory ───────────────────────────────────────────────────

      memory.inEnemyFlare = worldview.inEnemyFlare.length > 0

      let closestEnemy: { id: string; pos: Coordinate; hp: number } | null = null
      let closestDist = Infinity

      for (const enemy of worldview.visibleEnemies ?? []) {
        memory.sightings.push({
          turn: worldview.turn, x: enemy.position.x,
          y: enemy.position.y, hp: enemy.hp, id: enemy.id,
        })
        const d = dist(worldview.position, enemy.position)
        if (d < closestDist) {
          closestDist = d
          closestEnemy = { id: enemy.id, pos: enemy.position, hp: enemy.hp }
        }
      }

      if (closestEnemy) {
        const wasLastKnown = memory.lastKnownEnemyPos
        memory.lastKnownEnemyPos = closestEnemy.pos
        memory.lastSeenTurn = worldview.turn
        memory.turnsBlind = 0
        if (wasLastKnown) {
          memory.enemyTrend = {
            dx: closestEnemy.pos.x - wasLastKnown.x,
            dy: closestEnemy.pos.y - wasLastKnown.y,
          }
        } else {
          memory.enemyTrend = { dx: 0, dy: 0 }
        }
      } else {
        memory.turnsBlind++
      }

      // ── State summary ───────────────────────────────────────────────────

      const hp = worldview.hp
      const isWounded = hp <= 1
      const hasSight = closestEnemy !== null
      const enemyPos = closestEnemy?.pos ?? { x: 10, y: 10 }
      const distToEnemy = hasSight
        ? dist(worldview.position, closestEnemy!.pos)
        : memory.lastKnownEnemyPos
          ? dist(worldview.position, memory.lastKnownEnemyPos)
          : Infinity

      // ── Decide: shell+move vs flare+move ────────────────────────────────

      // Always fire a shell when we have any intel (last known position).
      // Only flare when completely blind.
      const hasIntel = memory.lastKnownEnemyPos !== null

      if (hasIntel) {
        // ── SHELL + MOVE ─────────────────────────────────────────────────

        // Target position: current if visible, last known otherwise
        const targetPos = hasSight
          ? closestEnemy!.pos
          : memory.lastKnownEnemyPos!

        const shellAngle = bearing(worldview.position, targetPos)
        const shellDist = dist(worldview.position, targetPos)

        let power: number
        if (shellDist <= 2) {
          power = 2
        } else if (shellDist <= 5) {
          power = Math.max(2, Math.round(shellDist * 0.8))
        } else {
          power = Math.max(5, Math.min(10, Math.round(shellDist * 0.6)))
        }
        if (isWounded) power = Math.max(power, 6)
        if (Math.random() < 0.2) {
          power = Math.max(1, Math.min(10, power + (Math.random() < 0.5 ? -1 : 1)))
        }

        calls.push({
          id: `qwen-shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle: shellAngle, power },
        })

        // Movement logic
        const moveDir = computeMoveDir(
          worldview.position,
          enemyPos,
          hasSight,
          distToEnemy,
          hasIntel,
          memory.lastKnownEnemyPos,
          memory.inEnemyFlare,
          isWounded,
        )
        const moveDist = computeMoveDist(
          hasSight,
          distToEnemy,
          memory.inEnemyFlare,
          isWounded,
          hasIntel,
        )

        calls.push({
          id: `qwen-move-${worldview.turn}`,
          tool: { kind: 'move', direction: moveDir, distance: moveDist },
        })
      } else {
        // ── FLARE + MOVE (search mode) ───────────────────────────────────

        let fireDir: Direction
        let flareRange: number

        if (memory.inEnemyFlare) {
          fireDir = 'S'
          flareRange = 2
        } else {
          const center: Coordinate = { x: 10, y: 10 }
          fireDir = bearingToDirection(bearing(worldview.position, center))
          flareRange = 4
        }

        calls.push({
          id: `qwen-flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: fireDir, range: flareRange },
        })

        const center: Coordinate = { x: 10, y: 10 }
        const moveDir = bestDirectionTo(worldview.position, center, 2)
        calls.push({
          id: `qwen-move-${worldview.turn}`,
          tool: { kind: 'move', direction: moveDir, distance: 2 },
        })
      }

      return calls
    },
  }
}

// ── Movement helpers ──────────────────────────────────────────────────────────

function computeMoveDir(
  myPos: Coordinate,
  enemyPos: Coordinate,
  hasSight: boolean,
  distToEnemy: number,
  hasIntel: boolean,
  lastKnownPos: Coordinate | null,
  inEnemyFlare: boolean,
  isWounded: boolean,
): Direction {
  // Wounded + blind: move away from last known position
  if (isWounded && !hasSight && lastKnownPos) {
    const awayAngle = bearing(myPos, lastKnownPos)
    return bearingToDirection(awayAngle)
  }

  // In enemy flare: evade
  if (inEnemyFlare) {
    const awayAngle = bearing(enemyPos, myPos)
    return bearingToDirection(awayAngle)
  }

  // Moving toward enemy
  if (hasSight) {
    return bestDirectionTo(myPos, enemyPos, 2)
  }
  if (hasIntel && lastKnownPos) {
    return bestDirectionTo(myPos, lastKnownPos, 2)
  }

  // No intel: move toward center
  const center: Coordinate = { x: 10, y: 10 }
  return bestDirectionTo(myPos, center, 2)
}

function computeMoveDist(
  hasSight: boolean,
  distToEnemy: number,
  inEnemyFlare: boolean,
  isWounded: boolean,
  hasIntel: boolean,
): number {
  if (inEnemyFlare) return 2
  if (isWounded && !hasSight) return 2

  if (hasSight && distToEnemy > 4) return 2
  if (hasSight && distToEnemy > 2) return 1

  return 2
}