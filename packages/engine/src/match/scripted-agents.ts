import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS, manhattan } from '../geometry/coords.js'

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

// ─── DeepSeek Agent ───────────────────────────────────────────────────────────

interface Sighting {
  turn: number
  x: number
  y: number
  hp: number
}

interface DeepSeekMemory {
  sightings: Sighting[]
  lastKnownEnemyPos: Coordinate | null
  lastKnownEnemyHp: number
  lastSeenTurn: number
  searchStep: number
  turnsSinceFlare: number
  consecutiveMisses: number
  /** Sweep phase: 0=reach-center, 1+ sweeps in 8 directions */
  sweepPhase: number
  /** Steps taken within current sweep */
  sweepTick: number
  /** Last position (to detect being stuck) */
  lastPos: Coordinate | null
  /** Consecutive blocked moves */
  blockedStreak: number
}

const SEARCH_DIRECTIONS: Direction[] = [
  'N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW',
]

/**
 * Compute velocity (cells per round) from consecutive sightings.
 */
function estimateVelocity(
  sightings: Sighting[],
): { vx: number; vy: number } {
  if (sightings.length < 2) return { vx: 0, vy: 0 }
  const last = sightings[sightings.length - 1]
  const prev = sightings[sightings.length - 2]
  const dt = last.turn - prev.turn
  if (dt <= 0) return { vx: 0, vy: 0 }
  return {
    vx: (last.x - prev.x) / dt,
    vy: (last.y - prev.y) / dt,
  }
}

/**
 * Predict enemy position at current turn given sighting history.
 */
function predictPosition(
  sightings: Sighting[],
  currentTurn: number,
): Coordinate {
  if (sightings.length === 0) return { x: 10, y: 10 }
  const last = sightings[sightings.length - 1]
  if (sightings.length < 2 || last.turn === currentTurn) {
    return { x: last.x, y: last.y }
  }
  const vel = estimateVelocity(sightings)
  const dt = currentTurn - last.turn
  return {
    x: Math.round(last.x + vel.vx * dt),
    y: Math.round(last.y + vel.vy * dt),
  }
}

/**
 * Compute the compass direction that maximises distance from `target`
 * while heading roughly perpendicular. Used for lateral movement after firing.
 */
function lateralDirection(
  from: Coordinate,
  target: Coordinate,
  maxDist: number,
): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]
  const bearingAngle = bearing(from, target)
  let best: Direction = 'N'
  let bestScore = -Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    const dirBearing = bearing(
      from,
      { x: from.x + delta.dx * 5, y: from.y + delta.dy * 5 },
    )
    const angleDiff = Math.abs(dirBearing - bearingAngle)
    const perpendicularDiff = Math.min(
      Math.abs(angleDiff - 90),
      Math.abs(angleDiff - 270),
    )
    const distToTarget = euclidean(from, target)
    const newPos = { x: from.x + delta.dx * maxDist, y: from.y + delta.dy * maxDist }
    const newDist = euclidean(newPos, target)
    const separationScore = newDist - distToTarget
    const score = (90 - perpendicularDiff) * 0.6 + separationScore * 0.4
    if (score > bestScore) {
      bestScore = score
      best = dir
    }
  }

  return best
}

/**
 * Find the direction that moves away from the closest edge/wall.
 */
function directionAwayFromEdge(
  pos: Coordinate,
  mapWidth: number,
  mapHeight: number,
): Direction {
  const dirs: Direction[] = [
    'N', 'NE', 'E', 'SE',
    'S', 'SW', 'W', 'NW',
  ]
  let best: Direction = 'N'
  let bestMargin = -Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    const nx = pos.x + delta.dx * 2
    const ny = pos.y + delta.dy * 2
    if (nx < 0 || nx >= mapWidth || ny < 0 || ny >= mapHeight) continue
    const edgeDist = Math.min(nx, mapWidth - 1 - nx, ny, mapHeight - 1 - ny)
    if (edgeDist > bestMargin) {
      bestMargin = edgeDist
      best = dir
    }
  }

  return best
}

/**
 * DeepSeekAgent — precision-engineered tank with systematic scouting,
 * motion-predicted shelling, adaptive positioning, and pressure tactics.
 *
 * Strategy:
 * 1. CONTINUOUS SCANNING — fire a flare every turn the enemy is not
 *    currently visible, rotating through 8 compass directions at
 *    varying ranges (long-range cardinals, medium diagonals).
 * 2. PRECISION ENGAGEMENT — on sight, fire shell with exact bearing +
 *    power. Finish wounded enemies aggressively.
 * 3. LATERAL REPOSITIONING — after firing, move perpendicular to the
 *    enemy bearing to create a difficult return-shot angle.
 * 4. LEAD PREDICTION — when intel is 1+ turn stale, predict enemy
 *    position from velocity history and lead the shot.
 * 5. SPRAY-AND-PRAY — after 3 full scan cycles (24 turns) without
 *    contact, fire high-power blind shells to increase hit probability.
 * 6. DEFENSIVE STANDOFF — at 1 HP, use max-range shelling and
 *    prioritize distance over aggression.
 */
