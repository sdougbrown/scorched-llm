import { describe, it, expect } from 'vitest'
import { createOpusAgent, opusOptionsFromConfig } from '../src/opus-agent.js'
import { alwaysPassAgent } from '@scorched-llm/engine'
import { runMatch } from '@scorched-llm/engine'
import { fireShell } from '@scorched-llm/engine'
import { parseMatchConfig, type MatchConfig } from '@scorched-llm/engine'
import { generateTerrain } from '@scorched-llm/engine'
import { createRng } from '@scorched-llm/engine'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { GameState, TankState } from '@scorched-llm/engine'
import type { Cell, Coordinate } from '@scorched-llm/engine'
import type { ToolExecutionResult } from '@scorched-llm/engine'

// --- Helpers ---

const DUEL_OPTS = {
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

/** Open cells within Euclidean radius 3 of `center` (mirrors local scan). */
function openScan(center: Coordinate, radius = 3): Cell[] {
  const cells: Cell[] = []
  const span = Math.ceil(radius)
  for (let dy = -span; dy <= span; dy++) {
    for (let dx = -span; dx <= span; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue
      const coord = { x: center.x + dx, y: center.y + dy }
      if (coord.x < 0 || coord.x >= 20 || coord.y < 0 || coord.y >= 20) continue
      cells.push({ coord, terrain: 'open', obstacleHeight: 0 })
    }
  }
  return cells
}

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: openScan({ x: 5, y: 5 }),
    flaredCells: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 1,
    isMyTurn: true,
    aliveEnemyCount: 1,
    visibleEnemies: [],
    ...overrides,
  }
}

function findKind(calls: ToolCall[], kind: string): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === kind)
}

