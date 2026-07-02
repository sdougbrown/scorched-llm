import type { GameState, ToolCall } from '@scorched-llm/engine'
import { VERSION as ENGINE_VERSION } from '@scorched-llm/engine'

export const VERSION = '0.0.0'

/** Adapter interface for connecting LLM models to the engine. */
export interface ModelAdapter {
  /** Unique identifier for this adapter. */
  id: string
  /** Generate tool calls given the current game state. */
  generateMove(state: GameState): Promise<ToolCall[]>
}

/** Verify the engine version is available. */
export function getEngineVersion(): string {
  return ENGINE_VERSION
}