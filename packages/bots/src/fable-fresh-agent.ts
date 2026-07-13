// Entrant: fresh Fable (claude-fable-5, verbatim narrow prompt).
// Mechanically renamed fable → fable-fresh at reconciliation to coexist with
// the original fable measuring stick. No tactical changes.
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall, Tool, ActionResult } from '@scorched-llm/engine'
import type {
  TankAgent,
  AgentMessage,
  ToolSpec,
  ToolExecutor,
  AgentTurnResult,
} from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/**
 * Fable — a scripted tank built from a close reading of the engine.
 *
 * Core exploits of the mechanics:
 *
 * 1. Shells hit any living tank on any traversed trajectory cell regardless
 *    of arc height; only obstacles check height. With float angle/power we
 *    can compute engine-exact firing solutions (same supercover, same arc
 *    math), including deliberate overshoot so the arc clears mid-path
 *    obstacles.
 * 2. Enemies revealed at any point during *my* turn cannot move before my
 *    shell resolves — any same-turn sighting is an exact firing solution.
 * 3. Flare and shell are mutually exclusive per turn, so an opponent can
 *    never flare-then-shoot. Accurate return fire requires me to end my turn
 *    inside their local scan (after their move) or inside a flare that is
 *    still active on their turn. End-of-turn cells are scored against that
 *    exact move-and-fire envelope.
 * 4. Flares expire before the firer's next turn, so their intel must be
 *    consumed same-turn — which an incremental executor lets us do.
 *
 * The agent keeps persistent terrain knowledge and per-enemy tracks with
 * velocity extrapolation, executes tools incrementally to consume refreshed
 * worldviews mid-turn, and fires recon flares whenever the offensive action
 * would otherwise go unused.
 */

const DIRS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

interface EngineParams {
  width: number
  height: number
  localRadius: number
  flareRadius: number
  moveMax: number
  maxRange: number
  apexHeight: number
  tankHeight: number
  obstacleHeight: number
  actionBudget: number
  playerCount: number
  hitsToKill: number
  maxToolCallsPerTurn: number
}

/** Duel-preset defaults, used when no MatchConfig is provided. */
const DEFAULT_PARAMS: EngineParams = {
  width: 20,
  height: 20,
  localRadius: 3,
  flareRadius: 2,
  moveMax: 2,
  maxRange: 10,
  apexHeight: 5,
  tankHeight: 1,
  obstacleHeight: 3,
  actionBudget: 2,
  playerCount: 2,
  hitsToKill: 2,
  maxToolCallsPerTurn: 5,
}

function paramsFromConfig(config?: MatchConfig): EngineParams {
  if (!config) return { ...DEFAULT_PARAMS }
  const actionBudget = config.actionEconomy === 'double' ? 2 : 1
  return {
    width: config.map.width,
    height: config.map.height,
    localRadius: config.fog.localRadius,
    flareRadius: config.fog.flareRadius,
    moveMax: config.moveMax ?? config.fog.flareRadius,
    maxRange: config.shell.maxRange,
    apexHeight: config.shell.apexHeight,
    tankHeight: config.shell.tankHeight,
    obstacleHeight: config.map.obstacleHeight,
    actionBudget,
    playerCount: config.players.length,
    hitsToKill: config.lethality.hitsToKill,
    maxToolCallsPerTurn: config.maxToolCallsPerTurn,
  }
}

interface KnownCell {
  terrain: 'open' | 'obstacle'
  obstacleHeight: number
}

interface EnemyTrack {
  id: string
  pos: Coordinate
  hp: number
  /** Absolute turn number of the most recent exact sighting. */
  turnSeen: number
  /** Previous distinct sighting, used for velocity extrapolation. */
  prevPos: Coordinate | null
  prevTurn: number | null
}

interface FiringSolution {
  angle: number
  power: number
  /** Count of unknown cells the shell passes at blockable height. 0 = certain. */
  risky: number
}

function cellKey(x: number, y: number): string {
  return `${x},${y}`
}

/** Engine-identical angle→delta: 0°=N, 90°=E (clockwise from north). */
function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/** Clockwise bearing in degrees from north, `from` → `to`. */
function bearingDeg(from: Coordinate, to: Coordinate): number {
  let a = Math.atan2(to.x - from.x, -(to.y - from.y)) * (180 / Math.PI)
  if (a < 0) a += 360
  return a
}

function normAngle(a: number): number {
  let r = a % 360
  if (r < 0) r += 360
  return r
}

/** Smallest absolute angular difference in degrees. */
function angleGap(a: number, b: number): number {
  const d = Math.abs(normAngle(a) - normAngle(b)) % 360
  return d > 180 ? 360 - d : d
}

