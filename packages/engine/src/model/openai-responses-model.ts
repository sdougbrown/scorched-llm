import type { ModelSpec } from '../config/schema.js'
import type { AgentMessage, ToolSpec } from '../match/fake-agents.js'
import type { Model, ModelRequest, NormalizedModelResponse, NormalizedToolCall } from './types.js'

interface ResponsesFunctionCall {
  type: 'function_call'
  call_id: string
  name: string
  arguments: string
}

interface ResponsesOutputText {
  type: 'output_text'
  text: string
}

interface ResponsesMessage {
  type: 'message'
  role: 'assistant'
  content: ResponsesOutputText[]
}

interface ResponsesReasoning {
  type: 'reasoning'
  summary?: Array<{ type: string; text?: string }>
}

type ResponsesOutputItem = ResponsesFunctionCall | ResponsesMessage | ResponsesReasoning | Record<string, unknown>

interface ResponsesResponse {
  id?: string
  status?: string
  incomplete_details?: { reason?: string } | null
  output?: ResponsesOutputItem[]
  usage?: { input_tokens?: number; output_tokens?: number }
}

function parseToolCallContent(content: string): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  try {
    const value: unknown = JSON.parse(content)
    if (!Array.isArray(value)) return []
    return value.filter((item): item is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } => {
      if (typeof item !== 'object' || item == null) return false
      const candidate = item as Record<string, unknown>
      return candidate.type === 'tool_use' &&
        typeof candidate.id === 'string' &&
        typeof candidate.name === 'string' &&
        typeof candidate.input === 'object' && candidate.input != null
    })
  } catch {
    return []
  }
}

function parseToolResult(message: AgentMessage): { callId?: string; output: string } {
  try {
    const parsed = JSON.parse(message.content) as { toolCallId?: unknown; content?: unknown }
    return {
      callId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined,
      output: typeof parsed.content === 'string' ? parsed.content : message.content,
    }
  } catch {
    return { output: message.content }
  }
}

function buildInput(messages: AgentMessage[]): unknown[] {
  const input: unknown[] = []
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.providerData)) {
      input.push(...message.providerData)
      continue
    }
    if (message.role === 'assistant') {
      const calls = parseToolCallContent(message.content)
      if (calls.length > 0) {
        input.push(...calls.map((call) => ({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: JSON.stringify(call.input),
        })))
      } else {
        input.push({ role: 'assistant', content: message.content })
      }
      continue
    }
    if (message.role === 'tool') {
      const result = parseToolResult(message)
      if (result.callId != null) {
        input.push({ type: 'function_call_output', call_id: result.callId, output: result.output })
      } else {
        input.push({ role: 'user', content: result.output })
      }
      continue
    }
    input.push({ role: message.role, content: message.content })
  }
  return input
}

function buildTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }))
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class OpenAIResponsesModel implements Model {
  private spec: ModelSpec
  private perTurnTimeoutMs: number

  constructor(spec: ModelSpec, options?: { perTurnTimeoutMs?: number }) {
    this.spec = spec
    this.perTurnTimeoutMs = options?.perTurnTimeoutMs ?? 30000
  }

  async query(request: ModelRequest): Promise<NormalizedModelResponse> {
    const apiKeyEnv = this.spec.apiKeyEnv ?? 'OPENAI_API_KEY'
    const apiKey = process.env[apiKeyEnv]
    const baseURL = this.spec.baseURL.replace(/\/+$/, '')
    const url = baseURL.endsWith('/v1') ? `${baseURL}/responses` : `${baseURL}/v1/responses`
    const body: Record<string, unknown> = {
      ...this.spec.extraBody,
      model: this.spec.model,
      input: buildInput(request.messages),
      tools: buildTools(request.tools),
      max_output_tokens: request.maxTokens ?? this.spec.parameters?.maxTokens ?? 4096,
    }
    if (request.temperature != null) body.temperature = request.temperature
    else if (this.spec.parameters?.temperature != null) body.temperature = this.spec.parameters.temperature

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey != null) headers.Authorization = `Bearer ${apiKey}`
    Object.assign(headers, this.spec.headers ?? {})

    let timedOut = false
    const controller = new AbortController()
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, this.perTurnTimeoutMs)
    let response: Response | null = null
    let latencyMs = 0
    try {
      for (let attempt = 0; attempt <= 3; attempt++) {
        const startedAt = performance.now()
        try {
          const candidate = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          latencyMs = performance.now() - startedAt
          if (isRetryable(candidate.status) && attempt < 3) {
            await sleep(1000 * 2 ** attempt)
            continue
          }
          if (!candidate.ok) {
            const detail = await candidate.text()
            throw new Error(`OpenAIResponsesModel: HTTP ${candidate.status}: ${detail}`)
          }
          response = candidate
          break
        } catch (error) {
          if (timedOut) throw new Error(`OpenAIResponsesModel: request timed out after ${this.perTurnTimeoutMs}ms`)
          if (error instanceof Error && error.message.startsWith('OpenAIResponsesModel: HTTP ')) throw error
          if (attempt >= 3) throw error
          await sleep(1000 * 2 ** attempt)
        }
      }
    } finally {
      clearTimeout(timeoutId)
    }
    if (response == null) throw new Error('OpenAIResponsesModel: no response received')

    const data = await response.json() as ResponsesResponse
    const output = data.output ?? []
    const toolCalls: NormalizedToolCall[] = []
    const text: string[] = []
    const reasoning: string[] = []
    for (const item of output) {
      if (item.type === 'function_call') {
        const call = item as ResponsesFunctionCall
        let args: Record<string, unknown> = {}
        try { args = JSON.parse(call.arguments) as Record<string, unknown> } catch { /* invalid args remain empty */ }
        toolCalls.push({ id: call.call_id, name: call.name, arguments: args })
      } else if (item.type === 'message') {
        const message = item as ResponsesMessage
        for (const part of message.content ?? []) {
          if (part.type === 'output_text') text.push(part.text)
        }
      } else if (item.type === 'reasoning') {
        const thought = item as ResponsesReasoning
        for (const part of thought.summary ?? []) {
          if (typeof part.text === 'string') reasoning.push(part.text)
        }
      }
    }

    const tokensIn = data.usage?.input_tokens ?? 0
    const tokensOut = data.usage?.output_tokens ?? 0
    const costUsd = this.spec.pricing == null
      ? 'unknown' as const
      : (tokensIn / 1e6) * this.spec.pricing.inputPerMillionUsd +
        (tokensOut / 1e6) * this.spec.pricing.outputPerMillionUsd

    return {
      assistantText: text.join('\n') || undefined,
      reasoningContent: reasoning.join('\n') || undefined,
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      finishReason: toolCalls.length > 0
        ? 'tool_calls'
        : data.status === 'incomplete'
          ? data.incomplete_details?.reason ?? 'incomplete'
          : 'stop',
      providerData: output,
      raw: data,
    }
  }
}
