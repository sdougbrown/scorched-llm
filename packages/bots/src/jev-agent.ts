import type { WorldView } from '@scorched-llm/engine'
import type { Tool, ToolCall } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import type { AgentTurnResult, TankAgent, ToolExecutor } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, euclidean, inBounds, supercover } from '@scorched-llm/engine'
import type { DecisionAnswer, DecisionClient, DecisionQuestion } from './jev-client.js'
import { TypeSafeDecisionClient } from './jev-client.js'

/**
 * JevAgent — a tank driven by a System One classifier (Jev) instead of a
 * generative LLM. Jev holds no conversation, emits no text, and cannot do
 * arithmetic; it answers typed questions (choice / score / noul) about a
 * state blob with calibrated probabilities.
 *
 * The harness therefore inverts the usual LLM-agent shape. Code owns every
 * number and every feasibility check: it computes shot geometry, arc
 * clearance, path clearance, and enemy bearings; prunes options that cannot
 * work (no shot candidates, blocked directions) so Jev never reasons over
 * negations; and labels each remaining option with a computed verdict
 * ("likely destroys it", "recommended", "retreat"). Jev judges among the
 * described options; the chosen option's precomputed arguments are copied
 * verbatim into the engine tool call. Decisions resolve in stages — intent
 * first, then a branch-specific question set — with a fresh WorldView after
 * every executed action.
 *
 * The decision client is swappable (`DecisionClient` in jev-client.ts) so
 * other System One-style models or classifier stacks can be trialed.
 */

const COMPASS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

/** Offensive actions are irreversible: demand a clear winner. */
const OFFENSIVE_MIN_TOP = 0.5
const OFFENSIVE_MIN_MARGIN = 0.2
/** Moves and flare placement are reversible or low-stakes: accept a weak
 * consensus among near-symmetric options. */
const MOVE_MIN_TOP = 0.4
const MOVE_MIN_MARGIN = 0.1
const FLARE_MIN_TOP = 0.35
const FLARE_MIN_MARGIN = 0.05
/** Safety cap on decision rounds per turn. */
const MAX_DECISIONS_PER_TURN = 6
/** Maximum shot candidates offered in one shell question. */
const MAX_CANDIDATES = 6

interface EnemySighting {
  position: Coordinate
  hp: number
  lastSeenTurn: number
  visible: boolean
}

interface Target {
  id: string
  position: Coordinate
  hp: number
  visible: boolean
  lastSeenTurn: number
}

interface ShotCandidate {
  key: string
  angle: number
  power: number
  description: string
}

interface DirectionInfo {
  dir: Direction
  clear: number
  delta: number
  relation: string
  leavesFlare: boolean
}

interface TurnContext {
  offensiveUsed: boolean
}

interface DecisionLog {
  lines: string[]
  tokensIn: number
  tokensOut: number
  costUsd: number
  latencyMs: number
  model: string
}

type QuestionSet = Record<string, DecisionQuestion>