class FableBrain {
  readonly p: EngineParams
  private readonly hasConfig: boolean
  private readonly known = new Map<string, KnownCell>()
  private readonly tracks = new Map<string, EnemyTrack>()
  private myPos: Coordinate = { x: 0, y: 0 }
  private myHp = 2
  private turn = 0
  private activeFlares: WorldView['activeFlares'] = []
  /** Where a track went cold — bias exploration there. */
  private lastLostPos: Coordinate | null = null
  /** My-turns remaining before the lost-position bias expires. */
  private lostBiasTurns = 0
  private turnsSinceFlare = 99
  /** Committed exploration objective (hysteresis against goal-flapping). */
  private exploreGoal: Coordinate | null = null
  private exploreGoalAge = 0
  /** Turn each cell was last observed (scan or flare) — presence decays. */
  private lastObserved = new Map<string, number>()
  /** Targets of flares I fired, to tell mine from the enemy's. */
  private myFlareTargets = new Set<string>()
  /** Latest enemy flare target — their tank is somewhere on a ray behind it. */
  private suspectAnchor: { pos: Coordinate; turn: number } | null = null

  constructor(config?: MatchConfig) {
    this.p = paramsFromConfig(config)
    this.hasConfig = config !== undefined
  }

  // --- Knowledge ingestion -------------------------------------------------

  ingestView(view: WorldView): void {
    this.myPos = { ...view.position }
    this.myHp = view.hp
    this.turn = view.turn
    this.activeFlares = view.activeFlares ?? []

    for (const cell of view.localScan) {
      this.learnCell(cell.coord, cell.terrain, cell.obstacleHeight)
      this.lastObserved.set(cellKey(cell.coord.x, cell.coord.y), view.turn)
    }
    for (const fc of view.flaredCells) {
      this.learnCell(fc.cell.coord, fc.cell.terrain, fc.cell.obstacleHeight)
      this.lastObserved.set(cellKey(fc.cell.coord.x, fc.cell.coord.y), view.turn)
    }

    // Enemy flares betray activity: the firer stands somewhere on one of the
    // eight rays behind the target, usually not far. Bias the search there.
    for (const flare of view.activeFlares ?? []) {
      const k = `${flare.activatedTurn}:${flare.targetCell.x},${flare.targetCell.y}`
      if (this.myFlareTargets.has(k)) continue
      if (flare.activatedTurn >= view.turn - 1) {
        this.suspectAnchor = { pos: { ...flare.targetCell }, turn: flare.activatedTurn }
      }
    }

    for (const enemy of view.visibleEnemies ?? []) {
      const existing = this.tracks.get(enemy.id)
      if (existing) {
        if (existing.turnSeen < view.turn &&
            (existing.pos.x !== enemy.position.x || existing.pos.y !== enemy.position.y)) {
          existing.prevPos = { ...existing.pos }
          existing.prevTurn = existing.turnSeen
        }
        existing.pos = { ...enemy.position }
        existing.hp = enemy.hp
        existing.turnSeen = view.turn
      } else {
        this.tracks.set(enemy.id, {
          id: enemy.id,
          pos: { ...enemy.position },
          hp: enemy.hp,
          turnSeen: view.turn,
          prevPos: null,
          prevTurn: null,
        })
      }
      if (this.lastLostPos && euclidean(this.lastLostPos, enemy.position) <= this.p.localRadius * 2) {
        this.lastLostPos = null
        this.lostBiasTurns = 0
      }
    }

    // Negative intel: a predicted position we can currently see (scan or any
    // active flare) with nobody there means the track has gone cold. Tracks
    // also expire outright after a few rounds — hunting an old phantom is
    // worse than exploring. Either way, bias the search near the cold trail.
    const visibleSet = new Set<string>()
    for (const cell of view.localScan) visibleSet.add(cellKey(cell.coord.x, cell.coord.y))
    for (const fc of view.flaredCells) visibleSet.add(cellKey(fc.cell.coord.x, fc.cell.coord.y))
    for (const track of [...this.tracks.values()]) {
      if (track.turnSeen === view.turn) continue
      const pred = this.predict(track)
      const seenEmpty = this.ageRounds(track) >= 1 && visibleSet.has(cellKey(pred.x, pred.y))
      if (seenEmpty || this.ageRounds(track) > 4) {
        this.lastLostPos = pred
        this.lostBiasTurns = 6
        this.tracks.delete(track.id)
        this.exploreGoal = null
      }
    }

    if ((view.aliveEnemyCount ?? 0) === 0) this.tracks.clear()
  }

  ingestResult(call: ToolCall, result: ActionResult): void {
    if (result.kind === 'obstacle-hit') {
      const k = cellKey(result.coordinate.x, result.coordinate.y)
      if (!this.known.has(k)) {
        this.known.set(k, { terrain: 'obstacle', obstacleHeight: this.p.obstacleHeight })
      }
    }
    if (result.kind === 'hit') {
      const track = this.tracks.get(result.targetId)
      if (track) {
        track.hp -= result.damage
        if (track.hp <= 0) this.tracks.delete(result.targetId)
      }
    }
    if (call.tool.kind === 'fire_flare' && result.kind !== 'blocked' && result.kind !== 'invalid') {
      this.turnsSinceFlare = 0
      const d = DIRECTION_DELTAS[call.tool.direction]
      const target = {
        x: this.myPos.x + d.dx * call.tool.range,
        y: this.myPos.y + d.dy * call.tool.range,
      }
      this.myFlareTargets.add(`${this.turn}:${target.x},${target.y}`)
    }
  }

