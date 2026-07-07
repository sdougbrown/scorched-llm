import type { WorldView } from '@scorched-llm/engine'
import type { ActionResult, ToolCall } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec, ToolExecutor, AgentTurnResult } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, euclidean } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/**
 * Sonnet-5b — second independent Sonnet 5 build of the same brief (originally
 * mislabeled sonnet-4.6; the run turned out to be Sonnet 5). Kept as a
 * within-model consistency sample alongside sonnet-agent.ts. Mechanically
 * renamed only — no tactical changes.
 *
 * A heuristic tank built by reverse-engineering the engine's
 * combat math rather than by pattern-matching worldview snapshots.
 *
 * Key exploited facts (see resolution/shell.ts, worldview/build.ts):
 *  - fire_shell is deterministic hitscan: angle=bearing, power=distance
 *    lands exactly on the target cell (no wind/RNG). Precision aim beats
 *    the stock scripted bots, which clamp power to a hardcoded 10 instead
 *    of the true distance and round to integer power.
 *  - Local vision (radius 3) has no line-of-sight occlusion and is
 *    distance-symmetric: if I can see them this turn, they can see me too.
 *  - Only one offensive action (shell xor flare) is allowed per turn, but
 *    invalid/blocked tool calls don't consume the action budget — only a
 *    run of 3 in a row ends the turn early — so failed probes are cheap.
 *  - Shell arc height is a parabola from tankHeight at both ends up to
 *    apexHeight at the trajectory midpoint; obstacles near the shooter or
 *    target block the shot even when the map is otherwise clear.
 */

const DIRS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const OPPOSITE_DIR: Record<Direction, Direction> = {
  N: 'S', NE: 'SW', E: 'W', SE: 'NW', S: 'N', SW: 'NE', W: 'E', NW: 'SE',
}

/** Arc constants shared by every current preset (duel/blitz/survival). */
const ASSUMED_APEX_HEIGHT = 5
const ASSUMED_TANK_HEIGHT = 1

function cellKey(c: Coordinate): string {
  return `${c.x},${c.y}`
}

/** Clockwise bearing in degrees from north, matching resolution/shell.ts angleToDelta. */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function bearingToDirection(b: number): Direction {
  const idx = Math.round(b / 45) % 8
  return DIRS[idx]
}

interface EnemyRecord {
  id: string
  pos: Coordinate
  hp: number
  lastSeenTurn: number
  prevPos: Coordinate | null
  prevSeenTurn: number | null
}

interface Sonnet46Memory {
  enemies: Map<string, EnemyRecord>
  knownTerrain: Map<string, Cell>
  learnedMaxRange: number | null
  learnedMoveMax: number | null
  blindStreak: number
  waypointIdx: number
  waypointStallTurns: number
  waypointLastDist: number | null
  /** Cells a move into has actually failed at runtime — learned live, not from vision. */
  badCells: Set<string>
  /** Position at the start of each of the last few turns — detects multi-turn oscillation loops. */
  recentPositions: string[]
  pendingCycleBreak: boolean
}

function createMemory(): Sonnet46Memory {
  return {
    enemies: new Map(),
    knownTerrain: new Map(),
    learnedMaxRange: null,
    learnedMoveMax: null,
    blindStreak: 0,
    waypointIdx: -1,
    waypointStallTurns: 0,
    waypointLastDist: null,
    badCells: new Set(),
    recentPositions: [],
    pendingCycleBreak: false,
  }
}

/**
 * Detour around an obstacle corner can settle into a period-N loop that
 * revisits the same start-of-turn position forever (net displacement per
 * turn cancels out). A simple turn-over-turn distance comparison doesn't
 * catch this since distance to goal isn't monotonic across the cycle —
 * so track raw position history instead and flag an exact repeat.
 */
function trackPositionCycle(memory: Sonnet46Memory, wv: WorldView): void {
  const key = cellKey(wv.position)
  if (memory.recentPositions.includes(key)) memory.pendingCycleBreak = true
  memory.recentPositions.push(key)
  if (memory.recentPositions.length > 8) memory.recentPositions.shift()
}

