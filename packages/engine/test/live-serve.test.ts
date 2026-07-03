import { describe, it, expect } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { alwaysPassAgent } from '../src/match/fake-agents.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { MatchLog } from '../src/types/log.js'

function makeConfig(overrides: Partial<MatchConfig>): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double', moveMax: 5,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 5,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

describe('onTurnComplete hook', () => {
  it('fires on initial log before turns', async () => {
    let firstCallTurns: number | undefined
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      if (firstCallTurns === undefined) {
        firstCallTurns = log.turns.length
      }
    })
    expect(firstCallTurns).toBe(0)
  })

  it('fires after each turn', async () => {
    const callCount = { value: 0 }
    const finalTurns = { value: 0 }
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      callCount.value++
      finalTurns.value = log.turns.length
    })
    expect(callCount.value).toBeGreaterThanOrEqual(5)
    expect(finalTurns.value).toBe(5)
  })

  it('fires at completion with result', async () => {
    let lastLog: MatchLog | undefined
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      lastLog = log
    })
    expect(lastLog).toBeDefined()
    expect(lastLog!.result.terminationReason).toBe('turn-limit')
  })

  it('is not called when omitted', async () => {
    const config = makeConfig({ turnLimit: 3 })
    await expect(
      runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    ).resolves.toBeDefined()
  })
})
