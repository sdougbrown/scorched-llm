import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, inBounds, euclidean } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/**
 * Persistent memory for the minimax agent.
 *
 * Tracks everything the engine gives us per turn plus accumulated intel
 * (terrain we've seen, enemy sightings, and the most recent active flare
 * geometry) so we can reason across turns without re-discovering basics.
 */
interface AgentMemory {
  // Last known enemy position + the turn it was seen.
  lastKnownEnemy: { pos: Coordinate; turn: number; hp: number } | null
  // Map dimensions / shell config — set on the first turn.
  mapWidth: number
  mapHeight: number
  moveMax: number
  shellMaxRange: number
  obstacleHeight: number
  apexHeight: number
  tankHeight: number
  flareRadius: number
  localRadius: number
  actionBudget: number
  // Terrain we've seen. Maps "x,y" -> { terrain, obstacleHeight }.
  knownTerrain: Map<string, { x: number; y: number; terrain: 'open' | 'obstacle'; obstacleHeight: number }>
  // Flare cooldown: turn we last fired a flare. Used to space them out.
  lastFlareTurn: number
  // Tick of the current game. Set from worldview each turn.
  currentTurn: number
  // Consecutive turns with no hit/visibility, used to escalate hunt behavior.
  turnsBlind: number
  // Sticky mode determined by HP and intel — kept across turns for continuity.
  preferredFlankDir: Direction
  // Sticky destination used when we have no intel. Set on the first
  // move and never updated — flipping the destination as we cross
  // the center line causes the agent to oscillate around the
  // midline.
  huntDestination: Coordinate | null
  // Counter of how many hunt corners we've already checked. When
  // we've cycled through all four, we fall back to sweeping the
  // center.
  huntCornersTried: number
}

const ALL_DIRS: Direction[] = [
  'N', 'NE', 'E', 'SE',
  'S', 'SW', 'W', 'NW',
]

/** Bearing (degrees, 0=N, 90=E, 180=S, 270=W) from `from` to `to`. */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  if (angle >= 360) angle -= 360
  return angle
}

/** Round a bearing to one of the 8 compass directions. */
function bearingToDirection(b: number): Direction {
  const idx = Math.round(b / 45) % 8
  return ALL_DIRS[idx]
}

/**
 * 8-direction unit delta for a direction. Wraps DIRECTION_DELTAS but gives
 * us a single import-free path for callers that already have the table.
 */
function dirDelta(dir: Direction): { dx: number; dy: number } {
  return DIRECTION_DELTAS[dir]
}

/**
 * Walk the cells returned by the engine's worldview (local scan + flared
 * cells) and merge them into the agent's persistent terrain memory.
 * Returns the new (merged) terrain map.
 */
function absorbWorldviewTerrain(
  memory: AgentMemory,
  worldview: WorldView,
): void {
  for (const c of worldview.localScan) {
    memory.knownTerrain.set(`${c.coord.x},${c.coord.y}`, {
      x: c.coord.x,
      y: c.coord.y,
      terrain: c.terrain,
      obstacleHeight: c.obstacleHeight,
    })
  }
  for (const fc of worldview.flaredCells) {
    memory.knownTerrain.set(`${fc.cell.coord.x},${fc.cell.coord.y}`, {
      x: fc.cell.coord.x,
      y: fc.cell.coord.y,
      terrain: fc.cell.terrain,
      obstacleHeight: fc.cell.obstacleHeight,
    })
  }
}

/**
 * Shell height at sample index i out of N cells (mirrors engine math in
 * `fireShell`). Used by the shot solver to predict whether a trajectory
 * cell will be blocked by an obstacle.
 */
function shellHeight(i: number, N: number, apex: number, tank: number): number {
  if (N <= 0) return tank
  const progress = (i + 1) / N
  const arc = 4 * progress * (1 - progress)
  return tank + (apex - tank) * arc
}

/**
 * Solve angle/power for a guaranteed hit on `target` from `shooter`, using
 * the agent's terrain memory to avoid obstacles. Returns null if no clean
 * shot is possible at any legal power.
 *
 * Algorithm: for each candidate angle, iterate powers 1..maxRange and
 * simulate the engine's supercover trajectory. The shell hits iff
 *   (a) the line stays in bounds,
 *   (b) the target cell appears in the trajectory (endpoint or any
 *       intermediate cell the line passes through), and
 *   (c) no obstacle blocks the path before the target is reached.
 *
 * We prefer the direct bearing (highest EV), then ±6° and ±12° as
 * fallbacks for when a slight angle adjustment clears an obstacle.
 */
