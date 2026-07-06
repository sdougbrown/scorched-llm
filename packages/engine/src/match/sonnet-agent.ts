import type { WorldView } from '../types/events.js'
import type { Tool, ToolCall } from '../types/tool.js'
import type { Coordinate, Direction } from '../types/coords.js'
import type { MatchConfig } from '../config/schema.js'
import type { AgentTurnResult, TankAgent, ToolExecutor, ToolSpec } from './fake-agents.js'
import { DIRECTION_DELTAS, euclidean, inBounds } from '../geometry/coords.js'
import { supercover } from '../geometry/supercover.js'

/**
 * SonnetAgent — a scripted tank that plays with exact geometry instead of the
 * rounded/clamped heuristics used by the built-in Aggressive/Conservative
 * bots, and that is handed the match's `MatchConfig` so it never has to
 * guess engine constants (shell range, per-move cap, map size, lethality).
 *
 * Design notes (see packages/engine/src/resolution/{shell,movement,flare}.ts
 * and src/match/orchestration.ts for the mechanics this exploits):
 *
 * 1. Precise fire control. `fire_shell` takes a continuous `angle` and
 *    `power` (not integers) and the engine reconstructs the target cell as
 *    `round(firer.position + unitVector(angle) * power)`. Feeding it the
 *    *exact* bearing and Euclidean distance to a currently-visible enemy
 *    lands on their cell (mod obstacles) — no rounding-induced drift like
 *    `Math.round(euclidean(...))` used by the bundled scripted bots.
 *
 * 2. Known-obstacle line-of-sight prediction. A shell's clearance height
 *    follows a parabola (`shellHeight`) that is low near the shooter and the
 *    target and only reaches apex height at the trajectory midpoint,
 *    mirroring `resolution/shell.ts`. Cells this tank has actually observed
 *    as obstacles are checked against that arc before committing the one
 *    offensive action per turn, so a shot known to be blocked is skipped in
 *    favor of repositioning instead of being wasted.
 *
 * 3. Shoot-and-scoot. Only one offensive action (flare or shell) is legal
 *    per turn, but up to `actionEconomy === 'double' ? 2 : 1` action slots
 *    exist. When a second slot is available after firing, it is spent
 *    retreating or strafing away from the target's bearing so a
 *    same-worldview counter-shot at our last known cell misses.
 *
 * 4. Turn-adaptive play. `takeTurn` is handed an `executeTool` callback by
 *    the real match runner (see orchestration.ts) that returns a freshly
 *    rebuilt `WorldView` after *every* action, including moves. This agent
 *    uses that callback to move first and re-check visibility before
 *    deciding whether to fire — a blind turn can become a lethal one
 *    without waiting for the next round. When `executeTool` is absent (unit
 *    tests, or any harness that only wants a static plan), it falls back to
 *    building the same decisions against a locally-simulated worldview.
 *
 * 5. Exact-config awareness. Being constructed with the match's
 *    `MatchConfig` means map bounds, the per-move distance cap, shell max
 *    range, and hits-to-kill are known quantities rather than guesses —
 *    exploration aims at real map waypoints instead of a hardcoded center,
 *    and shots are never wasted by exceeding the real shell range.
 */

const COMPASS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

interface EnemySighting {
  position: Coordinate
  hp: number
  lastSeenTurn: number
}

interface Target {
  id: string
  position: Coordinate
  hp: number
  visible: boolean
  lastSeenTurn: number
}

interface TurnContext {
  offensiveUsed: boolean
  movesUsed: number
}

function cellKey(c: Coordinate): string {
  return `${c.x},${c.y}`
}

/** Clockwise bearing in degrees [0, 360) from `from` to `to`. 0 = N, 90 = E. */
function bearingDeg(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  if (angle >= 360) angle -= 360
  return angle
}

function bearingToDirection(b: number): Direction {
  const idx = ((Math.round(b / 45) % 8) + 8) % 8
  return COMPASS[idx]
}

function normalizeAngle(angle: number): number {
  let a = angle % 360
  if (a < 0) a += 360
  return a
}

/**
 * Height of the shell's parabolic arc at sample index `i` of `N` cells
 * after the shooter — mirrors `resolution/shell.ts:shellHeight`.
 */
function shellArcHeight(i: number, n: number, apexHeight: number, tankHeight: number): number {
  if (n <= 0) return tankHeight
  const progress = (i + 1) / n
  const arc = 4 * progress * (1 - progress)
  return tankHeight + (apexHeight - tankHeight) * arc
}

