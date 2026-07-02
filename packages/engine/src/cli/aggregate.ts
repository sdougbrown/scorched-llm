import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MatchLog } from '../types/log.js'

interface SeatAssignment {
  matchId: number
  seatAssignment: Record<number, string>
}

interface PlayerStats {
  matchCount: number
  winCount: number
  winRate: number
  placementDistribution: Record<number, number>
  totalDamageDealt: number
  totalHitsLanded: number
  totalInvalidCalls: number
  totalTokensIn: number
  totalTokensOut: number
  totalKnownCostUsd: number
  unknownCostMatchCount: number
  avgLatencyMs: number
  medianLatencyMs: number
}

interface Reconciliation {
  matchCountSum: number
  totalMatchesTimesPlayers: number
  matchCountMatches: boolean
  damageSum: number
  placementDamageSum: number
  damageMatches: boolean
  hitsSum: number
  placementHitsSum: number
  hitsMatches: boolean
}

interface AggregateSummary {
  preset: string
  seedCount: number
  matchesTotal: number
  perPlayer: Record<string, PlayerStats>
  reconciliation: Reconciliation
}

interface RawPlayerAccum {
  matchCount: number
  winCount: number
  placementDistribution: Record<number, number>
  totalDamageDealt: number
  totalHitsLanded: number
  totalInvalidCalls: number
  totalTokensIn: number
  totalTokensOut: number
  totalKnownCostUsd: number
  unknownMatchIds: Set<string>
  latencies: number[]
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2
  }
  return sorted[mid]
}

function computeAvg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

function createAccum(): RawPlayerAccum {
  return {
    matchCount: 0,
    winCount: 0,
    placementDistribution: {},
    totalDamageDealt: 0,
    totalHitsLanded: 0,
    totalInvalidCalls: 0,
    totalTokensIn: 0,
    totalTokensOut: 0,
    totalKnownCostUsd: 0,
    unknownMatchIds: new Set(),
    latencies: [],
  }
}

function getLabel(seatAssignment: Record<number, string>, tankId: string): string | undefined {
  const seatIndex = parseInt(tankId.split('-')[1], 10)
  return seatAssignment[seatIndex]
}

export function aggregateLogs(
  logs: MatchLog[],
  seatAssignments: SeatAssignment[],
  preset: string,
): AggregateSummary {
  const manifestMap = new Map<number, SeatAssignment>()
  for (const sa of seatAssignments) {
    manifestMap.set(sa.matchId, sa)
  }

  const accumMap = new Map<string, RawPlayerAccum>()
  let totalDamageFromPlacements = 0
  let totalHitsFromPlacements = 0
  const seedSet = new Set<number>()

  for (const log of logs) {
    const logMatchId = parseInt(log.metadata.matchId, 10)
    const sa = manifestMap.get(logMatchId)
    if (!sa) continue

    seedSet.add(log.config.seed)

    for (const placement of log.result.placements) {
      totalDamageFromPlacements += placement.damageDealt
      totalHitsFromPlacements += placement.hitsLanded

      const label = getLabel(sa.seatAssignment, placement.tankId)
      if (!label) continue

      if (!accumMap.has(label)) {
        accumMap.set(label, createAccum())
      }
      const acc = accumMap.get(label)!
      acc.matchCount += 1
      acc.totalDamageDealt += placement.damageDealt
      acc.totalHitsLanded += placement.hitsLanded

      if (placement.rank === 1 && !placement.tieGroup) {
        acc.winCount += 1
      }

      acc.placementDistribution[placement.rank] = (acc.placementDistribution[placement.rank] || 0) + 1
    }

    for (const turn of log.turns) {
      const label = getLabel(sa.seatAssignment, turn.player)
      if (!label) continue

      if (!accumMap.has(label)) {
        accumMap.set(label, createAccum())
      }
      const acc = accumMap.get(label)!

      for (const action of turn.actions) {
        if (action.kind === 'invalid') {
          acc.totalInvalidCalls += 1
        }
      }

      if (turn.modelTrace) {
        const trace = turn.modelTrace
        acc.totalTokensIn += trace.tokensIn
        acc.totalTokensOut += trace.tokensOut
        acc.totalKnownCostUsd += trace.costUsd !== 'unknown' ? trace.costUsd : 0
        if (trace.costUsd === 'unknown') {
          acc.unknownMatchIds.add(log.metadata.matchId)
        }
        if (trace.latencyMs > 0) {
          acc.latencies.push(trace.latencyMs)
        }
      }
    }
  }

  const matchesTotal = logs.length
  const seedCount = seedSet.size
  const playersPerMatch = preset === 'survival' ? 4 : 2

  const perPlayer: Record<string, PlayerStats> = {}
  for (const [label, acc] of accumMap) {
    const winRate = acc.matchCount > 0 ? acc.winCount / acc.matchCount : 0
    perPlayer[label] = {
      matchCount: acc.matchCount,
      winCount: acc.winCount,
      winRate,
      placementDistribution: acc.placementDistribution,
      totalDamageDealt: acc.totalDamageDealt,
      totalHitsLanded: acc.totalHitsLanded,
      totalInvalidCalls: acc.totalInvalidCalls,
      totalTokensIn: acc.totalTokensIn,
      totalTokensOut: acc.totalTokensOut,
      totalKnownCostUsd: Math.round(acc.totalKnownCostUsd * 10000) / 10000,
      unknownCostMatchCount: acc.unknownMatchIds.size,
      avgLatencyMs: computeAvg(acc.latencies),
      medianLatencyMs: computeMedian(acc.latencies),
    }
  }

  const matchCountSum = Object.values(perPlayer).reduce((s, p) => s + p.matchCount, 0)
  const damageSum = Object.values(perPlayer).reduce((s, p) => s + p.totalDamageDealt, 0)
  const hitsSum = Object.values(perPlayer).reduce((s, p) => s + p.totalHitsLanded, 0)

  const reconciliation: Reconciliation = {
    matchCountSum,
    totalMatchesTimesPlayers: matchesTotal * playersPerMatch,
    matchCountMatches: matchCountSum === matchesTotal * playersPerMatch,
    damageSum,
    placementDamageSum: totalDamageFromPlacements,
    damageMatches: damageSum === totalDamageFromPlacements,
    hitsSum,
    placementHitsSum: totalHitsFromPlacements,
    hitsMatches: hitsSum === totalHitsFromPlacements,
  }

  const checks: string[] = []
  if (!reconciliation.matchCountMatches) {
    checks.push(`matchCount: sum=${reconciliation.matchCountSum} expected=${reconciliation.totalMatchesTimesPlayers}`)
  }
  if (!reconciliation.damageMatches) {
    checks.push(`damage: sum=${reconciliation.damageSum} expected=${reconciliation.placementDamageSum}`)
  }
  if (!reconciliation.hitsMatches) {
    checks.push(`hits: sum=${reconciliation.hitsSum} expected=${reconciliation.placementHitsSum}`)
  }

  if (checks.length > 0) {
    throw new Error(`Reconciliation failed: ${checks.join(', ')}`)
  }

  return {
    preset,
    seedCount,
    matchesTotal,
    perPlayer,
    reconciliation,
  }
}