  private learnCell(coord: Coordinate, terrain: 'open' | 'obstacle', obstacleHeight: number): void {
    this.known.set(cellKey(coord.x, coord.y), { terrain, obstacleHeight })
    if (!this.hasConfig) {
      // Grow inferred bounds from observations.
      if (coord.x + 1 > this.p.width) this.p.width = coord.x + 1
      if (coord.y + 1 > this.p.height) this.p.height = coord.y + 1
    }
  }

  private inBounds(c: Coordinate): boolean {
    return c.x >= 0 && c.x < this.p.width && c.y >= 0 && c.y < this.p.height
  }

  private knownAt(c: Coordinate): KnownCell | undefined {
    return this.known.get(cellKey(c.x, c.y))
  }

  // --- Enemy tracking ------------------------------------------------------

  /** Full rounds the enemy has had to act since last exact sighting. */
  private ageRounds(track: EnemyTrack): number {
    const age = this.turn - track.turnSeen
    if (age <= 0) return 0
    return Math.ceil(age / Math.max(1, this.p.playerCount))
  }

  /** Dead-reckoned current position for a track. */
  private predict(track: EnemyTrack): Coordinate {
    const rounds = this.ageRounds(track)
    if (rounds === 0 || !track.prevPos || track.prevTurn == null) return { ...track.pos }
    const roundsBetween = Math.max(
      1,
      Math.round((track.turnSeen - track.prevTurn) / Math.max(1, this.p.playerCount)),
    )
    const vx = (track.pos.x - track.prevPos.x) / roundsBetween
    const vy = (track.pos.y - track.prevPos.y) / roundsBetween
    // Dead-reckon at most two rounds ahead — beyond that the uncertainty
    // dwarfs the velocity signal.
    const driftRounds = Math.min(rounds, 2)
    const maxDrift = this.p.moveMax * this.p.actionBudget * driftRounds
    let dx = vx * driftRounds
    let dy = vy * driftRounds
    const mag = Math.max(Math.abs(dx), Math.abs(dy))
    if (mag > maxDrift) {
      dx = (dx / mag) * maxDrift
      dy = (dy / mag) * maxDrift
    }
    const pred = {
      x: Math.max(0, Math.min(this.p.width - 1, Math.round(track.pos.x + dx))),
      y: Math.max(0, Math.min(this.p.height - 1, Math.round(track.pos.y + dy))),
    }
    const k = this.knownAt(pred)
    if (k?.terrain === 'obstacle') return { ...track.pos }
    return pred
  }

  /** Tracks whose position is exact right now (seen during the current turn). */
  private freshTracks(): EnemyTrack[] {
    return [...this.tracks.values()].filter((t) => t.turnSeen === this.turn)
  }

  private staleTracks(): EnemyTrack[] {
    return [...this.tracks.values()].filter((t) => t.turnSeen < this.turn)
  }

  // --- Shell simulation (engine-exact) --------------------------------------

  /**
   * Mirror of resolution/shell.ts. Returns the tank cell hit (if any) and the
   * number of unknown cells traversed at blockable height before the hit.
   * `unknownIsOpen` = optimistic traversal (used when modelling enemy fire at
   * us, where unknown-to-us terrain must be assumed passable).
   */
  private simulateShot(
    origin: Coordinate,
    angle: number,
    power: number,
    hittable: Coordinate[],
    unknownIsOpen: boolean,
  ): { hit: Coordinate | null; risky: number } {
    const delta = angleToDelta(angle)
    const target = {
      x: Math.round(origin.x + delta.dx * power),
      y: Math.round(origin.y + delta.dy * power),
    }
    const cells = supercover(origin, target).slice(1)
    const N = cells.length
    let risky = 0
    for (let i = 0; i < N; i++) {
      const c = cells[i]
      const progress = (i + 1) / N
      const h = this.p.tankHeight + (this.p.apexHeight - this.p.tankHeight) * 4 * progress * (1 - progress)
      if (!this.inBounds(c)) return { hit: null, risky }
      const k = this.knownAt(c)
      if (k) {
        if (k.terrain === 'obstacle' && h <= k.obstacleHeight) return { hit: null, risky }
      } else if (!unknownIsOpen && h <= this.p.obstacleHeight) {
        risky++
      }
      for (const t of hittable) {
        if (t.x === c.x && t.y === c.y) return { hit: c, risky }
      }
    }
    return { hit: null, risky }
  }

