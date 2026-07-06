import type { WorldView } from '../types/events.js'
import type { ToolCall, ActionResult } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction, Cell } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS, inBounds } from '../geometry/coords.js'

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

// ---------------------------------------------------------------------------
// Qwen-27B — lethal scripted tank with predictive targeting & arc exploitation
// ---------------------------------------------------------------------------

/** Per-enemy position history entry. */
interface Sighting {
  turn: number
  x: number
  y: number
  hp: number
}

/** Persistent memory for Qwen-27B. */
interface QwenMemory {
  /** Per-enemy position history (newest last), capped per enemy. */
  enemies: Map<string, Sighting[]>
  /** Own position history for movement tracking. */
  ownHistory: Array<{ turn: number; x: number; y: number }>
  /** Known obstacle positions from local scan and flares. */
  knownObstacles: Set<string>
  /** Turns since last flare was fired. */
  turnsSinceFlare: number
  /** Map width (estimated from scan data + config defaults). */
  mapWidth: number
  /** Map height (estimated from scan data + config defaults). */
  mapHeight: number
  /** Compass directions already used for blind flare sweeps. */
  searchedDirs: Set<Direction>
}

const QWEN_MAX_SIGHTINGS = 16
const QWEN_MAX_OWN = 20
const QWEN_FLARE_COOLDOWN = 4
const QWEN_SAFE_FLARE_RANGE = 4 // > flareRadius so shooter stays hidden
const QWEN_OPTIMAL_RANGE = 6 // ideal distance for strafe-and-fire
const QWEN_INTEL_FRESH = 5 // max turns since sighting to fire confidently
const QWEN_INTEL_STALE = 7 // max turns before forcing a flare

/**
 * Predict enemy position one turn ahead using velocity from recent sightings.
 * Falls back to last-known position if insufficient data.
 */
function predictEnemyPos(history: Sighting[], currentTurn: number): Coordinate {
  if (history.length === 0) return { x: 0, y: 0 }
  const last = history[history.length - 1]

  if (history.length < 2) return { x: last.x, y: last.y }

  // Use last 4 sightings for velocity estimation
  const recent = history.slice(-Math.min(history.length, 4))
  if (recent.length < 2) return { x: last.x, y: last.y }

  // Weighted average velocity: more recent pairs count more
  let totalDx = 0, totalDy = 0, totalDt = 0, totalWeight = 0
  for (let i = 1; i < recent.length; i++) {
    const dt = recent[i].turn - recent[i - 1].turn
    if (dt <= 0) continue
    const weight = i // later pairs get higher weight
    totalDx += (recent[i].x - recent[i - 1].x) * weight
    totalDy += (recent[i].y - recent[i - 1].y) * weight
    totalDt += dt * weight
    totalWeight += weight
  }

  if (totalDt === 0) return { x: last.x, y: last.y }

  const avgVx = totalDx / totalDt
  const avgVy = totalDy / totalDt

  // Project forward: time since last sighting + 1 turn horizon
  const turnsAhead = (currentTurn - last.turn) + 1

  return {
    x: Math.round(last.x + avgVx * turnsAhead),
    y: Math.round(last.y + avgVy * turnsAhead),
  }
}

/** Clamp position to map bounds. */
function clampToMap(pos: Coordinate, width: number, height: number): Coordinate {
  return {
    x: Math.max(0, Math.min(width - 1, pos.x)),
    y: Math.max(0, Math.min(height - 1, pos.y)),
  }
}

/**
 * Rotate the direction list by a turn-dependent offset to avoid
 * predictable movement patterns. Same distances → different direction
 * preference each turn.
 */
function rotatedDirs(turn: number): Direction[] {
  const all: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const rot = turn % 8
  return [...all.slice(rot), ...all.slice(0, rot)]
}

/**
 * Find best move direction toward target, avoiding obstacles.
 * Direction evaluation order is rotated by turn to avoid predictability.
 */
