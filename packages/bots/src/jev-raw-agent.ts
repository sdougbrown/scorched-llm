import type { WorldView } from '@scorched-llm/engine'
import type { Tool, ToolCall } from '@scorched-llm/engine'
import type { Coordinate, Direction } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import type { AgentTurnResult, TankAgent, ToolExecutor } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, inBounds } from '@scorched-llm/engine'
import type { DecisionAnswer, DecisionClient, DecisionQuestion } from './jev-client.js'
import { TypeSafeDecisionClient } from './jev-client.js'

/**
 * JevRawAgent — the descaffolded ablation twin of JevAgent.
 *
 * Same model, same decision-client interface, same turn loop — but every
 * tactical crutch removed. No precomputed shot candidates, no computed
 * verdict labels, no waypoint exploration, no fallback ladder, no
 * probability-margin gating. Fire resolution is fully recursive and Jev
 * does the aiming judgment itself: sector, then sub-angle refinement
 * within the sector, then shell power as a bare legal-value choice.
 * Movement and flare options carry no tactical descriptions. The only
 * scaffolding kept is what any LLM entrant also gets: legal-value
 * filtering (tool-schema validation) and computed state facts.
 *
 * Mirror-matching this against JevAgent measures how much of that tank's
 * play is harness versus model judgment.
 */

const COMPASS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

const SECTOR_EDGES: Array<{ low: number; center: number; high: number }> = COMPASS.map(
  (_, i) => ({
    low: i * 45 - 22.5,
    center: i * 45,
    high: i * 45 + 22.5,
  }),
)

/** Safety cap on decision rounds per turn. */
const MAX_DECISIONS_PER_TURN = 6

