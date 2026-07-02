import { describe, it, expect } from 'vitest'
import { createAggressiveAgent, createConservativeAgent } from '../src/match/scripted-agents.js'
import { alwaysPassAgent } from '../src/index.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { MatchLog } from '../src/types/log.js'
import type { TankAgent } from '../src/match/fake-agents.js'
import { runMatch } from '../src/match/orchestration.js'

// --- Helpers ---

function makeConfig(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    moveMax: 5,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 20,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

function assertLog(log: MatchLog): void {
  expect(log.schemaVersion).toBe('v1')
  expect(log.metadata.matchId).toBeDefined()
  expect(log.metadata.createdAt).toBeDefined()
  expect(log.config).toBeDefined()
  expect(log.initialState).toBeDefined()
  expect(Array.isArray(log.turns)).toBe(true)
  expect(log.result).toBeDefined()
  expect(log.result.terminationReason).toBeDefined()
  expect(Array.isArray(log.result.placements)).toBe(true)
}

async function runScriptedMatch(
  p1Agent: TankAgent,
  p2Agent: TankAgent,
  overrides: Partial<MatchConfig> = {},
): Promise<{ log: MatchLog; result: import('../src/types/log.js').MatchResult }> {
  const config = makeConfig(overrides)
  return runMatch(config, [p1Agent, p2Agent])
}

// --- Fixtures ---

interface Fixture {
  name: string
  config: Partial<MatchConfig>
  expectedTermination?: string[]
}

const FIXTURES: Fixture[] = [
  {
    name: 'small-map-10-turns',
    config: { map: { width: 10, height: 10, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 }, turnLimit: 10 },
  },
  {
    name: 'medium-map-20-turns',
    config: { map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 }, turnLimit: 20 },
  },
  {
    name: 'large-map-30-turns',
    config: { map: { width: 30, height: 30, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 }, turnLimit: 30 },
  },
  {
    name: 'single-economy',
    config: { actionEconomy: 'single', turnLimit: 10 },
  },
  {
    name: 'lethal-1-hit',
    config: { lethality: { hitsToKill: 1 }, turnLimit: 20 },
  },
]

// --- Integration tests ---

describe('scripted-agent integration', () => {
  for (const fixture of FIXTURES) {
    it(`fixed seed: ${fixture.name}`, async () => {
      const { log, result } = await runScriptedMatch(
        createAggressiveAgent('tank-0'),
        createConservativeAgent('tank-1'),
        fixture.config,
      )

      // Schema validation
      assertLog(log)

      // Termination reason is valid
      if (fixture.expectedTermination) {
        expect(fixture.expectedTermination).toContain(result.terminationReason)
      }

      // Both tanks appear in placements
      expect(result.placements.length).toBe(2)

      // Turns were produced
      expect(log.turns.length).toBeGreaterThan(0)
    })

    it(`scripted agents finish without protocol errors: ${fixture.name}`, async () => {
      const { log } = await runScriptedMatch(
        createAggressiveAgent('tank-0'),
        createConservativeAgent('tank-1'),
        fixture.config,
      )

      // Every action should have a valid kind
      for (const turn of log.turns) {
        for (const action of turn.actions) {
          expect(['move', 'flare', 'shell', 'pass', 'invalid', 'observation']).toContain(action.kind)
          expect(action.call).toHaveProperty('id')
          expect(action.call).toHaveProperty('tool')
          expect(action.result).toHaveProperty('kind')
        }
      }
    })
  }

  it('aggressive vs always-pass: match completes without errors', async () => {
    const { log, result } = await runScriptedMatch(
      createAggressiveAgent('tank-0'),
      alwaysPassAgent('tank-1'),
      { lethality: { hitsToKill: 1 } },
    )
    // Schema validation
    assertLog(log)
    // Match completes (either turn-limit or last-standing)
    expect(['turn-limit', 'last-standing', 'mutual-destruction']).toContain(result.terminationReason)
    // Both tanks in placements
    expect(result.placements.length).toBe(2)
  })

  it('aggressive vs always-pass: both scripted and always-pass finish without errors', async () => {
    const { log } = await runScriptedMatch(
      createAggressiveAgent('tank-0'),
      alwaysPassAgent('tank-1'),
      { map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 }, turnLimit: 20 },
    )
    // No invalid actions (protocol errors)
    const invalidActions = log.turns.flatMap((t) => t.actions.filter((a) => a.kind === 'invalid'))
    expect(invalidActions.length).toBe(0)
  })

  it('conservative vs always-pass: conservative survives short match', async () => {
    const { result } = await runScriptedMatch(
      createConservativeAgent('tank-0'),
      alwaysPassAgent('tank-1'),
      { turnLimit: 5 },
    )
    // Conservative tank should at least survive
    const consRank = result.placements.find((p) => p.tankId === 'tank-0')
    expect(consRank).toBeDefined()
    expect(consRank!.hp).toBeGreaterThan(0)
  })

  it('aggressive vs conservative: both finish without errors', async () => {
    for (let i = 0; i < 3; i++) {
      const { log } = await runScriptedMatch(
        createAggressiveAgent('tank-0'),
        createConservativeAgent('tank-1'),
        { seed: 42 + i, map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 }, turnLimit: 15 },
      )
      // No invalid actions (protocol errors)
      const invalidActions = log.turns.flatMap((t) => t.actions.filter((a) => a.kind === 'invalid'))
      expect(invalidActions.length).toBe(0)
    }
  })
})
