import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseMatchConfig } from '../config/schema.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import type { MatchLog } from '../types/log.js'
import { runMatch } from '../match/orchestration.js'
import { createModel } from '../model/factory.js'
import { ModelBackedTankAgent } from '../model/tank-agent.js'
import { buildSystemPrompt } from '../model/system-prompt.js'
import { createFableAgent } from '../match/fable-agent.js'
import { createGlmAgent } from '../match/glm-agent.js'
import { createQwen27BAgent } from '../match/qwen-agent.js'
import { createAggressiveAgent, createConservativeAgent, createDeepSeekAgent } from '../match/scripted-agents.js'
import { createHaikuAgent } from '../match/haiku-agent.js'
import { createSonnetAgent } from '../match/sonnet-agent.js'
import { createOpusAgent, opusOptionsFromConfig } from '../match/opus-agent.js'
import { createGpt54Agent } from '../match/gpt-5.4-agent.js'
import { createGpt55Agent } from '../match/gpt-5.5-agent.js'
import { createGeminiAgent } from '../match/gemini-agent.js'
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
      } else if (p.scripted) {
        if (p.scripted === 'aggressive') {
          return createAggressiveAgent(p.label)
        } else if (p.scripted === 'fable') {
          return createFableAgent(p.label, config)
        } else if (p.scripted === 'glm') {
          return createGlmAgent(p.label, {
            shellMaxRange: config.shell.maxRange,
            moveMax: config.moveMax ?? config.fog.flareRadius,
            mapWidth: config.map.width,
            mapHeight: config.map.height,
          })
        } else if (p.scripted === 'deepseek') {
          return createDeepSeekAgent(p.label)
        } else if (p.scripted === 'qwen-27b') {
          return createQwen27BAgent(p.label)
        } else if (p.scripted === 'haiku') {
          return createHaikuAgent(p.label)
        } else if (p.scripted === 'sonnet') {
          return createSonnetAgent(p.label, config)
        } else if (p.scripted === 'opus') {
          return createOpusAgent(p.label, opusOptionsFromConfig(config))
        } else if (p.scripted === 'gpt-5.4') {
          return createGpt54Agent(p.label, {
            shellMaxRange: config.shell.maxRange,
            moveMax: config.moveMax ?? config.fog.flareRadius,
            flareMaxRange: config.fog.flareRadius,
            flareRadius: config.fog.flareRadius,
          })
        } else if (p.scripted === 'gpt-5.5') {
          return createGpt55Agent(p.label)
        } else if (p.scripted === 'gemini') {
          return createGeminiAgent(p.label)
        } else {
          return createConservativeAgent(p.label)
        }
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
