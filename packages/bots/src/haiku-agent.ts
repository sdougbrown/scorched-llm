import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'

/** Persistent memory for the Haiku agent — tracks enemy intel and strategy state. */
interface HaikuMemory {
  /** Last known position of the enemy tank. */
  lastKnownEnemyPos: Coordinate | null
  /** Turn when the enemy was last seen. */
  lastSeenTurn: number
  /** Confidence in current enemy position (0-1). Decays over time. */
  positionConfidence: number
  /** Previous position to help predict movement. */
  previousEnemyPos: Coordinate | null
  /** How many turns since we've successfully hit the enemy. */
  turnsSinceLastHit: number
  /** Strategy phase: 'scout' | 'hunt' | 'strike' | 'evade' */
  strategyPhase: 'scout' | 'hunt' | 'strike' | 'evade'
  /** Last direction we fired a flare (to avoid immediate repeat). */
  lastFlareDirection: Direction | null
}

/**
 * Compute the compass direction that minimises Euclidean distance from
 * `from` along its straight line up to `maxDist`. Walks each direction's
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
 * Get next flare direction in a scanning pattern (scout mode).
 * Cycles through 8 directions to systematically search the map.
 */
function getNextScanDirection(lastDir: Direction | null, currentBearing: number): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]

  if (lastDir === null) {
    // Start with direction closest to north
    return dirs[0]
  }

  const currentIdx = dirs.indexOf(lastDir)
  const nextIdx = (currentIdx + 1) % dirs.length
  return dirs[nextIdx]
}

/**
 * Predict where the enemy will be based on observed movement pattern.
 * Uses last two positions to extrapolate trajectory.
 */
function predictEnemyPosition(
  lastPos: Coordinate,
  previousPos: Coordinate | null,
  turnsAhead: number = 1,
): Coordinate {
  if (previousPos === null) {
    return lastPos
  }

  // Calculate velocity vector
  const vx = lastPos.x - previousPos.x
  const vy = lastPos.y - previousPos.y

  // Extrapolate forward
  return {
    x: Math.round(lastPos.x + vx * turnsAhead),
    y: Math.round(lastPos.y + vy * turnsAhead),
  }
}

/**
 * Check if we have a clear line of sight (heuristic based on visible enemies).
 */
function hasVisualContact(worldview: WorldView): boolean {
  return (
    worldview.aliveEnemyCount > 0 &&
    worldview.visibleEnemies !== undefined &&
    worldview.visibleEnemies.length > 0
  )
}

/**
 * HaikuAgent — A balanced tank combining scouting, positioning, and adaptive tactics.
 * Strategy: Scout early, predict enemy movement, position strategically, strike decisively.
 *
 * @param tankId - Identifier for this tank (used as suffix in name).
 * @param lastKnownEnemyPos - Optional initial last-known enemy position.
 */
export function createHaikuAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: HaikuMemory = {
    lastKnownEnemyPos: lastKnownEnemyPos ?? null,
    lastSeenTurn: lastSeenTurn ?? (lastKnownEnemyPos !== undefined ? 0 : -999),
    positionConfidence: lastKnownEnemyPos !== undefined ? 0.8 : 0,
    previousEnemyPos: null,
    turnsSinceLastHit: 0,
    strategyPhase: lastKnownEnemyPos !== undefined ? 'hunt' : 'scout',
    lastFlareDirection: null,
  }

  return {
    name: `haiku-${tankId}`,
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

      // Update memory from visible enemies
      const visualContact = hasVisualContact(worldview)
      if (visualContact && worldview.visibleEnemies && worldview.visibleEnemies.length > 0) {
        const enemy = worldview.visibleEnemies[0]
        memory.previousEnemyPos = memory.lastKnownEnemyPos
        memory.lastKnownEnemyPos = enemy.position
        memory.lastSeenTurn = worldview.turn
        memory.positionConfidence = 1.0 // High confidence from direct observation
        memory.strategyPhase = 'strike'
        memory.turnsSinceLastHit += 1
      } else {
        // Decay confidence over time
        const turnsSinceSighting = worldview.turn - memory.lastSeenTurn
        memory.positionConfidence = Math.max(0, 0.8 - turnsSinceSighting * 0.2)

        if (memory.lastKnownEnemyPos !== null && turnsSinceSighting >= 3) {
          memory.strategyPhase = 'scout'
        } else if (memory.lastKnownEnemyPos !== null && turnsSinceSighting <= 1) {
          memory.strategyPhase = 'hunt'
        } else if (memory.lastKnownEnemyPos === null) {
          memory.strategyPhase = 'scout'
        }
      }

      const isWounded = worldview.hp <= 1

      // === ACTION DECISION LOGIC ===

      // Priority 1: FIRE if we have high-confidence enemy position and ammunition window
      if (
        memory.lastKnownEnemyPos !== null &&
        (memory.positionConfidence >= 0.7 || visualContact)
      ) {
        // Use predicted position for better accuracy
        const targetPos = predictEnemyPosition(
          memory.lastKnownEnemyPos,
          memory.previousEnemyPos,
          1,
        )

        const fireAngle = bearing(worldview.position, targetPos)
        const distance = Math.round(euclidean(worldview.position, targetPos))

        // Clamp power between 1-10
        const power = Math.max(1, Math.min(10, distance))

        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle: fireAngle, power },
        })
      }

      // Priority 2: MOVEMENT based on strategy phase
      if (memory.lastKnownEnemyPos !== null) {
        if (memory.strategyPhase === 'strike' && visualContact) {
          // When we see the enemy, move closer for next shot
          const dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 5)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        } else if (memory.strategyPhase === 'hunt' && !isWounded) {
          // Methodical advance toward last known position
          const dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 3)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        } else if (isWounded) {
          // When wounded, try to move away from known enemy position
          const awayPos: Coordinate = {
            x: worldview.position.x - (memory.lastKnownEnemyPos.x - worldview.position.x),
            y: worldview.position.y - (memory.lastKnownEnemyPos.y - worldview.position.y),
          }
          const dir = bestDirectionTo(worldview.position, awayPos, 5)
          calls.push({
            id: `move-${worldview.turn}`,
            tool: { kind: 'move', direction: dir, distance: 1 },
          })
        }
      } else {
        // No intel — move toward center to increase encounter probability
        const center: Coordinate = { x: 10, y: 10 }
        const dir = bestDirectionTo(worldview.position, center, 5)
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })
      }

      // Priority 3: FLARE for reconnaissance
      if (memory.strategyPhase === 'scout' || memory.positionConfidence < 0.3) {
        // Scout mode: systematic flare pattern
        const flareDir = getNextScanDirection(memory.lastFlareDirection, 0)
        memory.lastFlareDirection = flareDir

        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: flareDir, range: 5 },
        })
      } else if (memory.lastKnownEnemyPos !== null && memory.positionConfidence < 0.8) {
        // Hunt mode: flare toward predicted enemy position
        const predictionDir = bearingToDirection(
          bearing(worldview.position, memory.lastKnownEnemyPos),
        )
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: predictionDir, range: 5 },
        })
      } else if (visualContact && worldview.turn % 3 === 0) {
        // During visual contact, periodically flare to track enemy movement
        const dir = bearingToDirection(
          bearing(worldview.position, memory.lastKnownEnemyPos!),
        )
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: dir, range: 5 },
        })
      }

      // Fallback: if we have no actions yet, pass
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