function bestMoveToward(
  from: Coordinate,
  target: Coordinate,
  maxDist: number,
  obstacles: Set<string>,
  w: number,
  h: number,
  turn: number,
): { direction: Direction; distance: number } | null {
  const dirs = rotatedDirs(turn)
  let bestDir: Direction | null = null
  let bestDist = 0
  let bestFinal = Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let pathLen = 0
    let closest = Infinity

    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step
      if (!inBounds({ x: cx, y: cy }, w, h)) break
      if (obstacles.has(`${cx},${cy}`)) break
      pathLen = step
      const d = euclidean({ x: cx, y: cy }, target)
      if (d < closest) closest = d
    }

    if (pathLen > 0 && closest < bestFinal) {
      bestFinal = closest
      bestDir = dir
      bestDist = pathLen
    }
  }

  return bestDir ? { direction: bestDir, distance: bestDist } : null
}

/**
 * Find best move direction away from a threat, avoiding obstacles.
 * Direction evaluation order is rotated by turn to avoid predictability.
 */
function bestMoveAway(
  from: Coordinate,
  threat: Coordinate,
  maxDist: number,
  obstacles: Set<string>,
  w: number,
  h: number,
  turn: number,
): { direction: Direction; distance: number } | null {
  const dirs = rotatedDirs(turn)
  let bestDir: Direction | null = null
  let bestDist = 0
  let bestFinal = -Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let pathLen = 0
    let furthest = -Infinity

    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step
      if (!inBounds({ x: cx, y: cy }, w, h)) break
      if (obstacles.has(`${cx},${cy}`)) break
      pathLen = step
      const d = euclidean({ x: cx, y: cy }, threat)
      if (d > furthest) furthest = d
    }

    if (pathLen > 0 && furthest > bestFinal) {
      bestFinal = furthest
      bestDir = dir
      bestDist = pathLen
    }
  }

  return bestDir ? { direction: bestDir, distance: bestDist } : null
}

/**
 * Compute shell power: exact distance for accuracy, with slight
 * turn-based variation at longer range to avoid predictable patterns.
 */
function shellPower(dist: number, turn: number, maxRange: number): number {
  const rounded = Math.max(1, Math.min(maxRange, Math.round(dist)))
  if (rounded <= 3) return rounded // exact at close range
  const offset = ((turn * 7 + 3) % 3) - 1 // -1, 0, +1
  return Math.max(1, Math.min(maxRange, rounded + offset))
}

/**
 * Qwen-27B — lethal tank with predictive targeting, arc exploitation,
 * and adaptive engagement tactics.
 *
 * Core tactics:
 * 1. **Predictive leading**: Track enemy velocity vectors, fire at predicted
 *    position one turn ahead. Weighted velocity from last 4 sightings.
 * 2. **Shell arc exploitation**: Parabolic arc (height 1→5→1) clears
 *    mid-path obstacles. Only obstacles near endpoints block. This means
 *    we can fire through obstacle corridors that would block movement.
 * 3. **Distance management**: Maintain ~6 cells for optimal engagement.
 *    Strafe (move perpendicular) when too close, advance when too far.
 * 4. **Evasion priority**: When exposed in enemy flare, move away first,
 *    fire second. Survival > offense.
 * 5. **Smart flares**: Use range 4 (safe from self-reveal). Systematic
 *    directional sweep when blind. Only flare when intel is stale.
 * 6. **Obstacle awareness**: Track all known obstacles for movement
 *    planning. Use obstacles as cover when retreating.
 * 7. **Aggressive engagement**: Fire every turn with fresh intel (≤ 5 turns).
 *    Never waste a turn without an offensive action when intel allows.
 */
