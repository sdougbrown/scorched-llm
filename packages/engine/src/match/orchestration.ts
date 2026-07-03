import type { GameState, TankState } from '../types/state.js'
import type { ToolCall, ActionEvent, ActionResult } from '../types/tool.js'
import type { MatchConfig } from '../config/schema.js'
import type { MatchLog, MatchResult, MatchCheckpoint } from '../types/log.js'
import type { TankAgent, ToolSpec } from './fake-agents.js'
import type { Rng } from '../rng/rng.js'
import type { TurnConditions } from '../rules/turn-rules.js'
import type { Cell } from '../types/coords.js'

import { generateTerrain } from '../terrain/generate.js'
import { createRng } from '../rng/rng.js'
import { expireFlares } from '../resolution/flare.js'
import { move } from '../resolution/movement.js'
import { fireFlare } from '../resolution/flare.js'
import { fireShell } from '../resolution/shell.js'
import { applyDamage } from '../resolution/damage.js'
import { buildWorldView } from '../worldview/build.js'
import { computeMatchResult } from '../result/ranking.js'
import { createTurnRules } from '../rules/turn-rules.js'
import { ok, invalid as invalidResult } from '../action-result/index.js'

export interface MatchRunner {
  state: GameState
  turnCursor: number
  playerCursor: number
  remainingActions: number
  remainingMoveBudget: number
  invalidStreak: number
  rng: Rng
  agentMemory: Record<string, unknown>
  accounting: Record<string, { tokensIn: number; tokensOut: number; costUsd: number | 'unknown' }>
  log: MatchLog
  actionEvents: ActionEvent[]
}

function deepCloneGameState(state: GameState): GameState {
  return {
    ...state,
    tanks: state.tanks.map((t) => ({ ...t, position: { ...t.position } })),
    flares: state.flares.map((f) => ({ ...f, targetCell: { ...f.targetCell } })),
    terrain: state.terrain.map((row) =>
      row.map((cell) => ({ ...cell, coord: { ...cell.coord } })),
    ),
  }
}

function createInitialGameState(config: MatchConfig, rng: Rng): GameState {
  const terrain = generateTerrain(config.map, rng)
  const { width, height } = config.map

  const occupied = new Set<string>()
  const tanks: TankState[] = config.players.map((player, i) => {
    let position: { x: number; y: number } = { x: 0, y: 0 }
    if (player.startPosition === 'random') {
      let attempts = 0
      let placed = false
      while (attempts < 200) {
        const x = rng.int(0, width - 1)
        const y = rng.int(0, height - 1)
        const key = `${x},${y}`
        if (terrain[y][x].terrain === 'open' && !occupied.has(key)) {
          position = { x, y }
          occupied.add(key)
          placed = true
          break
        }
        attempts++
      }
      if (!placed) {
        position = { x: Math.min(i, width - 1), y: Math.min(i, height - 1) }
      }
    } else {
      position = { ...player.startPosition }
      occupied.add(`${position.x},${position.y}`)
    }

    const maxHp = config.lethality.hitsToKill === 2 ? 2 : 1
    return {
      id: `tank-${i}`,
      position,
      hp: maxHp,
      maxHp,
      alive: true,
      facing: 0,
      damageDealt: 0,
      hitsLanded: 0,
    }
  })

  return {
    turn: 0,
    currentPlayerIndex: 0,
    tanks,
    flares: [],
    terrain,
    rulesVersion: config.rulesVersion,
  }
}

function getActionBudget(config: MatchConfig): number {
  return config.actionEconomy === 'double' ? 2 : 1
}

function getMoveBudget(config: MatchConfig): number {
  return config.moveMax ?? config.fog.flareRadius
}

function getAliveCount(state: GameState): number {
  return state.tanks.filter((t) => t.alive).length
}

function checkTermination(
  state: GameState,
  config: MatchConfig,
  turnCursor: number,
): MatchResult | null {
  const aliveCount = getAliveCount(state)
  if (aliveCount === 0) {
    return computeMatchResult(state, config, turnCursor)
  }
  if (aliveCount === 1) {
    return computeMatchResult(state, config, turnCursor)
  }
  if (turnCursor >= config.turnLimit) {
    return computeMatchResult(state, config, turnCursor)
  }
  return null
}

