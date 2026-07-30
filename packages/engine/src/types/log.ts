import type { GameState } from './state.js'
import type { TurnEvent } from './events.js'
import type { MatchConfig } from '../config/schema.js'
import type { TankState, FlareState } from './state.js'

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

/**
 * Compact snapshot — omits terrain (always from initialState) and rulesVersion
 * (unchanged). Used by schemaVersion v2+ to reduce replay file size.
 * The full GameState is reconstructed by merging with initialState.terrain
 * and initialState.rulesVersion.
 */
export interface CompactGameState {
  /** Explicit discriminator: v1 snapshots are full GameState objects. */
  snapshotFormat: 'compact-v2'
  turn: number
  currentPlayerIndex: number
  tanks: TankState[]
  flares: FlareState[]
}

/**
 * Reconstruct a full GameState from a compact snapshot and a base state.
 * If snapshot already has terrain, returns it directly (v1 compat).
 */
export function reconstructGameState(
  snapshot: GameState | CompactGameState,
  base: GameState,
): GameState {
  if (!isCompactSnapshot(snapshot)) return snapshot
  const compact = snapshot
  return {
    turn: compact.turn,
    currentPlayerIndex: compact.currentPlayerIndex,
    tanks: compact.tanks,
    flares: compact.flares,
    terrain: base.terrain,
    rulesVersion: base.rulesVersion,
  }
}

/**
 * Check whether a snapshot is in compact format (missing terrain).
 */
export function isCompactSnapshot(
  snapshot: GameState | CompactGameState,
): snapshot is CompactGameState {
  return 'snapshotFormat' in snapshot && snapshot.snapshotFormat === 'compact-v2'
}

/** Copy all mutable dynamic state while sharing the immutable initial terrain. */
export function compactGameState(state: GameState): CompactGameState {
  return {
    snapshotFormat: 'compact-v2',
    turn: state.turn,
    currentPlayerIndex: state.currentPlayerIndex,
    tanks: state.tanks.map((tank) => ({ ...tank, position: { ...tank.position } })),
    flares: state.flares.map((flare) => ({ ...flare, targetCell: { ...flare.targetCell } })),
  }
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