export interface JevAgentOptions {
  /** Inject a decision client (tests, or non-Jev classifiers). */
  client?: DecisionClient
  /** Jev model name sent as the request's `model` field. */
  model?: string
  apiKey?: string
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
 * Margin-aware gate on a Choice answer. Confidence summarizes distribution
 * concentration, so gate on the per-option probabilities: the winner must
 * clear `minTop` and beat the runner-up by `minMargin`. Returns the winning
 * option key, or null when the gate fails.
 */
function gatedChoice(answer: DecisionAnswer | undefined, minTop: number, minMargin: number): string | null {
  if (answer?.type !== 'choice') return null
  const probs = Object.entries(answer.probabilities ?? {})
  const sorted = (probs.length > 0 ? probs : [['choice', answer.confidence] as [string, number]])
    .sort((a, b) => b[1] - a[1])
  const [topKey, topProb] = sorted[0]
  const secondProb = sorted[1]?.[1] ?? 0
  if (topProb < minTop || topProb - secondProb < minMargin) return null
  return topKey
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

function isOffensive(tool: Tool): boolean {
  return tool.kind === 'fire_shell' || tool.kind === 'fire_bomb' || tool.kind === 'fire_flare'
}

export function createJevAgent(
  tankId: string,
  config: MatchConfig,
  options: JevAgentOptions = {},
): TankAgent {
  const client: DecisionClient = options.client ?? new TypeSafeDecisionClient({
    model: options.model,
    apiKey: options.apiKey,
  })

  const mapWidth = config.map.width
  const mapHeight = config.map.height
  const shellMaxRange = config.shell.maxRange
  const apexHeight = config.shell.apexHeight
  const tankHeight = config.shell.tankHeight
  const obstacleHeight = config.map.obstacleHeight
  const moveMax = Math.max(1, Math.floor(config.moveMax ?? config.fog.flareRadius))
  const flareRadius = config.fog.flareRadius
  const hitsToKill = config.lethality.hitsToKill
  const bombsEnabled = config.bomb != null

  const knownObstacles = new Set<string>()
  const enemyMemory = new Map<string, EnemySighting>()

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

  // --- State builders ---

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
      },
      target_hint: target === null
        ? 'no enemy has been seen yet'
        : target.visible
          ? 'an enemy is visible right now'
          : `the most recent enemy sighting is ${cw.turn - target.lastSeenTurn} turn(s) old`,
    }
  }

  // --- Decision stages ---

  function makeAsk(log: DecisionLog) {
    return async (
      state: unknown,
      questions: QuestionSet,
    ): Promise<Record<string, DecisionAnswer>> => {
      const response = await client.ask(state, questions)
      log.tokensIn += response.usage.inputTokens
      log.tokensOut += response.usage.outputTokens
      log.latencyMs += response.usage.latencyMs
      if (typeof response.usage.costUsd === 'number') log.costUsd += response.usage.costUsd
      log.model = response.usage.model
      return response.answers
    }
  }

  /** One intent + resolution cycle. Returns the tool to execute, or null to
   * end the turn. */
  async function decideOnce(
    cw: WorldView,
    ctx: TurnContext,
    log: DecisionLog,
  ): Promise<Tool | null> {
    const ask = makeAsk(log)

    // Prune before asking: Jev never sees options that cannot work.
    const candidates = ctx.offensiveUsed ? [] : buildShotCandidates(cw)
    const flee = cw.inEnemyFlare.length > 0
    const target = pickTarget(cw)
    const moveInfos = directionInfos(cw, target, flee)
    const canMove = moveInfos.length > 0
    const canFlare = !ctx.offensiveUsed

    // Stage 1: intent. Options whose conditions cannot hold are not offered.
    const actionCriteria: Record<string, string> = {}
    if (candidates.length > 0) {
      actionCriteria.fire_shell =
        'The `shell.shots_available` field is greater than 0: the fire-control system has precomputed at least one shot in `candidates`. Firing uses the tank\'s one offensive action for this turn.'
    }
    if (bombsEnabled && (cw.bombsRemaining ?? 0) > 0 && candidates.length > 0) {
      actionCriteria.fire_bomb =
        'The `shell.shots_available` field is greater than 0 and `me` still has bombs: a splash hit near clustered targets beats a direct shell'
    }
    if (canMove) {
      actionCriteria.move =
        'No shot option is offered, or the tank is inside an enemy flare (`threats.in_enemy_flare` is true) and should escape the light. Moving repositions the tank.'
    }
    if (canFlare) {
      actionCriteria.fire_flare =
        'No shot option is offered and `target_hint` says the enemy position is unknown or stale: reveal darkness with a flare. Firing a flare uses the tank\'s one offensive action for this turn.'
    }
    actionCriteria.pass = 'Every other offered option fails its stated conditions.'

    const answers = await ask(baseState(cw, candidates.length), {
      intent: {
        type: 'choice',
        instructions:
          'You are the tank in `me` in a fog-of-war tank duel. `visible_enemies` lists enemies you can see right now; `memory` lists where enemies were last seen when out of sight. Each turn the tank takes at most one offensive action (shell, bomb, or flare) plus optional moves. Only options whose stated conditions hold are offered. Pick exactly one option: the one whose stated conditions hold. If two options qualify, choose the one listed first.',
        criteria: actionCriteria,
      },
    })

    const intent = answers.intent
    if (intent?.type !== 'choice') return null
    const gatedIntent = gatedChoice(intent, MOVE_MIN_TOP, MOVE_MIN_MARGIN)
    log.lines.push(
      `T${cw.turn}: intent=${intent.choice} p=${(intent.probabilities[intent.choice] ?? intent.confidence).toFixed(2)} conf=${intent.confidence.toFixed(2)}`,
    )
    if (gatedIntent === null || gatedIntent === 'pass') {
      return { kind: 'pass' }
    }

    if (gatedIntent === 'fire_shell' || gatedIntent === 'fire_bomb') {
      if (candidates.length === 0) return { kind: 'pass' }
      const shotState = {
        ...baseState(cw, candidates.length),
        candidates: candidates.map((c) => ({ option: c.key, description: c.description })),
      }
      const shotAnswers = await ask(shotState, {
        shot: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. `candidates` lists precomputed shots the fire-control system can execute this turn: aim and distance in each option are exact, and each option ends with a computed outcome verdict. Choose the option with the best outcome. Prefer options that say "likely destroys it" over "likely damages it" over "likely misses". Choose hold only if no shot option beats "likely misses".',
          criteria: {
            ...Object.fromEntries(candidates.map((c) => [c.key, c.description])),
            hold: 'do not fire — keep the shell for a target the tank can actually see',
          },
        },
      })
      const shot = shotAnswers.shot
      const gatedShot = gatedChoice(shot, OFFENSIVE_MIN_TOP, OFFENSIVE_MIN_MARGIN)
      if (shot?.type !== 'choice' || gatedShot === null || gatedShot === 'hold') {
        log.lines.push(`  shot=${shot?.type === 'choice' ? shot.choice : 'unusable'} → hold`)
        return { kind: 'pass' }
      }
      const picked = candidates.find((c) => c.key === gatedShot)
      if (!picked) {
        log.lines.push(`  shot=${gatedShot} unknown option; holding fire`)
        return { kind: 'pass' }
      }
      log.lines.push(`  shot=${picked.key} p=${(shot.probabilities[picked.key] ?? shot.confidence).toFixed(2)}`)
      return gatedIntent === 'fire_bomb'
        ? { kind: 'fire_bomb', angle: picked.angle, power: picked.power }
        : { kind: 'fire_shell', angle: picked.angle, power: picked.power }
    }

    if (gatedIntent === 'move') {
      const dirCriteria: Record<string, string> = {}
      for (const info of moveInfos) dirCriteria[info.dir] = describeDirection(info, target !== null, flee)
      const moveAnswers = await ask(baseState(cw, candidates.length), {
        direction: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose to move. Choose the compass direction the tank should travel this turn; it will move exactly the number of cells stated in the chosen option. Each option states what the move achieves relative to the target and ends with a computed verdict. Prefer options labeled "recommended" or "retreat: exits the enemy flare". Options that would move into terrain or off the map are not offered.',
          criteria: dirCriteria,
        },
      })
      let chosen = gatedChoice(moveAnswers.direction, MOVE_MIN_TOP, MOVE_MIN_MARGIN)
      if (chosen !== null && dirCriteria[chosen] === undefined) chosen = null
      if (chosen === null) {
        // Fallback ladder: the code-computed best direction, never a pass —
        // a wasted move is better than a wasted turn.
        const fallback = moveInfos.find((i) => flee && i.leavesFlare)
          ?? moveInfos.reduce((a, b) => (b.delta < a.delta ? b : a))
        log.lines.push(`  move: gate failed; fallback ${fallback.dir}`)
        return {
          kind: 'move',
          direction: fallback.dir,
          distance: clearDistance(cw.position, fallback.dir),
        }
      }
      const dirProb = moveAnswers.direction.type === 'choice'
        ? moveAnswers.direction.probabilities[chosen] ?? moveAnswers.direction.confidence
        : 0
      log.lines.push(`  move=${chosen} x${clearDistance(cw.position, chosen as Direction)} p=${dirProb.toFixed(2)}`)
      return { kind: 'move', direction: chosen as Direction, distance: clearDistance(cw.position, chosen as Direction) }
    }

    if (gatedIntent === 'fire_flare') {
      // One information goal in code: the freshest memory, else the current
      // exploration waypoint.
      const goalPosition = target !== null ? target.position : currentWaypoint()
      const goalBearing = bearingDeg(cw.position, goalPosition)
      const goalDist = euclidean(cw.position, goalPosition)
      const dirCriteria: Record<string, string> = {}
      for (const info of directionInfos(cw, target, false)) {
        if (bearingDelta(COMPASS.indexOf(info.dir) * 45, goalBearing) > 90) continue
        dirCriteria[info.dir] = `${info.dir}: places the reveal circle ${relationPhrase(info.delta, info.relation)}`
      }
      if (Object.keys(dirCriteria).length === 0) return { kind: 'pass' }
      const aimRange = Math.min(shellMaxRange, Math.max(1, Math.round(goalDist)))
      const rangeOptions: Record<string, string> = {
        '1': `flare 1 cell out — reveals a circle of radius ${flareRadius} right next to the tank; wastes range when the goal is far`,
        [String(aimRange)]: `flare ${aimRange} cells out — places the reveal circle on the goal area, ${Math.round(goalDist)} cells away`,
        [String(shellMaxRange)]: `flare ${shellMaxRange} cells out — maximum reach; overshoots the goal if it is closer than ${shellMaxRange} cells`,
      }
      const flareAnswers = await ask(baseState(cw, candidates.length), {
        flare_direction: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose to fire a flare. A flare lands `flare_range` cells away in the chosen direction and reveals a circle of radius `flare.reveal_radius` around its landing cell, overriding fog there. Choose the direction that places the reveal circle where the enemy is most likely to be.',
          criteria: dirCriteria,
        },
        flare_range: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose to fire a flare. Choose how far from the tank it should land; each option states the tradeoff.',
          criteria: rangeOptions,
        },
      })
      const gatedDir = gatedChoice(flareAnswers.flare_direction, FLARE_MIN_TOP, FLARE_MIN_MARGIN)
      if (gatedDir !== null && dirCriteria[gatedDir] === undefined) {
        log.lines.push('  flare: unknown direction answer')
        return { kind: 'pass' }
      }
      // Flare placement is low-stakes: on a weak consensus, fall back to the
      // offered direction closest to the information goal instead of a pass.
      const chosenDir = gatedDir ?? [...Object.keys(dirCriteria)].reduce((a, b) =>
        bearingDelta(COMPASS.indexOf(b as Direction) * 45, goalBearing) <
        bearingDelta(COMPASS.indexOf(a as Direction) * 45, goalBearing)
          ? b
          : a,
      )
      const rangeAnswer = flareAnswers.flare_range
      const rangeValue = rangeAnswer?.type === 'choice' && rangeOptions[rangeAnswer.choice] !== undefined
        ? Number(rangeAnswer.choice)
        : aimRange
      const dirProb = flareAnswers.flare_direction.type === 'choice'
        ? flareAnswers.flare_direction.probabilities[chosenDir] ?? flareAnswers.flare_direction.confidence
        : 0
      log.lines.push(`  flare=${chosenDir} r${rangeValue} p=${dirProb.toFixed(2)}${gatedDir === null ? ' (fallback)' : ''}`)
      return { kind: 'fire_flare', direction: chosenDir as Direction, range: rangeValue }
    }

    return { kind: 'pass' }
  }

  // --- Turn loop ---

  async function runTurn(
    initial: WorldView,
    executeTool: ToolExecutor | null,
  ): Promise<ToolCall[]> {
    let cw = initial
    const calls: ToolCall[] = []
    const ctx: TurnContext = { offensiveUsed: false }
    const log: DecisionLog = { lines: [], tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model: client.id }
    let seq = 0

    for (let iter = 0; iter < MAX_DECISIONS_PER_TURN; iter++) {
      if (cw.remainingActions <= 0) break
      const tool = await decideOnce(cw, ctx, log)
      if (!tool) break
      if (isOffensive(tool) && ctx.offensiveUsed) break
      const call: ToolCall = { id: `jev-${tankId}-T${cw.turn}-${seq++}`, tool }
      calls.push(call)

      if (executeTool === null) {
        // Static mode (no executor): simulate our own action optimistically.
        if (tool.kind === 'move') {
          const delta = DIRECTION_DELTAS[tool.direction]
          cw = {
            ...cw,
            position: {
              x: cw.position.x + delta.dx * tool.distance,
              y: cw.position.y + delta.dy * tool.distance,
            },
          }
        }
        if (isOffensive(tool)) ctx.offensiveUsed = true
        cw = { ...cw, remainingActions: cw.remainingActions - 1 }
        continue
      }

      const exec = await executeTool(call)
      cw = exec.worldview
      absorb(cw)
      if (isOffensive(tool)) ctx.offensiveUsed = true
      log.lines.push(`  -> ${exec.result.kind}`)
      if (exec.turnEnded) break
      // Jev is extremely consistent: re-asking after a deliberate pass on
      // unchanged state deterministically passes again. End the turn.
      if (tool.kind === 'pass') break
    }

    if (calls.length === 0) {
      calls.push({ id: `jev-${tankId}-T${initial.turn}-pass`, tool: { kind: 'pass' } })
    }
    lastLog = log
    return calls
  }

  let lastLog: DecisionLog | null = null

  return {
    name: `jev-${tankId}`,
    messages: [],
    takeTurn: async (
      worldview: WorldView,
      _tools,
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `jev-${tankId}-T${worldview.turn}-pass`, tool: { kind: 'pass' } }]
      }
      absorb(worldview)
      tickExploration(worldview)
      const calls = await runTurn(worldview, executeTool ?? null)
      const log = lastLog ?? { lines: [], tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model: client.id }
      if (executeTool == null) {
        return calls
      }
      return {
        toolCalls: calls,
        executed: true,
        modelTrace: {
          toolCalls: calls,
          assistantText: log.lines.join('\n') || undefined,
          tokensIn: log.tokensIn,
          tokensOut: log.tokensOut,
          costUsd: log.tokensIn + log.tokensOut === 0 ? 'unknown' : log.costUsd,
          latencyMs: log.latencyMs,
          finishReason: 'stop',
        },
      }
    },
  }
}
