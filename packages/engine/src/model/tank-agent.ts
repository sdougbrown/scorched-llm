import type {
  TankAgent,
  AgentMessage,
  AgentTurnResult,
  ToolExecutor,
  ToolSpec,
} from '../match/fake-agents.js'
import type { ModelTrace, WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { Model, ModelRequest, NormalizedModelResponse, NormalizedToolCall } from './types.js'
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
 *
 * Supports an inner loop: if the model returns finishReason 'tool_calls'
 * (indicating more calls are needed), the agent re-queries with updated
 * history until the max tool call cap is reached or the model stops.
 */
export class ModelBackedTankAgent implements TankAgent {
  name: string
  messages: AgentMessage[]
  private model: Model
  private systemPrompt: string
  private maxToolCallsPerTurn: number

  constructor(name: string, model: Model, systemPrompt: string, maxToolCallsPerTurn: number) {
    this.name = name
    this.model = model
    this.systemPrompt = systemPrompt
    this.maxToolCallsPerTurn = maxToolCallsPerTurn
    this.messages = [{ role: 'system', content: systemPrompt }]
  }

  async takeTurn(
    worldview: WorldView,
    tools: ToolSpec[],
    executeTool?: ToolExecutor,
  ): Promise<ToolCall[] | AgentTurnResult> {
    // 1. Append worldview as user message
    const description = serializeWorldView(worldview)
    this.messages.push({ role: 'user', content: description })

    // 2. Inner loop: query model, execute, re-query if more calls needed
    const allToolCalls: ToolCall[] = []
    let finishReason = ''
    let callCount = 0
    let queryCount = 0
    const responses: NormalizedModelResponse[] = []
    let turnEnded = false
    let responseHadToolCalls = false

    do {
      // 2a. Query the model with full history
      const request: ModelRequest = {
        messages: this.messages,
        tools,
      }
      const response = await this.model.query(request)
      queryCount++
      responses.push(response)
      responseHadToolCalls = response.toolCalls.length > 0
      finishReason = response.finishReason

      // 2b. Parse tool calls
      const calls: ToolCall[] = []
      for (const call of response.toolCalls) {
        const validated = normalizeToolCall(call)
        if (validated !== null) {
          calls.push(validated)
        }
      }

      // 2c. Append assistant response to history
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

      // 2d. Execute validated calls in order and provide their real outcomes
      // before asking the model to continue.
      const answeredToolCallIds = new Set<string>()
      for (const call of calls) {
        if (callCount >= this.maxToolCallsPerTurn || turnEnded) break
        allToolCalls.push(call)
        callCount++

        if (executeTool != null) {
          const execution = await executeTool(call)
          this.messages.push({
            role: 'tool',
            content: JSON.stringify({
              toolCallId: call.id,
              content: JSON.stringify({
                result: execution.result,
                worldview: execution.worldview,
                ...(execution.knownMap == null ? {} : { knownMap: execution.knownMap }),
                turnEnded: execution.turnEnded,
              }),
            }),
          })
          answeredToolCallIds.add(call.id)
          turnEnded = execution.turnEnded
        }
      }
      if (executeTool != null) {
        // Provider protocols require one result for every advertised tool call,
        // including calls rejected during normalization or skipped at the cap.
        for (const rawCall of response.toolCalls) {
          if (answeredToolCallIds.has(rawCall.id)) continue
          this.messages.push({
            role: 'tool',
            content: JSON.stringify({
              toolCallId: rawCall.id,
              content: JSON.stringify({
                result: {
                  kind: 'invalid',
                  reason: normalizeToolCall(rawCall) == null
                    ? 'Invalid tool name or arguments'
                    : 'Turn has ended or tool call limit reached',
                },
                turnEnded:
                  turnEnded ||
                  callCount >= this.maxToolCallsPerTurn ||
                  queryCount >= this.maxToolCallsPerTurn,
              }),
            }),
          })
        }
      }
    } while (
      !turnEnded &&
      (finishReason === 'tool_calls' || (executeTool != null && responseHadToolCalls)) &&
      callCount < this.maxToolCallsPerTurn &&
      queryCount < this.maxToolCallsPerTurn
    )

    if (executeTool == null) {
      return allToolCalls
    }

    const costUnknown = responses.some((response) => response.costUsd === 'unknown')
    const trace: ModelTrace = {
      toolCalls: allToolCalls,
      assistantText: responses
        .map((response) => response.assistantText)
        .filter((text): text is string => text != null && text.length > 0)
        .join('\n') || undefined,
      reasoningContent: responses
        .map((response) => response.reasoningContent)
        .filter((text): text is string => text != null && text.length > 0)
        .join('\n') || undefined,
      tokensIn: responses.reduce((sum, response) => sum + response.tokensIn, 0),
      tokensOut: responses.reduce((sum, response) => sum + response.tokensOut, 0),
      costUsd: costUnknown
        ? 'unknown'
        : responses.reduce((sum, response) => sum + (response.costUsd as number), 0),
      latencyMs: responses.reduce((sum, response) => sum + response.latencyMs, 0),
      finishReason: responses.at(-1)?.finishReason ?? 'unknown',
    }
    return { toolCalls: allToolCalls, modelTrace: trace, executed: true }
  }
}
