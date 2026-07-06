import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { type PlayerSpec } from '../config/schema.js'
import { DEFAULT_SEED_COUNT, PRESETS, SEED_SUITE, type PresetName } from '../config/presets.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import { createFableAgent } from '../match/fable-agent.js'
import { createGlmAgent } from '../match/glm-agent.js'
import { createQwen27BAgent } from '../match/qwen-agent.js'
import { createAggressiveAgent, createConservativeAgent, createDeepSeekAgent } from '../match/scripted-agents.js'
import { createAggressiveAgent, createConservativeAgent } from '../match/scripted-agents.js'
import { createHaikuAgent } from '../match/haiku-agent.js'
import { runMatch } from '../match/orchestration.js'
import { createModel } from '../model/factory.js'
import { ModelBackedTankAgent } from '../model/tank-agent.js'
import { buildSystemPrompt } from '../model/system-prompt.js'
import type { CliRunHooks } from './hooks.js'

interface RosterPlayer {
  label: string
  scripted?: 'aggressive' | 'conservative' | 'fable' | 'glm' | 'deepseek' | 'qwen-27b' | 'haiku'
  model?: {
    name: string
    baseURL: string
    protocol?: 'openai-chat' | 'openai-responses' | 'anthropic-messages'
    apiKeyEnv?: string
    model: string
    headers?: Record<string, string>
    extraBody?: Record<string, unknown>
    parameters?: Record<string, unknown>
    pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number }
  }
}

