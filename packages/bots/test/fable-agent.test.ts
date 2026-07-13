import { describe, it, expect } from 'vitest'
import { createFableAgent } from '../src/fable-agent.js'
import { createAggressiveAgent, createConservativeAgent } from '@scorched-llm/engine'
import { alwaysPassAgent } from '@scorched-llm/engine'
import { PRESETS, SEED_SUITE } from '@scorched-llm/engine'
import type { MatchConfig, PlayerSpec } from '@scorched-llm/engine'
import type { MatchLog } from '@scorched-llm/engine'
import type { TankAgent } from '@scorched-llm/engine'
import { runMatch } from '@scorched-llm/engine'

const BENCH_SEEDS = SEED_SUITE.slice(0, 5)

type ScriptedKind = 'aggressive' | 'conservative' | 'fable'

function duelConfig(seed: number, kinds: [ScriptedKind, ScriptedKind]): MatchConfig {
  const players: PlayerSpec[] = kinds.map((kind, i) => ({
    label: `${kind}-${i}`,
    startPosition: 'random' as const,
    scripted: kind,
  }))
  return PRESETS.duel(seed, players)
}

function makeAgent(kind: ScriptedKind, tankId: string, config: MatchConfig): TankAgent {
  if (kind === 'fable') return createFableAgent(tankId, config)
  if (kind === 'aggressive') return createAggressiveAgent(tankId)
  return createConservativeAgent(tankId)
}

async function runDuel(
  seed: number,
  kinds: [ScriptedKind, ScriptedKind],
): Promise<{ log: MatchLog; result: MatchLog['result'] }> {
  const config = duelConfig(seed, kinds)
  const agents = kinds.map((kind, i) => makeAgent(kind, `tank-${i}`, config))
  return runMatch(config, agents)
}

function invalidActionsBy(log: MatchLog, tankId: string): number {
  return log.turns
    .filter((t) => t.player === tankId)
    .flatMap((t) => t.actions)
    .filter((a) => a.kind === 'invalid')
    .length
}

function rankOf(result: MatchLog['result'], tankId: string): number {
  const placement = result.placements.find((p) => p.tankId === tankId)
  expect(placement).toBeDefined()
  return placement!.rank
}

describe('fable agent', () => {
  it('hunts down a silent, hiding always-pass opponent', async () => {
    const config: MatchConfig = {
      ...duelConfig(42, ['fable', 'fable']),
      map: { width: 14, height: 14, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 3 },
    }
    const agents = [
      createFableAgent('tank-0', config),
      alwaysPassAgent('tank-1'),
    ]
    const { result } = await runMatch(config, agents)
    expect(result.terminationReason).toBe('last-standing')
    expect(rankOf(result, 'tank-0')).toBe(1)
  })

  for (const opponent of ['aggressive', 'conservative'] as const) {
    it(`beats ${opponent} across the seed suite in both seats without protocol errors`, async () => {
      let wins = 0
      let matches = 0
      for (const seed of BENCH_SEEDS) {
        for (const fableSeat of [0, 1]) {
          const kinds: [ScriptedKind, ScriptedKind] = fableSeat === 0
            ? ['fable', opponent]
            : [opponent, 'fable']
          const fableTank = `tank-${fableSeat}`
          const { log, result } = await runDuel(seed, kinds)

          matches++
          expect(invalidActionsBy(log, fableTank)).toBe(0)
          // Fable must never lose to a baseline bot
          expect(rankOf(result, fableTank)).toBe(1)
          if (result.terminationReason === 'last-standing') wins++
        }
      }
      // Draws are tolerated only as a small minority
      expect(wins).toBeGreaterThanOrEqual(Math.ceil(matches * 0.7))
    })
  }

  it('is deterministic: same seed and seats produce the same log', async () => {
    const a = await runDuel(99, ['fable', 'aggressive'])
    const b = await runDuel(99, ['fable', 'aggressive'])
    const stripVolatile = (log: MatchLog): unknown => ({
      turns: log.turns.map((t) => ({ ...t, actions: t.actions })),
      result: log.result,
    })
    expect(stripVolatile(a.log)).toEqual(stripVolatile(b.log))
  })
})
