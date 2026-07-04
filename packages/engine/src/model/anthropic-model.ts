import type { Model, ModelRequest, NormalizedModelResponse, NormalizedToolCall } from './types.js'
import type { ModelSpec } from '../config/schema.js'

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

interface AnthropicRequestBody {
  [key: string]: unknown
  model: string
  system?: string
  messages: AnthropicMessage[]
  tools?: AnthropicTool[]
  temperature?: number
  max_tokens: number
}

interface AnthropicUsage {
  input_tokens: number
  output_tokens: number
}

interface AnthropicContentBlockOut {
  type: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  text?: string
  thinking?: string
  signature?: string
}

interface AnthropicResponse {
  content: AnthropicContentBlockOut[]
  stop_reason: 'tool_use' | 'end_turn' | 'max_tokens' | null
  usage: AnthropicUsage
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') {
    return true
  }
  return err instanceof Error && !('status' in err)
}

function buildAnthropicMessages(messages: ModelRequest['messages']): {
  system?: string
  messages: AnthropicMessage[]
} {
  let systemText = ''
  const result: AnthropicMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemText += msg.content
    } else if (msg.role === 'assistant') {
      if (Array.isArray(msg.providerData)) {
        result.push({
          role: 'assistant',
          content: msg.providerData as AnthropicContentBlock[],
        })
        continue
      }
      try {
        const parsed = JSON.parse(msg.content)
        if (Array.isArray(parsed) && parsed.every((b: { type: string }) => b.type === 'tool_use')) {
          result.push({
            role: 'assistant',
            content: parsed as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }[],
          })
          continue
        }
      } catch {
        // Not JSON, fall through to plain text
      }
      result.push({
        role: 'assistant',
        content: msg.content,
      })
    } else if (msg.role === 'tool') {
      let toolCallId: string | undefined
      let toolContent: string = msg.content

      try {
        const parsed = JSON.parse(msg.content)
        toolCallId = typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined
        if (typeof parsed.content === 'string') {
          toolContent = parsed.content
        }
      } catch {
        // Not JSON, use raw content
      }

      if (toolCallId != null) {
        result.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolCallId, content: toolContent }],
        })
      } else {
        result.push({
          role: 'user',
          content: toolContent,
        })
      }
    } else {
      result.push({
        role: 'user' as const,
        content: msg.content,
      })
    }
  }

  return { system: systemText || undefined, messages: result }
}

function buildAnthropicTools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }))
}

function redactSecretHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (headers == null || Object.keys(headers).length === 0) {
    return undefined
  }
  const secretPatterns = /secret|key|token|auth/i
  const redacted: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (secretPatterns.test(k)) {
      redacted[k] = '***REDACTED***'
    } else {
      redacted[k] = v
    }
  }
  return redacted
}

export class AnthropicModel implements Model {
  private spec: ModelSpec
  private perTurnTimeoutMs: number
  private secretHeaders: Record<string, string> | undefined

  constructor(spec: ModelSpec, options?: { perTurnTimeoutMs?: number }) {
    this.spec = spec
    this.perTurnTimeoutMs = options?.perTurnTimeoutMs ?? 30000
    this.secretHeaders = spec.headers ? redactSecretHeaders(spec.headers) : undefined
  }

