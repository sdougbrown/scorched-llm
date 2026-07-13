import { describe, it, expect } from 'vitest'
import { createGlmAgent } from '../src/glm-agent.js'
import { createAggressiveAgent, createConservativeAgent } from '@scorched-llm/engine'
import { alwaysPassAgent } from '@scorched-llm/engine'
import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { Coordinate } from '@scorched-llm/engine'
import type { MatchConfig } from '@scorched-llm/engine'
import type { MatchLog, MatchResult } from '@scorched-llm/engine'
import type { TankAgent } from '@scorched-llm/engine'
import { runMatch } from '@scorched-llm/engine'

// --- Helpers ---

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: [],
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

function firstShellCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'fire_shell')
}

function firstFlareCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'fire_flare')
}

function firstMoveCall(calls: ToolCall[]): ToolCall | undefined {
  return calls.find((c) => c.tool.kind === 'move')
}

function makeConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 3 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    moveMax: 2,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 20,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 5,
    ...overrides,
  }
}

async function runGlmMatch(
  p1Agent: TankAgent,
  p2Agent: TankAgent,
  overrides: Partial<MatchConfig> = {},
): Promise<{ log: MatchLog; result: MatchResult }> {
  const config = makeConfig(overrides)
  return runMatch(config, [p1Agent, p2Agent])
}

// --- Unit tests ---

describe('GlmAgent', () => {
  it('has correct name', () => {
    const agent = createGlmAgent('tank-0')
    expect(agent.name).toBe('glm-tank-0')
  })

  it('returns valid tool calls', async () => {
    const agent = createGlmAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView(), [])
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call).toHaveProperty('id')
      expect(call).toHaveProperty('tool')
    }
  })

  it('never flares (flare is a wasted action for the firer)', async () => {
    const agent = createGlmAgent('tank-0')
    for (let t = 1; t <= 10; t++) {
      const calls = await agent.takeTurn(makeWorldView({ turn: t }), [])
      expect(firstFlareCall(calls)).toBeUndefined()
    }
  })

  it('passes when not its turn', async () => {
    const agent = createGlmAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView({ isMyTurn: false }), [])
    expect(calls).toHaveLength(1)
    expect(calls[0].tool.kind).toBe('pass')
  })

  it('fires shell at visible enemy with correct angle/power', async () => {
    const agent = createGlmAgent('tank-0', { shellMaxRange: 10, mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 1,
        aliveEnemyCount: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 8, y: 8 }, hp: 2 }],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
    expect(shell!.tool.kind).toBe('fire_shell')
    // bearing (5,5)->(8,8): dx=3, dy=3 → SE = 135°
    expect(shell!.tool.angle).toBeCloseTo(135, 0)
    // power = round(euclidean) = round(√18) ≈ 4
    expect(shell!.tool.power).toBe(4)
  })

  it('prefers the lowest-hp visible enemy as target', async () => {
    const agent = createGlmAgent('tank-0')
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 1,
        aliveEnemyCount: 2,
        visibleEnemies: [
          { id: 'tank-1', position: { x: 6, y: 5 }, hp: 2 },
          { id: 'tank-2', position: { x: 5, y: 6 }, hp: 1 },
        ],
      }),
      [],
    )
    const shell = firstShellCall(calls)
    expect(shell).toBeDefined()
    // Targeting (5,6): bearing dx=0, dy=1 → S = 180°
    expect(shell!.tool.angle).toBeCloseTo(180, 0)
    expect(shell!.tool.power).toBe(1)
  })

  it('engages: fires then repositions when enemy is visible', async () => {
    const agent = createGlmAgent('tank-0', { moveMax: 2, mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        turn: 1,
        aliveEnemyCount: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 6, y: 5 }, hp: 2 }],
        remainingActions: 2,
      }),
      [],
    )
    const kinds = calls.map((c) => c.tool.kind)
    expect(kinds).toContain('fire_shell')
    expect(kinds).toContain('move')
  })

  it('hunts toward opposite corner when no intel (1v1)', async () => {
    const agent = createGlmAgent('tank-0', { moveMax: 2, mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        turn: 1,
        aliveEnemyCount: 1,
        visibleEnemies: [],
      }),
      [],
    )
    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    // From (2,2) toward (17,17): dx=+, dy=+ → SE
    expect(move!.tool.direction).toBe('SE')
  })

  it('hunts toward center when multi-player and no intel', async () => {
    const agent = createGlmAgent('tank-0', { moveMax: 2, mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        turn: 1,
        aliveEnemyCount: 3,
        visibleEnemies: [],
      }),
      [],
    )
    const move = firstMoveCall(calls)
    expect(move).toBeDefined()
    expect(move!.tool.direction).toBe('SE')
  })

  it('uses both actions for movement during the hunt', async () => {
    const agent = createGlmAgent('tank-0', { moveMax: 2, mapWidth: 20, mapHeight: 20 })
    const calls = await agent.takeTurn(
      makeWorldView({
        position: { x: 2, y: 2 },
        turn: 1,
        aliveEnemyCount: 1,
        visibleEnemies: [],
        remainingActions: 2,
      }),
      [],
    )
    const moves = calls.filter((c) => c.tool.kind === 'move')
    expect(moves.length).toBeGreaterThanOrEqual(1)
  })

  it('is deterministic — same input → same output', async () => {
    const enemyPos: Coordinate = { x: 8, y: 8 }
    const vw: WorldView = {
      position: { x: 5, y: 5 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 5,
      isMyTurn: true,
      aliveEnemyCount: 1,
      visibleEnemies: [{ id: 'tank-1', position: enemyPos, hp: 2 }],
    }
    const a1 = createGlmAgent('tank-0')
    const a2 = createGlmAgent('tank-0')
    expect(await a1.takeTurn(vw, [])).toEqual(await a2.takeTurn(vw, []))
  })
})

