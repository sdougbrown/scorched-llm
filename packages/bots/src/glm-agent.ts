import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'

/**
 * GLM Agent — a lethal scripted tank built on a close reading of the engine.
 *
 * Tactical pillars (each tied to a concrete engine mechanic):
 *
 *  1. Read `worldview.visibleEnemies` (local vision + flares) for exact, live
 *     targeting. The reference aggressive/conservative bots ignore this field
 *     and fire at a stale `lastKnownEnemyPos`, so they miss moving targets.
 *
 *  2. Hit guarantee inside ~6 cells. The shell height arc is
 *     `tankHeight + (apexHeight - tankHeight) * 4 * p * (1-p)`. With the preset
 *     values (apex=5, obstacle=3, tank=1), the arc clears every obstacle along
 *     the supercover path for sampled lengths up to 6 cells; the impact cell is
 *     always open (tanks cannot occupy obstacle cells). So a correctly aimed
 *     shot at a visible enemy within 6 cells is a guaranteed hit.
 *
 *  3. Never flare. A flare's `expiryTurn = state.turn + playerCount`, and it is
 *     expired at the start of every turn via `expiryTurn > currentTurn`. The
 *     firer's next turn is exactly `T + N`, so the flare is gone before the
 *     firer ever sees it again. Scripted agents commit their calls upfront and
 *     cannot react mid-turn, so flaring only hands free intel to the enemy and
 *     burns an offensive action. The GLM bot spends both actions on movement
 *     and shells instead.
 *
 *  4. Sprint-hunt. With double economy and moveMax derived from flareRadius,
 *     two move actions cover `2 * moveMax` cells per turn. The bot races to the
 *     opposite corner (1v1) or the map center (survival) to bring the enemy into
 *     local-vision radius, where pillar 1 takes over.
 *
 *  5. Shoot-and-dodge. After firing at a visible enemy, the bot relocates so
 *     dumb bots that lock onto a stale `lastKnownEnemyPos` shoot at empty air
 *     on their turn. Even a 2-cell shift is enough to defeat the reference
 *     aggressive/conservative aiming.
 */

const ALL_DIRS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export interface GlmAgentOptions {
  shellMaxRange?: number
  moveMax?: number
  mapWidth?: number
  mapHeight?: number
  lastKnownEnemyPos?: Coordinate
  lastSeenTurn?: number
}

interface GlmMemory {
  lastKnownEnemyPos: Coordinate | null
  lastSeenTurn: number
  spawn: Coordinate | null
  /** Rotating index used to pick a sweep direction when the goal is reached. */
  sweepCursor: number
  /** Monotonic counter of turns this agent has actually played. */
  turnsPlayed: number
}

