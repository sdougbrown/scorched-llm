import type { WorldView } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, euclidean, inBounds, supercover } from '@scorched-llm/engine'

/**
 * Shared scaffold for the Jev harness family. Every number the harness
 * family computes lives here: shot candidates with verdict labels, per-turn
 * direction intel with clearance and goal relations, waypoint exploration,
 * damage tracking, and opponent-flare triangulation. The decision layer on
 * top differs per entrant — `jev` asks a System One model to judge among
 * the scaffold's options, `jev-greedy` picks them deterministically — which
 * is what makes mirror matches between them a clean ablation.
 */

export const COMPASS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

const MAX_CANDIDATES = 6

export interface EnemySighting {
  position: Coordinate
  hp: number
  lastSeenTurn: number
  visible: boolean
}

export interface Target {
  id: string
  position: Coordinate
  hp: number
  visible: boolean
  lastSeenTurn: number
}

export interface ShotCandidate {
  key: string
  angle: number
  power: number
  description: string
}

export interface DirectionInfo {
  dir: Direction
  clear: number
  delta: number
  relation: string
  leavesFlare: boolean
}

export interface DecisionLog {
  lines: string[]
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  model: string
}

export function emptyLog(model: string): DecisionLog {
  return { lines: [], tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model }
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

function normalizeAngle(angle: number): number {
  let a = angle % 360
  if (a < 0) a += 360
  return a
}

/** Smallest absolute difference between two bearings, in degrees. */
function bearingDelta(a: number, b: number): number {
  const d = Math.abs(normalizeAngle(a) - normalizeAngle(b))
  return d > 180 ? 360 - d : d
}

/**
 * Height of the shell's parabolic arc at sample index `i` of `n` cells after
 * the shooter — mirrors `engine/src/resolution/shell.ts`.
 */
function shellArcHeight(i: number, n: number, apexHeight: number, tankHeight: number): number {
  if (n <= 0) return tankHeight
  const progress = (i + 1) / n
  const arc = 4 * progress * (1 - progress)
  return tankHeight + (apexHeight - tankHeight) * arc
}

export function createJevScaffold(tankId: string, config: MatchConfig) {
  const mapWidth = config.map.width
  const mapHeight = config.map.height
  const shellMaxRange = config.shell.maxRange
  const apexHeight = config.shell.apexHeight
  const tankHeight = config.shell.tankHeight
  const obstacleHeight = config.map.obstacleHeight
  const moveMax = Math.max(1, Math.floor(config.moveMax ?? config.fog.flareRadius))
  const flareRadius = config.fog.flareRadius
  const hitsToKill = config.lethality.hitsToKill

  const knownObstacles = new Set<string>()
  const enemyMemory = new Map<string, EnemySighting>()
  // Damage tracking: an hp drop without a sighting means an unseen hunter is
  // firing from beyond local vision.
  let lastHp: number | null = null
  let underAttackTurns = 0
  // Opponent flares are triangulation data: a flare target sits within shell
  // range of where the opponent stood when it fired. Learn which flare
  // firerId is ours from the first flare we execute, then track the most
  // recent opponent flare as a location hint.
  let myEngineId: string | null = null
  let enemyFlareHint: { targetCell: Coordinate; turn: number } | null = null
  let lastFlareTarget: Coordinate | null = null

  // Exploration: inset corners plus the exact map center, rotated when the
  // tank arrives or stalls — real coordinates instead of a fixed center that
  // invites N/S oscillation on an empty local map.
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

  function currentWaypoint(): Coordinate {
    return waypoints[waypointIndex % waypoints.length]
  }

  function advanceWaypoint(): void {
    waypointIndex = (waypointIndex + 1) % waypoints.length
    turnsSinceWaypointShift = 0
  }

  /** Rotate exploration when the tank has arrived or is stalled. Called on
   * blind turns only — a known target outranks waypoint exploration. */
  function tickExploration(cw: WorldView): void {
    if (pickTarget(cw) !== null) return
    turnsSinceWaypointShift += 1
    if (euclidean(cw.position, currentWaypoint()) <= 1 || turnsSinceWaypointShift >= 4) {
      advanceWaypoint()
    }
  }

  function absorb(cw: WorldView): void {
    for (const cell of cw.localScan) {
      if (cell.terrain === 'obstacle') knownObstacles.add(cellKey(cell.coord))
    }
    for (const fc of cw.flaredCells) {
      if (fc.cell.terrain === 'obstacle') knownObstacles.add(cellKey(fc.cell.coord))
    }
    const visibleIds = new Set<string>()
    for (const enemy of cw.visibleEnemies ?? []) {
      visibleIds.add(enemy.id)
      enemyMemory.set(enemy.id, {
        position: { ...enemy.position },
        hp: enemy.hp,
        lastSeenTurn: cw.turn,
        visible: true,
      })
    }
    for (const [id, sighting] of enemyMemory) {
      if (!visibleIds.has(id)) sighting.visible = false
    }
    if (lastHp != null && cw.hp < lastHp) {
      underAttackTurns = 3
    }
    lastHp = cw.hp
    for (const flare of cw.activeFlares ?? []) {
      if (lastFlareTarget != null && flare.targetCell.x === lastFlareTarget.x && flare.targetCell.y === lastFlareTarget.y) {
        myEngineId = flare.firerId
      }
      if (myEngineId != null && flare.firerId === myEngineId) continue
      if (enemyFlareHint === null || flare.activatedTurn > enemyFlareHint.turn) {
        enemyFlareHint = { targetCell: { ...flare.targetCell }, turn: flare.activatedTurn }
      }
    }
  }

  /** Record the landing cell of our own flare so absorb() can learn which
   * flare firerId is ours. */
  function noteFlareTarget(cw: WorldView, direction: Direction, range: number): void {
    const delta = DIRECTION_DELTAS[direction]
    lastFlareTarget = {
      x: cw.position.x + delta.dx * range,
      y: cw.position.y + delta.dy * range,
    }
  }

  /** Per-decision decay of the under-attack window. */
  function decayAttack(): void {
    if (underAttackTurns > 0) underAttackTurns -= 1
  }

  function underAttack(): boolean {
    return underAttackTurns > 0
  }

  /** The opponent's most recent flare target, when fresh enough to mean the
   * opponent was near it within the last two rounds. */
  function freshEnemyFlareHint(cw: WorldView): { targetCell: Coordinate; turn: number } | null {
    if (enemyFlareHint === null || cw.turn - enemyFlareHint.turn > 2) return null
    return enemyFlareHint
  }

  function pickTarget(cw: WorldView): Target | null {
    let best: Target | null = null
    for (const [id, s] of enemyMemory) {
      if (
        best === null ||
        (s.visible && !best.visible) ||
        (s.visible === best.visible && s.lastSeenTurn > best.lastSeenTurn)
      ) {
        best = { id, position: s.position, hp: s.hp, visible: s.visible, lastSeenTurn: s.lastSeenTurn }
      }
    }
    return best
  }

  /** Steps the tank can travel in `dir` before known terrain or the map edge. */
  function clearDistance(from: Coordinate, dir: Direction): number {
    const delta = DIRECTION_DELTAS[dir]
    for (let step = 1; step <= moveMax; step++) {
      const c: Coordinate = { x: from.x + delta.dx * step, y: from.y + delta.dy * step }
      if (!inBounds(c, mapWidth, mapHeight)) return step - 1
      if (knownObstacles.has(cellKey(c))) return step - 1
    }
    return moveMax
  }

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

  function enemyFlareCenter(cw: WorldView): Coordinate | null {
    const firerIds = new Set(cw.inEnemyFlare.map((f) => f.firerId))
    let best: Coordinate | null = null
    let bestDist = Infinity
    for (const flare of cw.activeFlares ?? []) {
      if (!firerIds.has(flare.firerId)) continue
      const dist = euclidean(cw.position, flare.targetCell)
      if (dist < bestDist) {
        bestDist = dist
        best = flare.targetCell
      }
    }
    return best
  }

  /** Code-computed shot solutions with computed verdicts. Visible enemies
   * with verified-clear paths rank first, then stale last-known positions. */
  function buildShotCandidates(cw: WorldView): ShotCandidate[] {
    const candidates: ShotCandidate[] = []
    const seenCells = new Set<string>()
    const push = (id: string, sighting: EnemySighting, turnsAgo: number): void => {
      const cell = cellKey(sighting.position)
      if (seenCells.has(cell)) return
      const { angle, power } = preciseShot(cw.position, sighting.position)
      if (power < 1 || power > shellMaxRange + 1e-6) return
      const pathClear = !knownBlockedShot(cw.position, sighting.position)
      if (sighting.visible && !pathClear) return // a known-blocked visible shot is a wasted shell
      seenCells.add(cell)
      const dist = Math.round(power * 10) / 10
      const path = sighting.visible ? 'arc verified clear' : 'arc not verified'
      const outcome = sighting.visible
        ? hitsToKill === 1 || sighting.hp <= 1
          ? 'likely destroys it'
          : 'likely damages it'
        : 'likely misses (the target may have moved since)'
      const what = sighting.visible
        ? `${id} — visible now at cell ${cell}, hp ${sighting.hp} of ${hitsToKill} hits to kill`
        : `${id}'s last-known position, cell ${cell}, seen ${turnsAgo} turn${turnsAgo === 1 ? '' : 's'} ago`
      candidates.push({
        key: `c${candidates.length}`,
        angle,
        power,
        description: `fire the shell at ${what}; distance ${dist} of max ${shellMaxRange}; ${path} — ${outcome}`,
      })
    }

    const visible = [...enemyMemory.entries()].filter(([, s]) => s.visible)
    const stale = [...enemyMemory.entries()]
      .filter(([, s]) => !s.visible)
      .sort((a, b) => b[1].lastSeenTurn - a[1].lastSeenTurn)
    for (const [id, s] of visible) push(id, s, 0)
    for (const [id, s] of stale) push(id, s, cw.turn - s.lastSeenTurn)
    return candidates.slice(0, MAX_CANDIDATES)
  }

  function directionInfos(
    cw: WorldView,
    target: Target | null,
    flee: boolean,
  ): DirectionInfo[] {
    const flareCenter = enemyFlareCenter(cw)
    const goalPosition = target !== null ? target.position : currentWaypoint()
    const goal = target === null
      ? 'the exploration waypoint'
      : target.visible ? 'the enemy' : "the enemy's last known position"
    const goalBearing = bearingDeg(cw.position, goalPosition)
    const desired = flee ? normalizeAngle(goalBearing + 180) : goalBearing
    const infos: DirectionInfo[] = []
    for (const dir of COMPASS) {
      const clear = clearDistance(cw.position, dir)
      if (clear <= 0) continue // blocked directions are never offered
      const delta = bearingDelta(COMPASS.indexOf(dir) * 45, desired)
      let leavesFlare = false
      if (flareCenter !== null) {
        const delta2 = DIRECTION_DELTAS[dir]
        const next: Coordinate = {
          x: cw.position.x + delta2.dx * clear,
          y: cw.position.y + delta2.dy * clear,
        }
        leavesFlare = euclidean(next, flareCenter) > euclidean(cw.position, flareCenter)
      }
      infos.push({ dir, clear, delta, relation: goal, leavesFlare })
    }
    return infos
  }

  function relationPhrase(delta: number, goal: string): string {
    if (delta <= 22.5) return `directly toward ${goal}`
    if (delta <= 67.5) return `diagonally toward ${goal}`
    if (delta <= 112.5) return `sideways relative to ${goal}`
    if (delta <= 157.5) return `diagonally away from ${goal}`
    return `directly away from ${goal}`
  }

  function describeDirection(
    info: DirectionInfo,
    hasTarget: boolean,
    flee: boolean,
  ): string {
    let verdict: string
    if (flee) {
      verdict = info.leavesFlare ? 'retreat: exits the enemy flare' : 'stays exposed in the enemy flare'
    } else if (!hasTarget) {
      verdict = 'explores toward the current waypoint'
    } else if (info.delta <= 67.5) {
      verdict = 'recommended: closes on the target'
    } else if (info.delta <= 112.5) {
      verdict = 'flanks the target'
    } else {
      verdict = 'gives up pursuit'
    }
    const cells = info.clear === 1 ? '1 cell' : `${info.clear} cells`
    return `${info.dir}: moves ${relationPhrase(info.delta, info.relation)}; travels ${cells}; path clear for ${cells} — ${verdict}`
  }

  /** Maximum legal flare range in `dir` from `from` (landing cell in bounds). */
  function maxFlareRange(from: Coordinate, dir: Direction): number {
    const delta = DIRECTION_DELTAS[dir]
    let max = 0
    for (let r = 1; r <= shellMaxRange; r++) {
      const cell: Coordinate = {
        x: from.x + delta.dx * r,
        y: from.y + delta.dy * r,
      }
      if (!inBounds(cell, mapWidth, mapHeight)) break
      max = r
    }
    return max
  }

  function baseState(cw: WorldView, candidateCount: number): Record<string, unknown> {
    const target = pickTarget(cw)
    return {
      me: {
        position: cw.position,
        hp: cw.hp,
        actions_left: cw.remainingActions,
        turn: cw.turn,
      },
      shell: { max_range: shellMaxRange, shots_available: candidateCount },
      move: { max_distance: moveMax },
      flare: { reveal_radius: flareRadius },
      visible_enemies: [...enemyMemory.entries()]
        .filter(([, s]) => s.visible)
        .map(([id, s]) => {
          const shot = preciseShot(cw.position, s.position)
          return {
            id,
            position: s.position,
            hp: s.hp,
            distance: Math.round(shot.power * 10) / 10,
            in_range: shot.power <= shellMaxRange + 1e-6,
            arc_clear: !knownBlockedShot(cw.position, s.position),
            cell: cellKey(s.position),
          }
        }),
      memory: [...enemyMemory.entries()]
        .filter(([, s]) => !s.visible)
        .map(([id, s]) => {
          const shot = preciseShot(cw.position, s.position)
          return {
            id,
            last_position: s.position,
            turns_since_seen: cw.turn - s.lastSeenTurn,
            distance: Math.round(shot.power * 10) / 10,
            in_range: shot.power <= shellMaxRange + 1e-6,
          }
        }),
      threats: {
        in_enemy_flare: cw.inEnemyFlare.length > 0,
        flare_expires_turn: cw.inEnemyFlare[0]?.expiryTurn,
        under_attack: underAttackTurns > 0,
        under_attack_note: underAttackTurns > 0
          ? 'the tank has taken damage without seeing the shooter: an unseen enemy is firing from beyond local vision'
          : null,
      },
      target_hint: target === null
        ? 'no enemy has been seen yet'
        : target.visible
          ? 'an enemy is visible right now'
          : `the most recent enemy sighting is ${cw.turn - target.lastSeenTurn} turn(s) old`,
    }
  }

  return {
    tankId,
    shellMaxRange,
    moveMax,
    flareRadius,
    bombsEnabled: config.bomb != null,
    absorb,
    tickExploration,
    currentWaypoint,
    pickTarget,
    clearDistance,
    buildShotCandidates,
    directionInfos,
    describeDirection,
    maxFlareRange,
    baseState,
    underAttack,
    decayAttack,
    freshEnemyFlareHint,
    noteFlareTarget,
  }
}
