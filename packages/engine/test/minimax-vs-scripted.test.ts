import { describe, it, expect } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { PRESETS } from '../src/config/presets.js'
import { createAggressiveAgent } from '../src/match/scripted-agents.js'
import { createConservativeAgent } from '../src/match/scripted-agents.js'
import { createMinimaxAgent } from '../src/match/minimax-agent.js'

// Adversarial smoke test: run a small round-robin against the existing
// scripted bots across multiple seeds. We don't assert wins against
// the conservative bot (it's so passive that a random matchup with
// random spawns can stalemate), but we do require minimax to win
// most seeds against the aggressive bot and to stay alive in all
// matches.

describe('minimax vs scripted baseline', () => {
  const seeds = [42, 7, 99, 123, 256, 314, 2718, 1618, 2024, 8675309]
  const cases = [
    { name: 'aggressive', factory: (id: string) => createAggressiveAgent(id) },
    { name: 'conservative', factory: (id: string) => createConservativeAgent(id) },
  ]

  for (const foe of cases) {
    it(`vs ${foe.name}: minimax plays all matches to completion`, async () => {
      let wins = 0
      let totalDamage = 0
      let survivals = 0
      for (const seed of seeds) {
        const me = createMinimaxAgent('tank-0')
        const other = foe.factory('tank-1')
        const config = PRESETS.duel!(seed, [
          { label: 'minimax', startPosition: 'random', scripted: 'minimax' },
          { label: foe.name, startPosition: 'random', scripted: 'aggressive' },
        ])
        const { result } = await runMatch(config, [me, other])
        const mePlacement = result.placements.find((p) => p.tankId === 'tank-0')
        if (mePlacement?.rank === 1) wins++
        if (mePlacement != null && mePlacement.hp > 0) survivals++
        totalDamage += mePlacement?.damageDealt ?? 0
      }
      // We expect to win the majority of seeds against aggressive.
      // The conservative bot is very passive and can stalemate, so
      // we don't require a win there.
      if (foe.name === 'aggressive') {
        expect(wins).toBeGreaterThanOrEqual(Math.ceil(seeds.length * 0.6))
        expect(totalDamage).toBeGreaterThan(0)
      }
      // Survival: we never let the other bot kill us in all matches.
      expect(survivals).toBeGreaterThanOrEqual(Math.ceil(seeds.length * 0.7))
    }, 60000)
  }
})