  /**
   * Search for a firing solution from `origin` against exact enemy positions.
   * Prefers certain (zero-risk) solutions; explores overshoot powers so the
   * arc clears mid-path obstacles and small angle offsets so the supercover
   * line snakes around low-arc blockers.
   */
  findShot(origin: Coordinate, targets: Array<{ pos: Coordinate; hp: number }>): FiringSolution | null {
    const allPositions = targets.map((t) => t.pos)
    const ordered = [...targets].sort(
      (a, b) => a.hp - b.hp || euclidean(origin, a.pos) - euclidean(origin, b.pos),
    )
    let best: FiringSolution | null = null

    for (const target of ordered) {
      const dist = euclidean(origin, target.pos)
      if (dist > this.p.maxRange + 0.5) continue
      const base = bearingDeg(origin, target.pos)

      const powers: number[] = []
      for (let pw = Math.max(1, dist); pw < this.p.maxRange; pw += 0.5) powers.push(pw)
      powers.push(this.p.maxRange)

      const offsets = [0, -0.75, 0.75, -1.5, 1.5, -2.5, 2.5, -4, 4, -6, 6, -8.5, 8.5]

      for (const off of offsets) {
        for (const pw of powers) {
          const res = this.simulateShot(origin, normAngle(base + off), pw, allPositions, false)
          if (res.hit == null) continue
          if (res.risky === 0) {
            return { angle: normAngle(base + off), power: pw, risky: 0 }
          }
          if (best == null || res.risky < best.risky) {
            best = { angle: normAngle(base + off), power: pw, risky: res.risky }
          }
        }
      }
    }
    return best
  }

  /**
   * Can a competent enemy at `origin` hit `cell`? Assumes unknown terrain is
   * open (pessimistic for us) and only samples the direct-aim family of shots.
   */
  private canHitFrom(origin: Coordinate, cell: Coordinate): boolean {
    const dist = euclidean(origin, cell)
    if (dist > this.p.maxRange + 0.5) return false
    const base = bearingDeg(origin, cell)
    const powers: number[] = []
    for (let pw = Math.max(1, dist); pw < this.p.maxRange; pw += 1.5) powers.push(pw)
    powers.push(this.p.maxRange)
    for (const off of [0, -2, 2]) {
      for (const pw of powers) {
        if (this.simulateShot(origin, normAngle(base + off), pw, [cell], true).hit != null) {
          return true
        }
      }
    }
    return false
  }

  // --- Threat model ----------------------------------------------------------

  /** Cells an enemy could occupy before firing on its next turn. */
  private threatEnvelope(pos: Coordinate): Coordinate[] {
    const positions: Coordinate[] = [{ ...pos }]
    if (this.p.actionBudget < 2) return positions
    for (const dir of DIRS) {
      const d = DIRECTION_DELTAS[dir]
      for (let step = 1; step <= this.p.moveMax; step++) {
        const c = { x: pos.x + d.dx * step, y: pos.y + d.dy * step }
        if (!this.inBounds(c)) break
        const k = this.knownAt(c)
        if (k?.terrain === 'obstacle') break
        positions.push(c)
      }
    }
    return positions
  }

  /** Is `cell` lit by a flare that will still be active on the next turn? */
  private litNextTurn(cell: Coordinate): boolean {
    for (const flare of this.activeFlares ?? []) {
      if (flare.expiryTurn > this.turn + 1 &&
          euclidean(cell, flare.targetCell) <= flare.radius + 1e-9) {
        return true
      }
    }
    return false
  }

  /**
   * Could any recently-sighted enemy move into vision of `cell` and land a
   * shell there on its next turn?
   */
  private isThreatened(cell: Coordinate): boolean {
    const lit = this.litNextTurn(cell)
    for (const track of this.tracks.values()) {
      if (this.ageRounds(track) > 1) continue
      const from = track.turnSeen === this.turn ? track.pos : this.predict(track)
      for (const vantage of this.threatEnvelope(from)) {
        const visible = lit || euclidean(cell, vantage) <= this.p.localRadius + 1e-9
        if (!visible) continue
        if (this.canHitFrom(vantage, cell)) return true
      }
    }
    return false
  }

  // --- Movement --------------------------------------------------------------

  /** All single-move-action destinations validated against known terrain. */
  private moveOptions(origin: Coordinate): Array<{ dir: Direction; dist: number; end: Coordinate }> {
    const options: Array<{ dir: Direction; dist: number; end: Coordinate }> = []
    const freshCells = this.freshTracks().map((t) => t.pos)
    for (const dir of DIRS) {
      const d = DIRECTION_DELTAS[dir]
      for (let step = 1; step <= this.p.moveMax; step++) {
        const c = { x: origin.x + d.dx * step, y: origin.y + d.dy * step }
        if (!this.inBounds(c)) break
        const k = this.knownAt(c)
        if (!k || k.terrain === 'obstacle') break
        if (freshCells.some((f) => f.x === c.x && f.y === c.y)) break
        options.push({ dir, dist: step, end: c })
      }
    }
    return options
  }

  /** Nearest believed enemy position (fresh preferred, else predicted). */
  private nearestEnemyBelief(): { pos: Coordinate; hp: number; fresh: boolean } | null {
    let best: { pos: Coordinate; hp: number; fresh: boolean } | null = null
    let bestDist = Infinity
    for (const track of this.tracks.values()) {
      const fresh = track.turnSeen === this.turn
      const pos = fresh ? track.pos : this.predict(track)
      const dist = euclidean(this.myPos, pos)
      if (dist < bestDist) {
        bestDist = dist
        best = { pos: { ...pos }, hp: track.hp, fresh }
      }
    }
    return best
  }