const TOOLS: ToolSpec[] = [
  {
    name: 'move',
    description: 'Move the tank in a direction',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] },
        distance: { type: 'integer', minimum: 1 },
      },
      required: ['direction', 'distance'],
      additionalProperties: false,
    },
  },
  {
    name: 'fire_flare',
    description: 'Fire a flare to reveal terrain',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] },
        range: { type: 'integer', minimum: 1 },
      },
      required: ['direction', 'range'],
      additionalProperties: false,
    },
  },
  {
    name: 'fire_shell',
    description: 'Fire a shell at an angle and power',
    parameters: {
      type: 'object',
      properties: {
        angle: { type: 'number', minimum: 0, exclusiveMaximum: 360 },
        power: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['angle', 'power'],
      additionalProperties: false,
    },
  },
  {
    name: 'pass',
    description: 'Pass the turn',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'look',
    description: 'Look at the current position',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'known_map',
    description: 'View known map data',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
]

interface TankKnowledge {
  knownCells?: Record<string, Cell>
}

function updateKnowledge(runner: MatchRunner, tankId: string, worldview: ReturnType<typeof buildWorldView>): Cell[] {
  const memory = (runner.agentMemory[tankId] ?? {}) as TankKnowledge
  const knownCells = memory.knownCells ?? {}
  for (const cell of worldview.localScan) {
    knownCells[`${cell.coord.x},${cell.coord.y}`] = cell
  }
  for (const visible of worldview.flaredCells) {
    knownCells[`${visible.cell.coord.x},${visible.cell.coord.y}`] = visible.cell
  }
  memory.knownCells = knownCells
  runner.agentMemory[tankId] = memory
  return Object.values(knownCells).sort(
    (a, b) => a.coord.y - b.coord.y || a.coord.x - b.coord.x,
  )
}

function buildUmpireFields(toolCall: ToolCall): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const tool = toolCall.tool

  switch (tool.kind) {
    case 'move':
      fields.move1 = { direction: tool.direction, distance: tool.distance }
      break
    case 'fire_flare':
      fields.flare = { direction: tool.direction, range: tool.range }
      break
    case 'fire_shell':
      fields.shell = { angle: tool.angle, power: tool.power }
      break
    case 'pass':
      fields.pass = true
      break
    case 'look':
    case 'known_map':
      break
  }
  return fields
}

function isFieldEnabled(
  umpireFields: Record<string, unknown>,
  conditions: TurnConditions,
  config: MatchConfig,
): boolean {
  const umpire = createTurnRules(config.actionEconomy)
  const availability = umpire.check(umpireFields, conditions)

  for (const [key, value] of Object.entries(umpireFields)) {
    if (value == null) continue
    if (key === 'pass') continue
    const fieldKey = key as keyof typeof availability
    if (!availability[fieldKey]?.enabled) {
      return false
    }
  }
  return true
}

function resolveAction(
  state: GameState,
  config: MatchConfig,
  tankId: string,
  toolCall: ToolCall,
  remainingMoveBudget: number,
): {
  newState: GameState
  result: ActionResult
  moveCost: number
} {
  const tool = toolCall.tool
  let result: ActionResult
  let newState: GameState = state
  let moveCost = 0

  switch (tool.kind) {
    case 'move': {
      const moveResult = move(
        state,
        config,
        tankId,
        tool.direction,
        tool.distance,
        remainingMoveBudget,
      )
      newState = moveResult.newState
      result = moveResult.result
      moveCost = moveResult.moveCost
      break
    }

    case 'fire_flare': {
      const flareResult = fireFlare(state, config, tankId, tool.direction, tool.range)
      newState = flareResult.newState
      result = flareResult.result
      break
    }

    case 'fire_shell': {
      const shellResult = fireShell(state, config, tankId, tool.angle, tool.power)
      newState = shellResult.newState
      result = shellResult.result
      if (result.kind === 'hit') {
        const damageResult = applyDamage(newState, result.targetId, tankId, result.damage)
        newState = damageResult.newState
      }
      break
    }

    case 'pass':
    case 'look':
    case 'known_map':
      result = ok()
      break

    default:
      result = invalidResult('Unknown tool kind')
  }

  return { newState, result, moveCost }
}

function getActionKind(toolCall: ToolCall): 'move' | 'flare' | 'shell' | 'pass' | 'invalid' | 'observation' {
  switch (toolCall.tool.kind) {
    case 'move':
      return 'move'
    case 'fire_flare':
      return 'flare'
    case 'fire_shell':
      return 'shell'
    case 'look':
    case 'known_map':
      return 'observation'
    default:
      return 'pass'
  }
}