function solveShot(
  shooter: Coordinate,
  target: Coordinate,
  memory: AgentMemory,
): { angle: number; power: number } | null {
  const baseAngle = bearing(shooter, target)
  // Candidate angles: direct first, then small off-axis adjustments.
  const angleCandidates: number[] = []
  for (const offset of [0, -3, 3, -6, 6, -12, 12, -20, 20]) {
    let a = baseAngle + offset
    a = ((a % 360) + 360) % 360
    angleCandidates.push(a)
  }

  // We may need to try many powers per angle; budget the work so the
  // agent's takeTurn is fast (vitest can call it thousands of times).
  const maxPowersPerAngle = memory.shellMaxRange

  for (const angle of angleCandidates) {
    const rad = (angle * Math.PI) / 180
    const dxUnit = Math.sin(rad)
    const dyUnit = -Math.cos(rad)
    for (let power = 1; power <= maxPowersPerAngle; power++) {
      const tx = Math.round(shooter.x + dxUnit * power)
      const ty = Math.round(shooter.y + dyUnit * power)
      if (!inBounds({ x: tx, y: ty }, memory.mapWidth, memory.mapHeight)) continue
      const trajectory = supercover(shooter, { x: tx, y: ty })
      const samples = trajectory.slice(1)
      let hit = false
      let blocked = false
      for (let i = 0; i < samples.length; i++) {
        const cell = samples[i]
        if (
          cell.x < 0 || cell.x >= memory.mapWidth ||
          cell.y < 0 || cell.y >= memory.mapHeight
        ) {
          blocked = true
          break
        }
        const known = memory.knownTerrain.get(`${cell.x},${cell.y}`)
        const sh = shellHeight(i, samples.length, memory.apexHeight, memory.tankHeight)
        if (known && known.terrain === 'obstacle' && sh <= known.obstacleHeight) {
          blocked = true
          break
        }
        if (cell.x === target.x && cell.y === target.y) {
          hit = true
          break
        }
      }
      if (hit && !blocked) {
        return { angle, power }
      }
    }
  }
  return null
}

/**
 * Direction perpendicular to the line toward the enemy. Used for kiting:
 * if the enemy is east of us, we want to move N or S to make their
 * return shot miss. Returns a direction that is roughly orthogonal to
 * the enemy bearing.
 */
function perpendicularDirection(
  from: Coordinate,
  to: Coordinate,
  side: 1 | -1 = 1,
): Direction {
  const b = bearing(from, to)
  const perp = (b + 90 * side + 360) % 360
  return bearingToDirection(perp)
}

/**
 * Direction away from the enemy (used for retreat/kiting).
 */
function awayFrom(
  from: Coordinate,
  to: Coordinate,
): Direction {
  return bearingToDirection((bearing(from, to) + 180) % 360)
}

/**
 * Read the cell at (x, y) from known terrain. Out-of-bounds is treated
 * as an obstacle of zero height — i.e. it will not block shots but is
 * not a valid landing cell.
 */
function terrainAt(
  memory: AgentMemory,
  x: number,
  y: number,
): { x: number; y: number; terrain: 'open' | 'obstacle'; obstacleHeight: number } | null {
  if (!inBounds({ x, y }, memory.mapWidth, memory.mapHeight)) return null
  return memory.knownTerrain.get(`${x},${y}`) ?? null
}

/**
 * Is the cell at (x, y) safe to step on right now? (In-bounds, not an
 * obstacle, not occupied by another tank we know about.) We don't have
 * direct tank positions in the agent, but `visibleEnemies` plus our
 * last-known enemy give us a partial picture.
 */
function isCellSafe(
  memory: AgentMemory,
  pos: Coordinate,
  enemyPositions: Coordinate[],
): boolean {
  if (!inBounds(pos, memory.mapWidth, memory.mapHeight)) return false
  const cell = terrainAt(memory, pos.x, pos.y)
  if (cell == null) return false
  if (cell.terrain === 'obstacle') return false
  for (const e of enemyPositions) {
    if (e.x === pos.x && e.y === pos.y) return false
  }
  return true
}

