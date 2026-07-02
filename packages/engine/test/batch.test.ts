import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBatch } from '../src/cli/batch.js'

function createRoster(players: Array<{ label: string; scripted?: 'aggressive' | 'conservative' }>): string {
  return JSON.stringify({ players })
}

describe('runBatch', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'batch-test-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('duel schedule produces correct number of matches', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    const players = [
      { label: 'alpha', scripted: 'aggressive' as const },
      { label: 'beta', scripted: 'conservative' as const },
      { label: 'gamma', scripted: 'aggressive' as const },
    ]
    writeFileSync(rosterPath, createRoster(players))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const files = readdirSync(outDir)
    const matchFiles = files.filter((f) => f.startsWith('match-') && f.endsWith('.json'))
    expect(matchFiles.length).toBe(12)
  })

  it('creates batch-manifest.json', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
      { label: 'p2', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    expect(existsSync(join(outDir, 'batch-manifest.json'))).toBe(true)

    const manifest = JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf-8'))
    expect(Array.isArray(manifest)).toBe(true)
    expect(manifest.length).toBe(4)
  })

  it('manifest entries match log file count', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
      { label: 'p2', scripted: 'conservative' as const },
      { label: 'p3', scripted: 'aggressive' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const files = readdirSync(outDir).filter((f) => f.startsWith('match-') && f.endsWith('.json'))
    const manifest = JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf-8'))

    expect(manifest.length).toBe(files.length)
  })

  it('paired runs have swapped seat assignments', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'playerA', scripted: 'aggressive' as const },
      { label: 'playerB', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '2',
    ])

    const manifest = JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf-8'))

    expect(manifest.length).toBe(4)

    expect(manifest[0].seatAssignment['0']).toBe('playerA')
    expect(manifest[0].seatAssignment['1']).toBe('playerB')
    expect(manifest[1].seatAssignment['0']).toBe('playerB')
    expect(manifest[1].seatAssignment['1']).toBe('playerA')

    expect(manifest[2].seatAssignment['0']).toBe('playerA')
    expect(manifest[2].seatAssignment['1']).toBe('playerB')
    expect(manifest[3].seatAssignment['0']).toBe('playerB')
    expect(manifest[3].seatAssignment['1']).toBe('playerA')
  })

  it('seat assignment reflects roster label in each seat', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'aggressiveBot', scripted: 'aggressive' as const },
      { label: 'conservativeBot', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '1',
    ])

    const manifest = JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf-8'))

    expect(manifest[0].seatAssignment['0']).toBe('aggressiveBot')
    expect(manifest[0].seatAssignment['1']).toBe('conservativeBot')
    expect(manifest[1].seatAssignment['0']).toBe('conservativeBot')
    expect(manifest[1].seatAssignment['1']).toBe('aggressiveBot')
  })

  it('all match logs are valid MatchLog schema', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
      { label: 'p2', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '1',
    ])

    const files = readdirSync(outDir).filter((f) => f.startsWith('match-') && f.endsWith('.json'))

    for (const file of files) {
      const log = JSON.parse(readFileSync(join(outDir, file), 'utf-8'))

      expect(log.schemaVersion).toBe('v1')
      expect(log.metadata).toBeDefined()
      expect(log.metadata.matchId).toBeDefined()
      expect(log.metadata.createdAt).toBeDefined()
      expect(log.metadata.promptVersion).toBeDefined()
      expect(log.metadata.adapterVersions).toBeDefined()
      expect(log.config).toBeDefined()
      expect(log.config.seed).toBeDefined()
      expect(log.config.map).toBeDefined()
      expect(log.config.players).toBeDefined()
      expect(log.initialState).toBeDefined()
      expect(Array.isArray(log.turns)).toBe(true)
      expect(log.result).toBeDefined()
      expect(log.result.terminationReason).toBeDefined()
      expect(Array.isArray(log.result.placements)).toBe(true)
    }
  })

  it('blitz preset has lethality.hitsToKill === 1', async () => {
    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
      { label: 'p2', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'blitz',
      '--out', outDir,
      '--seeds', '1',
    ])

    const files = readdirSync(outDir).filter((f) => f.startsWith('match-') && f.endsWith('.json'))

    for (const file of files) {
      const log = JSON.parse(readFileSync(join(outDir, file), 'utf-8'))
      expect(log.config.lethality.hitsToKill).toBe(1)
    }
  })

  it('records failure in manifest and continues processing', async () => {
    const originalRunMatch = (await import('../src/match/orchestration.js')).runMatch


    let callCount = 0
    vi.spyOn(await import('../src/match/orchestration.js'), 'runMatch').mockImplementation(async (config, agents) => {
      callCount++
      if (callCount === 2) {
        throw new Error('simulated match failure')
      }
      return originalRunMatch(config, agents)
    })

    const rosterPath = join(tmpDir, 'roster.json')
    const outDir = join(tmpDir, 'output')

    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
      { label: 'p2', scripted: 'conservative' as const },
    ]))

    await runBatch([
      '--roster', rosterPath,
      '--preset', 'duel',
      '--out', outDir,
      '--seeds', '1',
    ])

    const manifest = JSON.parse(readFileSync(join(outDir, 'batch-manifest.json'), 'utf-8'))

    expect(manifest.length).toBe(2)

    const failedEntry = manifest.find((e: { failure?: string }) => e.failure !== undefined)
    expect(failedEntry).toBeDefined()
    expect(failedEntry.failure).toContain('simulated match failure')
    expect(failedEntry.result.terminationReason).toBe('error')
    expect(failedEntry.result.placements).toEqual([])

    const successEntry = manifest.find((e: { failure?: string }) => e.failure === undefined)
    expect(successEntry).toBeDefined()
    expect(successEntry.result.placements.length).toBe(2)
  })

  it('requires --roster flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>

    try {
      await runBatch(['--preset', 'duel', '--out', tmpDir])
      expect.unreachable('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
    }
  })

  it('requires --preset flag', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    }) as unknown as ReturnType<typeof vi.spyOn>

    const rosterPath = join(tmpDir, 'roster.json')
    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
    ]))

    try {
      await runBatch(['--roster', rosterPath, '--out', tmpDir])
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

    const rosterPath = join(tmpDir, 'roster.json')
    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
    ]))

    try {
      await runBatch(['--roster', rosterPath, '--preset', 'duel'])
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

    const rosterPath = join(tmpDir, 'roster.json')
    writeFileSync(rosterPath, createRoster([
      { label: 'p1', scripted: 'aggressive' as const },
    ]))

    try {
      await runBatch(['--roster', rosterPath, '--preset', 'nonexistent', '--out', tmpDir])
      expect.unreachable('Expected process.exit to be called')
    } catch (err) {
      expect(String(err)).toContain('process.exit(1)')
    } finally {
      exitSpy.mockRestore()
    }
  })
})
