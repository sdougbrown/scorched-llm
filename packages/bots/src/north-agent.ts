import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'

/** Persistent memory for a scripted agent \u2014 tracks last-known enemy position. */
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
 * Compute a clockwise bearing (degrees from north, 0\u2011360) from `from` to `to`.
 * 0\u00b0 = north, 90\u00b0 = east, 180\u00b0 = south, 270\u00b0 = west.
 */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y // dy positive = south
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Round a bearing to the nearest 45\u00b0 and return the compass direction. */
function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]
  const idx = Math.round(b / 45) % 8
  return dirs[idx]
}

/**
 * NorthAgent \u2014 intelligent tactical agent that adapts based on map knowledge,
 * balances offense/defense, and uses information gathering strategically.
 *
 * Strategy:
 * 1. Uses 'look' to get immediate battlefield info and flare range
 * 2. Uses 'known_map' periodically to build complete map knowledge
 * 3. Targets enemies when visible, retreats when low health
 * 4. Moves toward center or away from danger to maintain positioning
 * 5. Fires shells with precise trajectory calculations when advantageous
 * 6. Fires flares when blinded or to maintain information advantage
 *
 * @param tankId - Identifier for this tank (used as suffix in name and call IDs).
 * @param lastKnownEnemyPos - Optional initial last-known enemy position.
 * @param lastSeenTurn - Optional turn when enemy was last seen.
 */
export function createNorthAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: AgentMemory = {
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
  }
  let turnsSinceLastIntel = 0
  let lastTurnKnownMapUsed = 0
  let healthCritical = false

  return {
    name: `north-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      const isMyTurn = worldview.isMyTurn
      if (!isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // Use known_map periodically to build complete map knowledge
      // Check if known_map tool is available
      const hasKnownMapTool = tools.some(tool => tool.name === 'known_map')
      if (hasKnownMapTool && worldview.turn - lastTurnKnownMapUsed >= 5) {
        calls.push({
          id: `known_map-${worldview.turn}`,
          tool: { kind: 'known_map' },
        })
        lastTurnKnownMapUsed = worldview.turn
      }

      // Use look to get immediate info and flare range
      const hasLookTool = tools.some(tool => tool.name === 'look')
      if (hasLookTool && turnsSinceLastIntel >= 2) {
        calls.push({
          id: `look-${worldview.turn}`,
          tool: { kind: 'look' },
        })
        turnsSinceLastIntel = 0
      }

      // Check if we're wounded - prioritize defense but still fire when possible
      if (worldview.hp <= 1) {
        healthCritical = true
        // When critical, flare to find cover and retreat
        if (turnsSinceLastIntel >= 2 && !calls.some(c => c.tool.kind === 'fire_flare')) {
          const fireDir = memory.lastKnownEnemyPos
            ? bearingToDirection(bearing(worldview.position, memory.lastKnownEnemyPos))
            : 'N'
          calls.push({
            id: `flare-${worldview.turn}`,
            tool: { kind: 'fire_flare', direction: fireDir, range: 5 },
          })
        }

        // Fire with reduced power when wounded (if enemy is visible)
        if (worldview.aliveEnemyCount > 0 && memory.lastKnownEnemyPos) {
          const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
          const dist = Math.round(
            euclidean(worldview.position, memory.lastKnownEnemyPos),
          )
          const power = Math.min(dist, 7) // Reduced max power when wounded
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', angle, power },
          })
        }

        // Move toward center for safer position when wounded
        const center: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, center, 3)
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })
        return calls
      }

      // Enemy visibility heuristic
      const enemyVisible =
        worldview.aliveEnemyCount > 0 &&
        memory.lastKnownEnemyPos !== null &&
        worldview.turn - memory.lastSeenTurn <= 2

      // --- Offensive actions ---
      if (enemyVisible && memory.lastKnownEnemyPos) {
        // Calculate precise shot
        const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
        const dist = Math.round(
          euclidean(worldview.position, memory.lastKnownEnemyPos),
        )
        const power = Math.max(1, Math.min(dist, 10))
        
        // Adjust power based on health - be more aggressive when healthy
        const adjustedPower = worldview.hp >= 2 ? power : Math.min(power, 7)
        
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power: adjustedPower },
        })

        // Move toward enemy after firing (aggressive positioning)
        if (worldview.remainingActions > 0) {
          const dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 3)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        }
      } else if (memory.lastKnownEnemyPos) {
        // Has intel but enemy not visible - continue approach or reposition
        if (worldview.aliveEnemyCount > 0) {
          // Try to get better position
          const center: Coordinate = { x: 10, y: 10 }
          const dirToCenter = bestDirectionTo(worldview.position, center, 3)
          const dirToEnemy = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 3)
          
          // Choose direction based on which is better
          const centerDist = euclidean(worldview.position, center)
          const enemyDist = euclidean(worldview.position, memory.lastKnownEnemyPos)
          
          const moveDir = centerDist < enemyDist ? dirToCenter : dirToEnemy
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: moveDir, distance: 1 },
          })
          
          // Fire high-power warning shot to test terrain
          const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', angle, power: 10 },
          })
        } else {
          // No enemy alive but we have memory - retreat toward center
          const center: Coordinate = { x: 10, y: 10 }
          const dir = bestDirectionTo(worldview.position, center, 3)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        }
      } else {
        // No enemy intel - explore and position
        const center: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, center, 3)
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })

        // Flare if we've been blind for a while
        if (turnsSinceLastIntel >= 3) {
          const fireDir = memory.lastKnownEnemyPos
            ? bearingToDirection(bearing(worldview.position, memory.lastKnownEnemyPos))
            : 'N'
          calls.push({
            id: `flare-${worldview.turn}`,
            tool: { kind: 'fire_flare', direction: fireDir, range: 5 },
          })
          turnsSinceLastIntel = 0
        }
      }

      // Update intel tracking
      if (memory.lastKnownEnemyPos === null) {
        turnsSinceLastIntel++
      } else if (worldview.aliveEnemyCount === 0) {
        turnsSinceLastIntel++
      } else {
        turnsSinceLastIntel = 0
      }

      return calls
    },
  }
}