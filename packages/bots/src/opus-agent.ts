import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type {
  TankAgent,
  AgentMessage,
  ToolSpec,
  ToolExecutor,
  AgentTurnResult,
} from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import { euclidean, inBounds, DIRECTION_DELTAS } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/**
 * OpusAgent — a lethal scripted tank.
 *
 * Design philosophy: the engine's shell resolution is fully deterministic, so
 * rather than guessing at aim (like the aggressive/conservative bots, which
 * fire at a `lastKnownEnemyPos` they never actually populate), this agent
 * *replicates the engine's shell math exactly* and brute-forces an
 * `(angle, power)` pair that is guaranteed to land on a currently-visible
 * enemy given the terrain it has mapped. It only ever fires at enemies it can
 * actually see, so nearly every shell connects.
 *
 * It drives its turn incrementally through the supplied `executeTool` callback:
 * it can move to open a firing lane, observe the rebuilt worldview, and then
 * fire — all within a single turn. When blind it maps the arena, closes toward
 * the enemy's last-known position, and pops flares to relocate.
 *
 * Key engine facts exploited (see resolution/shell.ts, movement.ts,
 * rules/turn-rules.ts, worldview/build.ts):
 *   - A shell hits the first living enemy whose cell lies on the supercover
 *     line from firer to the rounded target point, unless an obstacle blocks it
 *     first. The shell arcs: height starts/ends at `tankHeight` and peaks at
 *     `apexHeight` mid-flight, so obstacles only block near the two endpoints.
 *   - `worldview.visibleEnemies` gives exact enemy coordinates whenever an enemy
 *     sits in local vision (radius 3) or any active flare.
 *   - Only one offensive action (shell OR flare) is allowed per turn; a turn has
 *     `actionBudget` actions total; a blocked move counts toward the 3-strike
 *     limit, so moves are validated against mapped terrain before being issued.
 */

/** Engine/arena parameters the agent needs to reason about shots and moves. */
export interface OpusOptions {
  mapWidth: number
  mapHeight: number
  maxRange: number
  apexHeight: number
  tankHeight: number
  obstacleHeight: number
  moveMax: number
  actionBudget: number
  maxToolCalls: number
}

const DEFAULT_OPTIONS: OpusOptions = {
  mapWidth: 20,
  mapHeight: 20,
  maxRange: 10,
  apexHeight: 5,
  tankHeight: 1,
  obstacleHeight: 3,
  moveMax: 2,
  actionBudget: 2,
  maxToolCalls: 5,
}

const DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** Derive Opus's arena parameters from a fully-parsed match config. */
export function opusOptionsFromConfig(config: MatchConfig): OpusOptions {
  return {
    mapWidth: config.map.width,
    mapHeight: config.map.height,
    maxRange: config.shell.maxRange,
    apexHeight: config.shell.apexHeight,
    tankHeight: config.shell.tankHeight,
    obstacleHeight: config.map.obstacleHeight,
    moveMax: config.moveMax ?? config.fog.flareRadius,
    actionBudget: config.actionEconomy === 'double' ? 2 : 1,
    maxToolCalls: config.maxToolCallsPerTurn,
  }
}

interface EnemySighting {
  id: string
  position: Coordinate
  hp: number
}

// --- Geometry helpers (mirror the engine exactly) ---

/**
 * Convert a clockwise bearing (degrees from north) to a delta vector.
 * Mirrors resolution/shell.ts::angleToDelta so simulated shots match the engine.
 */
function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/**
 * Parabolic shell height at sample index `i` of `n`. Mirrors
 * resolution/shell.ts::shellHeight — starts/ends at tankHeight, peaks at apex.
 */
function shellHeight(i: number, n: number, apex: number, tank: number): number {
  if (n <= 0) return tank
  const progress = (i + 1) / n
  const arc = 4 * progress * (1 - progress)
  return tank + (apex - tank) * arc
}

