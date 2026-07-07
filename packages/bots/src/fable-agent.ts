import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec, ToolExecutor, AgentTurnResult } from '@scorched-llm/engine'
import type { Coordinate, Direction, TerrainKind } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import { euclidean, chebyshev, DIRECTION_DELTAS, inBounds } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/**
 * Fable — the measuring-stick scripted tank.
 *
 * Design principles:
 * - Perfect bookkeeping: accumulates a persistent terrain map from every scan
 *   and flare, and tracks every enemy sighting with its turn number.
 * - Exact gunnery: firing solutions are found by simulating the engine's own
 *   shell resolution (supercover path + parabolic height) against the known
 *   map, so a shot is only taken when the simulation says it lands.
 * - Flare discipline: flares are aimed to cover the predicted enemy position
 *   without illuminating the firer, and only when intel is stale.
 * - Positioning: moves score on cover, ideal engagement range, enemy vision
 *   avoidance, and breaking the enemy's firing line.
 *
 * Everything is deterministic — same inputs, same calls.
 */

const DIRECTIONS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

interface EnemySighting {
  id: string
  position: Coordinate
  previousPosition: Coordinate | null
  hp: number
  turnSeen: number
}

interface FableMemory {
  /** null = never observed */
  terrain: (TerrainKind | null)[][]
  obstacleHeights: number[][]
  /** Turn each cell was last directly observed; -1 = never. */
  seenTurn: number[][]
  enemies: Map<string, EnemySighting>
  /** Turn number when we last fired a flare (throttles flare spam). */
  lastFlareTurn: number
}

/** How stale a cell is, capped so ancient cells don't dominate forever. */
const STALENESS_CAP = 30