  /**
   * Exploration objective: the nearest dense patch of unexplored terrain.
   * (A global centroid stalls when the remaining unknowns are symmetric —
   * e.g. four corners average out to an already-explored center.)
   */
  /**
   * Information value of (re)observing a cell. Unexplored terrain is worth
   * the most, but observations decay: a hiding enemy can re-enter ground we
   * scanned long ago, so stale cells regain search value over time. Recent
   * enemy flare activity marks a neighborhood as suspect.
   */
  private cellValue(cx: number, cy: number): number {
    const k = cellKey(cx, cy)
    let value: number
    if (!this.known.has(k)) {
      value = 8
    } else {
      const staleness = this.turn - (this.lastObserved.get(k) ?? 0)
      value = Math.min(staleness, 24) / 4
    }
    if (
      this.suspectAnchor &&
      this.turn - this.suspectAnchor.turn <= 8 &&
      euclidean({ x: cx, y: cy }, this.suspectAnchor.pos) <= this.p.maxRange * 0.7
    ) {
      value += 4
    }
    return value
  }

  /** Information a scan from `center` would gather. */
  private scanGain(center: Coordinate): number {
    const span = Math.ceil(this.p.localRadius)
    const radiusSq = this.p.localRadius * this.p.localRadius
    let gain = 0
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        if (dx * dx + dy * dy > radiusSq) continue
        const cx = center.x + dx
        const cy = center.y + dy
        if (cx < 0 || cy < 0 || cx >= this.p.width || cy >= this.p.height) continue
        gain += this.cellValue(cx, cy)
      }
    }
    return gain
  }

  private explorationTarget(): Coordinate {
    // Stick with the committed goal until its area is actually revealed —
    // re-picking every turn flaps between scattered unknown scraps and the
    // tank tours the map without finishing any region. The age cap breaks
    // out of unreachable pockets.
    if (this.exploreGoal) {
      if (this.scanGain(this.exploreGoal) > 6 && this.exploreGoalAge <= 12) {
        return { ...this.exploreGoal }
      }
      this.exploreGoal = null
    }
    // Nearest-first coverage: visit the closest spot whose scan still reveals
    // a meaningful patch (recon flares mop up the 1-2 cell scraps). Nearest-
    // first is stable while approaching, so the goal cannot flap mid-route.
    // The enemy is equally likely in any unrevealed cell, so systematic
    // coverage is also optimal hunting. A cold trail re-anchors the search
    // near where the track was lost.
    const anchor = this.lastLostPos ?? this.myPos
    let best: Coordinate | null = null
    let bestDist = Infinity
    let bestIsPatch = false
    for (let y = 0; y < this.p.height; y += 2) {
      for (let x = 0; x < this.p.width; x += 2) {
        // Standing spot must be plausibly reachable.
        if (this.known.get(cellKey(x, y))?.terrain === 'obstacle') continue
        const density = this.scanGain({ x, y })
        if (density < 4) continue
        const isPatch = density >= 24
        const dist = euclidean(anchor, { x, y })
        // Real patches take priority over scraps; nearest within the tier.
        if ((isPatch && !bestIsPatch) || (isPatch === bestIsPatch && dist < bestDist)) {
          best = { x, y }
          bestDist = dist
          bestIsPatch = isPatch
        }
      }
    }
    if (best == null) return { x: Math.floor(this.p.width / 2), y: Math.floor(this.p.height / 2) }
    this.exploreGoal = { ...best }
    this.exploreGoalAge = 0
    return best
  }

  /**
   * BFS distance field (8-connected) toward `goal` over non-obstacle cells;
   * unknown terrain counts as passable. Euclidean hill-climbing strands the
   * tank in obstacle pockets — this routes around walls.
   */
  private goalField: Map<string, number> | null = null

  private computeGoalField(goal: Coordinate): Map<string, number> {
    const field = new Map<string, number>()
    const queue: Coordinate[] = [goal]
    field.set(cellKey(goal.x, goal.y), 0)
    let head = 0
    while (head < queue.length) {
      const c = queue[head++]
      const d = field.get(cellKey(c.x, c.y))!
      for (const dir of DIRS) {
        const dd = DIRECTION_DELTAS[dir]
        const n = { x: c.x + dd.dx, y: c.y + dd.dy }
        if (!this.inBounds(n)) continue
        const k = cellKey(n.x, n.y)
        if (field.has(k)) continue
        if (this.known.get(k)?.terrain === 'obstacle') continue
        field.set(k, d + 1)
        queue.push(n)
      }
    }
    return field
  }

  /** Routed distance from `cell` to the active goal (large fallback if cut off). */
  private goalDistance(cell: Coordinate, goal: Coordinate): number {
    const d = this.goalField?.get(cellKey(cell.x, cell.y))
    return d ?? euclidean(cell, goal) + 25
  }

  /**
   * Score an end-of-turn cell. Higher is better. `goal` shapes movement:
   * hunting pulls toward the objective; evading pushes out of the enemy's
   * move-and-see envelope.
   */
  private scoreEndCell(
    cell: Coordinate,
    goal: Coordinate | null,
    mode: 'hunt' | 'evade' | 'explore',
  ): number {
    let score = 0

    if (this.isThreatened(cell)) {
      score -= this.myHp <= 1 ? 4000 : 900
    }

    const belief = this.nearestEnemyBelief()
    if (belief) {
      const dist = euclidean(cell, belief.pos)

      // A cell we can actually shoot from is worth walking to — terrain
      // frequently makes the "obvious" stand-off cell a blind spot.
      if (mode !== 'evade') {
        const shot = this.findShot(cell, [{ pos: belief.pos, hp: belief.hp }])
        if (shot && shot.risky === 0) score += 140
      }
      if (mode === 'evade') {
        const safeDist = this.p.localRadius + this.p.moveMax + 1
        if (dist < safeDist) score -= (safeDist - dist) * 45
        if (dist <= this.p.localRadius) score -= 90
      } else {
        // Hold a sniping band: inside shell range, outside their scan+move reach.
        const lo = this.p.localRadius + (this.myHp <= 1 ? this.p.moveMax + 1 : 1)
        const hi = Math.max(lo + 1, this.p.maxRange - 2)
        if (dist < lo) score -= (lo - dist) * 35
        if (dist > hi) score -= (dist - hi) * 12
      }

      // Cover bonus: adjacent obstacle roughly toward the enemy blocks the
      // low tail of incoming arcs.
      const toEnemy = bearingDeg(cell, belief.pos)
      for (const dir of DIRS) {
        const d = DIRECTION_DELTAS[dir]
        const nb = { x: cell.x + d.dx, y: cell.y + d.dy }
        const k = this.knownAt(nb)
        if (k?.terrain === 'obstacle' && angleGap(bearingDeg(cell, nb), toEnemy) <= 67.5) {
          score += 30
          break
        }
      }
    }

    // Standing in a flare that outlives my turn hands the enemy a firing
    // solution — but only matters if someone is actually around to look.
    if (this.litNextTurn(cell)) {
      if (this.tracks.size > 0) score -= 120
      else if (mode !== 'explore') score -= 15
    }

    if (goal) score -= this.goalDistance(cell, goal) * (mode === 'explore' ? 6 : 10)

    // While exploring, prefer steps that scan fresh ground en route — but not
    // when re-acquiring a cold trail, where directness beats coverage.
    if (mode === 'explore' && !this.lastLostPos) score += this.scanGain(cell) * 0.3

    // Mild preference for not hugging edges (keeps dodge options open).
    const edgeDist = Math.min(cell.x, cell.y, this.p.width - 1 - cell.x, this.p.height - 1 - cell.y)
    if (edgeDist === 0) score -= 8

    return score
  }

  // --- Flare aiming ------------------------------------------------------------

  /** Information a flare landing at `target` would gather. */
  private flareGain(target: Coordinate): number {
    const span = Math.ceil(this.p.flareRadius)
    const radiusSq = this.p.flareRadius * this.p.flareRadius
    let gain = 0
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        if (dx * dx + dy * dy > radiusSq) continue
        const cx = target.x + dx
        const cy = target.y + dy
        if (cx < 0 || cy < 0 || cx >= this.p.width || cy >= this.p.height) continue
        gain += this.cellValue(cx, cy)
      }
    }
    return gain
  }

  /**
   * Best flare (direction, range) whose target lands nearest `desired`
   * without lighting up our own cell. Used for re-acquiring a tracked enemy —
   * terrain knowledge is irrelevant there, presence detection is the point.
   */
  private aimFlare(desired: Coordinate): { direction: Direction; range: number } | null {
    let best: { direction: Direction; range: number; err: number } | null = null
    const maxDim = Math.max(this.p.width, this.p.height)
    for (const dir of DIRS) {
      const d = DIRECTION_DELTAS[dir]
      for (let r = 1; r <= maxDim; r++) {
        const target = { x: this.myPos.x + d.dx * r, y: this.myPos.y + d.dy * r }
        if (!this.inBounds(target)) break
        if (euclidean(target, this.myPos) <= this.p.flareRadius + 0.2) continue
        const err = euclidean(target, desired)
        if (best == null || err < best.err) best = { direction: dir, range: r, err }
      }
    }
    if (best == null) return null
    return { direction: best.direction, range: best.range }
  }

  /**
   * Recon flare maximizing revealed unknown cells over all 8 rays. Flares are
   * a free long-range sensor whenever the shell isn't needed — decoupled from
   * the walking goal so movement and probing cover different ground.
   */
  private bestReconFlare(): { direction: Direction; range: number } | null {
    let best: { direction: Direction; range: number; score: number } | null = null
    const maxDim = Math.max(this.p.width, this.p.height)
    for (const dir of DIRS) {
      const d = DIRECTION_DELTAS[dir]
      for (let r = 1; r <= maxDim; r++) {
        const target = { x: this.myPos.x + d.dx * r, y: this.myPos.y + d.dy * r }
        if (!this.inBounds(target)) break
        if (euclidean(target, this.myPos) <= this.p.flareRadius + 0.2) continue
        const gain = this.flareGain(target)
        if (gain < 6) continue
        const score = gain - r * 0.05
        if (best == null || score > best.score) best = { direction: dir, range: r, score }
      }
    }
    if (best == null) return null
    return { direction: best.direction, range: best.range }
  }

  // --- Turn planning -------------------------------------------------------------

  /** Per-turn bookkeeping: cadence counters and bias expiry. */
  beginTurn(): void {
    this.turnsSinceFlare++
    if (this.lostBiasTurns > 0 && --this.lostBiasTurns === 0) {
      this.lastLostPos = null
    }
    if (this.exploreGoal) this.exploreGoalAge++
  }

  /**
   * Decide the next single tool call given the latest worldview. Returns null
   * to end the turn (unspent actions carry no value).
   */
  decideNext(view: WorldView, offenseUsed: boolean): Tool | null {
    const actionsLeft = view.remainingActions
    if (actionsLeft <= 0) return null

    const fresh = this.freshTracks()
    const single = this.p.actionBudget < 2

    // 1) Fresh, exact enemy positions.
    if (fresh.length > 0) {
      const targets = fresh.map((t) => ({ pos: t.pos, hp: t.hp }))
      if (!offenseUsed) {
        const shot = this.findShot(this.myPos, targets)
        if (shot && shot.risky === 0) {
          return { kind: 'fire_shell', angle: shot.angle, power: shot.power }
        }
        // Move into a certain firing position, then fire next iteration.
        if (actionsLeft >= 2) {
          let bestOpt: { dir: Direction; dist: number; end: Coordinate; score: number } | null = null
          for (const opt of this.moveOptions(this.myPos)) {
            const s = this.findShot(opt.end, targets)
            if (s == null || s.risky > 0) continue
            const score = this.scoreEndCell(opt.end, null, 'hunt')
            if (bestOpt == null || score > bestOpt.score) bestOpt = { ...opt, score }
          }
          if (bestOpt) return { kind: 'move', direction: bestOpt.dir, distance: bestOpt.dist }
        }
        // Accept a slightly risky shot when it may finish a wounded enemy.
        const weakest = Math.min(...targets.map((t) => t.hp))
        if (shot && shot.risky <= 2 && (weakest <= 1 || shot.risky <= 1)) {
          return { kind: 'fire_shell', angle: shot.angle, power: shot.power }
        }
      }
      // Offense used (or no shot exists): reposition. Threat scoring keeps us
      // out of the enemy's move-and-fire envelope; full evade only at 1 HP.
      return this.repositionTool(this.myHp <= 1 ? 'evade' : 'hunt', null)
    }

    // 2) Stale track — hunt.
    const stale = this.staleTracks()
    if (stale.length > 0) {
      const track = stale.reduce((a, b) =>
        euclidean(this.myPos, this.predict(a)) <= euclidean(this.myPos, this.predict(b)) ? a : b,
      )
      const pred = this.predict(track)
      const dist = euclidean(this.myPos, pred)
      const age = this.ageRounds(track)

      if (!offenseUsed) {
        // Speculative shot: an enemy that has never been observed moving is
        // almost certainly parked; trust the prediction longer in that case.
        const specAge = track.prevPos == null ? 3 : 1
        if (age <= specAge && dist <= this.p.maxRange + 0.5) {
          const spec = this.findShot(this.myPos, [{ pos: pred, hp: track.hp }])
          if (spec && spec.risky === 0) {
            return { kind: 'fire_shell', angle: spec.angle, power: spec.power }
          }
        }
        // No shot from here: walk toward a cell that has one. The next
        // iteration (or turn) fires from there.
        if (actionsLeft >= 2) {
          let bestOpt: { dir: Direction; dist: number; score: number } | null = null
          for (const opt of this.moveOptions(this.myPos)) {
            const s = this.findShot(opt.end, [{ pos: pred, hp: track.hp }])
            if (s == null || s.risky > 0) continue
            const score = this.scoreEndCell(opt.end, null, 'hunt')
            if (bestOpt == null || score > bestOpt.score) {
              bestOpt = { dir: opt.dir, dist: opt.dist, score }
            }
          }
          if (bestOpt) return { kind: 'move', direction: bestOpt.dir, distance: bestOpt.dist }
        }
        // Close for a same-turn reveal: move so the predicted cell enters my
        // scan, then the next iteration fires with exact intel.
        const canContact = !single && actionsLeft >= 2 && dist <= this.p.localRadius + this.p.moveMax
        const trade = this.myHp >= track.hp && this.myHp > 1
        if (canContact && trade) {
          const opt = this.bestApproach(pred, this.p.localRadius - 0.5)
          if (opt) return { kind: 'move', direction: opt.dir, distance: opt.dist }
        }
        // Re-acquire with a flare on the predicted position — but not on
        // consecutive turns; repositioning breaks flare-camp stalemates.
        if (this.turnsSinceFlare > 1) {
          const flare = this.aimFlare(pred)
          if (flare) return { kind: 'fire_flare', direction: flare.direction, range: flare.range }
        }
      }
      return this.repositionTool('hunt', pred)
    }

    // 3) No intel — explore and probe.
    const target = this.explorationTarget()
    const move = this.repositionTool('explore', target)
    const flareable = !offenseUsed
    const probe = (): Tool | null => {
      const flare = this.bestReconFlare()
      return flare ? { kind: 'fire_flare', direction: flare.direction, range: flare.range } : null
    }
    if (single) {
      // One action per turn: alternate probing and moving — flares reach
      // anywhere on the rays, so they carry most of the search.
      if (flareable && this.turnsSinceFlare >= 2) {
        const flare = probe()
        if (flare) return flare
      }
      if (move) return move
      return flareable ? probe() : null
    }
    // Two actions: move first so the flare is fired from the new vantage —
    // flaring first lights up the very cells the approach runs through.
    if (move && actionsLeft >= 2) return move
    if (flareable) {
      const flare = probe()
      if (flare) return flare
    }
    return move
  }

  /** Best single move toward `goal` that ends within `within` of it, else closest approach. */
  private bestApproach(
    goal: Coordinate,
    within: number,
  ): { dir: Direction; dist: number; end: Coordinate } | null {
    this.goalField = this.computeGoalField(goal)
    let best: { dir: Direction; dist: number; end: Coordinate; d: number } | null = null
    for (const opt of this.moveOptions(this.myPos)) {
      const d = this.goalDistance(opt.end, goal)
      if (best == null || d < best.d) best = { ...opt, d }
    }
    const here = this.goalDistance(this.myPos, goal)
    this.goalField = null
    if (best == null) return null
    if (best.d <= within || best.d < here) return best
    return null
  }

  /** Score current cell vs all move options; return a move or null to stay. */
  private repositionTool(mode: 'hunt' | 'evade' | 'explore', goal: Coordinate | null): Tool | null {
    this.goalField = goal ? this.computeGoalField(goal) : null
    const stayScore = this.scoreEndCell(this.myPos, goal, mode) + (mode === 'hunt' ? 4 : 0)
    let best: { dir: Direction; dist: number; score: number } | null = null
    for (const opt of this.moveOptions(this.myPos)) {
      const score = this.scoreEndCell(opt.end, goal, mode)
      if (best == null || score > best.score) best = { dir: opt.dir, dist: opt.dist, score }
    }
    this.goalField = null
    if (best && best.score > stayScore) {
      return { kind: 'move', direction: best.dir, distance: best.dist }
    }
    return null
  }
}

