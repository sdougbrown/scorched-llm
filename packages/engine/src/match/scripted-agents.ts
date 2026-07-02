import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS } from '../geometry/coords.js'

/** Persistent memory for a scripted agent — tracks last-known enemy position. */
interface AgentMemory {
  /** Last known position of the enemy tank. */
  lastKnownEnemyPos: Coordinate | null
  /** Turn when the enemy was last known to be alive/seen. */
  lastSeenTurn: number
}

/**
 * Compute the compass direction that minimises Euclidean distance from
 * `from` along its straight line up to `maxDist`.  Walks each direction's
 * ray and returns the direction whose closest cell is nearest to `target`.
 */
function bestDirectionTo(
  from: Coordinate,
  target: Coordinate,
  maxDist: number,
): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]
  let best: Direction = 'N'
  let bestDist = Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let dirBestDist = Infinity
    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step
      const d = euclidean({ x: cx, y: cy }, target)
      if (d < dirBestDist) {
        dirBestDist = d
      }
    }
    if (dirBestDist < bestDist) {
      bestDist = dirBestDist
      best = dir
    }
  }

  return best
}

/**
 * Compute a clockwise bearing (degrees from north, 0–360) from `from` to `to`.
 * 0° = north, 90° = east, 180° = south, 270° = west.
 */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y // dy positive = south
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Round a bearing to the nearest 45° and return the compass direction. */
function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]
  const idx = Math.round(b / 45) % 8
  return dirs[idx]
}

/**
 * AggressiveAgent — advances toward last-known enemy, fires on sight,
 * probes with flares when blind.
 *
 * @param tankId - Identifier for this tank (used as suffix in name and call IDs).
 * @param lastKnownEnemyPos - Optional initial last-known enemy position.
 */
export function createAggressiveAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: AgentMemory = {
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
  }
  let turnsSinceLastIntel = 0
  if (lastKnownEnemyPos !== undefined) {
    turnsSinceLastIntel = 0
  }

  return {
    name: `aggressive-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      const isMyTurn = worldview.isMyTurn
      if (!isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // Heuristic: consider the enemy "visible" when we have recent intel
      // (last seen within 2 turns) and the enemy is still reported alive.
      const enemyVisible =
        worldview.aliveEnemyCount > 0 &&
        memory.lastKnownEnemyPos !== null &&
        worldview.turn - memory.lastSeenTurn <= 2

      // --- Shell actions ---
      if (enemyVisible && memory.lastKnownEnemyPos) {
        // Fire shell at known enemy position with computed power
        const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
        const dist = Math.round(
          euclidean(worldview.position, memory.lastKnownEnemyPos),
        )
        const clampedPower = Math.max(1, Math.min(dist, 10))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power: clampedPower },
        })
      } else if (memory.lastKnownEnemyPos) {
        // No current intel — fire max power toward last known position
        const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power: 10 },
        })
      }

      // --- Movement ---
      if (memory.lastKnownEnemyPos) {
        const dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 5)
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })
      } else {
        // No intel — move toward center of map
        const center: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, center, 5)
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })
      }

      // --- Flare when blind ---
      if (memory.lastKnownEnemyPos === null) {
        turnsSinceLastIntel++
      } else if (worldview.aliveEnemyCount === 0) {
        turnsSinceLastIntel++
      } else {
        turnsSinceLastIntel = 0
      }

      if (turnsSinceLastIntel >= 2) {
        const fireDir = memory.lastKnownEnemyPos
          ? bearingToDirection(bearing(worldview.position, memory.lastKnownEnemyPos))
          : 'N'
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: fireDir, range: 5 },
        })
        turnsSinceLastIntel = 0
      }

      return calls
    },
  }
}

/**
 * ConservativeAgent — holds position, flares periodically, fires only
 * on direct sight.
 */
export function createConservativeAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: AgentMemory = {
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
  }
  let flareToggle = false

  return {
    name: `conservative-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      const isMyTurn = worldview.isMyTurn
      if (!isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // --- Flare every other turn ---
      if (!flareToggle) {
        const fireDir = memory.lastKnownEnemyPos
          ? bearingToDirection(bearing(worldview.position, memory.lastKnownEnemyPos))
          : 'N'
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: fireDir, range: 5 },
        })
      }
      flareToggle = !flareToggle

      // --- Movement (only when not wounded) ---
      const isWounded = worldview.hp < 2
      if (!isWounded && memory.lastKnownEnemyPos) {
        // Move only on non-flare turns — slow advance
        if (flareToggle) {
          const dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 3)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        }
      }

      // --- Fire only on direct sight ---
      // Heuristic: fire when we have very recent intel (≤ 1 turn ago).
      if (
        worldview.aliveEnemyCount > 0 &&
        memory.lastKnownEnemyPos !== null &&
        worldview.turn - memory.lastSeenTurn <= 1
      ) {
        const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
        const dist = Math.round(
          euclidean(worldview.position, memory.lastKnownEnemyPos),
        )
        const clampedPower = Math.max(1, Math.min(dist, 10))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power: clampedPower },
        })
      }

      // If no actions so far, pass
      if (calls.length === 0) {
        calls.push({
          id: `pass-${worldview.turn}`,
          tool: { kind: 'pass' },
        })
      }

      return calls
    },
  }
}