/** An all-open arena config with fixed start positions. */
function openConfig(overrides: Partial<Record<string, unknown>> = {}): MatchConfig {
  return parseMatchConfig({
    rulesVersion: 'v1',
    seed: 1,
    map: { width: 20, height: 20, obstacleDensity: 0, generatorVersion: 'v1', obstacleHeight: 3 },
    players: [
      { label: 'Opus', startPosition: { x: 5, y: 6 }, scripted: 'opus' },
      { label: 'Dummy', startPosition: { x: 8, y: 6 }, scripted: 'aggressive' },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 50,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 5,
    ...overrides,
  })
}

function openState(config: MatchConfig, positions: Coordinate[]): GameState {
  const terrain = generateTerrain(config.map, createRng(config.seed))
  // Force fully open terrain so we can test shell geometry deterministically.
  for (let y = 0; y < terrain.length; y++) {
    for (let x = 0; x < terrain[y].length; x++) {
      terrain[y][x] = { coord: { x, y }, terrain: 'open', obstacleHeight: 0 }
    }
  }
  const tanks: TankState[] = positions.map((pos, i) => ({
    id: `tank-${i}`,
    position: { ...pos },
    hp: 2,
    maxHp: 2,
    alive: true,
    facing: 0,
    damageDealt: 0,
    hitsLanded: 0,
  }))
  return { turn: 1, currentPlayerIndex: 0, tanks, flares: [], terrain, rulesVersion: 'v1' }
}

// --- Tests ---

describe('OpusAgent', () => {
  it('has correct name', () => {
    expect(createOpusAgent('tank-0').name).toBe('opus-tank-0')
  })

  it('passes when it is not its turn', async () => {
    const agent = createOpusAgent('tank-0')
    const calls = (await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])) as ToolCall[]
    expect(calls).toHaveLength(1)
    expect(calls[0].tool.kind).toBe('pass')
  })

  it('computes a shell that the engine resolves as a real hit', async () => {
    // Enemy in the open, 5 cells east — pure geometry, no obstacles.
    const from = { x: 5, y: 6 }
    const enemyPos = { x: 10, y: 6 }
    const agent = createOpusAgent('tank-0', DUEL_OPTS)
    const calls = (await agent.takeTurn(
      makeWorldView({
        position: from,
        localScan: openScan(from),
        visibleEnemies: [{ id: 'tank-1', position: enemyPos, hp: 2 }],
      }),
      [],
    )) as ToolCall[]

    const shell = findKind(calls, 'fire_shell')
    expect(shell).toBeDefined()
    if (shell?.tool.kind !== 'fire_shell') throw new Error('expected shell')

    // Feed the agent's own aim back into the real engine resolver.
    const config = openConfig()
    const state = openState(config, [from, enemyPos])
    const { result } = fireShell(state, config, 'tank-0', shell.tool.angle, shell.tool.power)
    expect(result.kind).toBe('hit')
    if (result.kind === 'hit') expect(result.targetId).toBe('tank-1')
  })

  it('never idles when blind — it scouts or moves', async () => {
    const agent = createOpusAgent('tank-0', DUEL_OPTS)
    // Drive it through a stub executor so the adaptive path is exercised.
    let view = makeWorldView({ visibleEnemies: [] })
    const executor = async (call: ToolCall): Promise<ToolExecutionResult> => {
      // Reflect moves so the worldview position keeps up; never reveal an enemy.
      let position = view.position
      if (call.tool.kind === 'move') {
        const delta = { N: [0, -1], NE: [1, -1], E: [1, 0], SE: [1, 1], S: [0, 1], SW: [-1, 1], W: [-1, 0], NW: [-1, -1] }[call.tool.direction]!
        position = { x: view.position.x + delta[0] * call.tool.distance, y: view.position.y + delta[1] * call.tool.distance }
      }
      view = { ...view, position, remainingActions: Math.max(0, view.remainingActions - 1), localScan: openScan(position), visibleEnemies: [] }
      return { result: { kind: 'ok' }, worldview: view, turnEnded: view.remainingActions <= 0 }
    }
    const result = await agent.takeTurn(view, [], executor)
    const calls = Array.isArray(result) ? result : result.toolCalls
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.tool.kind !== 'pass')).toBe(true)
    // A blind turn should include scouting (flare) and/or movement.
    expect(calls.some((c) => c.tool.kind === 'fire_flare' || c.tool.kind === 'move')).toBe(true)
  })

  it('only ever issues engine-valid calls (no invalid results) across a full match', async () => {
    const config = openConfig()
    const opts = opusOptionsFromConfig(config)
    const agents = [createOpusAgent('tank-0', opts), alwaysPassAgent('tank-1')]
    const { log } = await runMatch(config, agents)
    let invalid = 0
    for (const turn of log.turns) {
      if (turn.player !== 'tank-0') continue
      for (const action of turn.actions) {
        if (action.result.kind === 'invalid') invalid++
      }
    }
    expect(invalid).toBe(0)
  })

  it('hunts down and eliminates a stationary opponent', async () => {
    const config = openConfig()
    const opts = opusOptionsFromConfig(config)
    const agents = [createOpusAgent('tank-0', opts), alwaysPassAgent('tank-1')]
    const { result } = await runMatch(config, agents)
    expect(result.terminationReason).toBe('last-standing')
    const winner = result.placements.find((p) => p.rank === 1)
    expect(winner?.tankId).toBe('tank-0')
  })

  it('is deterministic — identical starting worldview yields identical aim', async () => {
    const enemyPos = { x: 9, y: 3 }
    const from = { x: 5, y: 5 }
    const vw = makeWorldView({
      position: from,
      localScan: openScan(from),
      visibleEnemies: [{ id: 'tank-1', position: enemyPos, hp: 2 }],
    })
    const a = createOpusAgent('tank-0', DUEL_OPTS)
    const b = createOpusAgent('tank-0', DUEL_OPTS)
    const callsA = (await a.takeTurn(vw, [])) as ToolCall[]
    const callsB = (await b.takeTurn(vw, [])) as ToolCall[]
    expect(callsA).toEqual(callsB)
  })
})
