import type { WorldView } from '@scorched-llm/engine'
import type { Tool, ToolCall } from '@scorched-llm/engine'
import type { Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import type { AgentTurnResult, TankAgent, ToolExecutor } from '@scorched-llm/engine'
import { DIRECTION_DELTAS } from '@scorched-llm/engine'
import type { DecisionLog, ShotCandidate } from './jev-scaffold.js'
import { emptyLog, createJevScaffold } from './jev-scaffold.js'

/**
 * JevGreedyAgent — the ablation control for the Jev harness.
 *
 * Identical scaffold to JevAgent (same shot candidates, direction intel,
 * flare goal modes, waypoint exploration, threat tracking, turn loop) but
 * the decision layer is a deterministic greedy policy instead of Jev:
 * always fire the best available candidate, always take the
 * harness-recommended direction, always flare the harness's current
 * information goal. Where Jev judges among described options, this bot
 * just takes option one.
 *
 * Mirror-matching it against `jev` measures how much Jev's judgment
 * contributes on top of the scaffold; running it against the strong
 * scripted hunters measures the scaffold's ceiling on its own.
 */

/** Safety cap on decision rounds per turn. */
const MAX_DECISIONS_PER_TURN = 6

function isOffensive(tool: Tool): boolean {
  return tool.kind === 'fire_shell' || tool.kind === 'fire_bomb' || tool.kind === 'fire_flare'
}

export interface JevGreedyAgentOptions {
  /** Label used in traces; purely cosmetic. */
  policy?: string
}

export function createJevGreedyAgent(
  tankId: string,
  config: MatchConfig,
  _options: JevGreedyAgentOptions = {},
): TankAgent {
  const sc = createJevScaffold(tankId, config)

  /** Best candidate: the scaffold ranks visible+clear first; among equals
   * prefer a 'likely destroys' verdict, which is a code-computed label. */
  function bestCandidate(candidates: ShotCandidate[]): ShotCandidate | null {
    if (candidates.length === 0) return null
    const kill = candidates.find((c) => c.description.includes('likely destroys it'))
    return kill ?? candidates[0]
  }

  /** One greedy decision. Returns the tool to execute, or null to end. */
  function decideOnce(
    cw: WorldView,
    ctx: { offensiveUsed: boolean },
    log: DecisionLog,
  ): Tool | null {
    const candidates = ctx.offensiveUsed ? [] : sc.buildShotCandidates(cw)
    const target = sc.pickTarget(cw)
    const flee = cw.inEnemyFlare.length > 0 || (sc.underAttack() && target !== null)

    // 1. Fire at the best precomputed shot while one exists.
    if (candidates.length > 0) {
      const picked = bestCandidate(candidates)
      if (picked !== null) {
        log.lines.push(`greedy: shot=${picked.key} (${picked.description.slice(-40)})`)
        return { kind: 'fire_shell', angle: picked.angle, power: picked.power }
      }
    }

    // 2. Blind: spend the offensive on the harness's current information
    //    goal (memory target > opponent-flare hint > self ring > waypoint).
    if (target === null && !ctx.offensiveUsed) {
      const hint = sc.freshEnemyFlareHint(cw)
      const selfRing = sc.underAttack()
      const goalPosition = hint !== null
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
      const infos = sc.directionInfos(cw, null, false)
      const legal = infos.filter((i) => sc.maxFlareRange(cw.position, i.dir) > 0)
      if (legal.length > 0) {
        const chosen = selfRing
          ? legal[0]
          : legal.reduce((a, b) => {
              const da = Math.abs(a.delta)
              const db = Math.abs(b.delta)
              return db < da ? b : a
            })
        const maxInBounds = sc.maxFlareRange(cw.position, chosen.dir)
        const range = selfRing
          ? Math.min(3, maxInBounds)
          : hint !== null
            ? Math.max(1, Math.min(maxInBounds, Math.round(Math.hypot(goalPosition.x - cw.position.x, goalPosition.y - cw.position.y))))
            : maxInBounds
        log.lines.push(`greedy: flare=${chosen.dir} r${range} (blind info goal)`)
        return { kind: 'fire_flare', direction: chosen.dir, range }
      }
    }

    // 3. Reposition along the harness-recommended direction.
    const moveInfos = sc.directionInfos(cw, target, flee)
    if (moveInfos.length === 0) {
      // Fully boxed in: no direction is legal.
      log.lines.push('greedy: no legal direction (boxed in); passing')
      return null
    }
    if (moveInfos.length > 0) {
      const recommended = moveInfos.find((i) => flee && i.leavesFlare)
        ?? moveInfos.find((i) => i.delta <= 67.5)
        ?? moveInfos.reduce((a, b) => (b.delta < a.delta ? b : a))
      log.lines.push(`greedy: move=${recommended.dir} x${recommended.clear}`)
      return {
        kind: 'move',
        direction: recommended.dir,
        distance: sc.clearDistance(cw.position, recommended.dir),
      }
    }

    return null
  }

  async function runTurn(
    initial: WorldView,
    executeTool: ToolExecutor | null,
  ): Promise<ToolCall[]> {
    let cw = initial
    const calls: ToolCall[] = []
    const ctx = { offensiveUsed: false }
    const log = emptyLog('greedy')
    let seq = 0

    for (let iter = 0; iter < MAX_DECISIONS_PER_TURN; iter++) {
      if (cw.remainingActions <= 0) break
      sc.decayAttack()
      const tool = decideOnce(cw, ctx, log)
      if (!tool) break
      if (isOffensive(tool) && ctx.offensiveUsed) break
      const call: ToolCall = { id: `jev-greedy-${tankId}-T${cw.turn}-${seq++}`, tool }
      calls.push(call)

      if (executeTool === null) {
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
      if (tool.kind === 'pass') break
    }

    if (calls.length === 0) {
      calls.push({ id: `jev-greedy-${tankId}-T${initial.turn}-pass`, tool: { kind: 'pass' } })
    }
    lastLog = log
    return calls
  }

  let lastLog: DecisionLog | null = null

  return {
    name: `jev-greedy-${tankId}`,
    messages: [],
    takeTurn: async (
      worldview: WorldView,
      _tools,
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `jev-greedy-${tankId}-T${worldview.turn}-pass`, tool: { kind: 'pass' } }]
      }
      sc.absorb(worldview)
      sc.tickExploration(worldview)
      const calls = await runTurn(worldview, executeTool ?? null)
      const log = lastLog ?? emptyLog('greedy')
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