function absorbWorldview(memory: Sonnet46Memory, wv: WorldView): void {
  for (const cell of wv.localScan) memory.knownTerrain.set(cellKey(cell.coord), cell)
  for (const fc of wv.flaredCells) memory.knownTerrain.set(cellKey(fc.cell.coord), fc.cell)

  const seenNow = new Set<string>()
  for (const enemy of wv.visibleEnemies ?? []) {
    seenNow.add(enemy.id)
    const prior = memory.enemies.get(enemy.id)
    if (prior && prior.lastSeenTurn === wv.turn) {
      // Re-observed within our own multi-action turn — refresh but keep real history.
      memory.enemies.set(enemy.id, { ...prior, pos: enemy.position, hp: enemy.hp })
    } else {
      memory.enemies.set(enemy.id, {
        id: enemy.id,
        pos: enemy.position,
        hp: enemy.hp,
        lastSeenTurn: wv.turn,
        prevPos: prior?.pos ?? null,
        prevSeenTurn: prior?.lastSeenTurn ?? null,
      })
    }
  }
  memory.blindStreak = seenNow.size > 0 ? 0 : memory.blindStreak + 1
}

/** Linear extrapolation from the last two sightings, damped to avoid wild overshoots. */
function predictPosition(rec: EnemyRecord, currentTurn: number): Coordinate {
  if (rec.prevPos != null && rec.prevSeenTurn != null) {
    const dt = rec.lastSeenTurn - rec.prevSeenTurn
    if (dt > 0) {
      const vx = (rec.pos.x - rec.prevPos.x) / dt
      const vy = (rec.pos.y - rec.prevPos.y) / dt
      const elapsed = currentTurn - rec.lastSeenTurn
      if (Math.abs(vx) <= 1.5 && Math.abs(vy) <= 1.5 && elapsed <= 3 && elapsed > 0) {
        return { x: Math.round(rec.pos.x + vx * elapsed), y: Math.round(rec.pos.y + vy * elapsed) }
      }
    }
  }
  return rec.pos
}

interface Target {
  id: string
  aimPos: Coordinate
  hp: number
  lastSeenTurn: number
  visibleNow: boolean
}

/** Pick the most actionable enemy: a live sighting first (lowest HP, then nearest), else freshest memory. */
function bestTarget(memory: Sonnet46Memory, wv: WorldView): Target | null {
  const visible = wv.visibleEnemies ?? []
  if (visible.length > 0) {
    let best = visible[0]
    for (const e of visible) {
      const better =
        e.hp < best.hp ||
        (e.hp === best.hp && euclidean(wv.position, e.position) < euclidean(wv.position, best.position))
      if (better) best = e
    }
    return { id: best.id, aimPos: best.position, hp: best.hp, lastSeenTurn: wv.turn, visibleNow: true }
  }

  let bestRec: EnemyRecord | null = null
  for (const rec of memory.enemies.values()) {
    if (bestRec == null || rec.lastSeenTurn > bestRec.lastSeenTurn) bestRec = rec
  }
  if (bestRec == null) return null

  return {
    id: bestRec.id,
    aimPos: predictPosition(bestRec, wv.turn),
    hp: bestRec.hp,
    lastSeenTurn: bestRec.lastSeenTurn,
    visibleNow: false,
  }
}

/** Estimate whether a known obstacle interrupts the shell arc before it reaches `to`. */
function shotLikelyBlocked(from: Coordinate, to: Coordinate, knownTerrain: Map<string, Cell>): boolean {
  const cells = supercover(from, to).slice(1)
  const n = cells.length
  if (n === 0) return false
  for (let i = 0; i < n; i++) {
    const progress = (i + 1) / n
    const arc = progress * (1 - progress)
    const height = ASSUMED_TANK_HEIGHT + (ASSUMED_APEX_HEIGHT - ASSUMED_TANK_HEIGHT) * 4 * arc
    const cell = knownTerrain.get(cellKey(cells[i]))
    if (cell && cell.terrain === 'obstacle' && height <= cell.obstacleHeight) return true
  }
  return false
}

/** Exact bearing + true (unrounded) distance — precision aim, not rounded-power guesswork. */
function buildShellCall(from: Coordinate, to: Coordinate, maxRangeGuess: number, id: string): ToolCall {
  const angle = bearing(from, to)
  const dist = euclidean(from, to)
  const power = Math.max(1, Math.min(dist, maxRangeGuess))
  return { id, tool: { kind: 'fire_shell', angle, power } }
}

