import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS, inBounds } from '@scorched-llm/engine'

/**
 * Kimi — a lethal scripted tank that exploits the engine's exact geometry.
 *
 * Core observations about the game:
 *  1. `visibleEnemies` already fuses local vision and active flares; a tank
 *     that reads it can fire at live coordinates instead of stale memory.
 *  2. Shells travel a parabolic arc from tankHeight (1) up to apexHeight (5)
 *     at the midpoint. Any obstacle whose cell is crossed while the arc is
 *     at or below obstacleHeight (3) blocks the shell. For short flights
 *     (roughly ≤6 cells) the arc is high enough to clear all obstacles,
 *     so a correctly aimed shot at a visible enemy within ~6 cells is a hit.
 *  3. Flares expire before the firer's next turn (expiryTurn = turn + N),
 *     so they reveal enemies to *both* players but the firer never benefits
 *     from them. They still have value as a probing tool when completely blind.
 *  4. Movement is the strongest defensive tool: changing your cell by even
 *     one step breaks opponents that aim at stale coordinates.
 *
 * Tactics:
 *  - Always use `visibleEnemies` for live target selection (weakest + nearest).
 *  - Fire first in a turn, then move to dodge return fire.
 *  - When blind, sprint to the opposite corner in 1v1 or the center in FFA,
 *    using a persistent known-map plus the local scan to path around terrain.
 *  - Once near the 1v1/FFA goal, lock into an expanding-square sweep so the
 *    tank does not oscillate around the goal point.
 *  - Track last-known enemy position for short-term prediction and a blind
 *    suppressive shot when the fix is fresh.
 */

const ALL_DIRS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

export interface KimiAgentOptions {
  shellMaxRange?: number
  moveMax?: number
  mapWidth?: number
  mapHeight?: number
}

interface KimiMemory {
  lastSeenPos: Coordinate | null
  lastSeenTurn: number
  spawn: Coordinate | null
  turnAtGoal: number
  atGoal: boolean
  blindTurns: number
  lastDir: Direction | null
  turnsPlayed: number
  knownMap: Map<string, Cell['terrain']>
}

/** Clockwise bearing in degrees from north (0=N, 90=E, 180=S, 270=W). */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function sign(n: number): number {
  return n > 0 ? 1 : n < 0 ? -1 : 0
}

function key(c: Coordinate): string {
  return `${c.x},${c.y}`
}

function isOpen(cell: Coordinate, scan: Cell[], known: Map<string, Cell['terrain']>, width: number, height: number): boolean {
  if (!inBounds(cell, width, height)) return false
  const scanned = scan.find((c) => c.coord.x === cell.x && c.coord.y === cell.y)
  if (scanned != null) return scanned.terrain === 'open'
  const terrain = known.get(key(cell))
  if (terrain != null) return terrain === 'open'
  // Unknown cells are treated as potentially passable; movement resolution
  // will block them if they are actually obstacles or out of bounds.
  return true
}

/**
 * Choose the movement that makes the most progress toward `goal` while every
 * scanned/known step is open. Falls back to any single open step if the direct
 * route is jammed. Returns null only when completely boxed in.
 */
function bestMoveToward(
  from: Coordinate,
  goal: Coordinate,
  scan: Cell[],
  known: Map<string, Cell['terrain']>,
  maxDist: number,
  width: number,
  height: number,
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
      const c = { x: from.x + d.dx * step, y: from.y + d.dy * step }
      if (!isOpen(c, scan, known, width, height)) break
      clear = step
    }
    if (clear > 0) candidates.push({ dir, score, dist: clear })
  }

  if (candidates.length === 0) {
    for (const dir of ALL_DIRS) {
      const d = DIRECTION_DELTAS[dir]
      const c = { x: from.x + d.dx, y: from.y + d.dy }
      if (isOpen(c, scan, known, width, height)) {
        return { direction: dir, distance: 1 }
      }
    }
    return null
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    // Tie-break by the candidate that ends up closest to the goal — prevents
    // oscillation when two directions have the same dot product.
    const aEnd = { x: from.x + DIRECTION_DELTAS[a.dir].dx * a.dist, y: from.y + DIRECTION_DELTAS[a.dir].dy * a.dist }
    const bEnd = { x: from.x + DIRECTION_DELTAS[b.dir].dx * b.dist, y: from.y + DIRECTION_DELTAS[b.dir].dy * b.dist }
    return euclidean(aEnd, goal) - euclidean(bEnd, goal)
  })
  return { direction: candidates[0].dir, distance: clamp(candidates[0].dist, 1, maxDist) }
}