export function createSonnetAgent(
  tankId: string,
  config: MatchConfig,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const mapWidth = config.map.width
  const mapHeight = config.map.height
  const obstacleHeight = config.map.obstacleHeight
  const shellMaxRange = config.shell.maxRange
  const apexHeight = config.shell.apexHeight
  const tankHeight = config.shell.tankHeight
  const moveMax = Math.max(1, Math.floor(config.moveMax ?? config.fog.flareRadius))
  const flareRadius = config.fog.flareRadius
  const staleThreshold = Math.max(4, config.players.length * 2)

  const knownObstacles = new Set<string>()
  const enemyMemory = new Map<string, EnemySighting>()
  if (lastKnownEnemyPos) {
    enemyMemory.set('enemy', {
      position: lastKnownEnemyPos,
      hp: Number.POSITIVE_INFINITY,
      lastSeenTurn: lastSeenTurn ?? 0,
    })
  }

  // Exploration waypoints: four inset corners plus the exact map center —
  // real coordinates, unlike a hardcoded {10, 10} that only works on a
  // 20x20 board.
  const marginX = Math.max(1, Math.floor(mapWidth * 0.15))
  const marginY = Math.max(1, Math.floor(mapHeight * 0.15))
  const waypoints: Coordinate[] = [
    { x: marginX, y: marginY },
    { x: mapWidth - 1 - marginX, y: marginY },
    { x: mapWidth - 1 - marginX, y: mapHeight - 1 - marginY },
    { x: marginX, y: mapHeight - 1 - marginY },
    { x: Math.round((mapWidth - 1) / 2), y: Math.round((mapHeight - 1) / 2) },
  ]
  let waypointIndex = 0
  let turnsSinceWaypointShift = 0
  let turnsSinceFlareProbe = 2 // probe on the first blind turn

  function absorb(cw: WorldView): void {
    for (const cell of cw.localScan) {
      if (cell.terrain === 'obstacle') knownObstacles.add(cellKey(cell.coord))
    }
    for (const fc of cw.flaredCells) {
      if (fc.cell.terrain === 'obstacle') knownObstacles.add(cellKey(fc.cell.coord))
    }
    if (cw.visibleEnemies) {
      for (const enemy of cw.visibleEnemies) {
        enemyMemory.set(enemy.id, {
          position: { ...enemy.position },
          hp: enemy.hp,
          lastSeenTurn: cw.turn,
        })
      }
    }
  }

  function isPathClear(from: Coordinate, dir: Direction, distance: number): boolean {
    const delta = DIRECTION_DELTAS[dir]
    for (let step = 1; step <= distance; step++) {
      const c: Coordinate = { x: from.x + delta.dx * step, y: from.y + delta.dy * step }
      if (!inBounds(c, mapWidth, mapHeight)) return false
      if (knownObstacles.has(cellKey(c))) return false
    }
    return true
  }

  function orderedDirectionCandidates(desiredBearing: number): Direction[] {
    const offsets = [0, 45, -45, 90, -90, 135, -135, 180]
    const seen = new Set<Direction>()
    const ordered: Direction[] = []
    for (const offset of offsets) {
      const dir = bearingToDirection(normalizeAngle(desiredBearing + offset))
      if (!seen.has(dir)) {
        seen.add(dir)
        ordered.push(dir)
      }
    }
    return ordered
  }

  /** Pick the clearest known-good direction toward `desiredBearing`, falling
   * back to the exact bearing (accepting the risk of a free 'blocked'
   * result) if every candidate is known to be bad. */
  function chooseDirection(from: Coordinate, desiredBearing: number, distance: number): Direction {
    for (const dir of orderedDirectionCandidates(desiredBearing)) {
      if (isPathClear(from, dir, distance)) return dir
    }
    return bearingToDirection(desiredBearing)
  }

  /** True only when a cell we have actually observed as an obstacle sits on
   * the shell's arc with insufficient clearance — mirrors the engine's own
   * obstacle-blocking check in resolution/shell.ts. Unseen cells are
   * optimistically treated as clear, same as real fog-of-war reasoning. */
  function knownBlockedShot(from: Coordinate, to: Coordinate): boolean {
    const cells = supercover(from, to).slice(1)
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      if (!knownObstacles.has(cellKey(cell))) continue
      const height = shellArcHeight(i, cells.length, apexHeight, tankHeight)
      if (height <= obstacleHeight) return true
    }
    return false
  }

  function preciseShot(from: Coordinate, to: Coordinate): { angle: number; power: number } {
    const dx = to.x - from.x
    const dy = to.y - from.y
    return { angle: bearingDeg(from, to), power: Math.sqrt(dx * dx + dy * dy) }
  }

  function pickTarget(cw: WorldView): Target | null {
    if (cw.visibleEnemies && cw.visibleEnemies.length > 0) {
      let best: Target | null = null
      let bestDist = Infinity
      for (const enemy of cw.visibleEnemies) {
        const dist = euclidean(cw.position, enemy.position)
        if (best === null || enemy.hp < best.hp || (enemy.hp === best.hp && dist < bestDist)) {
          best = { id: enemy.id, position: enemy.position, hp: enemy.hp, visible: true, lastSeenTurn: cw.turn }
          bestDist = dist
        }
      }
      return best
    }
    let best: Target | null = null
    for (const [id, sighting] of enemyMemory) {
      if (best === null || sighting.lastSeenTurn > best.lastSeenTurn) {
        best = {
          id,
          position: sighting.position,
          hp: sighting.hp,
          visible: false,
          lastSeenTurn: sighting.lastSeenTurn,
        }
      }
    }
    return best
  }

  function nearestEnemyFlareCenter(cw: WorldView): Coordinate | null {
    if (!cw.activeFlares || cw.inEnemyFlare.length === 0) return null
    const firerIds = new Set(cw.inEnemyFlare.map((f) => f.firerId))
    let best: Coordinate | null = null
    let bestDist = Infinity
    for (const flare of cw.activeFlares) {
      if (!firerIds.has(flare.firerId)) continue
      const dist = euclidean(cw.position, flare.targetCell)
      if (dist < bestDist) {
        bestDist = dist
        best = flare.targetCell
      }
    }
    return best
  }

  /** Retreat directly away from a close threat, or strafe perpendicular to
   * it when already at a comfortable range — classic shoot-and-scoot. */
  function evasionDirection(cw: WorldView, threatPos: Coordinate): Direction {
    const bearing = bearingDeg(cw.position, threatPos)
    const dist = euclidean(cw.position, threatPos)
    const side = cw.turn % 2 === 0 ? 90 : -90
    const desired = dist < shellMaxRange * 0.4 ? bearing + 180 : bearing + side
    return chooseDirection(cw.position, normalizeAngle(desired), moveMax)
  }

  function currentWaypoint(): Coordinate {
    return waypoints[waypointIndex % waypoints.length]
  }

  function advanceWaypoint(): void {
    waypointIndex = (waypointIndex + 1) % waypoints.length
    turnsSinceWaypointShift = 0
  }

  /** Pure decision core shared by the adaptive and static code paths: given
   * the current worldview and what has already happened this turn, returns
   * the next tool to attempt, or null when there is nothing useful left to
   * do. */
  function decide(cw: WorldView, ctx: TurnContext): Tool | null {
    const exposed = cw.inEnemyFlare.length > 0
    const target = pickTarget(cw)

    if (target) {
      const { angle, power } = preciseShot(cw.position, target.position)
      const inRange = power <= shellMaxRange + 1e-6
      const clearShot = !knownBlockedShot(cw.position, target.position)
      const engageable = target.visible && inRange && clearShot

      if (engageable && !ctx.offensiveUsed) {
        return { kind: 'fire_shell', angle, power }
      }

      if (ctx.offensiveUsed && ctx.movesUsed === 0) {
        return { kind: 'move', direction: evasionDirection(cw, target.position), distance: moveMax }
      }

      if (!engageable && ctx.movesUsed < 2) {
        if (!target.visible) {
          const stale = cw.turn - target.lastSeenTurn > staleThreshold
          if (stale && !ctx.offensiveUsed) {
            const range = Math.min(
              Math.max(1, Math.round(euclidean(cw.position, target.position))),
              shellMaxRange,
            )
            return {
              kind: 'fire_flare',
              direction: bearingToDirection(bearingDeg(cw.position, target.position)),
              range,
            }
          }
        }
        return {
          kind: 'move',
          direction: chooseDirection(cw.position, bearingDeg(cw.position, target.position), moveMax),
          distance: moveMax,
        }
      }
    }

    if (exposed && !ctx.offensiveUsed && ctx.movesUsed === 0) {
      const center = nearestEnemyFlareCenter(cw)
      const dir = center
        ? evasionDirection(cw, center)
        : chooseDirection(cw.position, bearingDeg(cw.position, currentWaypoint()), moveMax)
      return { kind: 'move', direction: dir, distance: moveMax }
    }

    if (!target) {
      if (turnsSinceFlareProbe >= 2 && !ctx.offensiveUsed) {
        return {
          kind: 'fire_flare',
          direction: bearingToDirection(bearingDeg(cw.position, currentWaypoint())),
          range: Math.min(Math.max(1, moveMax + flareRadius), shellMaxRange),
        }
      }
      if (ctx.movesUsed < 2) {
        if (euclidean(cw.position, currentWaypoint()) <= 1) {
          advanceWaypoint()
        }
        return {
          kind: 'move',
          direction: chooseDirection(cw.position, bearingDeg(cw.position, currentWaypoint()), moveMax),
          distance: moveMax,
        }
      }
    }

    return null
  }

  function passCall(turn: number): ToolCall {
    return { id: `sonnet-${tankId}-${turn}-pass`, tool: { kind: 'pass' } }
  }

  async function adaptiveTurn(initial: WorldView, executeTool: ToolExecutor): Promise<AgentTurnResult> {
    let cw = initial
    const calls: ToolCall[] = []
    const ctx: TurnContext = { offensiveUsed: false, movesUsed: 0 }
    let seq = 0

    for (let iter = 0; iter < 6; iter++) {
      if (cw.remainingActions <= 0) break
      const tool = decide(cw, ctx)
      if (!tool) break

      const call: ToolCall = { id: `sonnet-${tankId}-${cw.turn}-${seq++}`, tool }
      calls.push(call)
      const exec = await executeTool(call)
      cw = exec.worldview
      absorb(cw)

      if (tool.kind === 'fire_flare') {
        turnsSinceFlareProbe = 0
        ctx.offensiveUsed = true
      } else if (tool.kind === 'fire_shell') {
        ctx.offensiveUsed = true
      } else if (tool.kind === 'move') {
        ctx.movesUsed += 1
      }

      if (exec.turnEnded) break
    }

    if (calls.length === 0) {
      const call = passCall(initial.turn)
      calls.push(call)
      await executeTool(call)
    }

    return { toolCalls: calls, executed: true }
  }

  /** No-`executeTool` fallback: simulate our own actions optimistically
   * (position updates, action-slot accounting) since there is no engine to
   * ask. Used by direct unit tests and any harness that only wants a static
   * plan back. */
  function staticTurn(initial: WorldView): ToolCall[] {
    let cw = initial
    const calls: ToolCall[] = []
    const ctx: TurnContext = { offensiveUsed: false, movesUsed: 0 }
    let remaining = initial.remainingActions
    let seq = 0

    while (remaining > 0) {
      const tool = decide(cw, ctx)
      if (!tool) break
      calls.push({ id: `sonnet-${tankId}-${initial.turn}-${seq++}`, tool })

      if (tool.kind === 'move') {
        const delta = DIRECTION_DELTAS[tool.direction]
        cw = {
          ...cw,
          position: { x: cw.position.x + delta.dx * tool.distance, y: cw.position.y + delta.dy * tool.distance },
        }
        ctx.movesUsed += 1
      } else if (tool.kind === 'fire_flare') {
        turnsSinceFlareProbe = 0
        ctx.offensiveUsed = true
      } else if (tool.kind === 'fire_shell') {
        ctx.offensiveUsed = true
      }
      remaining -= 1
    }

    if (calls.length === 0) {
      calls.push(passCall(initial.turn))
    }
    return calls
  }

  return {
    name: `sonnet-${tankId}`,
    messages: [],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `sonnet-${tankId}-${worldview.turn}-pass`, tool: { kind: 'pass' } }]
      }

      absorb(worldview)

      if (pickTarget(worldview) === null) {
        turnsSinceFlareProbe += 1
        turnsSinceWaypointShift += 1
        if (turnsSinceWaypointShift >= 4) {
          advanceWaypoint()
        }
      }

      if (executeTool) {
        return adaptiveTurn(worldview, executeTool)
      }
      return staticTurn(worldview)
    },
  }
}
