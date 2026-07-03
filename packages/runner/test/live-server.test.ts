import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { startLiveServer } from '../src/live-server.js'

describe('live spectator server', () => {
  let server: Server | undefined
  let tempDir: string | undefined

  afterEach(async () => {
    if (server) await new Promise<void>((done) => server!.close(() => done()))
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  })

  it('serves the UI and APIs from one origin without CORS', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'runner-server-'))
    mkdirSync(join(tempDir, 'assets'))
    writeFileSync(join(tempDir, 'index.html'), '<html><head></head><body></body></html>')
    writeFileSync(join(tempDir, 'assets', 'app.js'), 'export {}')

    server = startLiveServer({
      port: 0,
      staticDir: tempDir,
      getLog: () => null,
      getStatus: () => ({ status: 'running', turns: 0, matchId: '' }),
    })
    await new Promise<void>((done) => server!.once('listening', done))
    const port = (server.address() as AddressInfo).port

    const page = await fetch(`http://localhost:${port}/`)
    expect(await page.text()).toContain(
      '<meta name="scorched-live-url" content="/match.json" />',
    )

    const status = await fetch(`http://localhost:${port}/status.json`)
    expect(await status.json()).toEqual({ status: 'running', turns: 0, matchId: '' })

    const match = await fetch(`http://localhost:${port}/match.json`)
    expect(match.status).toBe(404)
    expect(match.headers.get('access-control-allow-origin')).toBeNull()
  })
})
