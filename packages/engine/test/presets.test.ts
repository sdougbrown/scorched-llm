import { describe, it, expect } from 'vitest'
import { parseMatchConfig } from '../src/config/schema.js'
import { PRESETS, PRESET_NAMES, SEED_SUITE } from '../src/config/presets.js'

const playerA = { label: 'A', startPosition: { x: 0, y: 0 }, scripted: 'aggressive' as const }
const playerB = { label: 'B', startPosition: { x: 19, y: 19 }, scripted: 'conservative' as const }
const playerC = { label: 'C', startPosition: { x: 5, y: 5 }, scripted: 'aggressive' as const }
const playerD = { label: 'D', startPosition: { x: 10, y: 10 }, scripted: 'conservative' as const }

describe('PRESET_NAMES', () => {
  it('is an array of preset names', () => {
    expect(PRESET_NAMES).toEqual(['duel', 'blitz', 'survival'])
  })
})

describe('SEED_SUITE', () => {
  it('contains the expected seed values', () => {
    expect(SEED_SUITE).toEqual([42, 7, 99, 123, 256])
  })
})

describe('duel preset', () => {
  it('produces a schema-valid config', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(() => parseMatchConfig(config)).not.toThrow()
  })

  it('uses symmetric spawn placement', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.spawnStrategy).toBe('symmetric')
  })

  it('has correct map dimensions and obstacle density', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.map.width).toBe(20)
    expect(config.map.height).toBe(20)
    expect(config.map.obstacleDensity).toBe(0.1)
  })

  it('has correct lethality', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.lethality.hitsToKill).toBe(2)
  })

  it('has correct actionEconomy', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.actionEconomy).toBe('double')
  })

  it('has correct turnLimit', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.turnLimit).toBe(50)
  })

  it('has correct fog settings', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.fog.localRadius).toBe(3)
    expect(config.fog.flareRadius).toBe(2)
  })
})

describe('blitz preset', () => {
  it('produces a schema-valid config', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(() => parseMatchConfig(config)).not.toThrow()
  })

  it('has correct map dimensions and obstacle density', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(config.map.width).toBe(15)
    expect(config.map.height).toBe(15)
    expect(config.map.obstacleDensity).toBe(0.1)
  })

  it('has correct lethality', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(config.lethality.hitsToKill).toBe(1)
  })

  it('has correct actionEconomy', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(config.actionEconomy).toBe('single')
  })

  it('has correct turnLimit', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(config.turnLimit).toBe(30)
  })

  it('has correct fog settings', () => {
    const config = PRESETS.blitz(42, [playerA, playerB])
    expect(config.fog.localRadius).toBe(3)
    expect(config.fog.flareRadius).toBe(2)
  })
})

describe('survival preset', () => {
  it('produces a schema-valid config', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(() => parseMatchConfig(config)).not.toThrow()
  })

  it('has correct map dimensions and obstacle density', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.map.width).toBe(25)
    expect(config.map.height).toBe(25)
    expect(config.map.obstacleDensity).toBe(0.12)
  })

  it('has correct lethality', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.lethality.hitsToKill).toBe(2)
  })

  it('has correct actionEconomy', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.actionEconomy).toBe('double')
  })

  it('has correct turnLimit', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.turnLimit).toBe(80)
  })

  it('has correct fog settings', () => {
    const config = PRESETS.survival(42, [playerA, playerB, playerC, playerD])
    expect(config.fog.localRadius).toBe(3)
    expect(config.fog.flareRadius).toBe(3)
  })
})

describe('player count validation', () => {
  it('duel throws if players.length !== 2', () => {
    expect(() => PRESETS.duel(42, [playerA])).toThrow(/requires exactly 2 players/)
    expect(() => PRESETS.duel(42, [playerA, playerB, playerC])).toThrow(/requires exactly 2 players/)
  })

  it('blitz throws if players.length !== 2', () => {
    expect(() => PRESETS.blitz(42, [playerA])).toThrow(/requires exactly 2 players/)
    expect(() => PRESETS.blitz(42, [playerA, playerB, playerC])).toThrow(/requires exactly 2 players/)
  })

  it('survival throws if players.length !== 4', () => {
    expect(() => PRESETS.survival(42, [playerA])).toThrow(/requires exactly 4 players/)
    expect(() => PRESETS.survival(42, [playerA, playerB])).toThrow(/requires exactly 4 players/)
    expect(() => PRESETS.survival(42, [playerA, playerB, playerC])).toThrow(/requires exactly 4 players/)
  })
})

describe('seed propagation', () => {
  it('duel returns config with correct seed', () => {
    const config = PRESETS.duel(42, [playerA, playerB])
    expect(config.seed).toBe(42)
  })

  it('blitz returns config with correct seed', () => {
    const config = PRESETS.blitz(7, [playerA, playerB])
    expect(config.seed).toBe(7)
  })

  it('survival returns config with correct seed', () => {
    const config = PRESETS.survival(99, [playerA, playerB, playerC, playerD])
    expect(config.seed).toBe(99)
  })
})
