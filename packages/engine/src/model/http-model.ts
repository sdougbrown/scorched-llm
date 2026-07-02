import type { Model, ModelRequest, NormalizedModelResponse, NormalizedToolCall } from './types.js'
import type { ModelSpec } from '../config/schema.js'

export interface HttpModelOptions {
  perTurnTimeoutMs?: number
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAIRequestBody {
  model: string
  messages: OpenAIMessage[]
  tools?: { type: 'function'; function: Record<string, unknown> }[]
  temperature?: number
  max_tokens?: number
}

interface OpenAIChoice {
  message: {
    role?: string
    content?: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string | null
}

interface OpenAIUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
}

interface OpenAIResponse {
  choices: OpenAIChoice[]
  usage?: OpenAIUsage
}

const TOOL_CALL_CONTENT_PREFIX = '{"type":"tool_use",'

function isToolCallContent(content: string): boolean {
  return content.startsWith(TOOL_CALL_CONTENT_PREFIX)
}

function parseToolCallContent(content: string): Array<{
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}> {
  try {
    return JSON.parse(content)
  } catch {
    return []
  }
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

function buildOpenAIMessages(
  messages: Array<{ role: string; content: string }>,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = []

  for (const msg of messages) {
    if (msg.role === 'tool') {
      let toolCallId: string | undefined
      try {
        const parsed = JSON.parse(msg.content)
        toolCallId = typeof parsed.toolCallId === 'string' ? parsed.toolCallId : undefined
      } catch {
        // Not JSON, ignore
      }
      result.push({
        role: 'tool',
        content: msg.content,
        tool_call_id: toolCallId,
      })
    } else if (msg.role === 'assistant' && isToolCallContent(msg.content)) {
      const toolCalls = parseToolCallContent(msg.content)
      const openaiToolCalls: OpenAIToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      }))
      result.push({
        role: 'assistant',
        tool_calls: openaiToolCalls,
      })
    } else {
      result.push({
        role: msg.role as OpenAIMessage['role'],
        content: msg.content,
      })
    }
  }

  return result
}

function buildOpenAITools(tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>): {
  type: 'function'
  function: Record<string, unknown>
}[] {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
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
  // Network errors are retryable
  return err instanceof Error && !('status' in err)
}

export class HttpModel implements Model {
  private spec: ModelSpec
  private perTurnTimeoutMs: number
  private secretHeaders: Record<string, string> | undefined

  constructor(spec: ModelSpec, options?: HttpModelOptions) {
    this.spec = spec
    this.perTurnTimeoutMs = options?.perTurnTimeoutMs ?? 30000
    this.secretHeaders = spec.headers ? redactSecretHeaders(spec.headers) : undefined
  }

  async query(request: ModelRequest): Promise<NormalizedModelResponse> {
    const apiKey = process.env[this.spec.apiKeyEnv ?? 'OPENAI_API_KEY']
    if (apiKey == null) {
      throw new Error(`API key environment variable not set: ${this.spec.apiKeyEnv ?? 'OPENAI_API_KEY'}`)
    }

    const baseUrl = this.spec.baseURL.replace(/\/+$/, '')
    const url = `${baseUrl}/chat/completions`

    const openaiMessages = buildOpenAIMessages(request.messages)
    const openaiTools = buildOpenAITools(request.tools)

    const body: OpenAIRequestBody = {
      model: this.spec.model,
      messages: openaiMessages,
    }

    if (openaiTools.length > 0) {
      body.tools = openaiTools
    }

    if (request.temperature != null) {
      body.temperature = request.temperature
    } else if (this.spec.parameters?.temperature != null) {
      body.temperature = this.spec.parameters.temperature
    }

    if (request.maxTokens != null) {
      body.max_tokens = request.maxTokens
    } else if (this.spec.parameters?.maxTokens != null) {
      body.max_tokens = this.spec.parameters.maxTokens
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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

          // Check status — retry if retryable, otherwise return or throw
          if (fetchResponse.status >= 400 && isRetryable(fetchResponse.status) && retries < maxRetries) {
            retries++
            const delay = Math.min(1000 * Math.pow(2, retries - 1), 10000)
            process.stderr.write(`HttpModel: retry ${retries}/${maxRetries} after status ${fetchResponse.status}, waiting ${delay}ms\n`)
            await sleep(delay)
            continue
          }
          if (fetchResponse.status >= 400) {
            const responseBody = await fetchResponse.text()
            throw new Error(`HttpModel: ${fetchResponse.status} ${responseBody}`)
          }

          response = fetchResponse
          break
        } catch (err) {
          latencyMs = performance.now() - requestStartTime

          if (err instanceof DOMException && err.name === 'AbortError') {
            if (timedOut) {
              throw new Error(`HttpModel: request timed out after ${this.perTurnTimeoutMs}ms`)
            }
            throw err
          }

          // Re-throw HttpModel errors (from status check above)
          if (err instanceof Error && err.message.startsWith('HttpModel:')) {
            throw err
          }

          lastError = err as Error
          if (isRetryableError(err) && retries < maxRetries) {
            retries++
            const delay = Math.min(1000 * Math.pow(2, retries - 1), 10000)
            process.stderr.write(`HttpModel: retry ${retries}/${maxRetries}, waiting ${delay}ms\n`)
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
      throw lastError ?? new Error('HttpModel: no response received')
    }

    // Parse response
    const data: OpenAIResponse = await response.json()
    const choice = data.choices?.[0]

    if (choice == null) {
      throw new Error('HttpModel: empty response — no choices')
    }

    const message = choice.message
    let assistantText: string | undefined
    const toolCalls: NormalizedToolCall[] = []
    let finishReason: string

    if (message.content != null && message.content !== '') {
      assistantText = message.content
    }

    if (message.tool_calls != null && message.tool_calls.length > 0) {
      finishReason = choice.finish_reason ?? 'stop'
      for (const tc of message.tool_calls) {
        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(tc.function.arguments)
        } catch {
          // Keep empty object if parsing fails
        }
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        })
      }
    } else {
      finishReason = choice.finish_reason ?? 'stop'
    }

    if (finishReason == null || finishReason === '') {
      finishReason = 'stop'
    }

    const tokensIn = data.usage?.prompt_tokens ?? 0
    const tokensOut = data.usage?.completion_tokens ?? 0

    let costUsd: number | 'unknown'
    if (this.spec.pricing != null) {
      costUsd = (tokensIn / 1e6) * this.spec.pricing.inputPerMillionUsd +
        (tokensOut / 1e6) * this.spec.pricing.outputPerMillionUsd
    } else {
      costUsd = 'unknown'
    }

    return {
      assistantText,
      toolCalls,
      tokensIn,
      tokensOut,
      costUsd,
      latencyMs,
      finishReason,
      raw: data,
    }
  }
}