/** Clockwise bearing (0–360, 0 = north) from `from` to `to`. */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Round a bearing to the nearest of the eight compass directions. */
function bearingToDirection(b: number): Direction {
  return DIRECTIONS[Math.round(b / 45) % 8]
}

function key(c: Coordinate): string {
  return `${c.x},${c.y}`
}

// --- Shell simulation ---

interface ShotSim {
  hitId: string | null
  /** True if the trajectory crossed an unmapped cell at blockable height. */
  risky: boolean
}

/**
 * Replicate the engine's shell resolution against mapped terrain and the set of
 * known enemy positions. Unmapped cells are treated as passable but flagged
 * risky when the shell is low enough there for a hidden obstacle to block it.
 */
function simulateShell(
  from: Coordinate,
  angle: number,
  power: number,
  terrain: Map<string, Cell>,
  enemies: EnemySighting[],
  o: OpusOptions,
): ShotSim {
  const delta = angleToDelta(angle)
  const target: Coordinate = {
    x: Math.round(from.x + delta.dx * power),
    y: Math.round(from.y + delta.dy * power),
  }
  const cells = supercover(from, target).slice(1)
  const n = cells.length
  let risky = false

  for (let i = 0; i < n; i++) {
    const cell = cells[i]
    if (!inBounds(cell, o.mapWidth, o.mapHeight)) {
      return { hitId: null, risky }
    }
    const height = shellHeight(i, n, o.apexHeight, o.tankHeight)
    const known = terrain.get(key(cell))
    if (known) {
      if (known.terrain === 'obstacle' && height <= known.obstacleHeight) {
        return { hitId: null, risky }
      }
    } else if (height <= o.obstacleHeight) {
      // A hidden obstacle here could block the shell.
      risky = true
    }
    for (const enemy of enemies) {
      if (enemy.position.x === cell.x && enemy.position.y === cell.y) {
        return { hitId: enemy.id, risky }
      }
    }
  }
  return { hitId: null, risky }
}

interface FiringSolution {
  angle: number
  power: number
  targetId: string
  risky: boolean
}

interface ScoredSolution extends FiringSolution {
  score: number
}

/**
 * Search for an `(angle, power)` that the engine will resolve as a hit on a
 * visible enemy. Prioritises finishing blows (lowest-HP enemy), unobstructed
 * (non-risky) trajectories, then the closest target and lowest power.
 */
function findFiringSolution(
  from: Coordinate,
  enemies: EnemySighting[],
  terrain: Map<string, Cell>,
  o: OpusOptions,
): FiringSolution | null {
  if (enemies.length === 0) return null

  const ranked = [...enemies].sort(
    (a, b) => a.hp - b.hp || euclidean(from, a.position) - euclidean(from, b.position),
  )

  let best: ScoredSolution | undefined

  for (const target of ranked) {
    const bearingDeg = bearing(from, target.position)
    const dist = euclidean(from, target.position)

    for (let power = 1; power <= o.maxRange; power++) {
      // Skip powers that cannot plausibly carry the shell to the target cell.
      if (power < dist - 1.5) continue

      for (let offset = -14; offset <= 14; offset += 0.5) {
        let angle = ((bearingDeg + offset) % 360 + 360) % 360
        if (angle >= 360) angle -= 360

        const sim = simulateShell(from, angle, power, terrain, enemies, o)
        if (!sim.hitId) continue

        const wrongTarget = sim.hitId === target.id ? 0 : 3
        const riskPenalty = sim.risky ? 2 : 0
        const score =
          wrongTarget + riskPenalty + power * 0.05 + Math.abs(offset) * 0.01
        const candidate: ScoredSolution = {
          angle,
          power,
          targetId: sim.hitId,
          risky: sim.risky,
          score,
        }
        if (best === undefined || candidate.score < best.score) {
          best = candidate
        }
      }
    }

    // A safe, on-target, low-power solution is good enough — stop searching.
    if (best !== undefined && best.score < 1) break
  }

  if (best === undefined) return null
  return {
    angle: best.angle,
    power: best.power,
    targetId: best.targetId,
    risky: best.risky,
  }
}

