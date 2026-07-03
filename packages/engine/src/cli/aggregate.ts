import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { MatchLog } from '../types/log.js'

export interface SeatAssignment {
  matchId: number
  seatAssignment: Record<number, string>
  failure?: string
}

export interface PlayerStats {
  scheduledMatchCount: number
  failedMatchCount: number
  failureExposureRate: number
  matchCount: number
  winCount: number
  winRate: number
  placementDistribution: Record<number, number>
  meanPlacement: number
  totalDamageDealt: number
  avgDamagePerMatch: number
  totalHitsLanded: number
  avgHitsPerMatch: number
  totalInvalidCalls: number
  invalidCallRate: number
  totalToolCalls: number
  successfulToolCalls: number
  toolCallSuccessRate: number
  shellCalls: number
  shellHits: number
  shellHitRate: number
  avgSurvivalTurns: number
  totalTokensIn: number
  totalTokensOut: number
  damagePer1kOutputTokens: number | null
  totalKnownCostUsd: number
  winsPerKnownDollar: number | null
  unknownCostMatchCount: number
  avgLatencyMs: number
  medianLatencyMs: number
}

export interface LeaderboardEntry extends PlayerStats {
  rank: number
  label: string
}

export interface Reconciliation {
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

export interface AggregateSummary {
  preset: string
  seedCount: number
  matchesScheduled: number
  matchesTotal: number
  matchesFailed: number
  failureRate: number
  terminationDistribution: Record<string, number>
  perPlayer: Record<string, PlayerStats>
  leaderboard: LeaderboardEntry[]
  overallWinner: string | null
  reconciliation: Reconciliation
}

interface RawPlayerAccum {
  scheduledMatchCount: number
  failedMatchCount: number
  matchCount: number
  winCount: number
  placementDistribution: Record<number, number>
  placementSum: number
  totalDamageDealt: number
  totalHitsLanded: number
  totalInvalidCalls: number
  totalToolCalls: number
  successfulToolCalls: number
  shellCalls: number
  shellHits: number
  totalSurvivalTurns: number
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
    scheduledMatchCount: 0,
    failedMatchCount: 0,
    matchCount: 0,
    winCount: 0,
    placementDistribution: {},
    placementSum: 0,
    totalDamageDealt: 0,
    totalHitsLanded: 0,
    totalInvalidCalls: 0,
    totalToolCalls: 0,
    successfulToolCalls: 0,
    shellCalls: 0,
    shellHits: 0,
    totalSurvivalTurns: 0,
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

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0
}

function compareCompetitiveStats(a: PlayerStats, b: PlayerStats): number {
  if ((a.matchCount > 0) !== (b.matchCount > 0)) return a.matchCount > 0 ? -1 : 1
  if (a.meanPlacement !== b.meanPlacement) return a.meanPlacement - b.meanPlacement
  if (a.winRate !== b.winRate) return b.winRate - a.winRate
  if (a.avgDamagePerMatch !== b.avgDamagePerMatch) return b.avgDamagePerMatch - a.avgDamagePerMatch
  if (a.shellHitRate !== b.shellHitRate) return b.shellHitRate - a.shellHitRate
  if (a.invalidCallRate !== b.invalidCallRate) return a.invalidCallRate - b.invalidCallRate
  return 0
}

function getSurvivalTurns(log: MatchLog, tankId: string): number {
  for (const turn of log.turns) {
    for (const action of turn.actions) {
      const tank = action.snapshot.tanks.find((candidate) => candidate.id === tankId)
      if (tank && !tank.alive) return turn.turn
    }
  }
  return log.turns.at(-1)?.turn ?? 0
}

export function aggregateLogs(
  logs: MatchLog[],
  seatAssignments: SeatAssignment[],
  preset: string,
): AggregateSummary {
  const accumMap = new Map<string, RawPlayerAccum>()
  const manifestMap = new Map<number, SeatAssignment>()
  for (const sa of seatAssignments) {
    manifestMap.set(sa.matchId, sa)
    for (const label of Object.values(sa.seatAssignment)) {
      if (!accumMap.has(label)) accumMap.set(label, createAccum())
      const acc = accumMap.get(label)!
      acc.scheduledMatchCount += 1
      if (sa.failure) acc.failedMatchCount += 1
    }
  }

  let totalDamageFromPlacements = 0
  let totalHitsFromPlacements = 0
  const seedSet = new Set<number>()
  const terminationDistribution: Record<string, number> = {}

  for (const log of logs) {
    const logMatchId = parseInt(log.metadata.matchId, 10)
    const sa = manifestMap.get(logMatchId)
    if (!sa) continue

    seedSet.add(log.config.seed)
    terminationDistribution[log.result.terminationReason] =
      (terminationDistribution[log.result.terminationReason] ?? 0) + 1

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
      acc.placementSum += placement.rank
      acc.totalDamageDealt += placement.damageDealt
      acc.totalHitsLanded += placement.hitsLanded
      acc.totalSurvivalTurns += getSurvivalTurns(log, placement.tankId)

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
        acc.totalToolCalls += 1
        if (action.result.kind !== 'invalid' && action.result.kind !== 'blocked') {
          acc.successfulToolCalls += 1
        }
        if (action.call.tool.kind === 'fire_shell') {
          acc.shellCalls += 1
          if (action.result.kind === 'hit') acc.shellHits += 1
        }
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

  const matchesScheduled = seatAssignments.length
  const matchesTotal = logs.length
  const matchesFailed = seatAssignments.filter((assignment) => assignment.failure).length
  const seedCount = seedSet.size
  const playersPerMatch = preset === 'survival' ? 4 : 2

  const perPlayer: Record<string, PlayerStats> = {}
  for (const [label, acc] of accumMap) {
    const winRate = safeRatio(acc.winCount, acc.matchCount)
    perPlayer[label] = {
      scheduledMatchCount: acc.scheduledMatchCount,
      failedMatchCount: acc.failedMatchCount,
      failureExposureRate: safeRatio(acc.failedMatchCount, acc.scheduledMatchCount),
      matchCount: acc.matchCount,
      winCount: acc.winCount,
      winRate,
      placementDistribution: acc.placementDistribution,
      meanPlacement: safeRatio(acc.placementSum, acc.matchCount),
      totalDamageDealt: acc.totalDamageDealt,
      avgDamagePerMatch: safeRatio(acc.totalDamageDealt, acc.matchCount),
      totalHitsLanded: acc.totalHitsLanded,
      avgHitsPerMatch: safeRatio(acc.totalHitsLanded, acc.matchCount),
      totalInvalidCalls: acc.totalInvalidCalls,
      invalidCallRate: safeRatio(acc.totalInvalidCalls, acc.totalToolCalls),
      totalToolCalls: acc.totalToolCalls,
      successfulToolCalls: acc.successfulToolCalls,
      toolCallSuccessRate: safeRatio(acc.successfulToolCalls, acc.totalToolCalls),
      shellCalls: acc.shellCalls,
      shellHits: acc.shellHits,
      shellHitRate: safeRatio(acc.shellHits, acc.shellCalls),
      avgSurvivalTurns: safeRatio(acc.totalSurvivalTurns, acc.matchCount),
      totalTokensIn: acc.totalTokensIn,
      totalTokensOut: acc.totalTokensOut,
      damagePer1kOutputTokens: acc.totalTokensOut > 0
        ? (acc.totalDamageDealt * 1000) / acc.totalTokensOut
        : null,
      totalKnownCostUsd: Math.round(acc.totalKnownCostUsd * 10000) / 10000,
      winsPerKnownDollar: acc.totalKnownCostUsd > 0
        ? acc.winCount / acc.totalKnownCostUsd
        : null,
      unknownCostMatchCount: acc.unknownMatchIds.size,
      avgLatencyMs: computeAvg(acc.latencies),
      medianLatencyMs: computeMedian(acc.latencies),
    }
  }

  const leaderboard: LeaderboardEntry[] = Object.entries(perPlayer)
    .map(([label, stats]) => ({ rank: 0, label, ...stats }))
    .sort((a, b) => compareCompetitiveStats(a, b) || a.label.localeCompare(b.label))

  let rank = 1
  for (let index = 0; index < leaderboard.length; index++) {
    if (index > 0 && compareCompetitiveStats(leaderboard[index - 1], leaderboard[index]) !== 0) {
      rank = index + 1
    }
    leaderboard[index].rank = rank
  }

  const overallWinner = leaderboard.length > 0 &&
    (leaderboard.length === 1 || leaderboard[1].rank !== 1)
    ? leaderboard[0].label
    : null

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
    matchesScheduled,
    matchesTotal,
    matchesFailed,
    failureRate: safeRatio(matchesFailed, matchesScheduled),
    terminationDistribution,
    perPlayer,
    leaderboard,
    overallWinner,
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
    failure: e.failure,
  }))

  const summary = aggregateLogs(logs, seatAssignments, preset)

  writeFileSync(resolve(outDir, 'summary.json'), JSON.stringify(summary, null, 2))

  console.log(
    `Matches: ${summary.matchesTotal}/${summary.matchesScheduled} complete | ` +
    `Failures: ${summary.matchesFailed} (${(summary.failureRate * 100).toFixed(1)}%) | ` +
    `Seeds: ${summary.seedCount}`,
  )

  if (summary.overallWinner) {
    console.log(`Overall winner: ${summary.overallWinner}`)
  } else {
    console.log('Overall winner: tied')
  }

  for (const stats of summary.leaderboard) {
    const wr = (stats.winRate * 100).toFixed(1)
    const shellRate = (stats.shellHitRate * 100).toFixed(1)
    const invalidRate = (stats.invalidCallRate * 100).toFixed(1)
    console.log(
      `  ${stats.rank}. ${stats.label}: avg place ${stats.meanPlacement.toFixed(2)}, ` +
      `WR ${wr}%, dmg/match ${stats.avgDamagePerMatch.toFixed(2)}, ` +
      `shell hits ${shellRate}%, invalid ${invalidRate}%`,
    )
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