/**
 * Fable — precision-fire scripted tank.
 *
 * @param tankId - Identifier used in the agent name and call IDs.
 * @param config - Match config for engine-exact simulation. Falls back to
 *   duel-preset parameters (with observation-inferred map bounds) if omitted.
 */
export function createFableFreshAgent(tankId: string, config?: MatchConfig): TankAgent {
  const brain = new FableBrain(config)

  return {
    name: `fable-fresh-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      brain.ingestView(worldview)
      brain.beginTurn()

      const maxCalls = Math.max(1, brain.p.maxToolCallsPerTurn)
      const calls: ToolCall[] = []
      let view = worldview
      let offenseUsed = false
      let seq = 0

      while (calls.length < maxCalls && view.remainingActions > 0) {
        const tool = brain.decideNext(view, offenseUsed)
        if (tool == null) break

        const call: ToolCall = { id: `fable-${worldview.turn}-${seq++}`, tool }
        calls.push(call)
        if (tool.kind === 'fire_shell' || tool.kind === 'fire_flare') offenseUsed = true

        if (executeTool) {
          const outcome = await executeTool(call)
          brain.ingestResult(call, outcome.result)
          brain.ingestView(outcome.worldview)
          view = outcome.worldview
          if (outcome.turnEnded) break
          // A blocked call consumed no action; avoid retrying the same tool forever.
          if (outcome.result.kind === 'blocked' || outcome.result.kind === 'invalid') break
        } else {
          // Static fallback (no incremental executor): approximate state.
          const approx: WorldView = {
            ...view,
            remainingActions: view.remainingActions - 1,
            position:
              tool.kind === 'move'
                ? {
                    x: view.position.x + DIRECTION_DELTAS[tool.direction].dx * tool.distance,
                    y: view.position.y + DIRECTION_DELTAS[tool.direction].dy * tool.distance,
                  }
                : view.position,
          }
          brain.ingestView(approx)
          view = approx
        }
      }

      if (calls.length === 0) {
        const pass: ToolCall = { id: `fable-${worldview.turn}-pass`, tool: { kind: 'pass' } }
        if (executeTool) {
          await executeTool(pass)
          return { toolCalls: [pass], executed: true }
        }
        return [pass]
      }

      if (executeTool) {
        return { toolCalls: calls, executed: true }
      }
      return calls
    },
  }
}
