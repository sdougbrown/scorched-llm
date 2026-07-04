import type { ModelTrace, WorldView } from '../types/events.js'
import type { ActionResult, ToolCall } from '../types/tool.js'
import type { Cell } from '../types/coords.js'

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  reasoningContent?: string
  reasoningField?: 'reasoning' | 'reasoning_content'
  /** Opaque native response items needed by provider protocols on subsequent calls. */
  providerData?: unknown
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolExecutionResult {
  result: ActionResult
  worldview: WorldView
  knownMap?: Cell[]
  turnEnded: boolean
}

export type ToolExecutor = (call: ToolCall) => Promise<ToolExecutionResult>

export interface AgentTurnResult {
  toolCalls: ToolCall[]
  modelTrace?: ModelTrace
  /** True when the agent used the supplied executor while taking its turn. */
  executed: boolean
}

export interface TankAgent {
  name: string
  messages: AgentMessage[]
  takeTurn(
    worldview: WorldView,
    tools: ToolSpec[],
    executeTool?: ToolExecutor,
  ): Promise<ToolCall[] | AgentTurnResult>
}

export function alwaysPassAgent(name: string): TankAgent {
  return {
    name,
    messages: [],
    takeTurn: async (): Promise<ToolCall[]> => [
      { id: 'pass', tool: { kind: 'pass' } },
    ],
  }
}

export function fixtureCallAgent(name: string, calls: ToolCall[]): TankAgent {
  let index = 0
  return {
    name,
    messages: [],
    takeTurn: async (): Promise<ToolCall[]> => {
      if (index >= calls.length) {
        return [{ id: `pass-${index}`, tool: { kind: 'pass' } }]
      }
      const batchSize = Math.min(2, calls.length - index)
      const batch = calls.slice(index, index + batchSize)
      index += batchSize
      return batch
    },
  }
}