function flareCallTowards(from: Coordinate, to: Coordinate, id: string): ToolCall {
  const direction = bearingToDirection(bearing(from, to))
  const range = Math.max(1, Math.round(euclidean(from, to)))
  return { id, tool: { kind: 'fire_flare', direction, range } }
}

/**
 * Fixed boustrophedon sweep of the plausible map area (covers every current
 * preset, 15x15 to 25x25). Anchored in absolute coordinates rather than
 * relative to current position, so unlike a rotating scan it can't degrade
 * into an orbit that never reaches a stationary/stuck enemy.
 */
const WAYPOINTS: Coordinate[] = [
  { x: 3, y: 3 }, { x: 9, y: 3 }, { x: 15, y: 3 }, { x: 21, y: 3 },
  { x: 21, y: 9 }, { x: 15, y: 9 }, { x: 9, y: 9 }, { x: 3, y: 9 },
  { x: 3, y: 15 }, { x: 9, y: 15 }, { x: 15, y: 15 }, { x: 21, y: 15 },
  { x: 21, y: 21 }, { x: 15, y: 21 }, { x: 9, y: 21 }, { x: 3, y: 21 },
]
const WAYPOINT_ARRIVE_RADIUS = 3
const WAYPOINT_STALL_LIMIT = 6

/** Advance through the fixed sweep, skipping ahead on arrival or when stuck. */
function scoutWaypoint(memory: Sonnet46Memory, wv: WorldView): Coordinate {
  if (memory.waypointIdx === -1) {
    let bestI = 0
    let bestD = Infinity
    for (let i = 0; i < WAYPOINTS.length; i++) {
      const d = euclidean(wv.position, WAYPOINTS[i])
      if (d < bestD) {
        bestD = d
        bestI = i
      }
    }
    memory.waypointIdx = bestI
    memory.waypointStallTurns = 0
    memory.waypointLastDist = null
  }

  const advance = () => {
    memory.waypointIdx++
    memory.waypointStallTurns = 0
    memory.waypointLastDist = null
  }

  let dist = euclidean(wv.position, WAYPOINTS[memory.waypointIdx % WAYPOINTS.length])
  if (dist <= WAYPOINT_ARRIVE_RADIUS) {
    advance()
  } else if (memory.pendingCycleBreak) {
    advance()
  } else if (memory.waypointLastDist != null) {
    if (dist >= memory.waypointLastDist - 0.25) memory.waypointStallTurns++
    else memory.waypointStallTurns = 0
    if (memory.waypointStallTurns >= WAYPOINT_STALL_LIMIT) advance()
  }
  memory.pendingCycleBreak = false

  const wp = WAYPOINTS[memory.waypointIdx % WAYPOINTS.length]
  dist = euclidean(wv.position, wp)
  memory.waypointLastDist = dist
  return wp
}

function awayPoint(from: Coordinate, threat: Coordinate): Coordinate {
  const dx = from.x - threat.x
  const dy = from.y - threat.y
  const mag = Math.hypot(dx, dy) || 1
  const scale = 6 / mag
  return { x: Math.round(from.x + dx * scale), y: Math.round(from.y + dy * scale) }
}

/**
 * Rank the 8 compass directions by how much closer their first step gets to
 * `goal`, penalizing directions whose path (up to `checkDist`) crosses a
 * known obstacle or a cell we've learned by trial is impassable.
 */
function rankDirections(
  from: Coordinate,
  goal: Coordinate,
  knownTerrain: Map<string, Cell>,
  badCells: Set<string>,
  checkDist: number,
): Direction[] {
  const scored = DIRS.map((d) => {
    const delta = DIRECTION_DELTAS[d]
    let obstaclePenalty = 0
    for (let step = 1; step <= checkDist; step++) {
      const cell = { x: from.x + delta.dx * step, y: from.y + delta.dy * step }
      const key = cellKey(cell)
      const known = knownTerrain.get(key)
      if ((known && known.terrain === 'obstacle') || badCells.has(key)) {
        obstaclePenalty = 1000
        break
      }
    }
    const step1 = { x: from.x + delta.dx, y: from.y + delta.dy }
    return { d, score: euclidean(step1, goal) + obstaclePenalty }
  })
  scored.sort((a, b) => a.score - b.score)
  return scored.map((s) => s.d)
}

