import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { alwaysPassAgent } from '../src/match/fake-agents.js'
import type { MatchConfig } from '../src/config/schema.js'
import type { MatchLog } from '../src/types/log.js'
import { createServer } from 'node:http'

function makeConfig(overrides: Partial<MatchConfig>): MatchConfig {
  return {
    rulesVersion: 'v1',
    seed: 42,
    map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
    players: [
      { label: 'p1', startPosition: { x: 0, y: 0 } },
      { label: 'p2', startPosition: { x: 19, y: 19 } },
    ],
    fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
    actionEconomy: 'double', moveMax: 5,
    shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
    lethality: { hitsToKill: 2 },
    turnLimit: 5,
    perTurnTimeoutMs: 30000,
    maxToolCallsPerTurn: 3,
    ...overrides,
  }
}

describe('onTurnComplete hook', () => {
  it('fires on initial log before turns', async () => {
    let firstCallTurns: number | undefined
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      if (firstCallTurns === undefined) {
        firstCallTurns = log.turns.length
      }
    })
    expect(firstCallTurns).toBe(0)
  })

  it('fires after each turn', async () => {
    const callCount = { value: 0 }
    const finalTurns = { value: 0 }
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      callCount.value++
      finalTurns.value = log.turns.length
    })
    expect(callCount.value).toBeGreaterThanOrEqual(5)
    expect(finalTurns.value).toBe(5)
  })

  it('fires at completion with result', async () => {
    let lastLog: MatchLog | undefined
    const config = makeConfig({ turnLimit: 5 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      lastLog = log
    })
    expect(lastLog).toBeDefined()
    expect(lastLog!.result.terminationReason).toBe('turn-limit')
  })

  it('is not called when omitted', async () => {
    const config = makeConfig({ turnLimit: 3 })
    await expect(
      runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])
    ).resolves.toBeDefined()
  })
})

describe('HTTP serve', () => {
  let server: ReturnType<typeof createServer>
  let port: number
  let logRef: { current: MatchLog | null }

  beforeEach(() => { logRef = { current: null } })

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server = undefined
    }
  })

  function startServer(): number {
    server = createServer((req, res) => {
      if (req.url === '/match.json') {
        if (!logRef.current) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'waiting' }))
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify(logRef.current))
      } else if (req.url === '/') {
        const status = logRef.current ? 'complete' : 'running'
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        })
        res.end(JSON.stringify({
          status,
          turns: logRef.current?.turns.length ?? 0,
          matchId: logRef.current?.metadata.matchId ?? '',
        }))
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
      }
    }).listen(0)
    port = (server.address() as import('node:net').AddressInfo).port
    return port
  }

  it('serves /match.json with CORS headers', async () => {
    startServer()

    const config = makeConfig({ turnLimit: 3 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      logRef.current = log
    })

    const resp = await fetch(`http://localhost:${port}/match.json`)
    expect(resp.headers.get('access-control-allow-origin')).toBe('*')
    const data = await resp.json()
    expect(data.schemaVersion).toBe('v1')
    expect(data.turns.length).toBe(3)
  })

  it('serves / status endpoint', async () => {
    startServer()

    const config = makeConfig({ turnLimit: 3 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      logRef.current = log
    })

    const resp = await fetch(`http://localhost:${port}/`)
    expect(resp.status).toBe(200)
    const data = await resp.json()
    expect(data.status).toBe('complete')
    expect(data.turns).toBe(3)
    expect(data.matchId).toBeDefined()
  })

  it('reports running before match starts', async () => {
    startServer()

    const resp = await fetch(`http://localhost:${port}/`)
    expect(resp.status).toBe(200)
    const data = await resp.json()
    expect(data.status).toBe('running')
    expect(data.turns).toBe(0)
    expect(data.matchId).toBe('')
  })

  it('reports complete after match', async () => {
    startServer()

    const config = makeConfig({ turnLimit: 4 })
    await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')], (log) => {
      logRef.current = log
    })

    const resp = await fetch(`http://localhost:${port}/`)
    expect(resp.status).toBe(200)
    const data = await resp.json()
    expect(data.status).toBe('complete')
    expect(data.turns).toBe(4)
    expect(data.matchId).toBeDefined()
  })
})