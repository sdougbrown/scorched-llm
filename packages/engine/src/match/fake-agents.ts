import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface TankAgent {
  name: string
  messages: AgentMessage[]
  takeTurn(worldview: WorldView, tools: ToolSpec[]): Promise<ToolCall[]>
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