export function createQwen27BAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory: QwenMemory = {
    enemies: new Map(),
    ownHistory: [],
    knownObstacles: new Set(),
    turnsSinceFlare: 0,
    mapWidth: 20,
    mapHeight: 20,
    searchedDirs: new Set(),
  }

  // Seed with provided initial enemy position
  if (lastKnownEnemyPos) {
    memory.enemies.set('enemy-0', [
      { turn: lastSeenTurn ?? 0, x: lastKnownEnemyPos.x, y: lastKnownEnemyPos.y, hp: 2 },
    ])
  }

  return {
    name: `qwen-27b-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      const turn = worldview.turn
      const pos = worldview.position
      const calls: ToolCall[] = []

      // --- Update memory ---

      // Map size estimation from scan extent
      if (worldview.localScan.length > 0) {
        let maxX = 0, maxY = 0
        for (const c of worldview.localScan) {
          if (c.coord.x > maxX) maxX = c.coord.x
          if (c.coord.y > maxY) maxY = c.coord.y
        }
        memory.mapWidth = Math.max(memory.mapWidth, maxX + 6)
        memory.mapHeight = Math.max(memory.mapHeight, maxY + 6)
      }

      // Track obstacles from all visible cells
      for (const c of worldview.localScan) {
        if (c.terrain === 'obstacle') memory.knownObstacles.add(`${c.coord.x},${c.coord.y}`)
      }
      for (const fc of worldview.flaredCells) {
        if (fc.cell.terrain === 'obstacle') memory.knownObstacles.add(`${fc.cell.coord.x},${fc.cell.coord.y}`)
      }

      // Own position history
      const lastOwn = memory.ownHistory.at(-1)
      if (!lastOwn || lastOwn.x !== pos.x || lastOwn.y !== pos.y) {
        memory.ownHistory.push({ turn, x: pos.x, y: pos.y })
        if (memory.ownHistory.length > QWEN_MAX_OWN) memory.ownHistory.shift()
      }

      // Enemy tracking: record new sightings
      for (const enemy of worldview.visibleEnemies ?? []) {
        let hist = memory.enemies.get(enemy.id)
        if (!hist) {
          hist = []
          memory.enemies.set(enemy.id, hist)
        }
        const prev = hist.at(-1)
        const isNew = !prev ||
          prev.turn !== turn ||
          prev.x !== enemy.position.x ||
          prev.y !== enemy.position.y ||
          prev.hp !== enemy.hp
        if (isNew) {
          hist.push({ turn, x: enemy.position.x, y: enemy.position.y, hp: enemy.hp })
          if (hist.length > QWEN_MAX_SIGHTINGS) hist.shift()
        }
      }

      // Purge dead enemies
      for (const [id, hist] of memory.enemies) {
        if (hist.length > 0 && hist.at(-1)!.hp <= 0) {
          memory.enemies.delete(id)
        }
      }

      memory.turnsSinceFlare++
      const exposed = worldview.inEnemyFlare.length > 0
      const maxRange = Math.min(12, Math.floor(Math.min(memory.mapWidth, memory.mapHeight) * 0.6))

      // --- Select primary target (most recently sighted alive enemy) ---
      let targetLast: Coordinate | null = null
      let targetPredicted: Coordinate | null = null
      let intelAge = Infinity

      for (const [id, hist] of memory.enemies) {
        const last = hist.at(-1)
        if (!last) continue
        const age = turn - last.turn
        if (age < intelAge) {
          intelAge = age
          targetLast = { x: last.x, y: last.y }
          targetPredicted = clampToMap(
            predictEnemyPos(hist, turn),
            memory.mapWidth,
            memory.mapHeight,
          )
        }
      }

      const aimPos = targetPredicted ?? targetLast
      const hasTarget = targetLast !== null
      const intelFresh = intelAge <= QWEN_INTEL_FRESH
      const intelStale = intelAge > QWEN_INTEL_STALE

      // --- Offensive action (shell or flare, exclusive) ---
      let offensiveTaken = false

      // Fire shell: aim at predicted position, power = distance
      if (hasTarget && aimPos && intelFresh) {
        const dist = euclidean(pos, aimPos)
        if (dist <= maxRange) {
          calls.push({
            id: `shell-${turn}`,
            tool: { kind: 'fire_shell', angle: bearing(pos, aimPos), power: shellPower(dist, turn, maxRange) },
          })
          offensiveTaken = true
        }
      }

      // Flare: only when we need intel
      if (!offensiveTaken && worldview.aliveEnemyCount > 0) {
        const needFlare = !hasTarget || intelStale || memory.turnsSinceFlare >= QWEN_FLARE_COOLDOWN
        if (needFlare) {
          let flareDir: Direction | null = null

          if (targetLast) {
            flareDir = bearingToDirection(bearing(pos, targetLast))
          } else {
            // Systematic sweep: try each compass direction, skip searched ones
            const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
            for (const d of dirs) {
              if (!memory.searchedDirs.has(d)) { flareDir = d; break }
            }
            if (!flareDir) {
              memory.searchedDirs.clear()
              flareDir = 'N'
            }
          }

          // Validate flare target is in bounds
          if (flareDir) {
            const delta = DIRECTION_DELTAS[flareDir]
            const tx = pos.x + delta.dx * QWEN_SAFE_FLARE_RANGE
            const ty = pos.y + delta.dy * QWEN_SAFE_FLARE_RANGE
            if (inBounds({ x: tx, y: ty }, memory.mapWidth, memory.mapHeight)) {
              calls.push({
                id: `flare-${turn}`,
                tool: { kind: 'fire_flare', direction: flareDir, range: QWEN_SAFE_FLARE_RANGE },
              })
              offensiveTaken = true
              memory.turnsSinceFlare = 0
              memory.searchedDirs.add(flareDir)
            }
          }
        }
      }

      // --- Movement: always move when we have actions remaining ---
      // In double mode: offensive + move = 2 actions. Always use both.
      const actionsUsed = calls.length // 0 or 1 (offensive)
      const canMove = worldview.remainingActions > actionsUsed

      if (canMove) {
        let moveDir: Direction | null = null
        let moveDist = 1

        if (exposed && hasTarget && targetLast) {
          // Priority: get out of the enemy's flare cone
          const evade = bestMoveAway(pos, targetLast, 2, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn)
          if (evade) { moveDir = evade.direction; moveDist = evade.distance }
        } else if (hasTarget && aimPos) {
          const dist = euclidean(pos, aimPos)
          if (dist > QWEN_OPTIMAL_RANGE + 2) {
            // Too far: advance toward enemy
            const approach = bestMoveToward(pos, aimPos, 2, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn)
            if (approach) { moveDir = approach.direction; moveDist = approach.distance }
          } else if (dist < QWEN_OPTIMAL_RANGE - 2) {
            // Too close: strafe away to maintain optimal range
            const retreat = bestMoveAway(pos, aimPos, 2, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn)
            if (retreat) { moveDir = retreat.direction; moveDist = retreat.distance }
            // else: in optimal range — still move to stay unpredictable
            // Strafe perpendicular to enemy bearing
            if (!moveDir) {
              const strafe = bestMoveAway(pos, aimPos, 1, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn + 100)
              if (strafe) { moveDir = strafe.direction; moveDist = strafe.distance }
            }
          } else {
            // In optimal range: strafe perpendicular to stay unpredictable
            const strafe = bestMoveAway(pos, aimPos, 1, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn + 100)
            if (strafe) { moveDir = strafe.direction; moveDist = strafe.distance }
          }
        } else if (!hasTarget) {
          // Blind: move toward center for better flare coverage
          const center: Coordinate = { x: Math.floor(memory.mapWidth / 2), y: Math.floor(memory.mapHeight / 2) }
          const approach = bestMoveToward(pos, center, 2, memory.knownObstacles, memory.mapWidth, memory.mapHeight, turn)
          if (approach) { moveDir = approach.direction; moveDist = approach.distance }
        }

        if (moveDir) {
          calls.push({
            id: `move-${turn}`,
            tool: { kind: 'move', direction: moveDir, distance: moveDist },
          })
        }
      }

      // Safety net: always return at least one action
      if (calls.length === 0) {
        calls.push({ id: `pass-${turn}`, tool: { kind: 'pass' } })
      }

      return calls
    },
  }
}