interface EnemySighting {
  position: Coordinate
  hp: number
  lastSeenTurn: number
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

export interface JevRawAgentOptions {
  client?: DecisionClient
  model?: string
  apiKey?: string
}

function cellKey(c: Coordinate): string {
  return `${c.x},${c.y}`
}

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

function isOffensive(tool: Tool): boolean {
  return tool.kind === 'fire_shell' || tool.kind === 'fire_bomb' || tool.kind === 'fire_flare'
}

export function createJevRawAgent(
  tankId: string,
  config: MatchConfig,
  options: JevRawAgentOptions = {},
): TankAgent {
  const client: DecisionClient = options.client ?? new TypeSafeDecisionClient({
    model: options.model,
    apiKey: options.apiKey,
  })

  const mapWidth = config.map.width
  const mapHeight = config.map.height
  const shellMaxRange = config.shell.maxRange
  const moveMax = Math.max(1, Math.floor(config.moveMax ?? config.fog.flareRadius))
  const flareRadius = config.fog.flareRadius
  const bombsEnabled = config.bomb != null

  const enemyMemory = new Map<string, EnemySighting>()

  function absorb(cw: WorldView): void {
    for (const enemy of cw.visibleEnemies ?? []) {
      enemyMemory.set(enemy.id, {
        position: { ...enemy.position },
        hp: enemy.hp,
        lastSeenTurn: cw.turn,
      })
    }
  }

  function baseState(cw: WorldView): Record<string, unknown> {
    return {
      me: {
        position: cw.position,
        hp: cw.hp,
        actions_left: cw.remainingActions,
        turn: cw.turn,
      },
      shell: { max_range: shellMaxRange },
      move: { max_distance: moveMax },
      flare: { reveal_radius: flareRadius },
      visible_enemies: [...enemyMemory.entries()]
        .filter(([, s]) => s.lastSeenTurn === cw.turn)
        .map(([id, s]) => ({ id, position: s.position, hp: s.hp })),
      memory: [...enemyMemory.entries()]
        .filter(([, s]) => s.lastSeenTurn < cw.turn)
        .map(([id, s]) => ({
          id,
          last_position: s.position,
          turns_since_seen: cw.turn - s.lastSeenTurn,
        })),
      in_enemy_flare: cw.inEnemyFlare.length > 0,
    }
  }

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

  /** Legality check only — an answer must be one of the offered options. */
  function validChoice(answer: DecisionAnswer | undefined, offered: Set<string>): string | null {
    if (answer?.type !== 'choice') return null
    return offered.has(answer.choice) ? answer.choice : null
  }

  async function decideOnce(cw: WorldView, log: DecisionLog): Promise<Tool | null> {
    const ask = makeAsk(log)
    const state = baseState(cw)

    // Stage 1: intent. Criteria reference state facts, no tactical verdicts.
    const actionCriteria: Record<string, string> = {
      fire_shell: 'An entry in `visible_enemies` or `memory` gives a position to aim at',
      move: 'Change the tank position',
      fire_flare: 'Reveal cells: a flare lands `flare_range` cells away and reveals a circle of radius `flare.reveal_radius`',
      pass: 'End the turn without acting',
    }
    if (bombsEnabled && (cw.bombsRemaining ?? 0) > 0) {
      actionCriteria.fire_bomb =
        'Like fire_shell, but the bomb explodes with splash damage around its impact cell'
    }
    const answers = await ask(state, {
      intent: {
        type: 'choice',
        instructions:
          'You are the tank in `me` in a fog-of-war tank duel. `visible_enemies` lists enemies you can see right now; `memory` lists where enemies were last seen when out of sight. Each turn the tank takes at most one offensive action (shell, bomb, or flare) plus optional moves. Choose the single best action for this turn.',
        criteria: actionCriteria,
      },
    })
    const intent = answers.intent
    if (intent?.type !== 'choice') return null
    const choice = intent.choice
    log.lines.push(`T${cw.turn}: intent=${choice} p=${(intent.probabilities[choice] ?? intent.confidence).toFixed(2)}`)
    if (choice === 'pass' || !Object.keys(actionCriteria).includes(choice)) {
      return { kind: 'pass' }
    }

    const dirOptions = new Set(COMPASS)
    const neutralDirection = (q: string, instructions: string) => ask(state, {
      [q]: {
        type: 'choice',
        instructions,
        criteria: Object.fromEntries(COMPASS.map((d) => [d, `aim or travel due ${d} of the tank in \`me\``])),
      },
    })

    if (choice === 'fire_shell' || choice === 'fire_bomb') {
      // Recursive aim resolution: sector, then sub-angle, then power.
      const dirAnswers = await neutralDirection(
        'sector',
        'You are the tank in `me`. You chose to fire. Choose the rough compass sector to aim the barrel. The shell travels in a straight line from the tank along the chosen bearing.',
      )
      const sector = validChoice(dirAnswers.sector, dirOptions)
      if (sector === null) {
        log.lines.push('  sector: unusable answer; passing')
        return { kind: 'pass' }
      }
      const edges = SECTOR_EDGES[COMPASS.indexOf(sector as Direction)]
      const subOptions = new Set(['low', 'center', 'high'])
      const subAnswers = await ask(state, {
        refine: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose to fire toward ' +
            sector +
            '. Refine the bearing within that sector: the shell can travel along the counter-clockwise edge of the sector, the exact middle, or the clockwise edge.',
          criteria: {
            low: `counter-clockwise edge of the ${sector} sector (bearing ${normalizeAngle(edges.low)} degrees)`,
            center: `exact middle of the ${sector} sector (bearing ${edges.center} degrees)`,
            high: `clockwise edge of the ${sector} sector (bearing ${normalizeAngle(edges.high)} degrees)`,
          },
        },
      })
      const sub = validChoice(subAnswers.refine, subOptions) as 'low' | 'center' | 'high' | null
      if (sub === null) {
        log.lines.push('  refine: unusable answer; passing')
        return { kind: 'pass' }
      }
      const angle = normalizeAngle(edges[sub])
      const powerOptions = new Set(Array.from({ length: shellMaxRange }, (_, i) => String(i + 1)))
      const powerAnswers = await ask(state, {
        power: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You aimed the shell along a bearing. Choose how far the shell travels before landing: the impact cell is that many cells away from the tank along the bearing. Choose the distance that puts the impact on the target.',
          criteria: Object.fromEntries(
            [...powerOptions].map((p) => [p, `the shell lands ${p} cell${p === '1' ? '' : 's'} away from the tank along the aim bearing`]),
          ),
        },
      })
      const power = validChoice(powerAnswers.power, powerOptions)
      if (power === null) {
        log.lines.push('  power: unusable answer; passing')
        return { kind: 'pass' }
      }
      log.lines.push(`  shell angle=${angle} power=${power}`)
      return choice === 'fire_bomb'
        ? { kind: 'fire_bomb', angle, power: Number(power) }
        : { kind: 'fire_shell', angle, power: Number(power) }
    }

