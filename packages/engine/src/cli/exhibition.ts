import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { type PlayerSpec, type ScriptedAgentKind } from '../config/schema.js'
import { DEFAULT_SEED_COUNT, PRESETS, SEED_SUITE, type PresetName } from '../config/presets.js'
import { VERSION } from '../index.js'
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
import { createKimiAgent } from '../match/kimi-agent.js'
import { createMinimaxAgent } from '../match/minimax-agent.js'
import { createGemmaAgent } from '../match/gemma-agent.js'
import { createFableFreshAgent } from '../match/fable-fresh-agent.js'
import { runMatch } from '../match/orchestration.js'
import { alwaysPassAgent } from '../match/fake-agents.js'
import { aggregateLogs } from './aggregate.js'
import { SYSTEM_PROMPT_VERSION } from '../model/system-prompt.js'

interface RosterPlayer {
  label: string
  scripted: ScriptedAgentKind
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
  return {
    label: player.label,
    startPosition: 'random' as const,
    scripted: player.scripted,
  }
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

function buildSchedule(preset: PresetName, seeds: number[], players: RosterPlayer[]): ScheduledMatch[] {
  const schedule: ScheduledMatch[] = []

  if (preset === 'survival') {
    const combos = getCombinations(players, 4)
    for (const combo of combos) {
      for (const seed of seeds) {
        schedule.push({ preset, seed, players: combo })
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

  return schedule
}

export async function runExhibition(argv: string[]): Promise<void> {
  let presetName: string | undefined
  let outDir: string | undefined
  let seedsCount: number | undefined

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preset' && argv[i + 1]) {
      presetName = argv[++i]
    } else if (argv[i] === '--out' && argv[i + 1]) {
      outDir = resolve(argv[++i])
    } else if (argv[i] === '--seeds' && argv[i + 1]) {
      seedsCount = parseInt(argv[++i], 10)
    }
  }

  if (!presetName) {
    console.error('Error: --preset is required')
    process.exit(1)
  }
  if (!outDir) {
    console.error('Error: --out is required')
    process.exit(1)
  }

  const preset = presetName as PresetName
  if (!PRESETS[preset]) {
    console.error(`Error: unknown preset "${presetName}". Use: duel, blitz, survival`)
    process.exit(1)
  }

  const playerCount = getPlayerCount(preset)

  // Build fixed roster
  const players: RosterPlayer[] = [
    { label: 'Aggressive Bot', scripted: 'aggressive' },
    { label: 'Conservative Bot', scripted: 'conservative' },
    { label: 'Kimi Bot', scripted: 'kimi' },
  ]

  if (preset === 'survival') {
    players.push(
      { label: 'Aggressive Bot 2', scripted: 'aggressive' },
      { label: 'Conservative Bot 2', scripted: 'conservative' },
      { label: 'Kimi Bot 2', scripted: 'kimi' },
    )
  }

  if (players.length < playerCount) {
    console.error(`Error: roster needs at least ${playerCount} players for ${preset} preset, got ${players.length}`)
    process.exit(1)
  }

  const seeds: number[] = SEED_SUITE.slice(0, seedsCount ?? DEFAULT_SEED_COUNT)
  const schedule = buildSchedule(preset, seeds, players)

  const total = schedule.length
  mkdirSync(outDir, { recursive: true })

  const manifest: BatchEntry[] = []
  let completed = 0

  for (let m = 0; m < total; m++) {
    const entry = schedule[m]
    const matchId = m + 1
    const seatAssignment = buildSeatAssignment(entry.players)

    const playerSpecs: PlayerSpec[] = entry.players.map(rosterToPlayerSpec)
    const config = PRESETS[preset](entry.seed, playerSpecs)

    const agents = entry.players.map((p, i) => {
      const tankId = `tank-${i}`
      switch (p.scripted) {
        case 'aggressive': return createAggressiveAgent(tankId)
        case 'fable': return createFableAgent(tankId, config)
        case 'glm': return createGlmAgent(tankId, {
          shellMaxRange: config.shell.maxRange,
          moveMax: config.moveMax ?? config.fog.flareRadius,
          mapWidth: config.map.width,
          mapHeight: config.map.height,
        })
        case 'deepseek': return createDeepSeekAgent(tankId)
        case 'qwen-27b': return createQwen27BAgent(tankId)
        case 'haiku': return createHaikuAgent(tankId)
        case 'sonnet': return createSonnetAgent(tankId, config)
        case 'opus': return createOpusAgent(tankId, opusOptionsFromConfig(config))
        case 'gpt-5.4': return createGpt54Agent(tankId, {
          shellMaxRange: config.shell.maxRange,
          moveMax: config.moveMax ?? config.fog.flareRadius,
          flareMaxRange: config.fog.flareRadius,
          flareRadius: config.fog.flareRadius,
        })
        case 'gpt-5.5': return createGpt55Agent(tankId)
        case 'gemini': return createGeminiAgent(tankId)
        case 'kimi': return createKimiAgent(tankId, {
          shellMaxRange: config.shell.maxRange,
          moveMax: config.moveMax ?? config.fog.flareRadius,
          mapWidth: config.map.width,
          mapHeight: config.map.height,
        })
        case 'minimax': return createMinimaxAgent(tankId)
        case 'gemma': return createGemmaAgent(tankId)
        case 'fable-fresh': return createFableFreshAgent(tankId, config)
        default: return createConservativeAgent(tankId)
      }
      if (p.scripted === 'kimi') {
        return createKimiAgent(tankId, {
          shellMaxRange: config.shell.maxRange,
          moveMax: config.moveMax ?? config.fog.flareRadius,
          mapWidth: config.map.width,
          mapHeight: config.map.height,
        })
      }
      return createConservativeAgent(tankId)
    })

    const progressLabels = entry.players.map((p) => p.label).join(' vs ')
    console.log(`Running match ${matchId}/${total}: ${preset} seed ${entry.seed} (seat: ${progressLabels})`)

    try {
      const { log, result } = await runMatch(config, agents)
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
  }

  writeFileSync(`${outDir}/batch-manifest.json`, JSON.stringify(manifest, null, 2))

  // Run aggregation to produce summary.json
  const manifestMap = new Map<number, { matchId: number; seatAssignment: Record<number, string> }>()
  for (const sa of manifest) {
    manifestMap.set(sa.matchId, { matchId: sa.matchId, seatAssignment: sa.seatAssignment })
  }

  const logs: import('../types/log.js').MatchLog[] = []
  for (const entry of manifest) {
    if (entry.failure) continue
    const logPath = `${outDir}/match-${String(entry.matchId).padStart(3, '0')}.json`
    const raw = readFileSync(logPath, 'utf-8')
    logs.push(JSON.parse(raw) as import('../types/log.js').MatchLog)
  }

  const seatAssignments = manifest.map((e) => ({
    matchId: e.matchId,
    seatAssignment: e.seatAssignment,
  }))

  const summary = aggregateLogs(logs, seatAssignments, preset)
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2))

  // Write exhibition-info.json
  const uniqueSeeds = [...new Set(manifest.map((m) => m.seed))]
  const exhibitionInfo = {
    type: 'scripted' as const,
    preset: presetName,
    rulesVersion: 'v1',
    generatorVersion: 'v1',
    promptVersion: SYSTEM_PROMPT_VERSION,
    engineVersion: VERSION,
    timestamp: new Date().toISOString(),
    seedSuite: [...SEED_SUITE],
    seedsUsed: uniqueSeeds,
    roster: players.map((p) => ({
      label: p.label,
      scripted: p.scripted,
    })),
    totalMatches: total,
    completedMatches: completed,
    adapterVersions: {},
  }
  writeFileSync(`${outDir}/exhibition-info.json`, JSON.stringify(exhibitionInfo, null, 2))

  console.log(`Exhibition complete: ${completed}/${total} matches in ${outDir}`)

  // Print summary
  console.log(`Matches: ${summary.matchesTotal} | Seeds: ${summary.seedCount}`)
  for (const [label, stats] of Object.entries(summary.perPlayer)) {
    const wr = (stats.winRate * 100).toFixed(1)
    console.log(`  ${label}: WR ${wr}%, ${stats.winCount}/${stats.matchCount}, dmg ${stats.totalDamageDealt}, hits ${stats.totalHitsLanded}`)
  }
  if (summary.reconciliation.matchCountMatches && summary.reconciliation.damageMatches && summary.reconciliation.hitsMatches) {
    console.log('  Reconciliation: ok')
  }
}