/**
 * Choose a movement plan given the agent's current situation. Returns
 * one or two `move` calls (or `[]` if the agent should hold position).
 *
 *   actionBudget: how many actions the agent has left this turn.
 *   remainingMoveBudget: how many cells it can still move this turn.
 *   enemyVisible: whether we currently see the enemy.
 *   lastKnownEnemyPos: the most recent enemy position (for pursuit).
 *   enemyPositions: list of all known enemy positions (for blocking).
 */
function planMovement(
  memory: AgentMemory,
  pos: Coordinate,
  hp: number,
  maxHp: number,
  enemyVisible: boolean,
  enemy: Coordinate | null,
  enemyPositions: Coordinate[],
  remainingMoveBudget: number,
  actionBudget: number,
  inEnemyFlare: boolean,
): ToolCall[] {
  if (actionBudget <= 0) return []
  // If we're at zero move budget (e.g. already spent on a previous move),
  // we can't move at all.
  if (remainingMoveBudget <= 0) return []

  const wounded = hp < maxHp
  const critical = hp === 1 && maxHp >= 2

  // --- 1) Critical HP: hard retreat (always) ---
  if (critical && enemy != null) {
    const dir = awayFrom(pos, enemy)
    const dist = Math.min(memory.moveMax, remainingMoveBudget)
    if (dist <= 0) return []
    return [{ id: `move-${memory.currentTurn}-retreat`, tool: { kind: 'move', direction: dir, distance: dist } }]
  }

  // --- 2) Enemy visible: kite or close the gap ---
  if (enemyVisible && enemy != null) {
    const dist = euclidean(pos, enemy)
    // Inside our shell range (maxRange) but not on top of them: kite.
    if (dist > 2 && dist <= memory.shellMaxRange) {
      // If the enemy is in our flare zone, we want to break their line
      // of fire. A perpendicular move is best — it changes our position
      // along an axis the enemy's next shot won't predict.
      if (wounded) {
        // Wounded: move away (full retreat) rather than kiting.
        const dir = awayFrom(pos, enemy)
        const dist = Math.min(memory.moveMax, remainingMoveBudget)
        if (dist > 0) {
          return [{ id: `move-${memory.currentTurn}-retreat`, tool: { kind: 'move', direction: dir, distance: dist } }]
        }
        return []
      }
      // Healthy: kite perpendicularly. Pick a side that doesn't go into
      // an obstacle or off the map.
      for (const side of [1, -1] as const) {
        const dir = perpendicularDirection(pos, enemy, side)
        const delta = dirDelta(dir)
        const candidate: Coordinate = { x: pos.x + delta.dx, y: pos.y + delta.dy }
        if (isCellSafe(memory, candidate, enemyPositions)) {
          const d = Math.min(memory.moveMax, remainingMoveBudget)
          if (d > 0) {
            return [{ id: `move-${memory.currentTurn}-kite`, tool: { kind: 'move', direction: dir, distance: d } }]
          }
          return []
        }
      }
      // Perpendicular options blocked — try retreat.
      const dir = awayFrom(pos, enemy)
      const d = Math.min(memory.moveMax, remainingMoveBudget)
      if (d > 0) {
        return [{ id: `move-${memory.currentTurn}-retreat`, tool: { kind: 'move', direction: dir, distance: d } }]
      }
      return []
    }
    // Out of range: close the gap.
    if (dist > memory.shellMaxRange) {
      const dir = bearingToDirection(bearing(pos, enemy))
      const d = Math.min(memory.moveMax, remainingMoveBudget)
      if (d > 0) {
        return [{ id: `move-${memory.currentTurn}-close`, tool: { kind: 'move', direction: dir, distance: d } }]
      }
      return []
    }
    // Too close (< 2): back off to a better firing range.
    const dir = awayFrom(pos, enemy)
    const d = Math.min(memory.moveMax, remainingMoveBudget)
    if (d > 0) {
      return [{ id: `move-${memory.currentTurn}-backoff`, tool: { kind: 'move', direction: dir, distance: d } }]
    }
    return []
  }

  // --- 3) Enemy not visible: pursue or reposition ---
  if (enemy != null) {
    // Move toward last known position. If we're already there (or very
    // close), stop and prepare to scan with a flare.
    const dist = euclidean(pos, enemy)
    if (dist < 2) {
      return [] // we are on the LKP; let the flare turn handle intel
    }
    // Direct bearing toward the LKP, rounded to 8 dirs. The
    // 2-step bestDirectionTo heuristic can oscillate around the
    // long axis on long diagonal paths.
    const dir = bearingToDirection(bearing(pos, enemy))
    const d = Math.min(memory.moveMax, remainingMoveBudget)
    if (d > 0) {
      return [{ id: `move-${memory.currentTurn}-pursue`, tool: { kind: 'move', direction: dir, distance: d } }]
    }
    return []
  }

  // --- 4) No enemy info: push toward the opposite corner. ---
  // The hunt destination is picked once (on the first HUNT turn) and
  // sticks for the rest of the match. We point at the diagonally
  // opposite corner because that's the most likely enemy spawn
  // position in a symmetric-spawn match, and a reasonable
  // default for random spawn (the enemy will be somewhere on the
  // map; a corner-aligned sweep covers the most ground).
  if (memory.huntDestination == null) {
    memory.huntDestination = pickHuntDestination(memory, pos)
    memory.huntCornersTried = 0
  }
  if (
    memory.huntDestination != null &&
    euclidean(pos, memory.huntDestination) < 4
  ) {
    // We got close to the destination and didn't see anyone. That
    // means the enemy isn't waiting at the corner — either the
    // enemy is mobile and on the way to us, or the enemy is in
    // some other corner. In either case, the right move is to
    // SLOW DOWN and let the enemy close the distance.
    memory.huntCornersTried = (memory.huntCornersTried ?? 0) + 1
    if (memory.huntCornersTried >= 4) {
      // Cycled through all four corners without seeing the enemy —
      // the enemy must be mobile and not at a corner. Fall back to
      // walking toward the center, then alternating cardinal
      // directions every few turns to sweep the map.
      memory.huntDestination = {
        x: Math.floor(memory.mapWidth / 2),
        y: Math.floor(memory.mapHeight / 2),
      }
    } else {
      memory.huntDestination = pickHuntDestination(memory, pos, memory.huntCornersTried)
    }
  }
  const oppositeCorner = memory.huntDestination!
  // Use the direct bearing (rounded to 8 dirs) rather than the
  // 2-step heuristic — for long diagonal paths the 2-step lookahead
  // can pick a "tactical" direction that oscillates around the long
  // axis instead of progressing along it.
  const dir = bearingToDirection(bearing(pos, oppositeCorner))
  if (inEnemyFlare) {
    // While in an enemy flare, prefer a perpendicular move so we
    // have a chance of leaving the flare circle on the next turn.
    const delta = dirDelta(memory.preferredFlankDir)
    const candidate: Coordinate = { x: pos.x + delta.dx, y: pos.y + delta.dy }
    if (isCellSafe(memory, candidate, enemyPositions)) {
      const d = Math.min(memory.moveMax, remainingMoveBudget)
      if (d > 0) {
        return [{ id: `move-${memory.currentTurn}-flank`, tool: { kind: 'move', direction: memory.preferredFlankDir, distance: d } }]
      }
    }
  }
  // HUNT pace: move 1 cell per turn. Moving 2/turn in HUNT mode
  // causes the agent to overshoot the meeting point in
  // symmetric-spawn matchups where the enemy moves at 1/turn toward
  // the center. The second action slot is reserved for a flare
  // (handled by `buildCalls`).
  const d = Math.min(1, remainingMoveBudget)
  if (d > 0) {
    return [{ id: `move-${memory.currentTurn}-corner`, tool: { kind: 'move', direction: dir, distance: d } }]
  }
  return []
}

