import type { WorldView } from '@scorched-llm/engine'
import type { Tool, ToolCall } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import type { AgentTurnResult, TankAgent, ToolExecutor } from '@scorched-llm/engine'
import { DIRECTION_DELTAS } from '@scorched-llm/engine'
import type { DecisionAnswer, DecisionClient, DecisionQuestion } from './jev-client.js'
import type { DecisionLog } from './jev-scaffold.js'
import { emptyLog, createJevScaffold, COMPASS } from './jev-scaffold.js'
import { TypeSafeDecisionClient } from './jev-client.js'

/**
 * JevAgent — a tank driven by a System One classifier (Jev) instead of a
 * generative LLM. Jev holds no conversation, emits no text, and cannot do
 * arithmetic; it answers typed questions (choice / score / noul) about a
 * state blob with calibrated probabilities.
 *
 * The harness therefore inverts the usual LLM-agent shape. The shared
 * scaffold (`jev-scaffold.ts`) computes shot candidates, direction intel,
 * flare goals, and threat signals, and prunes options that cannot work so
 * Jev never reasons over negations; Jev judges among the described options
 * and the chosen option's precomputed arguments are copied verbatim into
 * the engine tool call. Decisions resolve in stages — intent first, then a
 * branch-specific question set — with a fresh WorldView after every
 * executed action.
 *
 * The decision client is swappable (`DecisionClient` in jev-client.ts) so
 * other System One-style models or classifier stacks can be trialed.
 * `jev-greedy` is the deterministic twin: identical scaffold, scripted
 * picks — the ablation control for how much Jev's judgment contributes.
 */

/** Offensive actions are irreversible: demand a clear winner. */
const OFFENSIVE_MIN_TOP = 0.5
const OFFENSIVE_MIN_MARGIN = 0.2
/** Moves and flare placement are reversible or low-stakes. */
const MOVE_MIN_TOP = 0.4
const MOVE_MIN_MARGIN = 0.1
const FLARE_MIN_TOP = 0.35
const FLARE_MIN_MARGIN = 0.05
/** Safety cap on decision rounds per turn. */
const MAX_DECISIONS_PER_TURN = 6

type QuestionSet = Record<string, DecisionQuestion>

export interface JevAgentOptions {
  /** Inject a decision client (tests, or non-Jev classifiers). */
  client?: DecisionClient
  /** Jev model name sent as the request's `model` field. */
  model?: string
  apiKey?: string
}

