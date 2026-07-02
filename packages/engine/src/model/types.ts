import type { AgentMessage, ToolSpec } from '../match/fake-agents.js'

/** Normalized model request sent to any Model implementation. */
export interface ModelRequest {
  messages: AgentMessage[]
  tools: ToolSpec[]
  temperature?: number
  seed?: number
  maxTokens?: number
}

/** A parsed tool call from a model response. */
export interface NormalizedToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** Normalized model response — provider-agnostic. */
export interface NormalizedModelResponse {
  assistantText?: string
  toolCalls: NormalizedToolCall[]
  tokensIn: number
  tokensOut: number
  costUsd: number | 'unknown'
  latencyMs: number
  finishReason: string
  raw?: unknown
}

/** Model interface — any provider adapter implements this. */
export interface Model {
  query(request: ModelRequest): Promise<NormalizedModelResponse>
}