// --- Movement helpers ---

/**
 * Whether every cell along `direction × distance` from `from` is in bounds and
 * not a mapped obstacle or a known-occupied cell. When `strict`, unmapped cells
 * are rejected too (guarantees the move cannot be blocked).
 */
function pathClear(
  from: Coordinate,
  direction: Direction,
  distance: number,
  terrain: Map<string, Cell>,
  enemies: EnemySighting[],
  o: OpusOptions,
  strict: boolean,
): boolean {
  const d = DIRECTION_DELTAS[direction]
  for (let step = 1; step <= distance; step++) {
    const cell: Coordinate = { x: from.x + d.dx * step, y: from.y + d.dy * step }
    if (!inBounds(cell, o.mapWidth, o.mapHeight)) return false
    const known = terrain.get(key(cell))
    if (known) {
      if (known.terrain === 'obstacle') return false
    } else if (strict) {
      return false
    }
    if (enemies.some((e) => e.position.x === cell.x && e.position.y === cell.y)) {
      return false
    }
  }
  return true
}

function step(from: Coordinate, direction: Direction, distance: number): Coordinate {
  const d = DIRECTION_DELTAS[direction]
  return { x: from.x + d.dx * distance, y: from.y + d.dy * distance }
}

interface MovePlan {
  direction: Direction
  distance: number
}

/**
 * Best move (over mapped-clear paths) that minimises distance to `target`.
 * Falls back to a cautious single unmapped step when nothing is mapped-clear.
 */
function bestMoveToward(
  from: Coordinate,
  target: Coordinate,
  terrain: Map<string, Cell>,
  enemies: EnemySighting[],
  o: OpusOptions,
  avoid: Set<string>,
): MovePlan | null {
  let best: { plan: MovePlan; dist: number } | null = null

  for (const direction of DIRECTIONS) {
    for (let distance = o.moveMax; distance >= 1; distance--) {
      if (!pathClear(from, direction, distance, terrain, enemies, o, true)) continue
      const dest = step(from, direction, distance)
      if (avoid.has(key(dest))) continue
      const dist = euclidean(dest, target)
      if (!best || dist < best.dist) best = { plan: { direction, distance }, dist }
    }
  }
  if (best && best.dist < euclidean(from, target)) return best.plan

  // Nothing mapped-clear improves position — probe one unmapped step forward.
  const dir = bearingToDirection(bearing(from, target))
  for (const cand of [dir, ...DIRECTIONS]) {
    if (avoid.has(key(step(from, cand, 1)))) continue
    if (pathClear(from, cand, 1, terrain, enemies, o, false)) {
      const dest = step(from, cand, 1)
      if (euclidean(dest, target) <= euclidean(from, target)) {
        return { direction: cand, distance: 1 }
      }
    }
  }
  return null
}

/** Best mapped-clear move that maximises distance from `threat` (evasion). */
function bestEvade(
  from: Coordinate,
  threat: Coordinate,
  terrain: Map<string, Cell>,
  enemies: EnemySighting[],
  o: OpusOptions,
  maxDistance: number,
): MovePlan | null {
  let best: { plan: MovePlan; dist: number } | null = null
  const cap = Math.min(maxDistance, o.moveMax)
  for (const direction of DIRECTIONS) {
    for (let distance = cap; distance >= 1; distance--) {
      if (!pathClear(from, direction, distance, terrain, enemies, o, true)) continue
      const dest = step(from, direction, distance)
      const dist = euclidean(dest, threat)
      if (!best || dist > best.dist) best = { plan: { direction, distance }, dist }
    }
  }
  return best && best.dist > euclidean(from, threat) ? best.plan : null
}