    if (choice === 'move') {
      const dirAnswers = await neutralDirection(
        'direction',
        'You are the tank in `me`. You chose to move. Choose the compass direction to travel. The tank moves in a straight line.',
      )
      const direction = validChoice(dirAnswers.direction, dirOptions)
      if (direction === null) {
        log.lines.push('  move: unusable direction answer; passing')
        return { kind: 'pass' }
      }
      const distOptions = new Set(Array.from({ length: moveMax }, (_, i) => String(i + 1)))
      const distAnswers = await ask(state, {
        distance: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose a travel direction. Choose how many cells the tank travels along it.',
          criteria: Object.fromEntries(
            [...distOptions].map((d) => [d, `travel ${d} cell${d === '1' ? '' : 's'} along the chosen direction`]),
          ),
        },
      })
      const distance = validChoice(distAnswers.distance, distOptions)
      if (distance === null) {
        log.lines.push('  move: unusable distance answer; passing')
        return { kind: 'pass' }
      }
      log.lines.push(`  move=${direction} x${distance}`)
      return { kind: 'move', direction: direction as Direction, distance: Number(distance) }
    }

    if (choice === 'fire_flare') {
      const dirAnswers = await neutralDirection(
        'flare_direction',
        'You are the tank in `me`. You chose to fire a flare. Choose the compass direction the flare travels.',
      )
      const direction = validChoice(dirAnswers.flare_direction, dirOptions)
      if (direction === null) {
        log.lines.push('  flare: unusable direction answer; passing')
        return { kind: 'pass' }
      }
      const delta = DIRECTION_DELTAS[direction as Direction]
      const legalRanges: string[] = []
      for (let r = 1; r <= shellMaxRange; r++) {
        const cell: Coordinate = {
          x: cw.position.x + delta.dx * r,
          y: cw.position.y + delta.dy * r,
        }
        if (inBounds(cell, mapWidth, mapHeight)) legalRanges.push(String(r))
      }
      if (legalRanges.length === 0) return { kind: 'pass' }
      const rangeAnswers = await ask(state, {
        flare_range: {
          type: 'choice',
          instructions:
            'You are the tank in `me`. You chose a flare direction. Choose how many cells away the flare lands; it reveals a circle of radius `flare.reveal_radius` around the landing cell.',
          criteria: Object.fromEntries(
            legalRanges.map((r) => [r, `the flare lands ${r} cell${r === '1' ? '' : 's'} away from the tank`]),
          ),
        },
      })
      const range = validChoice(rangeAnswers.flare_range, new Set(legalRanges))
      if (range === null) {
        log.lines.push('  flare: unusable range answer; passing')
        return { kind: 'pass' }
      }
      log.lines.push(`  flare=${direction} r${range}`)
      return { kind: 'fire_flare', direction: direction as Direction, range: Number(range) }
    }

    return { kind: 'pass' }
  }

  async function runTurn(
    initial: WorldView,
    executeTool: ToolExecutor | null,
  ): Promise<ToolCall[]> {
    let cw = initial
    const calls: ToolCall[] = []
    const log: DecisionLog = { lines: [], tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, model: client.id }
    let seq = 0

    for (let iter = 0; iter < MAX_DECISIONS_PER_TURN; iter++) {
      if (cw.remainingActions <= 0) break
      const tool = await decideOnce(cw, log)
      if (!tool) break
      if (isOffensive(tool) && calls.some((c) => isOffensive(c.tool))) break
      const call: ToolCall = { id: `jev-raw-${tankId}-T${cw.turn}-${seq++}`, tool }
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
        cw = { ...cw, remainingActions: cw.remainingActions - 1 }
        continue
      }

      const exec = await executeTool(call)
      cw = exec.worldview
      absorb(cw)
      log.lines.push(`  -> ${exec.result.kind}`)
      if (exec.turnEnded) break
      if (tool.kind === 'pass') break
    }

    if (calls.length === 0) {
      calls.push({ id: `jev-raw-${tankId}-T${initial.turn}-pass`, tool: { kind: 'pass' } })
    }
    lastLog = log
    return calls
  }

  let lastLog: DecisionLog | null = null

  return {
    name: `jev-raw-${tankId}`,
    messages: [],
    takeTurn: async (
      worldview: WorldView,
      _tools,
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      if (!worldview.isMyTurn) {
        return [{ id: `jev-raw-${tankId}-T${worldview.turn}-pass`, tool: { kind: 'pass' } }]
      }
      absorb(worldview)
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
