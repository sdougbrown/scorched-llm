import type { TankAgent, AgentMessage, ToolSpec } from '../match/fake-agents.js'
import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { Model, ModelRequest, NormalizedToolCall } from './types.js'
import { serializeWorldView } from './worldview-serializer.js'

/** Valid tool names the model can return. */
const VALID_TOOL_NAMES = new Set<string>([
  'move',
  'fire_flare',
  'fire_shell',
  'pass',
  'look',
  'known_map',
])

/** Direction string validation. */
const VALID_DIRECTIONS = new Set<string>(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'])

/**
 * Convert a NormalizedToolCall to an engine ToolCall.
 * Returns null for invalid calls (unknown name, missing required fields,
 * wrong types).
 */
function normalizeToolCall(call: NormalizedToolCall): ToolCall | null {
  if (!VALID_TOOL_NAMES.has(call.name)) {
    return null
  }

  const args = call.arguments
  const id = call.id

  switch (call.name) {
    case 'move': {
      const direction = args.direction
      const distance = args.distance
      if (
        typeof direction !== 'string' ||
        !VALID_DIRECTIONS.has(direction) ||
        typeof distance !== 'number' ||
        !Number.isInteger(distance) ||
        distance < 1
      ) {
        return null
      }
      return { id, tool: { kind: 'move', direction: direction as 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW', distance } }
    }

    case 'fire_flare': {
      const direction = args.direction
      const range = args.range
      if (
        typeof direction !== 'string' ||
        !VALID_DIRECTIONS.has(direction) ||
        typeof range !== 'number' ||
        !Number.isInteger(range) ||
        range < 1
      ) {
        return null
      }
      return { id, tool: { kind: 'fire_flare', direction: direction as 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW', range } }
    }

    case 'fire_shell': {
      const angle = args.angle
      const power = args.power
      if (
        typeof angle !== 'number' ||
        typeof power !== 'number' ||
        !Number.isFinite(angle) ||
        !Number.isFinite(power)
      ) {
        return null
      }
      return { id, tool: { kind: 'fire_shell', angle, power } }
    }

    case 'pass':
      return { id, tool: { kind: 'pass' } }

    case 'look':
      return { id, tool: { kind: 'look' } }

    case 'known_map':
      return { id, tool: { kind: 'known_map' } }

    default:
      return null
  }
}

/**
 * ModelBackedTankAgent — a persistent agent that wraps a Model and
 * maintains linear message history across the whole match.
 */
export class ModelBackedTankAgent implements TankAgent {
  name: string
  messages: AgentMessage[]
  private model: Model
  private systemPrompt: string

  constructor(name: string, model: Model, systemPrompt: string) {
    this.name = name
    this.model = model
    this.systemPrompt = systemPrompt
    this.messages = [{ role: 'system', content: systemPrompt }]
  }

  async takeTurn(worldview: WorldView, tools: ToolSpec[]): Promise<ToolCall[]> {
    // 1. Append worldview as user message
    const description = serializeWorldView(worldview)
    this.messages.push({ role: 'user', content: description })

    // 2. Query the model
    const request: ModelRequest = {
      messages: this.messages,
      tools,
    }
    const response = await this.model.query(request)

    // 3. Parse tool calls
    const toolCalls: ToolCall[] = []
    for (const call of response.toolCalls) {
      const validated = normalizeToolCall(call)
      if (validated !== null) {
        toolCalls.push(validated)
      }
    }

    // 4. Append assistant response to history
    const assistantContent: string | Array<{ type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }> =
      response.toolCalls.length > 0
        ? response.toolCalls.map((tc) => ({
            type: 'tool_use' as const,
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          }))
        : (response.assistantText ?? '')
    
    this.messages.push({
      role: 'assistant',
      content: typeof assistantContent === 'string' ? assistantContent : JSON.stringify(assistantContent),
    })

    // 5. Return tool calls (stage 5: no inner-loop re-planning yet)
    return toolCalls
  }
}