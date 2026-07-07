import { describe, it, expect } from 'vitest'
import { PRESETS } from '@scorched-llm/engine'
import type { PlayerSpec } from '@scorched-llm/engine'
import type { WorldView } from '@scorched-llm/engine'
import { runMatch } from '@scorched-llm/engine'
import {
  createAggressiveAgent,
  createConservativeAgent,
} from '@scorched-llm/engine'
import { createFableFreshAgent } from '../src/fable-fresh-agent.js'

type OpponentKind = 'aggressive' | 'conservative'

function makeOpponent(kind: OpponentKind, tankId: string) {
  return kind === 'aggressive'
    ? createAggressiveAgent(tankId)
    : createConservativeAgent(tankId)
}

async function runDuel(seed: number, opponent: OpponentKind, fableSeat: 0 | 1) {
  const names = fableSeat === 0 ? ['fable', opponent] : [opponent, 'fable']
  const players: PlayerSpec[] = names.map((name) => ({
    label: name,
    startPosition: 'random' as const,
    scripted: name === 'fable' ? ('fable' as const) : (name as OpponentKind),
  }))
  const config = PRESETS.duel(seed, players)
  const agents = names.map((name, i) =>
    name === 'fable' ? createFableFreshAgent(`tank-${i}`, config) : makeOpponent(opponent, `tank-${i}`),
  )
  const { log, result } = await runMatch(config, agents)
  return { log, result, fableTankId: `tank-${fableSeat}` }
}

describe('fable agent', () => {
  const seeds = [42, 7, 99]

  for (const opponent of ['aggressive', 'conservative'] as const) {
    for (const seed of seeds) {
      for (const seat of [0, 1] as const) {
        it(`wins the ${opponent} duel (seed ${seed}, seat ${seat})`, async () => {
          const { result, fableTankId } = await runDuel(seed, opponent, seat)
          const placement = result.placements.find((p) => p.tankId === fableTankId)
          expect(placement?.rank).toBe(1)
          expect(result.terminationReason).toBe('last-standing')
        })
      }
    }
  }

  it('never emits invalid or blocked actions across a full match', async () => {
    for (const seed of seeds) {
      const { log } = await runDuel(seed, 'aggressive', 0)
      const fableTurns = log.turns.filter((t) => t.player === 'tank-0')
      expect(fableTurns.length).toBeGreaterThan(0)
      for (const turn of fableTurns) {
        for (const action of turn.actions) {
          expect(action.kind).not.toBe('invalid')
          expect(action.result.kind).not.toBe('blocked')
          expect(action.result.kind).not.toBe('invalid')
        }
      }
    }
  })

  it('respects the one-offensive-action-per-turn rule', async () => {
    const { log } = await runDuel(42, 'conservative', 0)
    for (const turn of log.turns) {
      if (turn.player !== 'tank-0') continue
      const offensive = turn.actions.filter(
        (a) => a.call.tool.kind === 'fire_shell' || a.call.tool.kind === 'fire_flare',
      )
      expect(offensive.length).toBeLessThanOrEqual(1)
    }
  })

  it('passes when it is not its turn', async () => {
    const agent = createFableFreshAgent('tank-0')
    const worldview: WorldView = {
      position: { x: 5, y: 5 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      activeFlares: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 3,
      isMyTurn: false,
      aliveEnemyCount: 1,
      visibleEnemies: [],
    }
    const calls = await agent.takeTurn(worldview, [])
    expect(Array.isArray(calls)).toBe(true)
    expect((calls as Array<{ tool: { kind: string } }>)[0]?.tool.kind).toBe('pass')
  })

  it('works without a config (falls back to duel defaults)', async () => {
    const players: PlayerSpec[] = [
      { label: 'fable', startPosition: 'random', scripted: 'fable-fresh' },
      { label: 'aggressive', startPosition: 'random', scripted: 'aggressive' },
    ]
    const config = PRESETS.duel(42, players)
    const agents = [createFableFreshAgent('tank-0'), createAggressiveAgent('tank-1')]
    const { result } = await runMatch(config, agents)
    const placement = result.placements.find((p) => p.tankId === 'tank-0')
    expect(placement?.rank).toBe(1)
  })

  it('holds its own in the survival preset', async () => {
    const names = ['fable', 'aggressive', 'conservative', 'aggressive']
    const players: PlayerSpec[] = names.map((name) => ({
      label: name,
      startPosition: 'random' as const,
      scripted: name as 'fable' | 'aggressive' | 'conservative',
    }))
    const config = PRESETS.survival(42, players)
    const agents = names.map((name, i) =>
      name === 'fable'
        ? createFableFreshAgent(`tank-${i}`, config)
        : makeOpponent(name as OpponentKind, `tank-${i}`),
    )
    const { result } = await runMatch(config, agents)
    const placement = result.placements.find((p) => p.tankId === 'tank-0')
    expect(placement?.rank).toBeLessThanOrEqual(2)
  })
})