function reasonOf(result: ActionResult): string | null {
  return result.kind === 'blocked' || result.kind === 'invalid' ? result.reason : null
}

/**
 * Adaptive turn: uses the live executor so aim and pathing react to real
 * engine feedback (learning maxRange/moveMax caps from rejected calls,
 * retrying with corrected values) instead of guessing blind once per turn.
 */
async function adaptiveTurn(
  memory: Sonnet46Memory,
  initialWv: WorldView,
  executeTool: ToolExecutor,
): Promise<AgentTurnResult> {
  const executed: ToolCall[] = []
  let wv = initialWv
  let turnEnded = false
  let callIdx = 0
  const nextId = (kind: string) => `${kind}-${wv.turn}-${callIdx++}`

  const runCall = async (call: ToolCall) => {
    executed.push(call)
    const exec = await executeTool(call)
    wv = exec.worldview
    turnEnded = exec.turnEnded
    return exec.result
  }

  // --- Offense phase (at most one of shell / flare) ---
  const target = bestTarget(memory, wv)
  let firedShell = false

  if (!turnEnded && target) {
    const staleness = wv.turn - target.lastSeenTurn
    const trustworthy = target.visibleNow || staleness <= 2
    const dist = euclidean(wv.position, target.aimPos)
    const rangeOk = memory.learnedMaxRange == null || dist <= memory.learnedMaxRange
    const blocked = shotLikelyBlocked(wv.position, target.aimPos, memory.knownTerrain)

    if (trustworthy && rangeOk && !blocked) {
      const maxRangeGuess = memory.learnedMaxRange ?? 14
      const call = buildShellCall(wv.position, target.aimPos, maxRangeGuess, nextId('shell'))
      const result = await runCall(call)
      if (!turnEnded) {
        if (result.kind === 'blocked') {
          const m = /between 1 and (\d+)/.exec(reasonOf(result) ?? '')
          if (m && wv.remainingActions > 0) {
            memory.learnedMaxRange = parseInt(m[1], 10)
            const retry = buildShellCall(wv.position, target.aimPos, memory.learnedMaxRange, nextId('shell'))
            await runCall(retry)
            firedShell = true
          }
        } else {
          firedShell = true
        }
      }
    }
  }

  if (!turnEnded && !firedShell && wv.remainingActions > 0) {
    const staleness = target ? wv.turn - target.lastSeenTurn : Infinity
    const wantFlare = target
      ? !target.visibleNow && staleness > 3
      : memory.blindStreak >= 2
    if (wantFlare) {
      const flareGoal = target ? target.aimPos : scoutWaypoint(memory, wv)
      await runCall(flareCallTowards(wv.position, flareGoal, nextId('flare')))
    }
  }

  // --- Movement phase ---
  let movesUsed = 0
  let lastMoveDir: Direction | null = null
  while (!turnEnded && wv.remainingActions > 0 && movesUsed < 2) {
    absorbWorldview(memory, wv)
    const currentTarget = bestTarget(memory, wv)
    let goal: Coordinate
    if (currentTarget) {
      goal =
        firedShell && wv.hp <= currentTarget.hp
          ? awayPoint(wv.position, currentTarget.aimPos)
          : currentTarget.aimPos
    } else {
      goal = scoutWaypoint(memory, wv)
    }

    const moveDistGuess = Math.max(1, memory.learnedMoveMax ?? 2)
    const ranked = rankDirections(wv.position, goal, memory.knownTerrain, memory.badCells, moveDistGuess)
    // Never immediately undo the move we just made this turn — a greedy
    // 1-step lookahead otherwise ping-pongs forever around obstacle corners.
    const candidates: Direction[] =
      lastMoveDir != null
        ? [...ranked.filter((d) => d !== OPPOSITE_DIR[lastMoveDir as Direction]), OPPOSITE_DIR[lastMoveDir as Direction]]
        : ranked
    let moved = false
    for (let attempt = 0; attempt < 2 && attempt < candidates.length && !turnEnded; attempt++) {
      const dir = candidates[attempt]
      const distGuess = moveDistGuess
      const fromPos = wv.position
      const result = await runCall({ id: nextId('move'), tool: { kind: 'move', direction: dir, distance: distGuess } })
      if (turnEnded) break
      if (result.kind === 'ok') {
        moved = true
        movesUsed++
        lastMoveDir = dir
        break
      }
      const reason = reasonOf(result) ?? ''
      if (/obstacle/i.test(reason) || /out of bounds/i.test(reason)) {
        const delta = DIRECTION_DELTAS[dir]
        const target = { x: fromPos.x + delta.dx * distGuess, y: fromPos.y + delta.dy * distGuess }
        memory.badCells.add(cellKey(target))
      }
      const m = /per-action maximum of (\d+)/.exec(reason)
      if (m) {
        memory.learnedMoveMax = parseInt(m[1], 10)
        if (memory.learnedMoveMax >= 1 && memory.learnedMoveMax !== distGuess && wv.remainingActions > 0) {
          const retryResult = await runCall({
            id: nextId('move'),
            tool: { kind: 'move', direction: dir, distance: memory.learnedMoveMax },
          })
          if (retryResult.kind === 'ok') {
            moved = true
            movesUsed++
            lastMoveDir = dir
            break
          }
        }
      }
      // Obstacle / bounds / occupied — fall through and try the next-best direction.
    }
    if (!moved) break
  }

  return { toolCalls: executed, executed: true }
}

