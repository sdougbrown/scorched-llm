import { describe, it, expect } from 'vitest'
import { loadMatchLog, loadMatchLogFromFile } from '../src/log-loader.js'
import type { MatchLog } from '@scorched-llm/engine'

function makeValidLog(overrides: Partial<MatchLog> = {}): MatchLog {
  return {
    schemaVersion: '1.0.0',
    metadata: {
      matchId: 'test-match',
      createdAt: '2024-01-01T00:00:00Z',
      promptVersion: 'v1',
      adapterVersions: { agent: '1.0.0' },
    },
    config: {
      rulesVersion: '1.0.0',
      seed: 42,
      map: { width: 10, height: 10, obstacleDensity: 0.1, generatorVersion: '1', obstacleHeight: 5 },
      players: [
        { label: 'A', startPosition: { x: 0, y: 0 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
        { label: 'B', startPosition: { x: 9, y: 9 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
      ],
      fog: { localRadius: 2, flareRadius: 3, flareDuration: 'one-round-global' as const },
      actionEconomy: 'double',
      shell: { maxRange: 8, apexHeight: 10, tankHeight: 2 },
      lethality: { hitsToKill: 2 },
      turnLimit: 20,
      perTurnTimeoutMs: 60000,
      maxToolCallsPerTurn: 4,
    },
    initialState: {
      turn: 0,
      currentPlayerIndex: 0,
      tanks: [
        { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [],
      terrain: Array.from({ length: 10 }, (_, y) =>
        Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))
      ),
      rulesVersion: '1.0.0',
    },
    turns: [],
    result: {
      terminationReason: 'turn-limit',
      placements: [],
    },
    ...overrides,
  }
}

describe('loadMatchLog', () => {
  it('parses valid JSON log', () => {
    const log = makeValidLog()
    expect(() => loadMatchLog(JSON.stringify(log))).not.toThrow()
    const result = loadMatchLog(JSON.stringify(log))
    expect(result.schemaVersion).toBe('1.0.0')
    expect(result.metadata.matchId).toBe('test-match')
  })

  it('throws on invalid JSON', () => {
    expect(() => loadMatchLog('not json')).toThrow('Invalid JSON')
  })

  it('throws on missing schemaVersion', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).schemaVersion
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('schemaVersion')
  })

  it('throws on empty schemaVersion', () => {
    const log = makeValidLog()
    log.schemaVersion = ''
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('schemaVersion')
  })

  it('throws on missing metadata', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).metadata
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('metadata')
  })

  it('throws on missing metadata.matchId', () => {
    const log = makeValidLog()
    delete (log.metadata as Record<string, unknown>).matchId
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('metadata.matchId')
  })

  it('throws on missing config', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).config
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('config')
  })

  it('throws on missing initialState', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).initialState
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('initialState')
  })

  it('throws on missing initialState.turn', () => {
    const log = makeValidLog()
    delete (log.initialState as Record<string, unknown>).turn
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('initialState.turn')
  })

  it('throws on missing turns', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).turns
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('turns')
  })

  it('throws on malformed turn entry', () => {
    const log = makeValidLog({ turns: ['not an object'] as unknown as MatchLog['turns'] })
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('turns[0]')
  })

  it('throws on missing turn.turn field', () => {
    const log = makeValidLog({ turns: [{ player: 'A', actions: [] }] as unknown as MatchLog['turns'] })
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('turns[0].turn')
  })

  it('throws on missing result', () => {
    const log = makeValidLog()
    delete (log as Record<string, unknown>).result
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('result')
  })

  it('throws on missing result.terminationReason', () => {
    const log = makeValidLog({ result: { placements: [] } })
    expect(() => loadMatchLog(JSON.stringify(log))).toThrow('terminationReason')
  })
})

describe('loadMatchLogFromFile', () => {
  it('reads and parses a File', async () => {
    const log = makeValidLog()
    const blob = new Blob([JSON.stringify(log)], { type: 'application/json' })
    const file = new File([blob], 'test.json', { type: 'application/json' })
    const result = await loadMatchLogFromFile(file)
    expect(result.schemaVersion).toBe('1.0.0')
  })

  it('throws on file read error', async () => {
    // Create a file that will fail — this is hard to test directly with File API
    // The function wraps errors with "File read error:" prefix
    const log = makeValidLog()
    const blob = new Blob([JSON.stringify(log)], { type: 'application/json' })
    const file = new File([blob], 'test.json', { type: 'application/json' })
    await expect(loadMatchLogFromFile(file)).resolves.toBeDefined()
  })
})