function createRunner(
  config: MatchConfig,
  state: GameState,
  rng: Rng,
  log: MatchLog,
): MatchRunner {
  return {
    state,
    turnCursor: 0,
    playerCursor: 0,
    remainingActions: getActionBudget(config),
    remainingMoveBudget: getMoveBudget(config),
    invalidStreak: 0,
    rng,
    agentMemory: Object.fromEntries(
      state.tanks.map((t) => [t.id, {}]),
    ),
    accounting: Object.fromEntries(
      state.tanks.map((t) => [t.id, { tokensIn: 0, tokensOut: 0, costUsd: 0 }]),
    ),
    log,
    actionEvents: [],
  }
}

export function createCheckpoint(runner: MatchRunner): MatchCheckpoint {
  return {
    engineState: runner.state,
    turnCursor: runner.turnCursor,
    playerCursor: runner.playerCursor,
    remainingActions: runner.remainingActions,
    remainingMoveBudget: runner.remainingMoveBudget,
    invalidStreak: runner.invalidStreak,
    rngState: runner.rng.state(),
    pendingRetries: [],
    accounting: runner.accounting,
    agentMemory: runner.agentMemory,
  }
}

export function restoreFromCheckpoint(
  checkpoint: MatchCheckpoint,
  config: MatchConfig,
  _agents: TankAgent[],
): MatchRunner {
  const rng = createRng(0)
  rng.restore(checkpoint.rngState)

  const log: MatchLog = {
    schemaVersion: 'v1',
    metadata: {
      matchId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      promptVersion: 'v1',
      adapterVersions: {},
    },
    config,
    initialState: checkpoint.engineState,
    turns: [],
    result: { terminationReason: 'turn-limit', placements: [] },
  }

  return {
    state: checkpoint.engineState,
    turnCursor: checkpoint.turnCursor,
    playerCursor: checkpoint.playerCursor,
    remainingActions: checkpoint.remainingActions,
    remainingMoveBudget: checkpoint.remainingMoveBudget,
    invalidStreak: checkpoint.invalidStreak,
    rng,
    agentMemory: checkpoint.agentMemory,
    accounting: checkpoint.accounting,
    log,
    actionEvents: [],
  }
}