/** Best single step directly away from `threat`, or null if boxed in. */
function bestMoveAway(
  from: Coordinate,
  threat: Coordinate,
  scan: Cell[],
  known: Map<string, Cell['terrain']>,
  maxDist: number,
  width: number,
  height: number,
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
      const c = { x: from.x + d.dx * step, y: from.y + d.dy * step }
      if (!isOpen(c, scan, known, width, height)) break
      clear = step
    }
    if (clear > 0) candidates.push({ dir, score, dist: clear })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score || b.dist - a.dist)
  return { direction: candidates[0].dir, distance: clamp(candidates[0].dist, 1, maxDist) }
}

/** Perpendicular strafe to break stale-aim tracking. */
function bestStrafe(
  from: Coordinate,
  threat: Coordinate,
  scan: Cell[],
  known: Map<string, Cell['terrain']>,
  maxDist: number,
  width: number,
  height: number,
): { direction: Direction; distance: number } | null {
  const dx = sign(threat.x - from.x)
  const dy = sign(threat.y - from.y)
  // Perpendicular vectors: (-dy, dx) and (dy, -dx)
  const deltas = [
    { dx: -dy, dy: dx },
    { dx: dy, dy: -dx },
  ]
  for (const delta of deltas) {
    if (delta.dx === 0 && delta.dy === 0) continue
    let clear = 0
    for (let step = 1; step <= maxDist; step++) {
      const c = { x: from.x + delta.dx * step, y: from.y + delta.dy * step }
      if (!isOpen(c, scan, known, width, height)) break
      clear = step
    }
    if (clear > 0) {
      const dir = ALL_DIRS.find((d) => {
        const dd = DIRECTION_DELTAS[d]
        return dd.dx === delta.dx && dd.dy === delta.dy
      })
      if (dir != null) return { direction: dir, distance: clamp(clear, 1, maxDist) }
    }
  }
  return null
}

function shellAt(from: Coordinate, target: Coordinate, maxRange: number, id: string): ToolCall {
  const angle = bearing(from, target)
  const dist = Math.round(euclidean(from, target))
  const power = clamp(dist, 1, maxRange)
  return { id, tool: { kind: 'fire_shell', angle, power } }
}

function flareAt(from: Coordinate, dir: Direction, range: number, id: string): ToolCall {
  return { id, tool: { kind: 'fire_flare', direction: dir, range } }
}

