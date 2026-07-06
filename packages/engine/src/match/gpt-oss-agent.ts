// gpt-oss-agent.ts
// A more sophisticated tank agent leveraging game engine utilities.

import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS } from '../geometry/coords.js'

/** Persistent memory for the GPT‑OSS agent. */
interface AgentMemory {
  /** Last known enemy position, if any. */
  lastKnownEnemyPos: Coordinate | null
  /** Turn when the enemy was last observed. */
  lastSeenTurn: number
  /** Counter for turns since we last used a flare for intel. */
  turnsSinceFlare: number
}

/** Compute the compass bearing (degrees clockwise from north) from `from` to `to`. */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y // positive = south
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Convert a bearing to the nearest cardinal/intercardinal direction. */
function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round(b / 45) % 8
  return dirs[idx]
}

/** Choose a direction that maximises distance from the target, up to `maxDist`. */
function furthestDirection(from: Coordinate, target: Coordinate, maxDist: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestDist = -Infinity
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    // Evaluate the cell `maxDist` steps away in this direction.
    const cx = from.x + delta.dx * maxDist
    const cy = from.y + delta.dy * maxDist
    const d = euclidean({ x: cx, y: cy }, target)
    if (d > bestDist) {
      bestDist = d
      best = dir
    }
  }
  return best
}

/** Compute the best direction (up to `maxDist`) that brings us closer to the target. */
function bestDirectionTo(from: Coordinate, target: Coordinate, maxDist: number): Direction {
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
    if (dirBestDist < bestDist) {
      bestDist = dirBestDist
      best = dir
    }
  }
  return best
}

/**
 * createGptOssAgent – a tactical agent that
 *   • tracks enemy intel,
 *   • keeps a safe distance (4‑8 cells) to survive longer,
 *   • uses flares every 2‑3 turns when blind,
 *   • retreats to centre when low HP,
 *   • fires with power proportional to distance.
 */
export function createGptOssAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: AgentMemory = {
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
    turnsSinceFlare: 0,
  }

  return {
    name: `gpt-oss-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (worldview: WorldView, _tools: ToolSpec[]): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // Update intel memory if we see an enemy this turn.
      if (worldview.aliveEnemyCount > 0 && worldview.visibleEnemies?.length) {
        const enemy = worldview.visibleEnemies[0] // engine currently reports a single enemy.
        memory.lastKnownEnemyPos = { x: enemy.position.x, y: enemy.position.y }
        memory.lastSeenTurn = worldview.turn
      }

      const enemyKnown = memory.lastKnownEnemyPos !== null
      const distanceToEnemy = enemyKnown
        ? euclidean(worldview.position, memory.lastKnownEnemyPos!)
        : null

      // ---------- Flare logic ----------
      // Fire a flare if we have no intel for 2 turns or every 3rd turn otherwise.
      if (!enemyKnown) {
        memory.turnsSinceFlare++
        if (memory.turnsSinceFlare >= 2) {
          calls.push({
            id: `flare-${worldview.turn}`,
            tool: { kind: 'fire_flare', direction: 'N', range: 5 },
          })
          memory.turnsSinceFlare = 0
        }
      } else {
        // Reset counter when we have intel.
        memory.turnsSinceFlare = 0
      }

      // ---------- Firing logic ----------
      if (enemyKnown && distanceToEnemy !== null) {
        // Only fire when we have recent intel (≤2 turns ago).
        if (worldview.turn - memory.lastSeenTurn <= 2) {
          const angle = bearing(worldview.position, memory.lastKnownEnemyPos!)
          const power = Math.max(1, Math.min(Math.round(distanceToEnemy), 10))
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', angle, power },
          })
        }
      }

      // ---------- Movement logic ----------
      // If low HP, retreat to centre of map.
      const isWounded = worldview.hp < 2
      if (isWounded) {
        const centre: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, centre, 5)
        calls.push({ id: `move-${worldview.turn}`, tool: { kind: 'move', direction: dir, distance: 1 } })
        return calls
      }

      if (enemyKnown && distanceToEnemy !== null) {
        if (distanceToEnemy < 4) {
          // Too close – move away.
          const awayDir = furthestDirection(worldview.position, memory.lastKnownEnemyPos!, 5)
          calls.push({ id: `move-${worldview.turn}`, tool: { kind: 'move', direction: awayDir, distance: 1 } })
        } else if (distanceToEnemy > 8) {
          // Too far – close in.
          const towardsDir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos!, 5)
          calls.push({ id: `move-${worldview.turn}`, tool: { kind: 'move', direction: towardsDir, distance: 1 } })
        } else {
          // Ideal distance – stay put (maybe a small jitter to avoid being predictable).
          // Occasionally reposition on even turns.
          if (worldview.turn % 4 === 0) {
            const jitterDir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos!, 3)
            calls.push({ id: `move-${worldview.turn}`, tool: { kind: 'move', direction: jitterDir, distance: 1 } })
          }
        }
      } else {
        // No intel – explore towards centre.
        const centre: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, centre, 5)
        calls.push({ id: `move-${worldview.turn}`, tool: { kind: 'move', direction: dir, distance: 1 } })
      }

      // If we ended up with no actions (unlikely), pass.
      if (calls.length === 0) {
        calls.push({ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } })
      }

      return calls
    },
  }
}