/**
 * Pick the hunt destination. The first pick is the center of the
 * map — the most likely meeting point in a 1v1 where both sides
 * are moving toward the middle. After the center has been visited
 * without contact, the picks rotate through the four corners in
 * an order that starts with the diagonally opposite corner
 * (the most likely enemy spawn in symmetric-spawn matches).
 */
function pickHuntDestination(
  memory: AgentMemory,
  pos: Coordinate,
  cornerIndex: number = 0,
): Coordinate {
  if (cornerIndex === 0) {
    return {
      x: Math.floor(memory.mapWidth / 2),
      y: Math.floor(memory.mapHeight / 2),
    }
  }
  const corners: Coordinate[] = [
    { x: memory.mapWidth - 2, y: memory.mapHeight - 2 },
    { x: 1, y: memory.mapHeight - 2 },
    { x: memory.mapWidth - 2, y: 1 },
    { x: 1, y: 1 },
  ]
  return corners[(cornerIndex - 1) % 4]!
}

/**
 * Decide whether to fire a flare this turn. Flares reveal cells to
 * EVERY player, so we use them surgically:
 *
 *  - When we have no intel at all and the blind timer is high.
 *  - When we are about to push into a corner and need to clear it.
 *  - When the enemy is on a flare-able position and we want to keep
 *    our firing solution accurate across turns.
 */