export function createDeepSeekAgent(
  tankId: string,
): TankAgent {
  // Duel preset: 20x20, flareRadius 2, maxRange 10, moveMax 2
  const MAP_W = 20
  const MAP_H = 20
  const SHELL_MAX = 10

  const memory: DeepSeekMemory = {
    sightings: [],
    lastKnownEnemyPos: null,
    lastKnownEnemyHp: 2,
    lastSeenTurn: -999,
    searchStep: 0,
    turnsSinceFlare: 0,
    consecutiveMisses: 0,
    sweepPhase: 0,
    sweepTick: 0,
    lastPos: null,
    blockedStreak: 0,
  }

  return {
    name: `deepseek-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // ── 1. Update memory from worldview ──────────────────────────────────
      const enemyVisible =
        (worldview.visibleEnemies?.length ?? 0) > 0

      if (enemyVisible && worldview.visibleEnemies) {
        const enemy = worldview.visibleEnemies[0]
        memory.sightings.push({
          turn: worldview.turn,
          x: enemy.position.x,
          y: enemy.position.y,
          hp: enemy.hp,
        })
        memory.lastKnownEnemyPos = { x: enemy.position.x, y: enemy.position.y }
        memory.lastKnownEnemyHp = enemy.hp
        memory.lastSeenTurn = worldview.turn
      }

      const myPos = worldview.position
      const myHp = worldview.hp
      const enemyLastPos = memory.lastKnownEnemyPos
      const turnsSinceContact = worldview.turn - memory.lastSeenTurn
      const enemyIsWounded = memory.lastKnownEnemyHp < 2

      // ── 2. Decide offensive action ───────────────────────────────────────
      let usedOffense = false

      if (enemyVisible && enemyLastPos) {
        // ── DIRECT ENGAGEMENT: fire shell at current position ──────────────
        // No leading needed — the enemy is seen this same turn.
        // If enemy is 1 HP, we finish them; if 2 HP, we wound them.
        const angle = bearing(myPos, enemyLastPos)
        const dist = Math.round(euclidean(myPos, enemyLastPos))
        const power = Math.max(1, Math.min(dist, SHELL_MAX))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power },
        })
        usedOffense = true
        memory.consecutiveMisses = 0
      } else if (enemyLastPos != null && turnsSinceContact <= 1) {
        // ── RECENT INTEL (1 turn stale): fire shell with motion prediction ─
        const predicted = predictPosition(memory.sightings, worldview.turn)
        const angle = bearing(myPos, predicted)
        const dist = Math.round(euclidean(myPos, predicted))
        const power = Math.max(1, Math.min(dist, SHELL_MAX))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power },
        })
        usedOffense = true
      } else if (enemyLastPos != null && turnsSinceContact <= 3) {
        // ── STALE INTEL (2-3 turns old): suppressive fire + re-acquire ────
        const predicted = predictPosition(memory.sightings, worldview.turn)
        const angle = bearing(myPos, predicted)
        const dist = Math.round(euclidean(myPos, predicted))
        const power = Math.max(1, Math.min(dist, SHELL_MAX))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power },
        })
        usedOffense = true
        memory.consecutiveMisses++
      }

      // ── 3. SEARCH OR SPRAY ──────────────────────────────────────────────
      if (!usedOffense && worldview.aliveEnemyCount > 0) {
        // After 32 search steps (4 full multi-range cycles) with no contact,
        // switch to blind shelling. Each cycle covers 8 directions at 3 ranges
        // (long=8, medium=5, close=3) for dense map coverage.
        if (memory.searchStep >= 32) {
          // Spray phase: fire shells in wide-spread directions to maximize
          // the chance that a supercover trajectory intersects the enemy.
          // 8 directions (cardinal + intercardinal) at max power.
          const sprayIdx = memory.searchStep % 8
          const angle = sprayIdx * 45  // 0, 45, 90, 135, 180, 225, 270, 315
          calls.push({
            id: `shell-${worldview.turn}`,
            tool: { kind: 'fire_shell', angle, power: SHELL_MAX },
          })
          memory.searchStep++
          usedOffense = true
        } else {
          // Multi-range flare scanning: cycle through 8 compass directions
          // at 3 different ranges to create dense map coverage.
          const dirIndex = memory.searchStep % SEARCH_DIRECTIONS.length
          const flareDir = SEARCH_DIRECTIONS[dirIndex]

          // Range bands: first cycle long-range, second medium, third close
          const rangeCycle = Math.floor(memory.searchStep / SEARCH_DIRECTIONS.length) % 3
          const ranges = [8, 5, 3]
          const range = ranges[rangeCycle]

          calls.push({
            id: `flare-${worldview.turn}`,
            tool: {
              kind: 'fire_flare',
              direction: flareDir,
              range: range,
            },
          })
          memory.searchStep++
          memory.turnsSinceFlare = 0
          usedOffense = true
        }
      } else if (usedOffense) {
        memory.turnsSinceFlare++
      }

      // ── 4. Movement phase ────────────────────────────────────────────────
      let moveDir: Direction
      const moveDist = 2

      // Helper: pick direction that maximizes distance from all map edges
      function bestEscapeDir(pos: Coordinate): Direction {
        const toRight = MAP_W - 1 - pos.x
        const toLeft = pos.x
        const toBottom = MAP_H - 1 - pos.y
        const toTop = pos.y
        // Pick the direction with the MOST space
        const max = Math.max(toRight, toLeft, toBottom, toTop)
        if (max === toRight) return 'W'  // head away from right edge
        if (max === toLeft) return 'E'   // head away from left edge
        if (max === toBottom) return 'N' // head away from bottom edge
        return 'S'
      }

      if (enemyLastPos != null && (enemyVisible || turnsSinceContact <= 1)) {
        // Hot pursuit or just fired: lateral dodge
        moveDir = lateralDirection(myPos, enemyLastPos, moveDist)
      } else if (enemyLastPos != null) {
        moveDir = bestDirectionTo(myPos, enemyLastPos, moveDist)
      } else {
        // ── SYSTEMATIC QUADRANT SWEEP ──────────────────────────────────────
        // First reach center, then sweep each map quadrant in sequence.
        // Advance phase immediately when stuck (detected via blocked streak).
        const center: Coordinate = { x: Math.floor(MAP_W / 2), y: Math.floor(MAP_H / 2) }

        // Detect being stuck
        if (
          memory.lastPos != null &&
          myPos.x === memory.lastPos.x &&
          myPos.y === memory.lastPos.y
        ) {
          memory.blockedStreak++
        } else {
          memory.blockedStreak = 0
        }
        memory.lastPos = { x: myPos.x, y: myPos.y }

        // Advance phase when stuck to avoid being trapped
        if (memory.blockedStreak >= 2) {
          memory.sweepPhase++
          memory.sweepTick = 0
          memory.blockedStreak = 0
        }

        // Phase 0: reach center
        if (memory.sweepPhase === 0) {
          const d = euclidean(myPos, center)
          if (d <= 5) {
            memory.sweepPhase = 1
            memory.sweepTick = 0
          }
          moveDir = bestDirectionTo(myPos, center, moveDist)
        } else if (memory.sweepPhase <= 4) {
          // Sweep quadrants: NE, SE, SW, NW
          memory.sweepTick++
          const quadrants: Coordinate[] = [
            { x: MAP_W - 3, y: 2 },           // NE
            { x: MAP_W - 3, y: MAP_H - 3 },    // SE
            { x: 2, y: MAP_H - 3 },            // SW
            { x: 2, y: 2 },                    // NW
          ]
          const target = quadrants[memory.sweepPhase - 1]
          const d = euclidean(myPos, target)

          if (d <= 4 || memory.sweepTick >= 8) {
            memory.sweepPhase++
            memory.sweepTick = 0
          }
          moveDir = bestDirectionTo(myPos, target, moveDist)
        } else {
          // Return to center, then restart sweep
          memory.sweepTick++
          const d = euclidean(myPos, center)
          if (d <= 3 || memory.sweepTick >= 8) {
            memory.sweepPhase = 1
            memory.sweepTick = 0
          }
          moveDir = bestDirectionTo(myPos, center, moveDist)
        }

        // Edge avoidance: if within 2 cells of any edge, move inward
        const edgeMargin = Math.min(
          myPos.x, MAP_W - 1 - myPos.x,
          myPos.y, MAP_H - 1 - myPos.y,
        )
        if (edgeMargin < 2) {
          moveDir = bestEscapeDir(myPos)
        }
      }

      calls.push({
        id: `move-${worldview.turn}`,
        tool: { kind: 'move', direction: moveDir, distance: moveDist },
      })

      return calls
    },
  }
}
