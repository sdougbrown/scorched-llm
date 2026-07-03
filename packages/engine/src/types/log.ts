import type { GameState } from './state.js'
import type { TurnEvent } from './events.js'
import type { MatchConfig } from '../config/schema.js'

/** Match termination and ranking result. */
export interface MatchResult {
  terminationReason: 'last-standing' | 'turn-limit' | 'mutual-destruction'
  placements: Array<{
    tankId: string
    rank: number
    hp: number
    damageDealt: number
    hitsLanded: number
    tieGroup?: string
  }>
}

/** Full match log — the replay contract. */
export interface MatchLog {
  schemaVersion: string
  metadata: {
    matchId: string
    createdAt: string
    promptVersion: string
    adapterVersions: Record<string, string>
  }
  config: MatchConfig
  initialState: GameState
  turns: TurnEvent[]
  result: MatchResult
  liveState?: {
    status: 'thinking'
    turn: number
    player: string
  }
  liveBatchState?: {
    currentMatch: number
    totalMatches: number
    status: 'running' | 'complete'
  }
}

/** Checkpoint state — serializable, for resume/replay. */
export interface MatchCheckpoint {
  engineState: GameState
  turnCursor: number
  playerCursor: number
  remainingActions: number
  remainingMoveBudget: number
  invalidStreak: number
  rngState: Uint8Array
  pendingRetries: unknown[]
  accounting: Record<string, { tokensIn: number; tokensOut: number; costUsd: number | 'unknown' }>
  agentMemory: Record<string, unknown>
}