export function createKimiAgent(
  tankId: string,
  options: KimiAgentOptions = {},
): TankAgent {
  const shellMaxRange = options.shellMaxRange ?? 10
  const moveMax = options.moveMax ?? 2
  const mapW = options.mapWidth ?? 20
  const mapH = options.mapHeight ?? 20
  const center: Coordinate = { x: Math.floor(mapW / 2), y: Math.floor(mapH / 2) }

  const memory: KimiMemory = {
    lastSeenPos: null,
    lastSeenTurn: -999,
    spawn: null,
    turnAtGoal: 0,
    atGoal: false,
    blindTurns: 0,
    lastDir: null,
    turnsPlayed: 0,
    knownMap: new Map(),
  }

  return {
    name: `kimi-${tankId}`,
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

      // Merge local scan into persistent known-map.
      for (const cell of worldview.localScan) {
        memory.knownMap.set(key(cell.coord), cell.terrain)
      }

      const visible = worldview.visibleEnemies ?? []
      if (visible.length > 0) {
        memory.lastSeenPos = { ...visible[0].position }
        memory.lastSeenTurn = turn
        memory.blindTurns = 0
      } else {
        memory.blindTurns++
      }

      const actions = worldview.remainingActions
      const calls: ToolCall[] = []

      // === ENGAGE: visible enemy ===
      if (visible.length > 0) {
        const target = visible.reduce((best, e) => {
          if (e.hp < best.hp) return e
          if (e.hp === best.hp && euclidean(me, e.position) < euclidean(me, best.position)) return e
          return best
        }, visible[0])
        const dist = euclidean(me, target.position)

        calls.push(shellAt(me, target.position, shellMaxRange, `kimi-shell-${turn}`))

        if (actions >= 2) {
          let move
          if (dist < 3) {
            // Too close — back off to stay out of enemy local vision
            move = bestMoveAway(me, target.position, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
          } else if (dist > 6) {
            // Too far — close the gap to guarantee hits
            move = bestMoveToward(me, target.position, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
          } else {
            // Ideal range — strafe to dodge while keeping them in vision
            move = bestStrafe(me, target.position, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
            if (move == null) {
              move = bestMoveToward(me, target.position, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
            }
          }
          if (move != null) {
            memory.lastDir = move.direction
            calls.push({
              id: `kimi-move-${turn}`,
              tool: { kind: 'move', direction: move.direction, distance: move.distance },
            })
          }
        }
        return calls
      }

      // === PURSUE: fresh but not currently visible fix ===
      const hasFix = memory.lastSeenPos !== null
      const intelAge = turn - memory.lastSeenTurn

      if (hasFix && intelAge <= 2 && memory.lastSeenPos) {
        const target = memory.lastSeenPos
        const dist = euclidean(me, target)

        // Move first for a closer/cleaner shot and to re-acquire vision
        if (actions >= 2) {
          const move = bestMoveToward(me, target, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
          if (move != null) {
            memory.lastDir = move.direction
            calls.push({
              id: `kimi-move-${turn}`,
              tool: { kind: 'move', direction: move.direction, distance: move.distance },
            })
          }
        }

        // Fire if there is a reasonable chance to connect.
        // Within ~6 cells the arc clears all obstacles; otherwise only fire
        // if the first cell along the bearing is open in our scan.
        if (actions >= 1 && dist <= shellMaxRange) {
          let canFire = dist <= 6
          if (!canFire) {
            const angle = bearing(me, target)
            const firstDir = ALL_DIRS[Math.round(angle / 45) % 8]
            const fd = DIRECTION_DELTAS[firstDir]
            const firstCell = { x: me.x + fd.dx, y: me.y + fd.dy }
            canFire = isOpen(firstCell, worldview.localScan, memory.knownMap, mapW, mapH)
          }
          if (canFire) {
            calls.push(shellAt(me, target, shellMaxRange, `kimi-shell-${turn}`))
          }
        }

        if (calls.length === 0) {
          calls.push({ id: `kimi-pass-${turn}`, tool: { kind: 'pass' } })
        }
        return calls
      }

      // === HUNT: stale or no intel ===
      const isMultiplayer = worldview.aliveEnemyCount >= 2
      let goal: Coordinate
      if (memory.spawn !== null && !isMultiplayer) {
        // 1v1: go to the opposite corner to sweep toward the likely enemy spawn
        goal = { x: mapW - 1 - memory.spawn.x, y: mapH - 1 - memory.spawn.y }
      } else {
        goal = center
      }

      if (!memory.atGoal && euclidean(me, goal) <= 2) {
        memory.atGoal = true
      }

      let move: { direction: Direction; distance: number } | null
      let sweepTarget: Coordinate | null = null
      if (memory.atGoal) {
        // Expanding-square sweep around the goal: NW, NE, SE, SW at radius 2, 4, 6...
        memory.turnAtGoal++
        const r = 2 + Math.floor((memory.turnAtGoal - 1) / 4) * 2
        const dirIdx = (memory.turnAtGoal - 1) % 4
        const dir: Direction = ['NW', 'NE', 'SE', 'SW'][dirIdx] as Direction
        const d = DIRECTION_DELTAS[dir]
        sweepTarget = { x: goal.x + d.dx * r, y: goal.y + d.dy * r }
        move = bestMoveToward(me, sweepTarget, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
        if (move == null) {
          move = bestMoveToward(me, center, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
        }
      } else {
        move = bestMoveToward(me, goal, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
      }

      if (move != null) {
        memory.lastDir = move.direction
        calls.push({
          id: `kimi-hunt-${turn}`,
          tool: { kind: 'move', direction: move.direction, distance: move.distance },
        })
      }

      // Use the second action to keep sprinting, or fire a probing flare when
      // completely blind for several turns.
      if (actions >= 2 && calls.length < 2) {
        if (memory.blindTurns >= 3) {
          const dir = memory.lastSeenPos
            ? (ALL_DIRS[Math.round(bearing(me, memory.lastSeenPos) / 45) % 8] as Direction)
            : (memory.lastDir ?? 'N')
          calls.push(flareAt(me, dir, 5, `kimi-flare-${turn}`))
          memory.blindTurns = 0
        } else {
          const move2 = bestMoveToward(me, sweepTarget ?? goal, worldview.localScan, memory.knownMap, moveMax, mapW, mapH)
          if (move2 != null) {
            calls.push({
              id: `kimi-hunt2-${turn}`,
              tool: { kind: 'move', direction: move2.direction, distance: move2.distance },
            })
          }
        }
      }

      if (calls.length === 0) {
        calls.push({ id: `kimi-pass-${turn}`, tool: { kind: 'pass' } })
      }
      return calls
    },
  }
}