/** Plan a flare that lands in bounds, aimed toward `target`. */
function planFlare(
  from: Coordinate,
  target: Coordinate,
  o: OpusOptions,
): { direction: Direction; range: number } | null {
  const direction = bearingToDirection(bearing(from, target))
  const cap = Math.min(o.maxRange, Math.max(o.mapWidth, o.mapHeight))
  let range = Math.min(cap, Math.max(1, Math.round(euclidean(from, target))))
  while (range >= 1) {
    if (inBounds(step(from, direction, range), o.mapWidth, o.mapHeight)) {
      return { direction, range }
    }
    range--
  }
  return null
}

// --- Agent ---

/**
 * Persistent, closure-scoped memory carried across the whole match.
 */
interface OpusMemory {
  terrain: Map<string, Cell>
  lastEnemyPos: Coordinate | null
  lastSeenTurn: number
  lastFlareTurn: number
  waypoints: Coordinate[]
  patrolIndex: number
}

/**
 * Build a serpentine grid of patrol waypoints spaced roughly a vision-diameter
 * apart so that visiting each in order sweeps the whole arena. Without this an
 * idle tank that reaches the map centre simply stops and never finds an enemy.
 */
function buildWaypoints(o: OpusOptions): Coordinate[] {
  const margin = Math.min(3, Math.floor(Math.min(o.mapWidth, o.mapHeight) / 4))
  const spacing = 5

  const axis = (extent: number): number[] => {
    const values: number[] = []
    const last = extent - 1 - margin
    for (let v = margin; v < last; v += spacing) values.push(v)
    if (values.length === 0 || values[values.length - 1] !== last) values.push(last)
    return values
  }

  const xs = axis(o.mapWidth)
  const ys = axis(o.mapHeight)
  const points: Coordinate[] = []
  ys.forEach((y, row) => {
    const order = row % 2 === 0 ? xs : [...xs].reverse()
    for (const x of order) points.push({ x, y })
  })
  return points
}

/**
 * Advance the patrol cursor to the current search waypoint, skipping any we are
 * already standing near. Returns the coordinate to head toward while hunting.
 */
function patrolTarget(memory: OpusMemory, from: Coordinate, o: OpusOptions): Coordinate {
  if (memory.waypoints.length === 0) {
    memory.waypoints = buildWaypoints(o)
    // Start from the waypoint nearest our spawn to avoid backtracking.
    let bestIdx = 0
    let bestDist = Infinity
    memory.waypoints.forEach((wp, i) => {
      const d = euclidean(from, wp)
      if (d < bestDist) {
        bestDist = d
        bestIdx = i
      }
    })
    memory.patrolIndex = bestIdx
  }
  let guard = 0
  while (
    euclidean(from, memory.waypoints[memory.patrolIndex]) <= 2 &&
    guard < memory.waypoints.length
  ) {
    memory.patrolIndex = (memory.patrolIndex + 1) % memory.waypoints.length
    guard++
  }
  return memory.waypoints[memory.patrolIndex]
}

function ingestWorldView(memory: OpusMemory, wv: WorldView): void {
  for (const cell of wv.localScan) memory.terrain.set(key(cell.coord), cell)
  for (const flared of wv.flaredCells) {
    memory.terrain.set(key(flared.cell.coord), flared.cell)
  }
  const enemies = wv.visibleEnemies ?? []
  if (enemies.length > 0) {
    // Track the nearest sighting as the freshest intel.
    const nearest = [...enemies].sort(
      (a, b) => euclidean(wv.position, a.position) - euclidean(wv.position, b.position),
    )[0]
    memory.lastEnemyPos = { ...nearest.position }
    memory.lastSeenTurn = wv.turn
  }
}

function visibleEnemies(wv: WorldView): EnemySighting[] {
  return (wv.visibleEnemies ?? []).map((e) => ({
    id: e.id,
    position: { ...e.position },
    hp: e.hp,
  }))
}

function mapCenter(o: OpusOptions): Coordinate {
  return { x: Math.floor(o.mapWidth / 2), y: Math.floor(o.mapHeight / 2) }
}

