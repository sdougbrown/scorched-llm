import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseMatchConfig } from '../config/schema.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import { runMatch } from '../match/orchestration.js'
import { createModel } from '../model/factory.js'
import { ModelBackedTankAgent } from '../model/tank-agent.js'
import { buildSystemPrompt } from '../model/system-prompt.js'
import { createAggressiveAgent, createConservativeAgent } from '../match/scripted-agents.js'
import { runBatch } from './batch.js'
import { runAggregate } from './aggregate.js'

export async function runCli(argv: string[]): Promise<void> {
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

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) {
      configPath = resolve(argv[++i])
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outPath = resolve(argv[++i])
    } else if (argv[i] === '--live') {
      live = true
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

  const { log, result } = await runMatch(config, agents)

  writeFileSync(outPath, JSON.stringify(log, null, 2))

  console.log(`Match complete: ${result.terminationReason}`)
  console.log(`Turns: ${log.turns.length}`)
  for (const placement of result.placements) {
    console.log(`  ${placement.rank}. ${placement.tankId} (HP: ${placement.hp}, DMG: ${placement.damageDealt})`)
  }
}
