/**
 * sonnet-4.6-agent.ts
 *
 * A lethal scripted tank authored for the Sonnet-4.6 tournament slot.
 *
 * Design principles extracted from the engine source:
 *
 * 1. SHELL PHYSICS
 *    angle is a clockwise bearing from north (0=N, 90=E, 180=S, 270=W).
 *    power determines range: target = pos + delta(angle) * power (rounded).
 *    Shell arc height: tankHeight=1, apexHeight=5. An obstacle blocks the
 *    shell only if obstacleHeight >= shellHeight at that cell. Since
 *    obstacleHeight is 3 and apexHeight is 5, the shell clears obstacles
 *    comfortably at mid-range but not at very short range (height ~1 at
 *    start/end of arc).
 *
 * 2. ACTION ECONOMY (duel / survival — "double" mode)
 *    2 actions per turn. One offensive action (shell OR flare) per turn.
 *    Move counts as an action. Two moves are permitted (move1 + move2)
 *    but total distance is capped at moveMax * actionBudget (= flareRadius * 2
 *    in the standard presets = 4 cells total).
 *
 * 3. VISIBILITY
 *    worldview.visibleEnemies — enemies inside local scan (radius 3) or any
 *    active flare. worldview.inEnemyFlare — we are illuminated by enemy flare.
 *
 * 4. REACTIVE EXECUTION
 *    By using the executeTool callback and returning AgentTurnResult
 *    { toolCalls, executed: true } the engine skips the legacy batch replay,
 *    so we can chain actions whose parameters depend on intermediate results.
 *
 * Strategy:
 *   PHASE 1 — if enemy is visible: fire shell at precise angle/power, then
 *              strafe perpendicular to the shot vector to make us hard to
 *              predict / dodge incoming counter-fire.
 *   PHASE 2 — if we are in enemy flare (spotted) but can't see them: move
 *              away from predicted enemy position to break line-of-sight;
 *              fire a scouting flare toward last known position.
 *   PHASE 3 — blind hunting: sector-sweep flares toward predicted enemy zones;
 *              move toward last known position to close the gap.
 *   ALWAYS   — never waste an action slot; always use both actions if possible.
 */

import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall, ActionResult } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type {
  TankAgent,
  AgentMessage,
  ToolSpec,
  AgentTurnResult,
  ToolExecutionResult,
  ToolExecutor,
} from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Clockwise bearing (degrees) from `from` to `to`. 0=N, 90=E, 180=S, 270=W */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Round bearing to the nearest 45° compass direction. */
function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round(b / 45) % 8
  return dirs[idx]
}

/** Pick the compass direction that gets us closest to target. */
function bestDirectionTo(
  from: Coordinate,
  target: Coordinate,
  maxSteps: number,
): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestDist = Infinity
  for (const dir of dirs) {
    const d = DIRECTION_DELTAS[dir]
    let minDist = Infinity
    for (let step = 1; step <= maxSteps; step++) {
      const dist = euclidean({ x: from.x + d.dx * step, y: from.y + d.dy * step }, target)
      if (dist < minDist) minDist = dist
    }
    if (minDist < bestDist) {
      bestDist = minDist
      best = dir
    }
  }
  return best
}

/** Rotate a direction 90° clockwise (for strafing perpendicular to shot). */
function rotateCW90(dir: Direction): Direction {
  const order: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = order.indexOf(dir)
  return order[(idx + 2) % 8]
}

/** Rotate a direction 90° counter-clockwise. */
function rotateCCW90(dir: Direction): Direction {
  const order: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = order.indexOf(dir)
  return order[(idx + 6) % 8]
}

/** Opposite direction (180°). */
function opposite(dir: Direction): Direction {
  const order: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = order.indexOf(dir)
  return order[(idx + 4) % 8]
}

/**
 * Would a move in `dir` by `dist` stay in bounds and avoid obstacles?
 * We only have the worldview's localScan (not full terrain) so we do a
 * best-effort check on known cells. Unknown cells are treated as open.
 */
