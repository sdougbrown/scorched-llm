import type { Coordinate, Direction } from './coords.js'
import type { GameState } from './state.js'

/** Tool call the engine exposes to agents. */
export type Tool =
  | { kind: 'look' }
  | { kind: 'known_map' }
  | { kind: 'move'; direction: Direction; distance: number }
  | { kind: 'fire_flare'; direction: Direction; range: number }
  | { kind: 'fire_shell'; angle: number; power: number }
  | { kind: 'fire_bomb'; angle: number; power: number }
  | { kind: 'pass' }

/** A tool call with a stable ID. */
export interface ToolCall {
  id: string
  tool: Tool
}

/** Result of executing a tool call. */
export type ActionResult =
  | { kind: 'ok' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'miss' }
  | { kind: 'obstacle-hit'; coordinate: Coordinate }
  | { kind: 'hit'; targetId: string; damage: number }
  | { kind: 'revealed'; cells: Coordinate[] }
  | { kind: 'splash'; impact: Coordinate; casualties: Array<{ targetId: string; damage: number }> }
  | { kind: 'invalid'; reason: string }

/** A single action event — one tool call and its result. */
export interface ActionEvent {
  kind: 'move' | 'flare' | 'shell' | 'bomb' | 'pass' | 'invalid' | 'observation'
  call: ToolCall
  result: ActionResult
  snapshot: GameState
}
