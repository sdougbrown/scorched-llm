import type { NormalizedModelResponse } from './types.js'
import type { ToolCall } from '../types/tool.js'
import type { ModelTrace } from '../types/events.js'

/**
 * Convert a NormalizedModelResponse into a ModelTrace.
 * The caller must provide the ToolCall[] that were actually executed
 * (after validation), since the trace records what the engine did,
 * not just what the model returned.
 */
export function buildModelTrace(
  response: NormalizedModelResponse,
  toolCalls: ToolCall[],
): ModelTrace {
  return {
    toolCalls,
    assistantText: response.assistantText,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    costUsd: response.costUsd,
    latencyMs: response.latencyMs,
    finishReason: response.finishReason,
  }
}