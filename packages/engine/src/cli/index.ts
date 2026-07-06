import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseMatchConfig } from '../config/schema.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import type { MatchLog } from '../types/log.js'
import { runMatch } from '../match/orchestration.js'
import { createModel } from '../model/factory.js'
import { ModelBackedTankAgent } from '../model/tank-agent.js'
import { buildSystemPrompt } from '../model/system-prompt.js'
import { createAggressiveAgent, createConservativeAgent } from '../match/scripted-agents.js'
import { createStepAgent } from '../match/step-agent.js'
import { runBatch } from './batch.js'
import { runAggregate } from './aggregate.js'
import { runExhibition } from './exhibition.js'
import type { CliRunHooks } from './hooks.js'

export type { CliRunHooks, CliRunProgress } from './hooks.js'

function printMatchResult(log: MatchLog, result: MatchLog['result']): void {
  console.log(`Match complete: ${result.terminationReason}`)
  console.log(`Turns: ${log.turns.length}`)
  for (const placement of result.placements) {
    const tankIndex = log.initialState.tanks.findIndex((tank) => tank.id === placement.tankId)
    const player = tankIndex >= 0 ? log.config.players[tankIndex] : undefined
    const label = player?.label ?? placement.tankId
    const modelId = player?.model?.model
    const identity = modelId
      ? `${label} [${placement.tankId}, ${modelId}]`
      : `${label} [${placement.tankId}]`
    console.log(
      `  ${placement.rank}. ${identity} (HP: ${placement.hp}, DMG: ${placement.damageDealt})`,
    )
  }
}

export async function runCli(argv: string[], hooks: CliRunHooks = {}): Promise<void> {
  if (argv.includes('--serve')) {
    throw new Error('--serve is provided by @scorched-llm/runner, not the headless engine CLI')
  }

  if (argv[0] === 'exhibition') {
    return runExhibition(argv.slice(1))
  }

  if (argv[0] === 'batch') {
    return runBatch(argv.slice(1), hooks)
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

  mkdirSync(dirname(outPath), { recursive: true })

  const raw = readFileSync(configPath, 'utf-8')
  const config = parseMatchConfig(JSON.parse(raw))

  const agents = config.players.map((p) => {
    if (live) {
      if (p.model) {
        const model = createModel(p.model, {
          perTurnTimeoutMs: config.perTurnTimeoutMs,
        })
        const systemPrompt = buildSystemPrompt(config, p.label)
        return new ModelBackedTankAgent(p.label, model, systemPrompt, config.maxToolCallsPerTurn)
      } else       if (p.scripted) {
        if (p.scripted === 'aggressive') {
          return createAggressiveAgent(p.label)
        }
        if (p.scripted === 'conservative') {
          return createConservativeAgent(p.label)
        }
        if (p.scripted === 'step') {
          return createStepAgent(p.label)
        }
        throw new Error(`Unknown scripted type: ${p.scripted}`)
      }
    }
    return alwaysPassAgent(p.label)
  })

  const { log, result } = await runMatch(
    config,
    agents,
    hooks.onLiveLog
      ? (turnLog) => hooks.onLiveLog!(turnLog, { currentMatch: 1, totalMatches: 1 })
      : undefined,
  )

  writeFileSync(outPath, JSON.stringify(log, null, 2))

  printMatchResult(log, result)
}