function planFlare(
  memory: AgentMemory,
  pos: Coordinate,
  enemy: Coordinate | null,
  enemyVisible: boolean,
  actionBudget: number,
): ToolCall | null {
  if (actionBudget <= 0) return null
  // Never fire two flares in a row — flares last one round and the
  // cooldown is enforced by the world state.
  if (memory.currentTurn - memory.lastFlareTurn < 2) return null

  // 1) Always flare toward a known enemy if we can — this gives us a
  //    firing solution AND keeps their position pinned for the next
  //    turn (the flare lasts until they take a turn again).
  if (enemy != null && !enemyVisible) {
    const dir = bearingToDirection(bearing(pos, enemy))
    const dist = Math.round(Math.min(10, euclidean(pos, enemy)))
    // Cap flare range to land in-bounds; the engine blocks out-of-bounds
    // flares (which would be an invalid call).
    const max = Math.max(1, Math.min(
      dist,
      memory.mapWidth - 1,
      memory.mapHeight - 1,
    ))
    if (max < 1) return null
    memory.lastFlareTurn = memory.currentTurn
    return { id: `flare-${memory.currentTurn}-track`, tool: { kind: 'fire_flare', direction: dir, range: max } }
  }

  // 2) HUNT: blind flare in the direction we're walking.
  if (enemy == null || memory.turnsBlind >= 3) {
    // The agent's "preferredFlankDir" reflects which corner of the
    // map it's pushing toward (e.g. SE for a NW spawn). Aim the
    // flare along the same axis so the reveal overlaps the next
    // turn's expected position.
    const delta = dirDelta(memory.preferredFlankDir)
    const targetX = pos.x + delta.dx * 4
    const targetY = pos.y + delta.dy * 4
    // Clamp into bounds.
    const tx = Math.max(0, Math.min(memory.mapWidth - 1, targetX))
    const ty = Math.max(0, Math.min(memory.mapHeight - 1, targetY))
    const dir = bearingToDirection(bearing(pos, { x: tx, y: ty }))
    const range = Math.max(1, Math.min(6, Math.round(euclidean(pos, { x: tx, y: ty }))))
    if (range < 1) return null
    memory.lastFlareTurn = memory.currentTurn
    return { id: `flare-${memory.currentTurn}-scout`, tool: { kind: 'fire_flare', direction: dir, range } }
  }

  // 3) Wounded but no enemy: don't flare — it gives away position. Move
  //    only.
  return null
}

/**
 * Build the turn's tool calls given the agent's current state. Returns
 * 0, 1, or 2 calls — the engine enforces "one offensive per turn" so
 * we never combine fire_shell with fire_flare.
 */
