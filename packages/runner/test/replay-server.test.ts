import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { startReplayServer } from '../src/replay-server.js'

describe('replay server', () => {
  let server: Server | undefined
  let tempDir: string | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()))
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('lists match logs and opens them in the bundled viewer', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'runner-replays-'))
    const replays = join(tempDir, 'replays')
    const ui = join(tempDir, 'ui')
    mkdirSync(replays)
    mkdirSync(join(ui, 'assets'), { recursive: true })
    writeFileSync(join(ui, 'index.html'), '<html><head></head><body></body></html>')
    writeFileSync(join(ui, 'assets', 'app.js'), 'export {}')
    writeFileSync(join(replays, 'match-001.json'), JSON.stringify({
      metadata: { matchId: 'one' },
      turns: [],
      result: { placements: [] },
      initialState: { tanks: [] },
      config: { players: [] },
    }))
    writeFileSync(join(replays, 'summary.json'), '{}')

    server = startReplayServer(0, replays, ui)
    await new Promise<void>((done) => server!.once('listening', done))
    const port = (server.address() as AddressInfo).port

    const index = await fetch(`http://localhost:${port}/`)
    const indexHtml = await index.text()
    expect(indexHtml).toContain('match-001.json')
    expect(indexHtml).not.toContain('summary.json')

    const viewer = await fetch(`http://localhost:${port}/view/match-001.json`)
    expect(await viewer.text()).toContain(
      '<meta name="scorched-live-url" content="/replays/match-001.json" />',
    )

    const replay = await fetch(`http://localhost:${port}/replays/match-001.json`)
    expect((await replay.json()).metadata.matchId).toBe('one')
  })
})