function isMovePassable(
  from: Coordinate,
  dir: Direction,
  dist: number,
  localScan: WorldView['localScan'],
  mapWidth: number,
  mapHeight: number,
): boolean {
  const cellMap = new Map<string, 'open' | 'obstacle'>()
  for (const cell of localScan) {
    cellMap.set(`${cell.coord.x},${cell.coord.y}`, cell.terrain)
  }
  const d = DIRECTION_DELTAS[dir]
  for (let step = 1; step <= dist; step++) {
    const cx = from.x + d.dx * step
    const cy = from.y + d.dy * step
    if (cx < 0 || cx >= mapWidth || cy < 0 || cy >= mapHeight) return false
    if (cellMap.get(`${cx},${cy}`) === 'obstacle') return false
  }
  return true
}

/**
 * Find the first passable move direction that gets us toward target, trying
 * preferred first then trying all 8 dirs. Returns null if none work.
 */
function findPassableDirectionToward(
  from: Coordinate,
  target: Coordinate,
  dist: number,
  localScan: WorldView['localScan'],
  mapWidth: number,
  mapHeight: number,
): Direction | null {
  const preferred = bestDirectionTo(from, target, dist)
  const order: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const sorted = [preferred, ...order.filter((d) => d !== preferred)]
  for (const dir of sorted) {
    if (isMovePassable(from, dir, dist, localScan, mapWidth, mapHeight)) {
      return dir
    }
    // Try distance 1 if dist > 1
    if (dist > 1 && isMovePassable(from, dir, 1, localScan, mapWidth, mapHeight)) {
      return dir
    }
  }
  return null
}

/**
 * Estimate map dimensions from worldview data.
 * The duel map is 20x20, survival 25x25. We infer from localScan extremes
 * but default to 20x20 when we can't tell.
 */
function estimateMapDims(localScan: WorldView['localScan']): { w: number; h: number } {
  // We can't know for sure, but 20x20 covers duel and blitz; survival is 25x25.
  // Err large to avoid false "out of bounds" rejections.
  // We use 30 as a safe upper bound.
  return { w: 30, h: 30 }
}

// ---------------------------------------------------------------------------
// Agent memory
// ---------------------------------------------------------------------------

interface EnemyRecord {
  id: string
  position: Coordinate
  hp: number
  seenTurn: number
}

interface Sonnet46Memory {
  /** Best known enemy records, keyed by enemy id. */
  enemies: Map<string, EnemyRecord>
  /** Sectors we've already illuminated with a flare, to sweep in rotation. */
  lastFlareSector: number
  /** Turn we last fired a flare. */
  lastFlareTurn: number
  /** Count of consecutive turns with no intel. */
  blindTurns: number
}

// ---------------------------------------------------------------------------
// Agent factory
// ---------------------------------------------------------------------------