function buildCalls(
  memory: AgentMemory,
  worldview: WorldView,
): ToolCall[] {
  if (!worldview.isMyTurn) {
    return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
  }

  const actions = worldview.remainingActions
  if (actions <= 0) {
    return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
  }

  // Scripted agents don't get a per-call callback, so we commit to a
  // 2-call plan up front. The first call is the "primary" (offensive
  // or scout), the second is a tactical follow-up move. The engine
  // validates per-call, so requesting a slightly-too-long move is
  // recoverable as long as we don't trigger 3 strikes in a row.

  // Identify the visible enemy (if any) and the LKP enemy.
  const visible = worldview.visibleEnemies ?? []
  const visibleEnemy = visible[0] ?? null
  const enemyVisible = visibleEnemy != null
  const enemy: Coordinate | null = visibleEnemy?.position ?? memory.lastKnownEnemy?.pos ?? null

  // Enemy positions we know about — used to avoid moving onto them.
  const enemyPositions: Coordinate[] = visible.map((e) => e.position)

  // In an enemy flare (we are visible to the enemy) — drive kiting.
  const inEnemyFlare = worldview.inEnemyFlare.length > 0

  // --- Decide primary action ---
  let primary: ToolCall | null = null
  let secondary: ToolCall | null = null

  // 1) We can SEE the enemy — try a guaranteed hit first.
  if (enemyVisible && enemy != null) {
    const shot = solveShot(worldview.position, enemy, memory)
    if (shot != null) {
      primary = {
        id: `shell-${worldview.turn}`,
        tool: { kind: 'fire_shell', angle: shot.angle, power: shot.power },
      }
    }
  }

  // 2) No clean shot — try a flare to reveal (and pin) the enemy.
  if (primary == null) {
    const flare = planFlare(
      memory,
      worldview.position,
      enemy,
      enemyVisible,
      actions,
    )
    if (flare != null) primary = flare
  }

  // --- Decide secondary action (move) ---
  // We only have a "primary" offensive/shell/flare. The follow-up is
  // always a single tactical move; we never request two moves because
  // we can't react to the engine's per-call feedback mid-turn.
  const afterPrimaryActions = primary != null ? actions - 1 : actions
  // Assume no move budget has been spent by the primary (true for
  // shell and flare; the engine doesn't decrement move budget on
  // offensive calls). If we ever set primary to a move, this becomes
  // unsafe and we'll silently no-op the secondary.
  const assumedMoveBudget = memory.moveMax * afterPrimaryActions

  const move = planMovement(
    memory,
    worldview.position,
    worldview.hp,
    // Conservative maxHp: 2 in duel/survival, but we don't know which
    // preset we're in. planMovement only uses maxHp to flag wounded
    // vs critical; either way 2 is the safer choice.
    2,
    enemyVisible,
    enemy,
    enemyPositions,
    assumedMoveBudget,
    afterPrimaryActions,
    inEnemyFlare,
  )
  if (move.length > 0) secondary = move[0] ?? null

  // --- Assemble ---
  const calls: ToolCall[] = []
  if (primary != null) calls.push(primary)
  if (secondary != null) calls.push(secondary)
  if (calls.length === 0) {
    return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
  }
  return calls
}

/**
 * Factory for the minimax scripted agent.
 *
 * The agent:
 *  - Tracks terrain persistently (engine never sends it again).
 *  - Solves for guaranteed-hit shell trajectories using supercover.
 *  - Falls back to flares only when it lacks intel or has no shot.
 *  - Kites perpendicularly when healthy, retreats when wounded.
 *  - Holds fire rather than fire blind (no waste of offensive action).
 *  - Uses one move per turn and lets the engine's per-call check
 *    decide if a second move is feasible.
 *
 * @param tankId - Identifier for this tank (used as suffix in name).
 * @param options.flankSeed - Initial flank direction (0-7). Inferred
 *   from tankId if not given so different minimax agents pick
 *   different flanks.
 */
