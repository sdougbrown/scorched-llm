import { describe, it, expect } from 'vitest'
import { buildSystemPrompt, SYSTEM_PROMPT_VERSION } from '../src/model/system-prompt.js'
import type { MatchConfig } from '../src/config/schema.js'

function makeConfig(overrides: Partial<MatchConfig>): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 5, flareDuration: 'one-round-global' },
    actionEconomy: 'double',
    moveMax: 7,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 10,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

describe('SYSTEM_PROMPT_VERSION', () => {
  it('is v1', () => {
    expect(SYSTEM_PROMPT_VERSION).toBe('v1')
  })
})

describe('buildSystemPrompt', () => {
  it('contains player label', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('Alpha')
  })

  it('contains action budget for double economy', () => {
    const prompt = buildSystemPrompt(makeConfig({ actionEconomy: 'double' }), 'Alpha')
    expect(prompt).toContain('2 action')
  })

  it('contains action budget for single economy', () => {
    const prompt = buildSystemPrompt(makeConfig({ actionEconomy: 'single' }), 'Alpha')
    expect(prompt).toContain('1 action')
  })

  it('contains move max', () => {
    const prompt = buildSystemPrompt(makeConfig({ moveMax: 7 }), 'Alpha')
    expect(prompt).toContain('7')
  })

  it('contains flare radius', () => {
    const prompt = buildSystemPrompt(makeConfig({ fog: { ...makeConfig().fog, flareRadius: 8 } }), 'Alpha')
    expect(prompt).toContain('8')
  })

  it('contains HP value', () => {
    const prompt = buildSystemPrompt(makeConfig({ lethality: { hitsToKill: 2 } }), 'Alpha')
    expect(prompt).toContain('2 HP')
  })

  it('contains hitsToKill value', () => {
    const prompt = buildSystemPrompt(makeConfig({ lethality: { hitsToKill: 1 } }), 'Alpha')
    expect(prompt).toContain('1 HP')
  })

  it('contains max tool calls', () => {
    const prompt = buildSystemPrompt(makeConfig({ maxToolCallsPerTurn: 5 }), 'Alpha')
    expect(prompt).toContain('5 tool calls')
  })

  it('contains move tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('move')
    expect(prompt).toContain('direction')
    expect(prompt).toContain('distance')
  })

  it('contains fire_flare tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('fire_flare')
    expect(prompt).toContain('range')
  })

  it('contains fire_shell tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('fire_shell')
    expect(prompt).toContain('angle')
    expect(prompt).toContain('power')
  })

  it('explains shell arcs and obstacle cover', () => {
    const prompt = buildSystemPrompt(makeConfig({
      map: { ...makeConfig({}).map, obstacleHeight: 3 },
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    }), 'Alpha')
    expect(prompt).toContain('parabolic arc')
    expect(prompt).toContain('peaking at height 5')
    expect(prompt).toContain('Obstacles have height 3')
    expect(prompt).toContain('provide cover')
  })

  it('contains pass tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('pass')
  })

  it('contains look tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('look')
  })

  it('contains known_map tool description', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('known_map')
  })

  it('contains win condition and notes', () => {
    const prompt = buildSystemPrompt(makeConfig(), 'Alpha')
    expect(prompt).toContain('Passing or scanning without ever firing cannot win')
    expect(prompt).toContain('enemy')
    expect(prompt).toContain('flare expiry')
  })

  it('produces different prompts for different configs', () => {
    const prompt1 = buildSystemPrompt(makeConfig({ actionEconomy: 'single', lethality: { hitsToKill: 1 } }), 'Alpha')
    const prompt2 = buildSystemPrompt(makeConfig({ actionEconomy: 'double', lethality: { hitsToKill: 2 } }), 'Alpha')
    expect(prompt1).not.toBe(prompt2)
    expect(prompt1).toContain('1 action')
    expect(prompt2).toContain('2 action')
  })

  it('produces different prompts for different labels', () => {
    const prompt1 = buildSystemPrompt(makeConfig(), 'Alpha')
    const prompt2 = buildSystemPrompt(makeConfig(), 'Beta')
    expect(prompt1).toContain('Alpha')
    expect(prompt2).toContain('Beta')
    expect(prompt1).not.toBe(prompt2)
  })
})