export function createSonnet46Agent(tankId: string): TankAgent {
  const memory: Sonnet46Memory = {
    enemies: new Map(),
    lastFlareSector: 0,
    lastFlareTurn: -999,
    blindTurns: 0,
  }

  let callCounter = 0
  function nextId(prefix: string): string {
    return `${prefix}-${++callCounter}`
  }

  // Update enemy records from worldview
  function absorbWorldview(wv: WorldView): void {
    if (wv.visibleEnemies && wv.visibleEnemies.length > 0) {
      for (const e of wv.visibleEnemies) {
        memory.enemies.set(e.id, { ...e, seenTurn: wv.turn })
      }
      memory.blindTurns = 0
    } else {
      memory.blindTurns++
    }
  }

  /**
   * Pick the best known enemy target: prefer the most-recently-seen,
   * then closest to us.
   */
  function pickTarget(from: Coordinate, currentTurn: number): EnemyRecord | null {
    let best: EnemyRecord | null = null
    for (const rec of memory.enemies.values()) {
      if (!best) {
        best = rec
        continue
      }
      // Prefer more-recently-seen
      if (rec.seenTurn > best.seenTurn) {
        best = rec
        continue
      }
      if (rec.seenTurn === best.seenTurn) {
        // Tie-break: closer is better
        if (euclidean(from, rec.position) < euclidean(from, best.position)) {
          best = rec
        }
      }
    }
    return best
  }

  /**
   * Compute angle and clamped power to shoot at a target from `from`.
   * Power is clamped to [1, maxRange].
   * We aim slightly ahead of the target's last-known position by projecting
   * a predictive offset if the target was seen recently.
   */
  function computeShot(
    from: Coordinate,
    target: EnemyRecord,
    currentTurn: number,
    maxRange: number,
  ): { angle: number; power: number } {
    const aim = { ...target.position }

    // Simple predictive lead: if seen very recently, they probably didn't move far.
    // If we saw them 1 turn ago, add 0 lead (they get one move). If longer, no change.
    // (Their position is already stale — firing at last-known is our best bet.)

    const angle = bearing(from, aim)
    const dist = euclidean(from, aim)
    const power = Math.max(1, Math.min(Math.round(dist), maxRange))
    return { angle, power }
  }

  /**
   * Pick a flare direction to sweep toward the predicted enemy zone.
   * Rotates through 8 sectors cyclically, biased toward last-known position.
   */
  function pickFlareSector(from: Coordinate, turn: number): { direction: Direction; range: number } {
    const target = pickTarget(from, turn)
    if (target) {
      // Fire toward last known enemy
      const b = bearing(from, target.position)
      const dist = Math.max(1, Math.min(Math.round(euclidean(from, target.position)) - 1, 5))
      return { direction: bearingToDirection(b), range: Math.max(1, dist) }
    }

    // Sweep sectors cyclically for blind search
    const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    const dir = dirs[memory.lastFlareSector % 8]
    memory.lastFlareSector = (memory.lastFlareSector + 1) % 8
    return { direction: dir, range: 5 }
  }

  const agent: TankAgent = {
    name: `sonnet-4.6-${tankId}`,
    messages: [] as AgentMessage[],

    async takeTurn(
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> {
      // --- Not my turn: pass ---
      if (!worldview.isMyTurn) {
        // Still absorb any visible-enemy data (observation turns)
        absorbWorldview(worldview)
        return [{ id: nextId('pass'), tool: { kind: 'pass' } }]
      }

      // If no executeTool callback available, fall back to static call list
      if (!executeTool) {
        return staticTurn(worldview)
      }

      return await reactiveTurn(worldview, executeTool)
    },
  }

  // ---------------------------------------------------------------------------
  // Reactive turn: uses executeTool callback to chain actions dynamically
  // ---------------------------------------------------------------------------

  async function reactiveTurn(
    worldview: WorldView,
    executeTool: ToolExecutor,
  ): Promise<AgentTurnResult> {
    absorbWorldview(worldview)

    const toolCalls: ToolCall[] = []
    let currentWv = worldview

    // Helper: execute one tool, record the call, return result+worldview
    async function exec(tool: ToolCall['tool']): Promise<ToolExecutionResult> {
      const call: ToolCall = { id: nextId(tool.kind), tool }
      toolCalls.push(call)
      const result = await executeTool(call)
      // Absorb fresh worldview after each action
      absorbWorldview(result.worldview)
      currentWv = result.worldview
      return result
    }

    const { w: mapW, h: mapH } = estimateMapDims(worldview.localScan)
    const maxRange = 10 // default from presets; conservative assumption

    // --- Determine if we can see an enemy ---
    const visibleTarget = currentWv.visibleEnemies && currentWv.visibleEnemies.length > 0
      ? currentWv.visibleEnemies.reduce((best, e) =>
          euclidean(currentWv.position, e.position) < euclidean(currentWv.position, best.position)
            ? e
            : best
        )
      : null

    const knownTarget = pickTarget(currentWv.position, currentWv.turn)
    const isSpotted = currentWv.inEnemyFlare && currentWv.inEnemyFlare.length > 0

    if (currentWv.remainingActions <= 0) {
      return { toolCalls, executed: true }
    }

    // ===========================================================
    // OFFENSIVE ACTION: fire shell if we have a target, else flare
    // ===========================================================

    let firedOffensive = false

    if (visibleTarget) {
      // We can see an enemy — fire a precise shell
      const rec: EnemyRecord = {
        id: visibleTarget.id,
        position: visibleTarget.position,
        hp: visibleTarget.hp,
        seenTurn: currentWv.turn,
      }
      memory.enemies.set(rec.id, rec)

      const { angle, power } = computeShot(currentWv.position, rec, currentWv.turn, maxRange)
      const r = await exec({ kind: 'fire_shell', angle, power })
      firedOffensive = true

      // If we hit, great. Whether hit or miss, proceed to movement.
    } else if (knownTarget && currentWv.turn - knownTarget.seenTurn <= 3) {
      // Stale intel, still worth a speculative shell at last known position
      const { angle, power } = computeShot(currentWv.position, knownTarget, currentWv.turn, maxRange)
      const r = await exec({ kind: 'fire_shell', angle, power })
      firedOffensive = true
    } else {
      // No intel — fire a scouting flare to illuminate probable enemy zone
      const { direction, range } = pickFlareSector(currentWv.position, currentWv.turn)
      memory.lastFlareTurn = currentWv.turn
      const r = await exec({ kind: 'fire_flare', direction, range })
      firedOffensive = true

      // After flare, check if we revealed an enemy (fresh worldview)
      const freshVisible = currentWv.visibleEnemies
      if (freshVisible && freshVisible.length > 0) {
        for (const e of freshVisible) {
          memory.enemies.set(e.id, { ...e, seenTurn: currentWv.turn })
        }
      }
    }

    if (currentWv.remainingActions <= 0) {
      return { toolCalls, executed: true }
    }

    // ===========================================================
    // MOVEMENT: use remaining action to reposition
    // ===========================================================

    // Priority 1: if we're lit by an enemy flare, DODGE perpendicular/away
    if (isSpotted) {
      await dodge(exec, currentWv, knownTarget, mapW, mapH)
    } else if (visibleTarget) {
      // We fired at them and can still see them — strafe to make us harder to hit
      await strafe(exec, currentWv, visibleTarget.position, mapW, mapH)
    } else if (knownTarget) {
      // Advance toward last known enemy position
      await advanceToward(exec, currentWv, knownTarget.position, mapW, mapH)
    } else {
      // Completely blind — move toward center of map to find enemies sooner
      const center: Coordinate = { x: 10, y: 10 }
      await advanceToward(exec, currentWv, center, mapW, mapH)
    }

    return { toolCalls, executed: true }
  }

  // ---------------------------------------------------------------------------
  // Movement helpers
  // ---------------------------------------------------------------------------

  async function dodge(
    exec: (tool: ToolCall['tool']) => Promise<ToolExecutionResult>,
    wv: WorldView,
    knownTarget: EnemyRecord | null,
    mapW: number,
    mapH: number,
  ): Promise<void> {
    // Move perpendicular to or away from the predicted enemy origin
    const from = wv.position

    let escapeDir: Direction
    if (knownTarget) {
      const toward = bearingToDirection(bearing(from, knownTarget.position))
      // Go perpendicular to break line-of-sight
      escapeDir = rotateCW90(toward)
    } else {
      // Move toward center as safe default
      escapeDir = bestDirectionTo(from, { x: 10, y: 10 }, 3)
    }

    const dist = 2
    if (isMovePassable(from, escapeDir, dist, wv.localScan, mapW, mapH)) {
      await exec({ kind: 'move', direction: escapeDir, distance: dist })
    } else if (isMovePassable(from, escapeDir, 1, wv.localScan, mapW, mapH)) {
      await exec({ kind: 'move', direction: escapeDir, distance: 1 })
    } else {
      // Try opposite perpendicular
      const alt = rotateCCW90(
        knownTarget ? bearingToDirection(bearing(from, knownTarget.position)) : 'N',
      )
      if (isMovePassable(from, alt, 1, wv.localScan, mapW, mapH)) {
        await exec({ kind: 'move', direction: alt, distance: 1 })
      }
      // else can't move — accept it
    }
  }

  async function strafe(
    exec: (tool: ToolCall['tool']) => Promise<ToolExecutionResult>,
    wv: WorldView,
    enemyPos: Coordinate,
    mapW: number,
    mapH: number,
  ): Promise<void> {
    // Move perpendicular to the shot vector to make counter-fire harder
    const from = wv.position
    const toward = bearingToDirection(bearing(from, enemyPos))
    const perp = rotateCW90(toward)

    const dist = 1
    if (isMovePassable(from, perp, dist, wv.localScan, mapW, mapH)) {
      await exec({ kind: 'move', direction: perp, distance: dist })
    } else {
      const alt = rotateCCW90(toward)
      if (isMovePassable(from, alt, dist, wv.localScan, mapW, mapH)) {
        await exec({ kind: 'move', direction: alt, distance: dist })
      } else {
        // Fall back: move toward or away from enemy
        const fwd = toward
        if (isMovePassable(from, fwd, dist, wv.localScan, mapW, mapH)) {
          await exec({ kind: 'move', direction: fwd, distance: dist })
        }
      }
    }
  }

  async function advanceToward(
    exec: (tool: ToolCall['tool']) => Promise<ToolExecutionResult>,
    wv: WorldView,
    target: Coordinate,
    mapW: number,
    mapH: number,
  ): Promise<void> {
    const from = wv.position
    const dir = findPassableDirectionToward(from, target, 2, wv.localScan, mapW, mapH)
    if (dir) {
      // Try distance 2 first, then 1
      if (isMovePassable(from, dir, 2, wv.localScan, mapW, mapH)) {
        await exec({ kind: 'move', direction: dir, distance: 2 })
      } else {
        await exec({ kind: 'move', direction: dir, distance: 1 })
      }
    }
    // else stuck — skip move (don't waste an action on a blocked move)
  }

  // ---------------------------------------------------------------------------
  // Static fallback (no executeTool callback — legacy path)
  // ---------------------------------------------------------------------------

  function staticTurn(worldview: WorldView): ToolCall[] {
    absorbWorldview(worldview)

    const calls: ToolCall[] = []
    const from = worldview.position
    const maxRange = 10
    const { w: mapW, h: mapH } = estimateMapDims(worldview.localScan)

    const visibleTarget =
      worldview.visibleEnemies && worldview.visibleEnemies.length > 0
        ? worldview.visibleEnemies[0]
        : null
    const knownTarget = pickTarget(from, worldview.turn)
    const isSpotted = worldview.inEnemyFlare && worldview.inEnemyFlare.length > 0

    // Offensive action
    if (visibleTarget) {
      const rec: EnemyRecord = {
        id: visibleTarget.id,
        position: visibleTarget.position,
        hp: visibleTarget.hp,
        seenTurn: worldview.turn,
      }
      memory.enemies.set(rec.id, rec)
      const { angle, power } = computeShot(from, rec, worldview.turn, maxRange)
      calls.push({ id: nextId('fire_shell'), tool: { kind: 'fire_shell', angle, power } })
    } else if (knownTarget && worldview.turn - knownTarget.seenTurn <= 3) {
      const { angle, power } = computeShot(from, knownTarget, worldview.turn, maxRange)
      calls.push({ id: nextId('fire_shell'), tool: { kind: 'fire_shell', angle, power } })
    } else {
      const { direction, range } = pickFlareSector(from, worldview.turn)
      memory.lastFlareTurn = worldview.turn
      calls.push({ id: nextId('fire_flare'), tool: { kind: 'fire_flare', direction, range } })
    }

    // Movement action
    if (isSpotted) {
      const toward = knownTarget
        ? bearingToDirection(bearing(from, knownTarget.position))
        : 'N'
      const escapeDir = rotateCW90(toward)
      if (isMovePassable(from, escapeDir, 1, worldview.localScan, mapW, mapH)) {
        calls.push({ id: nextId('move'), tool: { kind: 'move', direction: escapeDir, distance: 1 } })
      }
    } else if (visibleTarget) {
      const toward = bearingToDirection(bearing(from, visibleTarget.position))
      const perp = rotateCW90(toward)
      if (isMovePassable(from, perp, 1, worldview.localScan, mapW, mapH)) {
        calls.push({ id: nextId('move'), tool: { kind: 'move', direction: perp, distance: 1 } })
      }
    } else if (knownTarget) {
      const dir = findPassableDirectionToward(from, knownTarget.position, 2, worldview.localScan, mapW, mapH)
      if (dir) {
        calls.push({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: 1 } })
      }
    } else {
      const center: Coordinate = { x: 10, y: 10 }
      const dir = findPassableDirectionToward(from, center, 2, worldview.localScan, mapW, mapH)
      if (dir) {
        calls.push({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: 1 } })
      }
    }

    if (calls.length === 0) {
      calls.push({ id: nextId('pass'), tool: { kind: 'pass' } })
    }

    return calls
  }

  return agent
}