function readBatchLog(outDir: string, matchId: number): MatchLog {
  const filePath = resolve(outDir, `match-${String(matchId).padStart(3, '0')}.json`)
  const raw = readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as MatchLog
}

export async function runAggregate(outDir: string): Promise<void> {
  const manifestPath = resolve(outDir, 'batch-manifest.json')
  const manifestRaw = readFileSync(manifestPath, 'utf-8')
  const manifest: Array<{
    matchId: number
    preset: string
    seed: number
    seatAssignment: Record<number, string>
    failure?: string
  }> = JSON.parse(manifestRaw)

  const preset = manifest[0]?.preset || ''

  const logs: MatchLog[] = []
  for (const entry of manifest) {
    if (entry.failure) continue
    const log = readBatchLog(outDir, entry.matchId)
    logs.push(log)
  }

  const seatAssignments: SeatAssignment[] = manifest.map((e) => ({
    matchId: e.matchId,
    seatAssignment: e.seatAssignment,
  }))

  const summary = aggregateLogs(logs, seatAssignments, preset)

  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

  console.log(`Matches: ${summary.matchesTotal} | Seeds: ${summary.seedCount}`)

  for (const [label, stats] of Object.entries(summary.perPlayer)) {
    const wr = (stats.winRate * 100).toFixed(1)
    console.log(`  ${label}: WR ${wr}%, ${stats.winCount}/${stats.matchCount}, dmg ${stats.totalDamageDealt}, hits ${stats.totalHitsLanded}`)
  }

  if (summary.reconciliation.matchCountMatches && summary.reconciliation.damageMatches && summary.reconciliation.hitsMatches) {
    console.log('  Reconciliation: ok')
  } else {
    const details: string[] = []
    if (!summary.reconciliation.matchCountMatches) details.push(`matchCount: ${summary.reconciliation.matchCountSum} !== ${summary.reconciliation.totalMatchesTimesPlayers}`)
    if (!summary.reconciliation.damageMatches) details.push(`damage: ${summary.reconciliation.damageSum} !== ${summary.reconciliation.placementDamageSum}`)
    if (!summary.reconciliation.hitsMatches) details.push(`hits: ${summary.reconciliation.hitsSum} !== ${summary.reconciliation.placementHitsSum}`)
    console.log(`  Reconciliation: failed - ${details.join(', ')}`)
  }
}