export async function runMatch(
  config: MatchConfig,
  agents: TankAgent[],
  onTurnComplete?: (log: MatchLog) => void,
): Promise<{ log: MatchLog; result: MatchResult }> {
  if (agents.length !== config.players.length) {
    throw new Error(
      `Agent count (${agents.length}) does not match player count (${config.players.length})`,
    )
  }

  const rng = createRng(config.seed)
  const state = createInitialGameState(config, rng)
  const playerCount = config.players.length

  const log: MatchLog = {
    schemaVersion: 'v1',
    metadata: {
      matchId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      promptVersion: 'v1',
      adapterVersions: {},
    },
    config,
    initialState: deepCloneGameState(state),
    turns: [],
    result: { terminationReason: 'turn-limit', placements: [] },
  }

  const runner = createRunner(config, state, rng, log)

  onTurnComplete?.(log)

  while (runner.turnCursor < config.turnLimit) {
    runner.state = expireFlares(runner.state, runner.turnCursor)

    const aliveCount = getAliveCount(runner.state)
    if (aliveCount <= 1) break

    let alivePlayerIndex = -1
    for (let i = 0; i < playerCount; i++) {
      const idx = (runner.playerCursor + i) % playerCount
      if (runner.state.tanks[idx]?.alive) {
        alivePlayerIndex = idx
        break
      }
    }

    if (alivePlayerIndex === -1) break

    runner.playerCursor = alivePlayerIndex
    const currentTank = runner.state.tanks[runner.playerCursor]

    runner.remainingActions = getActionBudget(config)
    runner.remainingMoveBudget = getMoveBudget(config)
    runner.invalidStreak = 0

    runner.turnCursor++
    runner.state.turn = runner.turnCursor
    runner.state.currentPlayerIndex = runner.playerCursor

    const worldview = buildWorldView(
      runner.state,
      config,
      currentTank.id,
      runner.remainingActions,
    )
    updateKnowledge(runner, currentTank.id, worldview)

    const turnActions: ActionEvent[] = []
    let matchTermination: MatchResult | null = null
    let executedCallCount = 0

    const executeTool = async (call: ToolCall) => {
      if (
        executedCallCount >= config.maxToolCallsPerTurn ||
        runner.remainingActions <= 0 ||
        matchTermination != null
      ) {
        const currentWorldview = buildWorldView(
          runner.state,
          config,
          currentTank.id,
          runner.remainingActions,
        )
        return {
          result: invalidResult('Turn has ended or tool call limit reached'),
          worldview: currentWorldview,
          turnEnded: true,
        }
      }
      executedCallCount++

      const conditions: TurnConditions = {
        remainingActions: runner.remainingActions,
        moveBudgetRemaining: runner.remainingMoveBudget,
        invalidStreak: runner.invalidStreak,
        isDoubleMode: config.actionEconomy === 'double',
      }

      const umpireFields = buildUmpireFields(call)
      const isValid = isFieldEnabled(umpireFields, conditions, config)

      if (!isValid) {
        const result = invalidResult('Umpire validation failed')
        turnActions.push({
          kind: 'invalid',
          call,
          result,
          snapshot: deepCloneGameState(runner.state),
        })
        runner.invalidStreak++
        const currentWorldview = buildWorldView(
          runner.state,
          config,
          currentTank.id,
          runner.remainingActions,
        )
        return {
          result,
          worldview: currentWorldview,
          turnEnded: runner.invalidStreak >= 3,
        }
      }

      const { newState, result, moveCost } = resolveAction(
        runner.state,
        config,
        currentTank.id,
        call,
        runner.remainingMoveBudget,
      )

      runner.state = newState
      const kind = getActionKind(call)
      turnActions.push({
        kind,
        call,
        result,
        snapshot: deepCloneGameState(runner.state),
      })

      const isObservation = kind === 'observation'
      const isBlocked = result.kind === 'blocked'

      if (isObservation) {
        runner.invalidStreak = 0
      } else if (isBlocked) {
        runner.invalidStreak++
      } else {
        if (kind === 'move' && result.kind === 'ok') {
          runner.remainingMoveBudget -= moveCost
        }
        runner.remainingActions--
        runner.invalidStreak = 0
      }

      matchTermination = checkTermination(runner.state, config, runner.turnCursor)
      const currentWorldview = buildWorldView(
        runner.state,
        config,
        currentTank.id,
        runner.remainingActions,
      )
      const knownMap = updateKnowledge(runner, currentTank.id, currentWorldview)
      const turnEnded =
        matchTermination != null ||
        runner.remainingActions <= 0 ||
        runner.invalidStreak >= 3 ||
        executedCallCount >= config.maxToolCallsPerTurn

      return {
        result,
        worldview: currentWorldview,
        ...(call.tool.kind === 'known_map' ? { knownMap } : {}),
        turnEnded,
      }
    }

    const agentResult = await agents[runner.playerCursor].takeTurn(worldview, TOOLS, executeTool)
    const isStructuredResult = !Array.isArray(agentResult)
    const toolCalls = isStructuredResult ? agentResult.toolCalls : agentResult

    // Legacy/scripted agents return calls for the engine to execute. Model-backed
    // agents execute incrementally through the callback above.
    if (!isStructuredResult || !agentResult.executed) {
      for (const call of toolCalls.slice(0, config.maxToolCallsPerTurn)) {
        const execution = await executeTool(call)
        if (execution.turnEnded) break
      }
    }

    if (matchTermination != null) {
      log.turns.push({
        turn: runner.turnCursor,
        player: currentTank.id,
        actions: turnActions,
        worldview,
        ...(isStructuredResult && agentResult.modelTrace != null
          ? { modelTrace: agentResult.modelTrace }
          : {}),
      })
      log.result = matchTermination
      onTurnComplete?.(log)
      return { log, result: matchTermination }
    }

    log.turns.push({
      turn: runner.turnCursor,
      player: currentTank.id,
      actions: turnActions,
      worldview,
      ...(isStructuredResult && agentResult.modelTrace != null
        ? { modelTrace: agentResult.modelTrace }
        : {}),
    })

    onTurnComplete?.(log)

    runner.playerCursor = (runner.playerCursor + 1) % playerCount

    const termination = checkTermination(runner.state, config, runner.turnCursor)
    if (termination) {
      log.result = termination
      return { log, result: termination }
    }
  }

  const result = computeMatchResult(runner.state, config, runner.turnCursor)
  log.result = result

  onTurnComplete?.(log)

  return { log, result }
}