export function createMinimaxAgent(
  tankId: string,
  options: { flankSeed?: number } = {},
): TankAgent {
  // Initial flank direction; we'll refine this after the first turn
  // when we have a position reading.
  const memory: AgentMemory = {
    lastKnownEnemy: null,
    mapWidth: 0,
    mapHeight: 0,
    moveMax: 1,
    shellMaxRange: 10,
    obstacleHeight: 3,
    apexHeight: 5,
    tankHeight: 1,
    flareRadius: 2,
    localRadius: 3,
    actionBudget: 2,
    knownTerrain: new Map(),
    lastFlareTurn: -999,
    currentTurn: 0,
    turnsBlind: 0,
    preferredFlankDir: options.flankSeed != null
      ? (ALL_DIRS[options.flankSeed & 7] ?? 'E')
      : 'E',
    huntDestination: null,
    huntCornersTried: 0,
  }

  return {
    name: `minimax-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      // --- Update persistent memory from this turn's worldview ---
      memory.currentTurn = worldview.turn

      // Bootstrap config on the first turn. The agent can read the map
      // dimensions from the localScan if needed, but we can also pick
      // up the most extreme known terrain coordinates.
      if (memory.mapWidth === 0 || memory.mapHeight === 0) {
        bootstrapMapSize(memory, worldview)
      }
      // Refine the inferred config each turn. The map size is fixed
      // for the whole match but our knowledge of it grows as we move
      // around, so the smallest-preset-fits heuristic gets sharper.
      refineMapSize(memory, worldview)

      absorbWorldviewTerrain(memory, worldview)

      // Set the initial flank direction on the first turn only. The
      // flank represents the direction to the opposite corner of the
      // map — the most likely enemy position in a symmetric-spawn
      // match. This is sticky: once set it doesn't change, so the
      // agent never oscillates around the centre line.
      if (memory.preferredFlankDir === 'E' && memory.mapWidth > 0) {
        const isLeft = worldview.position.x < memory.mapWidth / 2
        const isTop = worldview.position.y < memory.mapHeight / 2
        if (isLeft && isTop) memory.preferredFlankDir = 'SE'
        else if (isLeft && !isTop) memory.preferredFlankDir = 'NE'
        else if (!isLeft && isTop) memory.preferredFlankDir = 'SW'
        else memory.preferredFlankDir = 'NW'
      }

      // Update known enemy sightings.
      const visible = worldview.visibleEnemies ?? []
      if (visible.length > 0) {
        const e = visible[0]!
        memory.lastKnownEnemy = { pos: { ...e.position }, turn: worldview.turn, hp: e.hp }
        memory.turnsBlind = 0
        // Reset the hunt destination — when the enemy is back in the
        // dark we'll pick a fresh corner to push toward, based on
        // wherever the enemy was last seen.
        memory.huntDestination = null
      } else if (memory.lastKnownEnemy != null) {
        if (worldview.turn - memory.lastKnownEnemy.turn > 0) {
          memory.turnsBlind = worldview.turn - memory.lastKnownEnemy.turn
        }
      } else {
        memory.turnsBlind++
      }

      // --- Build and return the action plan ---
      return buildCalls(memory, worldview)
    },
  }
}

/**
 * Set up the static config (shell arc, local/flare radii) on the
 * first turn. We pick conservative defaults that match the duel
 * preset; `refineMapSize` upgrades to survival settings (25x25,
 * maxRange 12) once a flare reveals a coord that wouldn't exist on
 * the smaller map.
 *
 * Map dimensions are seeded to 20x20 as a safe default so the
 * shot solver doesn't reject every trajectory endpoint as
 * out-of-bounds before `refineMapSize` has a chance to refine the
 * inference.
 */
function bootstrapMapSize(memory: AgentMemory, _worldview: WorldView): void {
  memory.localRadius = 3
  memory.obstacleHeight = 3
  memory.apexHeight = 5
  memory.tankHeight = 1
  memory.flareRadius = 2
  memory.moveMax = 2
  memory.shellMaxRange = 10
  memory.actionBudget = 2
  if (memory.mapWidth === 0) memory.mapWidth = 20
  if (memory.mapHeight === 0) memory.mapHeight = 20
}

/**
 * Refine the inferred map config based on the latest worldview.
 * Called every turn: as the agent moves and flares, its
 * observations grow and the smallest-fit-preset heuristic can
 * upgrade (e.g. 20x20 → 25x25 once a flare reveals a coord that
 * wouldn't exist on the smaller map).
 *
 * Safety: we only ever UPGRADE the inferred config, never
 * downgrade. Downgrading could turn a previously-valid request
 * (e.g. power=12) into an invalid one.
 *
 * The local scan alone can reveal coords up to 19 on a 20x20 map,
 * so a max-observed threshold is not a reliable survival
 * indicator. We require a flare-based observation of a coord
 * that wouldn't fit on the smaller map (>= 20) to upgrade.
 */
function refineMapSize(memory: AgentMemory, worldview: WorldView): void {
  let maxObserved = 0
  for (const c of worldview.localScan) {
    if (c.coord.x > maxObserved) maxObserved = c.coord.x
    if (c.coord.y > maxObserved) maxObserved = c.coord.y
  }
  let maxFlareObserved = 0
  for (const fc of worldview.flaredCells) {
    if (fc.cell.coord.x > maxFlareObserved) maxFlareObserved = fc.cell.coord.x
    if (fc.cell.coord.y > maxFlareObserved) maxFlareObserved = fc.cell.coord.y
  }
  const strongMaxObserved = Math.max(maxObserved, maxFlareObserved)
  if (maxFlareObserved >= 20) {
    if (memory.mapWidth < 25) {
      memory.mapWidth = 25
      memory.mapHeight = 25
      memory.shellMaxRange = 12
      memory.flareRadius = 3
      memory.moveMax = 3
      memory.actionBudget = 2
    }
  } else if (strongMaxObserved >= 7) {
    if (memory.mapWidth < 20) {
      memory.mapWidth = 20
      memory.mapHeight = 20
      memory.shellMaxRange = 10
      memory.flareRadius = 2
      memory.moveMax = 2
      memory.actionBudget = 2
    }
  }
}
