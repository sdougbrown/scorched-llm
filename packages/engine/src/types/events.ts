import type { Coordinate, Cell } from './coords.js'
import type { ToolCall, ActionEvent } from './tool.js'

/** What the model sees each turn. */
export interface WorldView {
  position: Coordinate
  hp: number
  facing: number
  localScan: Cell[]
  flaredCells: Array<{ cell: Cell; firerId: string; activatedTurn: number; expiryTurn: number }>
  inEnemyFlare: Array<{ firerId: string; expiryTurn: number }>
  remainingActions: number
  turn: number
  isMyTurn: boolean
  aliveEnemyCount: number
  /** Enemy tanks currently revealed by local vision or any active flare. */
  visibleEnemies?: Array<{
    id: string
    position: Coordinate
    hp: number
  }>
}

/** Optional model execution trace attached to a turn. */
export interface ModelTrace {
  toolCalls: ToolCall[]
  assistantText?: string
  tokensIn: number
  tokensOut: number
  costUsd: number | 'unknown'
  latencyMs: number
  finishReason: string
}

/** A complete turn event. */
export interface TurnEvent {
  turn: number
  player: string
  actions: ActionEvent[]
  worldview: WorldView
  modelTrace?: ModelTrace
}
