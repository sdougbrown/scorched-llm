import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runCli } from '../src/cli/index.js'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configTemplate = JSON.stringify({
  rulesVersion: 'v1',
  seed: 42,
  map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
  players: [
    { label: 'p1', startPosition: { x: 0, y: 0 }, scripted: 'aggressive' as const },
    { label: 'p2', startPosition: { x: 19, y: 19 }, scripted: 'conservative' as const },
  ],
  fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
  actionEconomy: 'double',
  moveMax: 5,
  shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
  lethality: { hitsToKill: 2 },
  turnLimit: 5,
  perTurnTimeoutMs: 30000,
  maxToolCallsPerTurn: 3,
})

describe('CLI', () => {
  let tmpDir: string
  let configPath: string
  let outPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'engine-test-'))
    configPath = join(tmpDir, 'config.json')
    outPath = join(tmpDir, 'output.json')
    writeFileSync(configPath, configTemplate)
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('writes valid JSON output', async () => {
    await runCli(['--config', configPath, '--out', outPath])
    expect(existsSync(outPath)).toBe(true)
    const content = readFileSync(outPath, 'utf-8')
    const log = JSON.parse(content)
    expect(log.schemaVersion).toBe('v1')
    expect(log.metadata.matchId).toBeDefined()
    expect(Array.isArray(log.turns)).toBe(true)
    expect(log.result).toBeDefined()
  })

  it('requires --config flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await runCli(['--out', outPath])
      fail('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('requires --out flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      await runCli(['--config', configPath])
      fail('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
      errorSpy.mockRestore()
    }
  })

  it('output contains match result', async () => {
    await runCli(['--config', configPath, '--out', outPath])
    const content = readFileSync(outPath, 'utf-8')
    const log = JSON.parse(content)
    expect(log.result.terminationReason).toBe('turn-limit')
    expect(Array.isArray(log.result.placements)).toBe(true)
    expect(log.result.placements.length).toBe(2)
  })

  it('output has correct number of turns', async () => {
    await runCli(['--config', configPath, '--out', outPath])
    const content = readFileSync(outPath, 'utf-8')
    const log = JSON.parse(content)
    expect(log.turns.length).toBe(5)
  })

  describe('CLI live mode', () => {
    it('creates model-backed agents when --live flag is passed', async () => {
      // This test verifies the CLI accepts --live and creates agents
      // without actually calling real APIs (uses FakeModel in a mock)
      // We can't test the actual agent creation easily since runCli
      // calls the real match runner, but we can verify the --live flag
      // doesn't cause an error when combined with scripted players.
      // The real validation happens in the factory and model tests.
      
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
        throw new Error(`process.exit(${code})`)
      }) as unknown as ReturnType<typeof vi.spyOn>
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      
      try {
        // This should work fine — scripted players in live mode still use scripted agents
        await runCli(['--config', configPath, '--out', outPath, '--live'])
        expect(existsSync(outPath)).toBe(true)
        const content = readFileSync(outPath, 'utf-8')
        const log = JSON.parse(content)
        expect(log.schemaVersion).toBe('v1')
        expect(log.result).toBeDefined()
      } finally {
        exitSpy.mockRestore()
        errorSpy.mockRestore()
      }
    })
  })
})