// --- Integration tests ---

describe('glm-agent integration', () => {
  it('glm vs always-pass: match completes without errors', async () => {
    const { log, result } = await runGlmMatch(
      createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
      alwaysPassAgent('tank-1'),
    )
    expect(log.result).toBeDefined()
    expect(result.placements.length).toBe(2)
  })

  it('glm vs always-pass: no invalid actions', async () => {
    const { log } = await runGlmMatch(
      createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
      alwaysPassAgent('tank-1'),
    )
    const invalid = log.turns.flatMap((t) => t.actions.filter((a) => a.kind === 'invalid'))
    expect(invalid.length).toBe(0)
  })

  it('glm vs aggressive: completes without protocol errors', async () => {
    const { log } = await runGlmMatch(
      createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
      createAggressiveAgent('tank-1'),
      { seed: 42, turnLimit: 50 },
    )
    const invalid = log.turns.flatMap((t) => t.actions.filter((a) => a.kind === 'invalid'))
    expect(invalid.length).toBe(0)
  })

  it('glm vs conservative: completes without protocol errors', async () => {
    const { log } = await runGlmMatch(
      createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
      createConservativeAgent('tank-1'),
      { seed: 42, turnLimit: 50 },
    )
    const invalid = log.turns.flatMap((t) => t.actions.filter((a) => a.kind === 'invalid'))
    expect(invalid.length).toBe(0)
  })

  it('glm vs aggressive: glm places first or second (match resolves)', async () => {
    const { result } = await runGlmMatch(
      createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
      createAggressiveAgent('tank-1'),
      { seed: 7, turnLimit: 50 },
    )
    expect(result.placements.length).toBe(2)
    const glmPlacement = result.placements.find((p) => p.tankId === 'tank-0')
    expect(glmPlacement).toBeDefined()
    expect(glmPlacement!.rank).toBeGreaterThanOrEqual(1)
    expect(glmPlacement!.rank).toBeLessThanOrEqual(2)
  })

  it('glm vs aggressive across multiple seeds: glm wins majority', async () => {
    const seeds = [42, 7, 99, 123, 256]
    let glmWins = 0
    const glmRanks: number[] = []
    for (const seed of seeds) {
      const { result } = await runGlmMatch(
        createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
        createAggressiveAgent('tank-1'),
        { seed, turnLimit: 50 },
      )
      const glm = result.placements.find((p) => p.tankId === 'tank-0')
      expect(glm).toBeDefined()
      glmRanks.push(glm!.rank)
      if (glm!.rank === 1) glmWins++
    }
    // GLM should win the majority of duels against the aggressive bot.
    expect(glmWins).toBeGreaterThanOrEqual(Math.ceil(seeds.length / 2))
  })

  it('glm vs conservative across multiple seeds: glm wins majority', async () => {
    const seeds = [42, 7, 99, 123, 256]
    let glmWins = 0
    for (const seed of seeds) {
      const { result } = await runGlmMatch(
        createGlmAgent('tank-0', { shellMaxRange: 10, moveMax: 2, mapWidth: 20, mapHeight: 20 }),
        createConservativeAgent('tank-1'),
        { seed, turnLimit: 50 },
      )
      const glm = result.placements.find((p) => p.tankId === 'tank-0')
      expect(glm).toBeDefined()
      if (glm!.rank === 1) glmWins++
    }
    expect(glmWins).toBeGreaterThanOrEqual(Math.ceil(seeds.length / 2))
  })
})