  async query(request: ModelRequest): Promise<NormalizedModelResponse> {
    const apiKey = process.env[this.spec.apiKeyEnv ?? 'ANTHROPIC_API_KEY']
    if (apiKey == null) {
      throw new Error(`API key environment variable not set: ${this.spec.apiKeyEnv ?? 'ANTHROPIC_API_KEY'}`)
    }

    const baseUrl = this.spec.baseURL.replace(/\/+$/, '')
    const url = `${baseUrl}/v1/messages`

    const { system, messages: anthropicMessages } = buildAnthropicMessages(request.messages)
    const anthropicTools = buildAnthropicTools(request.tools)

    const body: AnthropicRequestBody = {
      ...this.spec.extraBody,
      model: this.spec.model,
      messages: anthropicMessages,
      max_tokens: request.maxTokens ?? this.spec.parameters?.maxTokens ?? 4096,
    }

    if (system != null && system !== '') {
      body.system = system
    }

    if (anthropicTools.length > 0) {
      body.tools = anthropicTools
    }

    if (request.temperature != null) {
      body.temperature = request.temperature
    } else if (this.spec.parameters?.temperature != null) {
      body.temperature = this.spec.parameters.temperature
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }

    if (this.spec.headers) {
      for (const [k, v] of Object.entries(this.spec.headers)) {
        headers[k] = v
      }
    }

    let timedOut = false
    const controller = new AbortController()
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort() }, this.perTurnTimeoutMs)

    let latencyMs = 0
    let response: Response | null = null
    let retries = 0
    const maxRetries = 3
    let lastError: Error | null = null

    try {
      while (retries <= maxRetries) {
        const requestStartTime = performance.now()
        try {
          const fetchResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          latencyMs = performance.now() - requestStartTime

          if (fetchResponse.status >= 400 && isRetryable(fetchResponse.status) && retries < maxRetries) {
            retries++
            const delay = Math.min(1000 * Math.pow(2, retries - 1), 10000)
            process.stderr.write(`AnthropicModel: retry ${retries}/${maxRetries} after status ${fetchResponse.status}, waiting ${delay}ms\n`)
            await sleep(delay)
            continue
          }
          if (fetchResponse.status >= 400) {
            const responseBody = await fetchResponse.text()
            throw new Error(`AnthropicModel: ${fetchResponse.status} ${responseBody}`)
          }

          response = fetchResponse
          break
        } catch (err) {
          latencyMs = performance.now() - requestStartTime

          if (err instanceof DOMException && err.name === 'AbortError') {
            if (timedOut) {
              throw new Error(`AnthropicModel: request timed out after ${this.perTurnTimeoutMs}ms`)
            }
            throw err
          }

          if (err instanceof Error && err.message.startsWith('AnthropicModel:')) {
            throw err
          }

          lastError = err as Error
          if (isRetryableError(err) && retries < maxRetries) {
            retries++
            const delay = Math.min(1000 * Math.pow(2, retries - 1), 10000)
            process.stderr.write(`AnthropicModel: retry ${retries}/${maxRetries}, waiting ${delay}ms\n`)
            await sleep(delay)
            continue
          }
          throw lastError
        }
      }
    } finally {
      clearTimeout(timeoutId)
    }

    if (response == null) {
      throw lastError ?? new Error('AnthropicModel: no response received')
    }

    const data: AnthropicResponse = await response.json()

    let assistantText: string | undefined
    const reasoning: string[] = []
    const toolCalls: NormalizedToolCall[] = []

    if (data.content != null && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text' && block.text != null) {
          if (assistantText == null) {
            assistantText = block.text
          } else {
            assistantText += '\n' + block.text
          }
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? '',
            name: block.name ?? '',
            arguments: block.input ?? {},
          })
        } else if (block.type === 'thinking' && block.thinking != null) {
          reasoning.push(block.thinking)
        }
      }
    }

    let finishReason: string
    switch (data.stop_reason) {
      case 'tool_use':
        finishReason = 'tool_calls'
        break
      case 'max_tokens':
        finishReason = 'max_tokens'
        break
      default:
        finishReason = 'stop'
    }

    const tokensIn = data.usage?.input_tokens ?? 0
    const tokensOut = data.usage?.output_tokens ?? 0

    let costUsd: number | 'unknown'
    if (this.spec.pricing != null) {
      costUsd = (tokensIn / 1e6) * this.spec.pricing.inputPerMillionUsd +
        (tokensOut / 1e6) * this.spec.pricing.outputPerMillionUsd
    } else {
      costUsd = 'unknown'
    }

    return {
      assistantText,
      reasoningContent: reasoning.join('\n') || undefined,
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      finishReason,
      providerData: data.content,
      raw: data,
    }
  }
}