interface ShellSolution {
  angle: number
  power: number
  /** Unknown low-arc cells crossed before the hit — lower is safer. */
  risk: number
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/** Mirrors the engine's shell arc: starts/ends at tank height, apex halfway. */
function shellHeight(i: number, n: number, apexHeight: number, tankHeight: number): number {
  if (n <= 0) return tankHeight
  const progress = (i + 1) / n
  const arc = 4 * progress * (1 - progress)
  return tankHeight + (apexHeight - tankHeight) * arc
}

export function createFableAgent(tankId: string, config: MatchConfig): TankAgent {
  const width = config.map.width
  const height = config.map.height
  const memory: FableMemory = {
    terrain: Array.from({ length: height }, () => Array<TerrainKind | null>(width).fill(null)),
    obstacleHeights: Array.from({ length: height }, () => Array<number>(width).fill(0)),
    seenTurn: Array.from({ length: height }, () => Array<number>(width).fill(-1)),
    enemies: new Map(),
    lastFlareTurn: -99,
  }

  function learnCell(
    cell: { coord: Coordinate; terrain: TerrainKind; obstacleHeight: number },
    turn: number,
  ): void {
    if (!inBounds(cell.coord, width, height)) return
    memory.terrain[cell.coord.y][cell.coord.x] = cell.terrain
    memory.obstacleHeights[cell.coord.y][cell.coord.x] = cell.obstacleHeight
    memory.seenTurn[cell.coord.y][cell.coord.x] = turn
  }

  /** Turns since a cell was last observed — an enemy could hide anywhere stale. */
  function staleness(pos: Coordinate, currentTurn: number): number {
    const seen = memory.seenTurn[pos.y][pos.x]
    if (seen < 0) return STALENESS_CAP
    return Math.min(currentTurn - seen, STALENESS_CAP)
  }

  function observe(view: WorldView): void {
    for (const cell of view.localScan) learnCell(cell, view.turn)
    for (const flared of view.flaredCells) learnCell(flared.cell, view.turn)
    for (const enemy of view.visibleEnemies ?? []) {
      const prior = memory.enemies.get(enemy.id)
      memory.enemies.set(enemy.id, {
        id: enemy.id,
        position: { ...enemy.position },
        previousPosition:
          prior && (prior.position.x !== enemy.position.x || prior.position.y !== enemy.position.y)
            ? { ...prior.position }
            : prior?.previousPosition ?? null,
        hp: enemy.hp,
        turnSeen: view.turn,
      })
    }
  }

  function knownTerrain(pos: Coordinate): TerrainKind | null {
    if (!inBounds(pos, width, height)) return null
    return memory.terrain[pos.y][pos.x]
  }

  /**
   * Predict where an enemy is now from its last sighting. Extrapolates the
   * last observed movement vector, capped at two cells, clamped to known
   * passable ground.
   */
  function predictPosition(sighting: EnemySighting, currentTurn: number): Coordinate {
    const age = currentTurn - sighting.turnSeen
    if (age <= 0 || sighting.previousPosition == null) return sighting.position
    const vx = Math.sign(sighting.position.x - sighting.previousPosition.x)
    const vy = Math.sign(sighting.position.y - sighting.previousPosition.y)
    const steps = Math.min(age, 2)
    let predicted = sighting.position
    for (let s = 1; s <= steps; s++) {
      const next = { x: sighting.position.x + vx * s, y: sighting.position.y + vy * s }
      if (!inBounds(next, width, height) || knownTerrain(next) === 'obstacle') break
      predicted = next
    }
    return predicted
  }

  /**
   * Simulate the engine's shell resolution against the known map.
   * Unknown terrain is assumed open; each unknown cell crossed while the
   * arc is low enough to be blocked adds risk.
   */
  function simulateShell(
    from: Coordinate,
    angle: number,
    power: number,
    targets: Coordinate[],
  ): { outcome: 'hit' | 'blocked' | 'miss'; risk: number } {
    const delta = angleToDelta(angle)
    const target = {
      x: Math.round(from.x + delta.dx * power),
      y: Math.round(from.y + delta.dy * power),
    }
    const cells = supercover(from, target).slice(1)
    const apex = config.shell.apexHeight
    const tankH = config.shell.tankHeight
    let risk = 0

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i]
      if (!inBounds(cell, width, height)) return { outcome: 'miss', risk }
      const arcHeight = shellHeight(i, cells.length, apex, tankH)
      const terrain = memory.terrain[cell.y][cell.x]
      if (terrain === 'obstacle' && arcHeight <= memory.obstacleHeights[cell.y][cell.x]) {
        return { outcome: 'blocked', risk }
      }
      if (terrain === null && arcHeight <= config.map.obstacleHeight) {
        risk++
      }
      if (targets.some((t) => t.x === cell.x && t.y === cell.y)) {
        return { outcome: 'hit', risk }
      }
    }
    return { outcome: 'miss', risk }
  }

  /** Find the safest (angle, power) that lands on any of the target cells. */
  function findSolution(from: Coordinate, targetCells: Coordinate[]): ShellSolution | null {
    let best: ShellSolution | null = null
    for (const target of targetCells) {
      const dist = euclidean(from, target)
      if (dist < 0.5 || dist > config.shell.maxRange + 0.25) continue
      const angle = bearing(from, target)
      const minPower = Math.max(1, Math.round(dist))
      for (let power = minPower; power <= config.shell.maxRange; power++) {
        const sim = simulateShell(from, angle, power, targetCells)
        if (sim.outcome !== 'hit') continue
        if (best == null || sim.risk < best.risk) {
          best = { angle: Math.round(angle * 100) / 100, power, risk: sim.risk }
        }
        break // higher power on the same bearing only raises the arc; first hit is enough
      }
    }
    if (best != null && best.risk > 2) return null
    return best
  }

  /** Cells an enemy might occupy right now, for aiming: predicted + adjacent ring when stale. */
  function aimCells(sighting: EnemySighting, currentTurn: number): Coordinate[] {
    const predicted = predictPosition(sighting, currentTurn)
    const age = currentTurn - sighting.turnSeen
    const cells: Coordinate[] = [predicted]
    if (age > 0 && (predicted.x !== sighting.position.x || predicted.y !== sighting.position.y)) {
      cells.push(sighting.position)
    }
    return cells.filter((c) => inBounds(c, width, height) && knownTerrain(c) !== 'obstacle')
  }

  function activeThreats(view: WorldView): EnemySighting[] {
    const maxStaleness = 6
    return [...memory.enemies.values()]
      .filter((e) => view.turn - e.turnSeen <= maxStaleness)
      .sort((a, b) => {
        if (a.hp !== b.hp) return a.hp - b.hp // weakest first
        const da = euclidean(a.position, view.position)
        const db = euclidean(b.position, view.position)
        if (da !== db) return da - db // then nearest
        return a.id.localeCompare(b.id)
      })
  }

  function isPassable(pos: Coordinate, view: WorldView): boolean {
    if (!inBounds(pos, width, height)) return false
    if (knownTerrain(pos) === 'obstacle') return false
    for (const enemy of view.visibleEnemies ?? []) {
      if (enemy.position.x === pos.x && enemy.position.y === pos.y) return false
    }
    return true
  }

  function coverScore(pos: Coordinate): number {
    let cover = 0
    for (const dir of DIRECTIONS) {
      const n = { x: pos.x + DIRECTION_DELTAS[dir].dx, y: pos.y + DIRECTION_DELTAS[dir].dy }
      if (inBounds(n, width, height) && knownTerrain(n) === 'obstacle') cover++
    }
    return Math.min(cover, 3)
  }

  function inAnyFlare(pos: Coordinate, view: WorldView): boolean {
    for (const flare of view.activeFlares ?? []) {
      if (euclidean(pos, flare.targetCell) <= flare.radius) return true
    }
    return false
  }

  /**
   * The stalest passable cell, distance-discounted — the hunting waypoint.
   * Staleness (not just "unknown") matters: an enemy can lurk on ground we
   * mapped twenty turns ago just as easily as on ground we never saw.
   */
  function explorationTarget(view: WorldView): Coordinate {
    // Hunt near the freshest enemy sighting we ever had, however old —
    // a cold trail still beats a uniform sweep.
    const lastTrail = [...memory.enemies.values()]
      .sort((a, b) => b.turnSeen - a.turnSeen)[0] ?? null

    let best: Coordinate = { x: Math.floor(width / 2), y: Math.floor(height / 2) }
    let bestScore = -Infinity
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (memory.terrain[y][x] === 'obstacle') continue
        const pos = { x, y }
        const dist = euclidean(view.position, pos)
        if (dist < 1) continue
        let score = staleness(pos, view.turn) - dist * 0.4
        if (lastTrail != null) {
          score += Math.max(0, 12 - euclidean(pos, lastTrail.position)) * 0.8
        }
        if (score > bestScore) {
          bestScore = score
          best = pos
        }
      }
    }
    return best
  }

  function scorePosition(pos: Coordinate, view: WorldView, threats: EnemySighting[]): number {
    let score = 0
    // Cover matters in a firefight; when blind, exploring beats hunkering
    score += (threats.length > 0 ? 2.5 : 0.5) * coverScore(pos)
    if (!inAnyFlare(pos, view)) score += 1.5

    if (threats.length > 0) {
      const nearest = threats.reduce((a, b) =>
        euclidean(a.position, view.position) <= euclidean(b.position, view.position) ? a : b,
      )
      const predicted = predictPosition(nearest, view.turn)
      const dist = euclidean(pos, predicted)
      const idealRange = Math.min(config.fog.localRadius + 2, config.shell.maxRange - 2)
      score -= Math.abs(dist - idealRange)
      // Standing inside the enemy's local vision invites return fire
      if (dist <= config.fog.localRadius + 0.5) score -= 4
      // Prefer cells the enemy cannot cleanly shell from its predicted spot
      const enemyShot = simulateShell(predicted, bearing(predicted, pos), Math.max(1, Math.round(euclidean(predicted, pos))), [pos])
      if (enemyShot.outcome !== 'hit') score += 2
      // A firing position for us next turn is worth a lot
      if (findSolution(pos, aimCells(nearest, view.turn)) != null) score += 3
    } else {
      const target = explorationTarget(view)
      score -= euclidean(pos, target) * 1.5
    }
    return score
  }

  interface MoveChoice {
    direction: Direction
    distance: number
    destination: Coordinate
    score: number
  }

  function bestMoves(view: WorldView, budget: number, threats: EnemySighting[]): MoveChoice[] {
    const here = scorePosition(view.position, view, threats)
    const choices: MoveChoice[] = []
    for (const dir of DIRECTIONS) {
      const delta = DIRECTION_DELTAS[dir]
      for (let dist = 1; dist <= budget; dist++) {
        // Every traversed cell must be passable or the engine blocks the whole move
        let pathClear = true
        for (let step = 1; step <= dist; step++) {
          const cell = { x: view.position.x + delta.dx * step, y: view.position.y + delta.dy * step }
          if (!isPassable(cell, view) || knownTerrain(cell) === null) {
            pathClear = false
            break
          }
        }
        if (!pathClear) break
        const destination = {
          x: view.position.x + delta.dx * dist,
          y: view.position.y + delta.dy * dist,
        }
        choices.push({
          direction: dir,
          distance: dist,
          destination,
          score: scorePosition(destination, view, threats),
        })
      }
    }
    return choices.filter((c) => c.score > here).sort((a, b) => b.score - a.score)
  }

  interface FlareChoice {
    direction: Direction
    range: number
    score: number
  }

  /** Best flare that covers the predicted enemy (or virgin terrain) without lighting us up. */
  function bestFlare(view: WorldView, threats: EnemySighting[]): FlareChoice | null {
    const flareRadius = config.fog.flareRadius
    const maxReach = Math.max(width, height)
    const predicted = threats.length > 0 ? predictPosition(threats[0], view.turn) : null
    let best: FlareChoice | null = null

    for (const dir of DIRECTIONS) {
      const delta = DIRECTION_DELTAS[dir]
      for (let range = 1; range <= maxReach; range++) {
        const target = {
          x: view.position.x + delta.dx * range,
          y: view.position.y + delta.dy * range,
        }
        if (!inBounds(target, width, height)) break
        // Never illuminate our own cell — flares are visible to every player
        if (euclidean(target, view.position) <= flareRadius + 0.5) continue

        let score: number
        if (predicted != null) {
          const coverage = euclidean(target, predicted)
          if (coverage > flareRadius) continue
          score = 1000 - coverage
        } else {
          // Blind: light up the stalest ground an enemy could be lurking on
          let staleMass = 0
          for (let dy = -Math.ceil(flareRadius); dy <= Math.ceil(flareRadius); dy++) {
            for (let dx = -Math.ceil(flareRadius); dx <= Math.ceil(flareRadius); dx++) {
              if (dx * dx + dy * dy > flareRadius * flareRadius) continue
              const cell = { x: target.x + dx, y: target.y + dy }
              if (!inBounds(cell, width, height)) continue
              if (memory.terrain[cell.y][cell.x] === 'obstacle') continue
              staleMass += staleness(cell, view.turn)
            }
          }
          // Not worth an action to re-light fresh ground
          if (staleMass < STALENESS_CAP) continue
          score = staleMass
        }
        if (best == null || score > best.score) {
          best = { direction: dir, range, score }
        }
      }
    }
    return best
  }

  /** Plan one action given the current view; returns null to end the turn. */
  function planAction(view: WorldView, moveBudget: number): ToolCall | null {
    const threats = activeThreats(view)
    const freshThreats = threats.filter((e) => view.turn - e.turnSeen <= 2)

    // 1. Take any clean shot available right now.
    for (const threat of freshThreats) {
      const solution = findSolution(view.position, aimCells(threat, view.turn))
      if (solution != null) {
        return {
          id: `shell-${view.turn}-${view.remainingActions}`,
          tool: { kind: 'fire_shell', angle: solution.angle, power: solution.power },
        }
      }
    }

    // 2. Reacquire stale targets (or scout blind) with a flare. Hunting a
    //    known trail justifies flaring every turn; blind sweeps are throttled.
    const staleIntel = freshThreats.length === 0
    const flareCooldown = threats.length > 0 || view.turn - memory.lastFlareTurn >= 2
    if (staleIntel && flareCooldown) {
      // bestFlare already refuses targets that aren't worth the action
      const flare = bestFlare(view, threats)
      if (flare != null) {
        memory.lastFlareTurn = view.turn
        return {
          id: `flare-${view.turn}-${view.remainingActions}`,
          tool: { kind: 'fire_flare', direction: flare.direction, range: flare.range },
        }
      }
    }

    // 3. Reposition: toward a firing position, cover, or unexplored ground.
    if (moveBudget > 0) {
      const moves = bestMoves(view, moveBudget, threats)
      if (moves.length > 0) {
        return {
          id: `move-${view.turn}-${view.remainingActions}`,
          tool: { kind: 'move', direction: moves[0].direction, distance: moves[0].distance },
        }
      }
    }

    return null
  }

  return {
    name: `fable-${tankId}`,
    messages: [] as AgentMessage[],

    async takeTurn(
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> {
      observe(worldview)

      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      const moveMax = config.moveMax ?? config.fog.flareRadius

      // Without an executor, plan the whole turn against the initial view.
      if (executeTool == null) {
        const calls: ToolCall[] = []
        let view = worldview
        let budget = moveMax
        let offensiveUsed = false
        for (let action = 0; action < worldview.remainingActions; action++) {
          const call = planAction(view, budget)
          if (call == null) break
          if (call.tool.kind === 'fire_shell' || call.tool.kind === 'fire_flare') {
            if (offensiveUsed) break
            offensiveUsed = true
          }
          if (call.tool.kind === 'move') {
            budget -= call.tool.distance
            view = {
              ...view,
              position: {
                x: view.position.x + DIRECTION_DELTAS[call.tool.direction].dx * call.tool.distance,
                y: view.position.y + DIRECTION_DELTAS[call.tool.direction].dy * call.tool.distance,
              },
            }
          }
          calls.push(call)
        }
        if (calls.length === 0) {
          calls.push({ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } })
        }
        return calls
      }

      // With an executor, act adaptively: observe after every action.
      const executed: ToolCall[] = []
      let view = worldview
      let budget = moveMax
      let offensiveUsed = false

      while (view.remainingActions > 0) {
        const call = planAction(view, budget)
        if (call == null) break
        if (call.tool.kind === 'fire_shell' || call.tool.kind === 'fire_flare') {
          if (offensiveUsed) break
          offensiveUsed = true
        }
        const moveDistance = call.tool.kind === 'move' ? call.tool.distance : 0

        const outcome = await executeTool(call)
        executed.push(call)
        observe(outcome.worldview)
        // A shell stopped by an obstacle maps that cell — never repeat the shot
        if (outcome.result.kind === 'obstacle-hit') {
          learnCell(
            {
              coord: outcome.result.coordinate,
              terrain: 'obstacle',
              obstacleHeight: config.map.obstacleHeight,
            },
            outcome.worldview.turn,
          )
        }
        if (outcome.result.kind === 'ok' && moveDistance > 0) {
          budget -= moveDistance
        }
        view = outcome.worldview
        if (outcome.turnEnded) break
      }

      if (executed.length === 0) {
        const pass: ToolCall = { id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }
        await executeTool(pass)
        executed.push(pass)
      }

      return { toolCalls: executed, executed: true }
    },
  }
}
