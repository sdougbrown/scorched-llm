import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMatchConfig } from '../config/schema.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import type { MatchLog } from '../types/log.js'
import { runMatch } from '../match/orchestration.js'
import { createModel } from '../model/factory.js'
import { ModelBackedTankAgent } from '../model/tank-agent.js'
import { buildSystemPrompt } from '../model/system-prompt.js'
import { createAggressiveAgent, createConservativeAgent } from '../match/scripted-agents.js'
import { runBatch } from './batch.js'
import { runAggregate } from './aggregate.js'
import { runExhibition } from './exhibition.js'

export async function runCli(argv: string[]): Promise<void> {
  if (argv[0] === 'exhibition') {
    return runExhibition(argv.slice(1))
  }

  if (argv[0] === 'batch') {
    return runBatch(argv.slice(1))
  }

  if (argv[0] === 'aggregate') {
    let outDir: string | undefined
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--out' && argv[i + 1]) {
        outDir = resolve(argv[++i])
      }
    }
    if (!outDir) {
      console.error('Error: --out is required')
      process.exit(1)
    }
    return runAggregate(outDir)
  }

  let configPath: string | undefined
  let outPath: string | undefined
  let live = false
  let servePort: number | undefined

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = resolve(argv[++i])
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = resolve(argv[++i])
    } else if (argv[i] === '--live') {
      live = true
    } else if (argv[i] === '--serve' && argv[i + 1]) {
      servePort = parseInt(argv[++i], 10)
    }
  }

  if (!configPath) {
    console.error('Error: --config is required')
    process.exit(1)
  }
  if (!outPath) {
    console.error('Error: --out is required')
    process.exit(1)
  }

  const raw = readFileSync(configPath, 'utf-8')
  const config = parseMatchConfig(JSON.parse(raw))

  const agents = config.players.map((p) => {
    if (live) {
      if (p.model) {
        const model = createModel(p.model)
        const systemPrompt = buildSystemPrompt(config, p.label)
        return new ModelBackedTankAgent(p.label, model, systemPrompt, config.maxToolCallsPerTurn)
      } else if (p.scripted) {
        if (p.scripted === 'aggressive') {
          return createAggressiveAgent(p.label)
        } else {
          return createConservativeAgent(p.label)
        }
      }
    }
    return alwaysPassAgent(p.label)
  })

  if (servePort) {
    let logRef: MatchLog | null = null
    let status: 'running' | 'complete' = 'running'

    const server = createServer((req, res) => {
      if (req.url === '/match.json') {
        if (!logRef) {
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Access-Control-Allow-Origin', '*')
          res.end(JSON.stringify({ error: 'waiting for match to start' }))
          return
        }
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(JSON.stringify(logRef))
        return
      }

      if (req.url === '/') {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.end(
          JSON.stringify({
            status,
            turns: logRef ? logRef.turns.length : 0,
            matchId: logRef ? logRef.metadata.matchId : '',
          }),
        )
        return
      }

      res.statusCode = 404
      res.end()
    })

    server.listen(servePort, '0.0.0.0', () => {
      console.log(`Live spectate: http://0.0.0.0:${servePort}/match.json`)
    })

    const httpServer = server

    const { log, result } = await runMatch(config, agents, (turnLog) => {
      logRef = structuredClone(turnLog)
    })

    writeFileSync(outPath, JSON.stringify(log, null, 2))

    status = 'complete'

    console.log(`Match complete: ${result.terminationReason}`)
    console.log(`Turns: ${log.turns.length}`)
    for (const placement of result.placements) {
      console.log(`  ${placement.rank}. ${placement.tankId} (HP: ${placement.hp}, DMG: ${placement.damageDealt})`)
    }

    const sigintHandler = () => {
      httpServer.close(() => {
        process.exit(0)
      })
    }
    process.on('SIGINT', sigintHandler)

    return
  }

  const { log, result } = await runMatch(config, agents)

  writeFileSync(outPath, JSON.stringify(log, null, 2))

  console.log(`Match complete: ${result.terminationReason}`)
  console.log(`Turns: ${log.turns.length}`)
  for (const placement of result.placements) {
    console.log(`  ${placement.rank}. ${placement.tankId} (HP: ${placement.hp}, DMG: ${placement.damageDealt})`)
  }
}