/** Clockwise bearing in degrees from north (0=N, 90=E, 180=S, 270=W). */
function bearingOf(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let a = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (a < 0) a += 360
  return a
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

/** True if a known obstacle cell sits at (x,y) in the local scan. */
function isBlockedScan(scan: Cell[], x: number, y: number): boolean {
  return scan.some((c) => c.coord.x === x && c.coord.y === y && c.terrain === 'obstacle')
}

/**
 * Best movement (direction + distance) that makes progress toward `goal`
 * while avoiding obstacles visible in `scan`. Falls back to any unblocked
 * adjacent cell when the direct route is jammed. Returns null only when the
 * tank is completely boxed in.
 */
function bestMoveToward(
  from: Coordinate,
  goal: Coordinate,
  scan: Cell[],
  maxDist: number,
): { direction: Direction; distance: number } | null {
  const sx = sign(goal.x - from.x)
  const sy = sign(goal.y - from.y)
  const candidates: Array<{ dir: Direction; score: number; dist: number }> = []

  for (const dir of ALL_DIRS) {
    const d = DIRECTION_DELTAS[dir]
    const score = d.dx * sx + d.dy * sy
    if (score <= 0) continue
    let clear = 0
    for (let step = 1; step <= maxDist; step++) {
      if (isBlockedScan(scan, from.x + d.dx * step, from.y + d.dy * step)) break
      clear = step
    }
    if (clear > 0) candidates.push({ dir, score, dist: clear })
  }

  if (candidates.length === 0) {
    for (const dir of ALL_DIRS) {
      const d = DIRECTION_DELTAS[dir]
      if (!isBlockedScan(scan, from.x + d.dx, from.y + d.dy)) {
        return { direction: dir, distance: 1 }
      }
    }
    return null
  }

  candidates.sort((a, b) => b.score - a.score || b.dist - a.dist)
  return { direction: candidates[0].dir, distance: Math.min(candidates[0].dist, maxDist) }
}

/** Best movement directly away from `threat`. */
function bestMoveAway(
  from: Coordinate,
  threat: Coordinate,
  scan: Cell[],
  maxDist: number,
): { direction: Direction; distance: number } | null {
  const sx = sign(from.x - threat.x)
  const sy = sign(from.y - threat.y)
  const candidates: Array<{ dir: Direction; score: number; dist: number }> = []

  for (const dir of ALL_DIRS) {
    const d = DIRECTION_DELTAS[dir]
    const score = d.dx * sx + d.dy * sy
    if (score <= 0) continue
    let clear = 0
    for (let step = 1; step <= maxDist; step++) {
      if (isBlockedScan(scan, from.x + d.dx * step, from.y + d.dy * step)) break
      clear = step
    }
    if (clear > 0) candidates.push({ dir, score, dist: clear })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score || b.dist - a.dist)
  return { direction: candidates[0].dir, distance: Math.min(candidates[0].dist, maxDist) }
}

/**
 * Perpendicular strafe relative to the line `from -> threat`: keeps range
 * roughly constant while shifting position so a tracker locked onto the old
 * coordinate misses. Prefers the side with more clearance.
 */
function bestStrafe(
  from: Coordinate,
  threat: Coordinate,
  scan: Cell[],
  maxDist: number,
): { direction: Direction; distance: number } | null {
  const dx = sign(threat.x - from.x)
  const dy = sign(threat.y - from.y)
  // Perpendicular candidates: rotate the threat vector 90° left/right.
  const left = { dx: -dy, dy: dx }
  const right = { dx: dy, dy: -dx }
  for (const delta of [left, right]) {
    let clear = 0
    for (let step = 1; step <= maxDist; step++) {
      if (isBlockedScan(scan, from.x + delta.dx * step, from.y + delta.dy * step)) break
      clear = step
    }
    if (clear > 0) {
      const dir = ALL_DIRS.find((d) => {
        const dd = DIRECTION_DELTAS[d]
        return dd.dx === delta.dx && dd.dy === delta.dy
      })
      if (dir) return { direction: dir, distance: Math.min(clear, maxDist) }
    }
  }
  return null
}

/** Aim a shell at `target` from `from`. Power is rounded euclidean, clamped. */
function shellAt(from: Coordinate, target: Coordinate, maxRange: number, id: string): ToolCall {
  const angle = bearingOf(from, target)
  const dist = Math.round(euclidean(from, target))
  const power = clamp(dist, 1, maxRange)
  return { id, tool: { kind: 'fire_shell', angle, power } }
}

export function createGlmAgent(
  tankId: string,
  options: GlmAgentOptions = {},
): TankAgent {
  const shellMaxRange = options.shellMaxRange ?? 10
  const moveMax = options.moveMax ?? 2
  const mapW = options.mapWidth ?? 20
  const mapH = options.mapHeight ?? 20
  const center: Coordinate = { x: Math.floor(mapW / 2), y: Math.floor(mapH / 2) }

  const memory: GlmMemory = {
    lastKnownEnemyPos: options.lastKnownEnemyPos ?? null,
    lastSeenTurn: options.lastSeenTurn ?? (options.lastKnownEnemyPos !== undefined ? 0 : -999),
    spawn: null,
    sweepCursor: 0,
    turnsPlayed: 0,
  }

  return {
    name: `glm-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const turn = worldview.turn
      const me = worldview.position

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${turn}`, tool: { kind: 'pass' } }]
      }

      memory.turnsPlayed++

      if (memory.spawn === null) {
        memory.spawn = { ...me }
      }

      // --- Refresh memory from live sightings --------------------------------
      const visible = worldview.visibleEnemies ?? []
      if (visible.length > 0) {
        const target = visible.reduce((best, e) => {
          if (e.hp < best.hp) return e
          if (e.hp === best.hp && euclidean(me, e.position) < euclidean(me, best.position)) return e
          return best
        }, visible[0])
        memory.lastKnownEnemyPos = { ...target.position }
        memory.lastSeenTurn = turn
      }

      const actions = worldview.remainingActions
      const calls: ToolCall[] = []

      // ======================================================================
      // ENGAGE — enemy is visible right now. Shoot first, then reposition.
      // Visible enemies within local-vision radius (3) are guaranteed hits:
      // the shell arc clears every intermediate obstacle at those distances.
      // ======================================================================
      if (visible.length > 0) {
        const target = visible.reduce((best, e) => {
          if (e.hp < best.hp) return e
          if (e.hp === best.hp && euclidean(me, e.position) < euclidean(me, best.position)) return e
          return best
        }, visible[0])
        const dist = euclidean(me, target.position)

        calls.push(shellAt(me, target.position, shellMaxRange, `glm-shell-${turn}`))

        if (actions >= 2) {
          // Reposition to dodge return fire. Up close, retreat to make space;
          // at mid-range, strafe to break dumb-bot aiming without yielding
          // the engagement; at long range, close in to keep the enemy in range.
          let move: { direction: Direction; distance: number } | null
          if (dist < 3) {
            move = bestMoveAway(me, target.position, worldview.localScan, moveMax)
          } else if (dist > 6) {
            move = bestMoveToward(me, target.position, worldview.localScan, moveMax)
          } else {
            move = bestStrafe(me, target.position, worldview.localScan, moveMax)
            if (move === null) {
              move = bestMoveToward(me, target.position, worldview.localScan, moveMax)
            }
          }
          if (move) {
            calls.push({
              id: `glm-move-${turn}`,
              tool: { kind: 'move', direction: move.direction, distance: move.distance },
            })
          }
        }
        return calls
      }

      // ======================================================================
      // PURSUE — recent fix (≤ 2 turns). Fire at the last-known cell (they may
      // have held position) and close distance to re-acquire via local vision.
      // ======================================================================
      const hasFix = memory.lastKnownEnemyPos !== null
      const intelAge = turn - memory.lastSeenTurn

      if (hasFix && intelAge <= 2 && memory.lastKnownEnemyPos) {
        const target = memory.lastKnownEnemyPos
        const dist = euclidean(me, target)

        // Move toward the fix first (closer shot, re-acquire via local vision).
        if (actions >= 2) {
          const move = bestMoveToward(me, target, worldview.localScan, moveMax)
          if (move) {
            calls.push({
              id: `glm-move-${turn}`,
              tool: { kind: 'move', direction: move.direction, distance: move.distance },
            })
          }
        }

        // Shoot at last-known from the current position. Only spend the shell
        // if there's a real chance it connects: distances ≤ 6 always clear
        // obstacles, and for longer shots we fire only when the first cell in
        // the line of bearing is not a known obstacle.
        const angle = bearingOf(me, target)
        const firstDelta = DIRECTION_DELTAS[
          ALL_DIRS[Math.round(angle / 45) % 8]
        ]
        const firstCellBlocked = isBlockedScan(
          worldview.localScan,
          me.x + firstDelta.dx,
          me.y + firstDelta.dy,
        )
        const inClearRange = dist <= 6
        if (actions >= 1 && (inClearRange || !firstCellBlocked) && dist <= shellMaxRange) {
          calls.push(shellAt(me, target, shellMaxRange, `glm-shell-${turn}`))
        }

        if (calls.length === 0) {
          // Surrounded by obstacles — nudge any way we can.
          const nudge = bestMoveToward(me, target, worldview.localScan, 1)
          if (nudge) {
            calls.push({
              id: `glm-move-${turn}`,
              tool: { kind: 'move', direction: nudge.direction, distance: 1 },
            })
          } else {
            calls.push({ id: `glm-pass-${turn}`, tool: { kind: 'pass' } })
          }
        }
        return calls
      }

      // ======================================================================
      // STALE PURSUIT — fix is 3–5 turns old. Close distance; the enemy has
      // likely drifted but the last-known cell is still the best anchor.
      // ======================================================================
      if (hasFix && intelAge <= 5 && memory.lastKnownEnemyPos) {
        const target = memory.lastKnownEnemyPos
        const move = bestMoveToward(me, target, worldview.localScan, moveMax)
        if (move) {
          calls.push({
            id: `glm-move-${turn}`,
            tool: { kind: 'move', direction: move.direction, distance: move.distance },
          })
        }
        if (actions >= 2) {
          const move2 = bestMoveToward(me, target, worldview.localScan, moveMax)
          if (move2) {
            calls.push({
              id: `glm-move2-${turn}`,
              tool: { kind: 'move', direction: move2.direction, distance: move2.distance },
            })
          }
        }
        if (calls.length === 0) {
          calls.push({ id: `glm-pass-${turn}`, tool: { kind: 'pass' } })
        }
        return calls
      }

      // ======================================================================
      // HUNT — no usable intel. Sprint toward the opposite corner (1v1) or
      // the map center (multi-player) to bring the enemy into local vision.
      // When the goal is reached, sweep around it.
      // ======================================================================
      const isMultiplayer = worldview.aliveEnemyCount >= 2
      let goal: Coordinate
      if (memory.spawn !== null && !isMultiplayer) {
        goal = {
          x: mapW - 1 - memory.spawn.x,
          y: mapH - 1 - memory.spawn.y,
        }
      } else {
        goal = center
      }

      const atGoal =
        Math.abs(me.x - goal.x) <= 1 && Math.abs(me.y - goal.y) <= 1

      if (atGoal) {
        // Sweep: rotate through all 8 directions from center to scan the map.
        const sweepDir = ALL_DIRS[memory.sweepCursor % ALL_DIRS.length]
        memory.sweepCursor++
        let move = bestMoveToward(me, {
          x: me.x + DIRECTION_DELTAS[sweepDir].dx * 4,
          y: me.y + DIRECTION_DELTAS[sweepDir].dy * 4,
        }, worldview.localScan, moveMax)
        if (move === null) {
          move = bestMoveToward(me, center, worldview.localScan, moveMax)
        }
        if (move) {
          calls.push({
            id: `glm-sweep-${turn}`,
            tool: { kind: 'move', direction: move.direction, distance: move.distance },
          })
        }
      } else {
        const move = bestMoveToward(me, goal, worldview.localScan, moveMax)
        if (move) {
          calls.push({
            id: `glm-hunt-${turn}`,
            tool: { kind: 'move', direction: move.direction, distance: move.distance },
          })
        }
      }

      // Use the second action to keep sprinting toward the goal.
      if (actions >= 2 && calls.length < 2) {
        const move2 = bestMoveToward(me, goal, worldview.localScan, moveMax)
        if (move2) {
          calls.push({
            id: `glm-hunt2-${turn}`,
            tool: { kind: 'move', direction: move2.direction, distance: move2.distance },
          })
        }
      }

      if (calls.length === 0) {
        calls.push({ id: `glm-pass-${turn}`, tool: { kind: 'pass' } })
      }
      return calls
    },
  }
}