function writeManifestCheckpoint(outDir: string, manifest: BatchEntry[]): void {
  const manifestPath = `${outDir}/batch-manifest.json`
  const temporaryPath = `${manifestPath}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2))
  renameSync(temporaryPath, manifestPath)
}

interface RosterFile {
  players: RosterPlayer[]
}

interface BatchEntry {
  matchId: number
  preset: string
  seed: number
  seatAssignment: Record<number, string>
  firstTurnSeat: number
  result: {
    terminationReason: string
    placements: Array<{
      tankId: string
      rank: number
      hp: number
      damageDealt: number
      hitsLanded: number
      tieGroup?: string
      label: string
    }>
  }
  failure?: string
}

interface ScheduledMatch {
  preset: PresetName
  seed: number
  players: RosterPlayer[]
}

function getUnorderedPairs<T>(arr: T[]): T[][] {
  const pairs: T[][] = []
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      pairs.push([arr[i], arr[j]])
    }
  }
  return pairs
}

function getCombinations<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [first, ...rest] = arr
  const withFirst = getCombinations(rest, k - 1).map((c) => [first, ...c])
  const withoutFirst = getCombinations(rest, k)
  return [...withFirst, ...withoutFirst]
}

function rosterToPlayerSpec(player: RosterPlayer): PlayerSpec {
  const base = {
    label: player.label,
    startPosition: 'random' as const,
  }
  if (player.scripted) {
    return { ...base, scripted: player.scripted }
  }
  if (player.model) {
    return { ...base, model: player.model }
  }
  throw new Error(`Roster player "${player.label}" has no model or scripted type`)
}

function getPlayerCount(preset: PresetName): number {
  if (preset === 'survival') return 4
  return 2
}

function buildSeatAssignment(players: RosterPlayer[]): Record<number, string> {
  const sa: Record<number, string> = {}
  for (let i = 0; i < players.length; i++) {
    sa[i] = players[i].label
  }
  return sa
}

export async function runBatch(argv: string[], hooks: CliRunHooks = {}): Promise<void> {
  let rosterPath: string | undefined
  let presetName: string | undefined
  let outDir: string | undefined
  let seedsCount: number | undefined
  let shellMaxRange: number | undefined
  let live = false

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--roster' && argv[i + 1]) {
      rosterPath = resolve(argv[++i])
    } else if (argv[i] === '--preset' && argv[i + 1]) {
      presetName = argv[++i]
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outDir = resolve(argv[++i])
    } else if (argv[i] === '--seeds' && argv[i + 1]) {
      seedsCount = parseInt(argv[++i], 10)
    } else if (argv[i] === '--shell-max-range' && argv[i + 1]) {
      shellMaxRange = parseInt(argv[++i], 10)
    } else if (argv[i] === '--live') {
      live = true
    }
  }

  if (!rosterPath) {
    console.error('Error: --roster is required')
    process.exit(1)
  }
  if (!presetName) {
    console.error('Error: --preset is required')
    process.exit(1)
  }
  if (!outDir) {
    console.error('Error: --out is required')
    process.exit(1)
  }
  if (shellMaxRange !== undefined && (!Number.isInteger(shellMaxRange) || shellMaxRange < 1)) {
    console.error('Error: --shell-max-range must be a positive integer')
    process.exit(1)
  }

  const preset = presetName as PresetName
  if (!PRESETS[preset]) {
    console.error(`Error: unknown preset "${presetName}". Use: duel, blitz, survival`)
    process.exit(1)
  }

  const rosterRaw = readFileSync(rosterPath, 'utf-8')
  const roster: RosterFile = JSON.parse(rosterRaw)
  const players = roster.players
  const playerCount = getPlayerCount(preset)

  if (players.length < playerCount) {
    console.error(`Error: roster needs at least ${playerCount} players for ${preset} preset, got ${players.length}`)
    process.exit(1)
  }

  const seeds = SEED_SUITE.slice(0, seedsCount ?? DEFAULT_SEED_COUNT)

  const schedule: ScheduledMatch[] = []

  if (preset === 'survival') {
    const combos = getCombinations(players, 4)
    for (const combo of combos) {
      for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
        const seatOffset = seedIndex % combo.length
        const rotatedPlayers = [
          ...combo.slice(seatOffset),
          ...combo.slice(0, seatOffset),
        ]
        schedule.push({ preset, seed: seeds[seedIndex], players: rotatedPlayers })
      }
    }
  } else {
    const pairs = getUnorderedPairs(players)
    for (const pair of pairs) {
      for (const seed of seeds) {
        schedule.push({ preset, seed, players: pair })
        schedule.push({ preset, seed, players: [pair[1], pair[0]] })
      }
    }
  }

  const total = schedule.length
  mkdirSync(outDir, { recursive: true })

  const manifest: BatchEntry[] = []
  writeManifestCheckpoint(outDir, manifest)
  let completed = 0

  for (let m = 0; m < total; m++) {
    const entry = schedule[m]
    const matchId = m + 1
    const seatAssignment = buildSeatAssignment(entry.players)

    const playerSpecs: PlayerSpec[] = entry.players.map(rosterToPlayerSpec)
    const presetConfig = PRESETS[preset](entry.seed, playerSpecs)
    const config = shellMaxRange === undefined
      ? presetConfig
      : { ...presetConfig, shell: { ...presetConfig.shell, maxRange: shellMaxRange } }

    const agents = entry.players.map((p, i) => {
      const tankId = `tank-${i}`
      if (p.scripted) {
        if (p.scripted === 'aggressive') {
          return createAggressiveAgent(tankId)
        } else if (p.scripted === 'haiku') {
          return createHaikuAgent(tankId)
        }
        if (p.scripted === 'qwen-27b') {
          return createQwen27BAgent(tankId)
        }
        if (p.scripted === 'deepseek') {
          return createDeepSeekAgent(tankId)
        }
        if (p.scripted === 'fable') {
          return createFableAgent(tankId, config)
        }
        if (p.scripted === 'glm') {
          return createGlmAgent(tankId, {
            shellMaxRange: config.shell.maxRange,
            moveMax: config.moveMax ?? config.fog.flareRadius,
            mapWidth: config.map.width,
            mapHeight: config.map.height,
          })
        }
        return createConservativeAgent(tankId)
      }
      if (p.model && live) {
        const model = createModel(p.model, {
          perTurnTimeoutMs: config.perTurnTimeoutMs,
        })
        const systemPrompt = buildSystemPrompt(config, p.label)
        return new ModelBackedTankAgent(p.label, model, systemPrompt, config.maxToolCallsPerTurn)
      }
      return alwaysPassAgent(p.label)
    })

    const progressLabels = entry.players.map((p) => p.label).join(' vs ')
    console.log(`Running match ${matchId}/${total}: ${preset} seed ${entry.seed} (seat: ${progressLabels})`)

    try {
      const { log, result } = await runMatch(config, agents, hooks.onLiveLog
        ? (turnLog) => {
            const liveLog = structuredClone(turnLog)
            liveLog.metadata.matchId = String(matchId)
            hooks.onLiveLog!(liveLog, { currentMatch: matchId, totalMatches: total })
          }
        : undefined)
      log.metadata.matchId = String(matchId)

      const matchLogPath = `${outDir}/match-${String(matchId).padStart(3, '0')}.json`
      writeFileSync(matchLogPath, JSON.stringify(log, null, 2))

      const placements = result.placements.map((pl) => {
        const tankIndex = parseInt(pl.tankId.split('-')[1], 10)
        const label = entry.players[tankIndex].label
        return {
          tankId: pl.tankId,
          rank: pl.rank,
          hp: pl.hp,
          damageDealt: pl.damageDealt,
          hitsLanded: pl.hitsLanded,
          tieGroup: pl.tieGroup,
          label,
        }
      })

      manifest.push({
        matchId,
        preset,
        seed: entry.seed,
        seatAssignment,
        firstTurnSeat: 0,
        result: {
          terminationReason: result.terminationReason,
          placements,
        },
      })
      completed++
    } catch (err) {
      const failureMsg = err instanceof Error ? err.message : String(err)
      console.error(`Match ${matchId} failed: ${failureMsg}`)
      manifest.push({
        matchId,
        preset,
        seed: entry.seed,
        seatAssignment,
        firstTurnSeat: 0,
        result: {
          terminationReason: 'error',
          placements: [],
        },
        failure: failureMsg,
      })
    }
    writeManifestCheckpoint(outDir, manifest)
  }

  writeManifestCheckpoint(outDir, manifest)
  console.log(`Batch complete: ${completed}/${total} matches in ${outDir}`)
}