/** Single-pass fallback used only when no executor is supplied (unit tests / dry inspection). */
function simpleTurn(memory: Sonnet46Memory, wv: WorldView): ToolCall[] {
  const calls: ToolCall[] = []
  const target = bestTarget(memory, wv)
  let firedShell = false

  if (target) {
    const staleness = wv.turn - target.lastSeenTurn
    const trustworthy = target.visibleNow || staleness <= 2
    const dist = euclidean(wv.position, target.aimPos)
    const rangeOk = memory.learnedMaxRange == null || dist <= memory.learnedMaxRange
    const blocked = shotLikelyBlocked(wv.position, target.aimPos, memory.knownTerrain)
    if (trustworthy && rangeOk && !blocked) {
      calls.push(buildShellCall(wv.position, target.aimPos, memory.learnedMaxRange ?? 14, `shell-${wv.turn}`))
      firedShell = true
    }
  }

  if (!firedShell) {
    const staleness = target ? wv.turn - target.lastSeenTurn : Infinity
    const wantFlare = target ? !target.visibleNow && staleness > 3 : memory.blindStreak >= 2
    if (wantFlare) {
      const flareGoal = target ? target.aimPos : scoutWaypoint(memory, wv)
      calls.push(flareCallTowards(wv.position, flareGoal, `flare-${wv.turn}`))
      firedShell = true // occupies the single offense slot
    }
  }

  const goal = target
    ? firedShell && wv.hp <= target.hp
      ? awayPoint(wv.position, target.aimPos)
      : target.aimPos
    : scoutWaypoint(memory, wv)
  const dir = rankDirections(wv.position, goal, memory.knownTerrain, memory.badCells, 1)[0]
  calls.push({ id: `move-${wv.turn}`, tool: { kind: 'move', direction: dir, distance: 1 } })

  return calls
}

/**
 * Sonnet-4.6's tank: precision hitscan aim (exact bearing + true distance,
 * not rounded power), obstacle-aware fire discipline, HP-relative
 * press/retreat after every shot, and adaptive learning of this match's
 * maxRange/moveMax caps from live engine feedback.
 */
export function createSonnet5bAgent(
  tankId: string,
  lastKnownEnemyPos?: Coordinate,
  lastSeenTurn?: number,
): TankAgent {
  const memory = createMemory()
  if (lastKnownEnemyPos !== undefined) {
    memory.enemies.set('seed', {
      id: 'seed',
      pos: lastKnownEnemyPos,
      hp: 2,
      lastSeenTurn: lastSeenTurn ?? 0,
      prevPos: null,
      prevSeenTurn: null,
    })
  }

  return {
    name: `sonnet-5b-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      absorbWorldview(memory, worldview)
      trackPositionCycle(memory, worldview)

      if (executeTool) {
        return adaptiveTurn(memory, worldview, executeTool)
      }
      return simpleTurn(memory, worldview)
    },
  }
}