/**
 * Create the Opus tank agent.
 *
 * @param tankId - Identifier for this tank (suffixes the agent name).
 * @param options - Arena/engine parameters; sensible duel defaults are used
 *   for any omitted field.
 */
export function createOpusAgent(
  tankId: string,
  options?: Partial<OpusOptions>,
): TankAgent {
  const o: OpusOptions = { ...DEFAULT_OPTIONS, ...options }
  const memory: OpusMemory = {
    terrain: new Map(),
    lastEnemyPos: null,
    lastSeenTurn: -999,
    lastFlareTurn: -999,
    waypoints: [],
    patrolIndex: 0,
  }

  /**
   * Where to head when not currently shooting: chase a fresh sighting,
   * otherwise sweep the patrol route.
   */
  function huntTarget(view: WorldView, enemies: EnemySighting[]): Coordinate {
    if (enemies.length > 0) {
      return [...enemies].sort(
        (a, b) => euclidean(view.position, a.position) - euclidean(view.position, b.position),
      )[0].position
    }
    const turnsSinceSeen = view.turn - memory.lastSeenTurn
    if (memory.lastEnemyPos && turnsSinceSeen <= 5) {
      return memory.lastEnemyPos
    }
    return patrolTarget(memory, view.position, o)
  }

  /** Non-adaptive fallback used when no executor is supplied (e.g. in tests). */
  function planStatic(wv: WorldView): ToolCall[] {
    const calls: ToolCall[] = []
    const enemies = visibleEnemies(wv)
    const shot = findFiringSolution(wv.position, enemies, memory.terrain, o)
    if (shot) {
      calls.push({
        id: `shell-${wv.turn}`,
        tool: { kind: 'fire_shell', angle: shot.angle, power: shot.power },
      })
      const evade = bestEvade(
        wv.position,
        enemies.find((e) => e.id === shot.targetId)?.position ?? wv.position,
        memory.terrain,
        enemies,
        o,
        o.moveMax,
      )
      if (evade) {
        calls.push({
          id: `move-${wv.turn}`,
          tool: { kind: 'move', direction: evade.direction, distance: evade.distance },
        })
      }
      return calls
    }

    const navTarget = memory.lastEnemyPos ?? mapCenter(o)
    const mv = bestMoveToward(wv.position, navTarget, memory.terrain, enemies, o, new Set())
    if (mv) {
      calls.push({
        id: `move-${wv.turn}`,
        tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
      })
      return calls
    }
    return [{ id: `pass-${wv.turn}`, tool: { kind: 'pass' } }]
  }

  async function playTurn(
    startView: WorldView,
    executeTool: ToolExecutor,
  ): Promise<ToolCall[]> {
    const issued: ToolCall[] = []
    let view = startView
    let offenseUsed = false
    let blockedMoves = 0
    const visited = new Set<string>([key(startView.position)])

    const doCall = async (tool: ToolCall['tool']) => {
      const call: ToolCall = { id: `${tool.kind}-${view.turn}-${issued.length}`, tool }
      issued.push(call)
      const result = await executeTool(call)
      view = result.worldview
      ingestWorldView(memory, view)
      visited.add(key(view.position))
      // Learn from a shell that struck terrain: mark that cell as an obstacle.
      if (result.result.kind === 'obstacle-hit') {
        const c = result.result.coordinate
        memory.terrain.set(key(c), {
          coord: { ...c },
          terrain: 'obstacle',
          obstacleHeight: o.obstacleHeight,
        })
      }
      return result
    }

    let guard = 0
    let shotFired = false
    while (
      view.isMyTurn &&
      view.remainingActions > 0 &&
      issued.length < o.maxToolCalls &&
      guard < 10
    ) {
      guard++
      const enemies = visibleEnemies(view)

      // 1. Shoot a visible enemy if we can and haven't used our offense yet.
      if (enemies.length > 0 && !offenseUsed) {
        const shot = findFiringSolution(view.position, enemies, memory.terrain, o)
        if (shot) {
          const r = await doCall({ kind: 'fire_shell', angle: shot.angle, power: shot.power })
          offenseUsed = true
          shotFired = true
          if (r.turnEnded) break
          continue
        }
        // Visible but no clean lane: reposition to open one this turn.
        const repo = findRepositionForShot(view.position, enemies, memory.terrain, o, visited)
        if (repo) {
          const r = await doCall({
            kind: 'move',
            direction: repo.direction,
            distance: repo.distance,
          })
          if (r.turnEnded) break
          if (r.result.kind === 'blocked') blockedMoves++
          if (blockedMoves >= 2) break
          continue
        }
      }

      // 2. Having taken our shot, spend the remaining action breaking away.
      if (shotFired) {
        const threat = memory.lastEnemyPos ?? view.position
        const evade = bestEvade(
          view.position,
          threat,
          memory.terrain,
          enemies,
          o,
          view.remainingActions * o.moveMax,
        )
        if (evade) {
          const r = await doCall({
            kind: 'move',
            direction: evade.direction,
            distance: evade.distance,
          })
          if (r.turnEnded) break
          continue
        }
        break
      }

      // 3. No shot this iteration — scout with a flare, then hunt.
      const blind = enemies.length === 0
      if (blind && !offenseUsed) {
        const scanTarget = memory.lastEnemyPos ?? patrolTarget(memory, view.position, o)
        const flare = planFlare(view.position, scanTarget, o)
        if (flare) {
          const r = await doCall({
            kind: 'fire_flare',
            direction: flare.direction,
            range: flare.range,
          })
          offenseUsed = true
          memory.lastFlareTurn = view.turn
          if (r.turnEnded) break
          // The flare may have revealed an enemy — re-loop to chase or shoot.
          continue
        }
      }

      // 4. Advance toward the hunt target (chase a sighting or sweep the map).
      const target = huntTarget(view, enemies)
      const mv = bestMoveToward(view.position, target, memory.terrain, enemies, o, visited)
      if (mv) {
        const r = await doCall({
          kind: 'move',
          direction: mv.direction,
          distance: mv.distance,
        })
        if (r.turnEnded) break
        if (r.result.kind === 'blocked') {
          blockedMoves++
          // Nudge the patrol cursor so we don't wedge against the same obstacle.
          if (memory.waypoints.length > 0) {
            memory.patrolIndex = (memory.patrolIndex + 1) % memory.waypoints.length
          }
        }
        if (blockedMoves >= 2) break
        continue
      }

      // 5. Fully boxed in — advance the patrol cursor and stop for this turn.
      if (memory.waypoints.length > 0) {
        memory.patrolIndex = (memory.patrolIndex + 1) % memory.waypoints.length
      }
      break
    }

    if (issued.length === 0) {
      await executeTool({ id: `pass-${startView.turn}`, tool: { kind: 'pass' } })
      issued.push({ id: `pass-${startView.turn}`, tool: { kind: 'pass' } })
    }
    return issued
  }

  return {
    name: `opus-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      ingestWorldView(memory, worldview)

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      if (!executeTool) {
        return planStatic(worldview)
      }

      const toolCalls = await playTurn(worldview, executeTool)
      return { toolCalls, executed: true }
    },
  }
}

/**
 * Look for a mapped-clear move (≤ moveMax) after which some enemy becomes
 * hittable. Enables opening a firing lane around an obstacle in one turn.
 */
function findRepositionForShot(
  from: Coordinate,
  enemies: EnemySighting[],
  terrain: Map<string, Cell>,
  o: OpusOptions,
  visited: Set<string>,
): MovePlan | null {
  for (let distance = 1; distance <= o.moveMax; distance++) {
    for (const direction of DIRECTIONS) {
      if (!pathClear(from, direction, distance, terrain, enemies, o, true)) continue
      const dest = step(from, direction, distance)
      if (visited.has(key(dest))) continue
      const shot = findFiringSolution(dest, enemies, terrain, o)
      if (shot && !shot.risky) return { direction, distance }
    }
  }
  return null
}
