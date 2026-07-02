import { describe, it, expect } from 'vitest'
import { MatchConfigSchema, parseMatchConfig, DEFAULT_MATCH_CONFIG } from '../src/config/schema.js'

describe('DEFAULT_MATCH_CONFIG', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_MATCH_CONFIG.actionEconomy).toBe('double')
    expect(DEFAULT_MATCH_CONFIG.lethality).toEqual({ hitsToKill: 2 })
  })
})

describe('parseMatchConfig', () => {
  const validRaw = {
    rulesVersion: '1.0',
    seed: 42,
    map: {
      width: 100,
      height: 50,
      obstacleDensity: 0.2,
      generatorVersion: 'v1',
      obstacleHeight: 3,
    },
    players: [
      {
        label: 'Alpha',
        startPosition: { x: 10, y: 10 },
        model: {
          name: 'test-model',
          baseURL: 'https://api.example.com',
          model: 'gpt-4',
        },
      },
      {
        label: 'Beta',
        startPosition: { x: 90, y: 40 },
        scripted: 'aggressive' as const,
      },
    ],
    fog: {
      localRadius: 5,
      flareRadius: 8,
      flareDuration: 'one-round-global',
    },
    shell: {
      maxRange: 80,
      apexHeight: 20,
      tankHeight: 1,
    },
    turnLimit: 100,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 10,
  }

  it('parses a fully specified config with hitsToKill string', () => {
    const config = parseMatchConfig({ ...validRaw, lethality: { hitsToKill: '2' } })
    expect(config.rulesVersion).toBe('1.0')
    expect(config.seed).toBe(42)
    expect(config.map.width).toBe(100)
    expect(config.players.length).toBe(2)
    expect(config.actionEconomy).toBe('double')
    expect(config.lethality).toEqual({ hitsToKill: 2 })
  })

  it('applies actionEconomy default when missing', () => {
    const config = parseMatchConfig({ ...validRaw, actionEconomy: undefined, lethality: { hitsToKill: '2' } })
    expect(config.actionEconomy).toBe('double')
  })

  it('applies lethality default when missing', () => {
    const config = parseMatchConfig({ ...validRaw, lethality: undefined })
    expect(config.lethality).toEqual({ hitsToKill: 2 })
  })

  it('applies moveMax default from fog.flareRadius when missing', () => {
    const config = parseMatchConfig({ ...validRaw, moveMax: undefined, lethality: { hitsToKill: '2' } })
    expect(config.moveMax).toBe(8)
  })

  it('preserves explicit moveMax', () => {
    const config = parseMatchConfig({ ...validRaw, moveMax: 12, lethality: { hitsToKill: '2' } })
    expect(config.moveMax).toBe(12)
  })

  it('rejects config with fewer than 2 players', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        players: [
          {
            label: 'Solo',
            startPosition: { x: 0, y: 0 },
            model: { name: 'm', baseURL: 'https://x.com', model: 'm' },
          },
        ],
      })
    ).toThrow()
  })

  it('rejects config with map width < 1', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        map: { ...validRaw.map, width: 0 },
      })
    ).toThrow()
  })

  it('rejects config with non-integer seed', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        seed: 1.5,
      })
    ).toThrow()
  })

  it('rejects player with both model and scripted', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        players: [
          {
            label: 'Bad',
            startPosition: { x: 0, y: 0 },
            model: { name: 'm', baseURL: 'https://x.com', model: 'm' },
            scripted: 'aggressive' as const,
          },
          {
            label: 'Good',
            startPosition: { x: 1, y: 1 },
            scripted: 'conservative' as const,
          },
        ],
      })
    ).toThrow()
  })

  it('rejects player with neither model nor scripted', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        players: [
          { label: 'Bad', startPosition: { x: 0, y: 0 } },
          { label: 'Good', startPosition: { x: 1, y: 1 }, scripted: 'conservative' as const },
        ],
      })
    ).toThrow()
  })

  it('rejects invalid obstacleDensity', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        map: { ...validRaw.map, obstacleDensity: 1.5 },
      })
    ).toThrow()
  })

  it('rejects invalid flareDuration', () => {
    expect(() =>
      parseMatchConfig({
        ...validRaw,
        fog: { ...validRaw.fog, flareDuration: 'forever' },
      })
    ).toThrow()
  })

  it('handles hitsToKill transform from "1" to 1', () => {
    const config = parseMatchConfig({
      ...validRaw,
      lethality: { hitsToKill: '1' },
    })
    expect(config.lethality.hitsToKill).toBe(1)
  })

  it('handles hitsToKill transform from "2" to 2', () => {
    const config = parseMatchConfig({
      ...validRaw,
      lethality: { hitsToKill: '2' },
    })
    expect(config.lethality.hitsToKill).toBe(2)
  })
})

describe('MatchConfigSchema', () => {
  it('validates a minimal valid config with defaults applied', () => {
    const raw = {
      rulesVersion: '1.0',
      seed: 1,
      map: {
        width: 10,
        height: 10,
        obstacleDensity: 0.1,
        generatorVersion: 'v1',
        obstacleHeight: 1,
      },
      players: [
        { label: 'A', startPosition: 'random', model: { name: 'm', baseURL: 'https://x.com', model: 'm' } },
        { label: 'B', startPosition: 'random', scripted: 'conservative' },
      ],
      fog: { localRadius: 3, flareRadius: 5, flareDuration: 'one-round-global' },
      shell: { maxRange: 50, apexHeight: 10, tankHeight: 1 },
      turnLimit: 50,
      perTurnTimeoutMs: 10000,
      maxToolCallsPerTurn: 5,
    }
    const config = MatchConfigSchema.parse(raw)
    expect(config.actionEconomy).toBe('double')
  })
})