function isOffensive(tool: Tool): boolean {
  return tool.kind === 'fire_shell' || tool.kind === 'fire_bomb' || tool.kind === 'fire_flare'
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

export function createJevAgent(
  tankId: string,
  config: MatchConfig,
  options: JevAgentOptions = {},
): TankAgent {
  const client: DecisionClient = options.client ?? new TypeSafeDecisionClient({
    model: options.model,
    apiKey: options.apiKey,
  })
  const sc = createJevScaffold(tankId, config)

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
    ctx: { offensiveUsed: boolean },
    log: DecisionLog,
  ): Promise<Tool | null> {
    const ask = makeAsk(log)

    // Prune before asking: Jev never sees options that cannot work.
    const candidates = ctx.offensiveUsed ? [] : sc.buildShotCandidates(cw)
    const target = sc.pickTarget(cw)
    const flee = cw.inEnemyFlare.length > 0 || (sc.underAttack() && target !== null)
    const moveInfos = sc.directionInfos(cw, target, flee)
    const canMove = moveInfos.length > 0
    const canFlare = !ctx.offensiveUsed

    // Stage 1: intent. Options whose conditions cannot hold are not offered.
    const actionCriteria: Record<string, string> = {}
    if (candidates.length > 0) {
      actionCriteria.fire_shell =
        'The `shell.shots_available` field is greater than 0: the fire-control system has precomputed at least one shot in `candidates`. Firing uses the tank\'s one offensive action for this turn.'
    }
    if (sc.bombsEnabled && (cw.bombsRemaining ?? 0) > 0 && candidates.length > 0) {
      actionCriteria.fire_bomb =
        'The `shell.shots_available` field is greater than 0 and `me` still has bombs: a splash hit near clustered targets beats a direct shell'
    }
    if (canMove) {
      actionCriteria.move = sc.underAttack()
        ? '`threats.under_attack` is true: an unseen enemy is shooting at the tank — relocate immediately, away from where the recent shots came from'
        : 'No shot option is offered, or the tank is inside an enemy flare (`threats.in_enemy_flare` is true) and should escape the light. Moving repositions the tank.'
    }
    if (canFlare) {
      actionCriteria.fire_flare = sc.underAttack()
        ? 'No shot option is offered and `threats.under_attack` is true: a flare ring around the tank can reveal the hidden shooter closing in'
        : 'No shot option is offered and `target_hint` says the enemy position is unknown or stale: reveal darkness with a deep flare. Firing a flare uses the tank\'s one offensive action for this turn.'
    }
    actionCriteria.pass = 'Every other offered option fails its stated conditions.'

    const answers = await ask(sc.baseState(cw, candidates.length), {
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
      if (candidates.length > 0) {
        const shotState = {
          ...sc.baseState(cw, candidates.length),
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
          log.lines.push(`  shot=${shot?.type === 'choice' ? shot.choice : 'unusable'} → hold; repositioning instead`)
          // Fallback ladder: a held shot still spends the turn repositioning —
          // never a bare pass while the tank is in contact.
        } else {
          const picked = candidates.find((c) => c.key === gatedShot)
          if (!picked) {
            log.lines.push(`  shot=${gatedShot} unknown option; holding fire`)
          } else {
            log.lines.push(`  shot=${picked.key} p=${(shot.probabilities[picked.key] ?? shot.confidence).toFixed(2)}`)
            return gatedIntent === 'fire_bomb'
              ? { kind: 'fire_bomb', angle: picked.angle, power: picked.power }
              : { kind: 'fire_shell', angle: picked.angle, power: picked.power }
          }
        }
      }
    }

    if (gatedIntent === 'move' || gatedIntent === 'fire_shell' || gatedIntent === 'fire_bomb') {
      const dirCriteria: Record<string, string> = {}
      for (const info of moveInfos) dirCriteria[info.dir] = sc.describeDirection(info, target !== null, flee)
      const moveAnswers = await ask(sc.baseState(cw, candidates.length), {
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
          distance: sc.clearDistance(cw.position, fallback.dir),
        }
      }
      const dirProb = moveAnswers.direction.type === 'choice'
        ? moveAnswers.direction.probabilities[chosen] ?? moveAnswers.direction.confidence
        : 0
      log.lines.push(`  move=${chosen} x${sc.clearDistance(cw.position, chosen as Direction)} p=${dirProb.toFixed(2)}`)
      return { kind: 'move', direction: chosen as Direction, distance: sc.clearDistance(cw.position, chosen as Direction) }
    }

    if (gatedIntent === 'fire_flare') {
      // Information goal, in priority order: a remembered enemy position;
      // else the opponent's own recent flare target (their flare sits within
      // shell range of where they stood — triangulation); else, while under
      // attack, a ring around the tank itself, where the hidden shooter must
      // be converging; else the current exploration waypoint. Code picks the
      // landing range — deep, in-bounds-verified flares cover new ground; a
      // bare magnitude choice is not a judgment Jev can ground.
      const hint = sc.freshEnemyFlareHint(cw)
      const selfRing = sc.underAttack() && target === null
      const goalPosition = target !== null
        ? target.position
        : hint !== null
          ? hint.targetCell
          : selfRing
            ? cw.position
            : sc.currentWaypoint()
      const goalBearing = ((): number => {
        const dx = goalPosition.x - cw.position.x
        const dy = goalPosition.y - cw.position.y
        let a = Math.atan2(dx, -dy) * (180 / Math.PI)
        if (a < 0) a += 360
        return a
      })()
      const goalDist = Math.sqrt(
        (goalPosition.x - cw.position.x) ** 2 + (goalPosition.y - cw.position.y) ** 2,
      )
      const dirCriteria: Record<string, string> = {}
      const ranges = new Map<string, number>()
      for (const info of sc.directionInfos(cw, target, false)) {
        if (!selfRing && normalize(info.dir, goalBearing) > 90) continue
        const maxInBounds = sc.maxFlareRange(cw.position, info.dir)
        if (maxInBounds <= 0) continue
        const range = selfRing
          ? Math.min(3, maxInBounds)
          : target !== null || hint !== null
            ? Math.max(1, Math.min(maxInBounds, Math.round(goalDist)))
            : maxInBounds
        const goalPhrase = target !== null
          ? `${target.id}'s last known position`
          : hint !== null
            ? 'the cell the opponent recently lit with its own flare'
            : selfRing
              ? 'the area right around the tank, where the hidden shooter must be closing in'
              : 'the exploration corridor'
        dirCriteria[info.dir] = `${info.dir}: flare lands ${range} cells out, revealing a circle of radius ${sc.flareRadius} around ${goalPhrase}`
        ranges.set(info.dir, range)
      }
      if (Object.keys(dirCriteria).length === 0) return { kind: 'pass' }
      const flareAnswers = await ask(sc.baseState(cw, candidates.length), {
        flare_direction: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose to fire a flare. Each option places a reveal circle of radius `flare.reveal_radius` at a computed landing distance. Choose the direction that places the reveal circle where the enemy is most likely to be.',
          criteria: dirCriteria,
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
        Math.abs(normalize(b as Direction, goalBearing)) < Math.abs(normalize(a as Direction, goalBearing))
          ? b
          : a,
      )
      const rangeValue = ranges.get(chosenDir) ?? 1
      const dirProb = flareAnswers.flare_direction.type === 'choice'
        ? flareAnswers.flare_direction.probabilities[chosenDir] ?? flareAnswers.flare_direction.confidence
        : 0
      log.lines.push(`  flare=${chosenDir} r${rangeValue} p=${dirProb.toFixed(2)}${gatedDir === null ? ' (fallback)' : ''}`)
      return { kind: 'fire_flare', direction: chosenDir as Direction, range: rangeValue }
    }

    return { kind: 'pass' }
  }

  /** Bearing delta helper local to the flare goal. */
  function normalize(dir: Direction, goalBearing: number): number {
    const d = Math.abs((COMPASS.indexOf(dir) * 45) - goalBearing) % 360
    return d > 180 ? 360 - d : d
  }

  // --- Turn loop ---

  async function runTurn(
    initial: WorldView,
    executeTool: ToolExecutor | null,
  ): Promise<ToolCall[]> {
    let cw = initial
    const calls: ToolCall[] = []
    const ctx = { offensiveUsed: false }
    const log = emptyLog(client.id)
    let seq = 0

    for (let iter = 0; iter < MAX_DECISIONS_PER_TURN; iter++) {
      if (cw.remainingActions <= 0) break
      sc.decayAttack()
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
      if (tool.kind === 'fire_flare') {
        sc.noteFlareTarget(cw, tool.direction, tool.range)
      }
      cw = exec.worldview
      sc.absorb(cw)
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
      sc.absorb(worldview)
      sc.tickExploration(worldview)
      const calls = await runTurn(worldview, executeTool ?? null)
      const log = lastLog ?? emptyLog(client.id)
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
