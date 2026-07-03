import { type MatchConfig, type PlayerSpec, parseMatchConfig } from './schema.js'

export const PRESET_NAMES = ['duel', 'blitz', 'survival'] as const
export type PresetName = typeof PRESET_NAMES[number]

export const SEED_SUITE = [42, 7, 99, 123, 256] as const

const commonFields: Partial<MatchConfig> = {
  rulesVersion: 'v1',
  fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
  shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
  perTurnTimeoutMs: 30000,
  maxToolCallsPerTurn: 3,
}

export const PRESETS: Record<string, (seed: number, players: PlayerSpec[]) => MatchConfig> = {
  duel(seed, players) {
    if (players.length !== 2) throw new Error(`Duel preset requires exactly 2 players, got ${players.length}`)
    return parseMatchConfig({
      ...commonFields,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 3 },
      actionEconomy: 'double',
      turnLimit: 50,
      seed,
      players,
    })
  },
  blitz(seed, players) {
    if (players.length !== 2) throw new Error(`Blitz preset requires exactly 2 players, got ${players.length}`)
    return parseMatchConfig({
      ...commonFields,
      map: { width: 15, height: 15, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 3 },
      actionEconomy: 'single',
      turnLimit: 30,
      lethality: { hitsToKill: 1 },
      seed,
      players,
    })
  },
  survival(seed, players) {
    if (players.length !== 4) throw new Error(`Survival preset requires exactly 4 players, got ${players.length}`)
    return parseMatchConfig({
      ...commonFields,
      map: { width: 25, height: 25, obstacleDensity: 0.12, generatorVersion: 'v1', obstacleHeight: 3 },
      fog: { localRadius: 3, flareRadius: 3, flareDuration: 'one-round-global' },
      actionEconomy: 'double',
      shell: { maxRange: 12, apexHeight: 5, tankHeight: 1 },
      turnLimit: 80,
      seed,
      players,
    })
  },
}
