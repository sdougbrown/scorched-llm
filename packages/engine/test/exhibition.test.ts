import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runExhibition } from '../src/cli/exhibition.js'
import type { MatchLog } from '../src/types/log.js'

function assertLog(log: MatchLog): void {
  expect(log.schemaVersion).toBe('v1')
  expect(log.metadata.matchId).toBeDefined()
  expect(log.metadata.createdAt).toBeDefined()
  expect(log.config).toBeDefined()
  expect(log.initialState).toBeDefined()
  expect(Array.isArray(log.turns)).toBe(true)
  expect(log.result).toBeDefined()
  expect(log.result.terminationReason).toBeDefined()
  expect(Array.isArray(log.result.placements)).toBe(true)
}

describe('runExhibition', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'exhibition-test-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('produces match logs for duel preset with 2 seeds', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const files = readdirSync(outDir)
    const matchFiles = files.filter((f) => f.startsWith('match-') && f.endsWith('.json'))
    expect(matchFiles.length).toBe(4)
  })

  it('creates batch-manifest.json', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    expect(existsSync(join(outDir, 'batch-manifest.json'))).toBe(true)
  })

  it('creates summary.json', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    expect(existsSync(join(outDir, 'summary.json'))).toBe(true)
  })

  it('creates exhibition-info.json with required fields', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    expect(existsSync(join(outDir, 'exhibition-info.json'))).toBe(true)

    const info = JSON.parse(readFileSync(join(outDir, 'exhibition-info.json'), 'utf-8'))

    expect(info.type).toBe('scripted')
    expect(info.preset).toBe('duel')
    expect(info.rulesVersion).toBe('v1')
    expect(info.generatorVersion).toBe('v1')
    expect(info.promptVersion).toBe('v4')
    expect(info.engineVersion).toBeDefined()
    expect(info.timestamp).toBeDefined()
    expect(Array.isArray(info.seedSuite)).toBe(true)
    expect(info.seedSuite.length).toBe(20)
    expect(Array.isArray(info.seedsUsed)).toBe(true)
    expect(info.seedsUsed.length).toBe(2)
    expect(Array.isArray(info.roster)).toBe(true)
    expect(info.roster.length).toBe(2)
    expect(info.totalMatches).toBe(4)
    expect(info.completedMatches).toBe(4)
  })

  it('exhibition-info.json lists all required version fields', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const info = JSON.parse(readFileSync(join(outDir, 'exhibition-info.json'), 'utf-8'))

    // Verify all required fields for exhibition artifacts
    const requiredFields = ['type', 'preset', 'rulesVersion', 'generatorVersion', 'promptVersion', 'engineVersion', 'timestamp', 'seedSuite', 'seedsUsed', 'roster', 'totalMatches', 'completedMatches', 'adapterVersions']
    for (const field of requiredFields) {
      expect(info).toHaveProperty(field)
    }
  })

  it('all match logs are schema-valid (reduce to final state matches)', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const files = readdirSync(outDir).filter((f) => f.startsWith('match-') && f.endsWith('.json'))

    for (const file of files) {
      const log = JSON.parse(readFileSync(join(outDir, file), 'utf-8'))
      assertLog(log)
    }
  })

  it('summary reconciliation passes', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const summary = JSON.parse(readFileSync(join(outDir, 'summary.json'), 'utf-8'))

    expect(summary.reconciliation.matchCountMatches).toBe(true)
    expect(summary.reconciliation.damageMatches).toBe(true)
    expect(summary.reconciliation.hitsMatches).toBe(true)
  })

  it('survival preset produces correct roster size', async () => {
    const outDir = join(tmpDir, 'output')

    await runExhibition([
      '--preset', 'survival',
      '--out', outDir,
      '--seeds', '1',
    ])

    const info = JSON.parse(readFileSync(join(outDir, 'exhibition-info.json'), 'utf-8'))
    expect(info.roster.length).toBe(4)
    expect(info.type).toBe('scripted')
  })

  it('requires --preset flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>

    try {
      await runExhibition(['--out', tmpDir])
      expect.unreachable('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('requires --out flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>

    try {
      await runExhibition(['--preset', 'duel'])
      expect.unreachable('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('rejects unknown preset', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>

    try {
      await runExhibition(['--preset', 'nonexistent', '--out', tmpDir])
      expect.unreachable('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
    }
  })
})
