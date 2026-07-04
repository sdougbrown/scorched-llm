import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { AnthropicModel } from '../src/model/anthropic-model.js'
import type { ModelSpec } from '../src/config/schema.js'
import type { ModelRequest } from '../src/model/types.js'

function makeSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    name: 'test-model',
    baseURL: 'http://localhost:9999',
    model: 'claude-sonnet-4-20250514',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    ...overrides,
  }
}

function makeRequest(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    messages: [{ role: 'system', content: 'You are a tank agent.' }],
    tools: [
      { name: 'move', description: 'Move the tank', parameters: { direction: { type: 'string' }, distance: { type: 'number' } } },
      { name: 'fire_shell', description: 'Fire a shell', parameters: { angle: { type: 'number' }, power: { type: 'number' } } },
      { name: 'pass', description: 'Pass', parameters: {} },
    ],
    ...overrides,
  }
}

function createMockServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()! as { port: number }
      resolve({ server, port: addr.port })
    })
  })
}

async function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
  })
}

describe('AnthropicModel', () => {
  describe('success: tool calls', () => {
    let server: http.Server
    let port: number

    beforeEach(async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tc1', name: 'move', input: { direction: 'N', distance: 3 } },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 100, output_tokens: 20 },
        }))
      })
      server = result.server
      port = result.port
    })

    afterEach(async () => { await closeServer(server) })

    it('returns normalized tool calls', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key'
      try {
        const spec = makeSpec({ baseURL: `http://127.0.0.1:${port}` })
        const model = new AnthropicModel(spec)
        const result = await model.query(makeRequest())

        expect(result.toolCalls.length).toBe(1)
        expect(result.toolCalls[0].id).toBe('tc1')
        expect(result.toolCalls[0].name).toBe('move')
        expect(result.toolCalls[0].arguments).toEqual({ direction: 'N', distance: 3 })
        expect(result.finishReason).toBe('tool_calls')
        expect(result.tokensIn).toBe(100)
        expect(result.tokensOut).toBe(20)
        expect(result.latencyMs).toBeGreaterThan(0)
        expect(result.raw).toBeDefined()
      } finally {
        delete process.env.ANTHROPIC_API_KEY
      }
    })
  })

  describe('success: text response', () => {
    it('returns assistantText for text content block', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'I will pass this turn.' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 50, output_tokens: 10 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('I will pass this turn.')
          expect(response.toolCalls).toEqual([])
          expect(response.finishReason).toBe('stop')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('request format', () => {
    it('preserves native thinking blocks and passes provider options', async () => {
      let capturedBody: Record<string, unknown> | undefined
      const result = await createMockServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          capturedBody = JSON.parse(body)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            content: [
              { type: 'thinking', thinking: 'Use cover.', signature: 'sig-2' },
              { type: 'text', text: 'Done' },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }))
        })
      })
      const prior = [
        { type: 'thinking', thinking: 'Move north.', signature: 'sig-1' },
        { type: 'tool_use', id: 'tc1', name: 'move', input: { direction: 'N', distance: 1 } },
      ]
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        const model = new AnthropicModel(makeSpec({
          baseURL: `http://127.0.0.1:${result.port}`,
          extraBody: { thinking: { type: 'enabled', budget_tokens: 4096 } },
        }))
        const response = await model.query(makeRequest({
          messages: [{ role: 'assistant', content: '[]', providerData: prior }],
        }))

        expect(capturedBody?.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 })
        expect(capturedBody?.messages).toEqual([{ role: 'assistant', content: prior }])
        expect(response.reasoningContent).toBe('Use cover.')
        expect(response.providerData).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'thinking', signature: 'sig-2' }),
        ]))
      } finally {
        delete process.env.ANTHROPIC_API_KEY
        await closeServer(result.server)
      }
    })

    it('sends system message in top-level system field', async () => {
      let capturedBody: unknown
      const result = await createMockServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => { capturedBody = JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_3',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedBody).toBeDefined()
          const body = capturedBody as Record<string, unknown>
          expect(body.system).toBe('You are a tank agent.')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('sends tool results as { role: "user", content: [{ type: "tool_result", tool_use_id, content }] }', async () => {
      let capturedBody: unknown
      const result = await createMockServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => { capturedBody = JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_4',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query({
            messages: [
              { role: 'system', content: 'You are a tank agent.' },
              { role: 'assistant', content: JSON.stringify([{ type: 'tool_use', id: 'tc1', name: 'move', input: { direction: 'N' } }]) },
              { role: 'tool', content: JSON.stringify({ toolCallId: 'tc1', content: 'moved north' }) },
            ],
            tools: [],
          })
          expect(capturedBody).toBeDefined()
          const body = capturedBody as Record<string, unknown>
          const msgs = body.messages as Array<{ role: string; content: unknown[] }>
          const lastMsg = msgs[msgs.length - 1]
          expect(lastMsg.role).toBe('user')
          expect(Array.isArray(lastMsg.content)).toBe(true)
          const contentBlock = lastMsg.content[0] as Record<string, unknown>
          expect(contentBlock.type).toBe('tool_result')
          expect(contentBlock.tool_use_id).toBe('tc1')
          expect(contentBlock.content).toBe('moved north')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('sends tools as [{ name, description, input_schema }]', async () => {
      let capturedBody: unknown
      const result = await createMockServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => { capturedBody = JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_5',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedBody).toBeDefined()
          const body = capturedBody as Record<string, unknown>
          expect(Array.isArray(body.tools)).toBe(true)
          const tool = body.tools[0] as Record<string, unknown>
          expect(tool.name).toBe('move')
          expect(tool.description).toBe('Move the tank')
          expect(tool.input_schema).toEqual({ direction: { type: 'string' }, distance: { type: 'number' } })
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('headers', () => {
    it('sends x-api-key header', async () => {
      const capturedHeaders: Record<string, string> = {}
      const result = await createMockServer((req, res) => {
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            capturedHeaders[key] = value
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_6',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'my-secret-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedHeaders['x-api-key']).toBe('my-secret-key')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('sends anthropic-version header', async () => {
      const capturedHeaders: Record<string, string> = {}
      const result = await createMockServer((req, res) => {
        for (const [key, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') {
            capturedHeaders[key] = value
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_7',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedHeaders['anthropic-version']).toBe('2023-06-01')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('error handling', () => {
    it('fails immediately on 400 (bad request)', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Bad request' } }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await expect(model.query(makeRequest())).rejects.toThrow('AnthropicModel: 400')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('retries on 429 (rate limit)', async () => {
      let callCount = 0
      const result = await createMockServer((_req, res) => {
        callCount++
        if (callCount === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'Rate limited' } }))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_8',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }))
        }
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
          expect(callCount).toBe(2)
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('retries on 500 (server error)', async () => {
      let callCount = 0
      const result = await createMockServer((_req, res) => {
        callCount++
        if (callCount === 1) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end('Internal Server Error')
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_9',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }))
        }
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
          expect(callCount).toBe(2)
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('retries on network error', async () => {
      let callCount = 0
      const result = await createMockServer((_req, res) => {
        callCount++
        if (callCount === 1) {
          res.destroy()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_10',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
          expect(callCount).toBe(2)
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('cost calculation', () => {
    it('calculates cost with pricing metadata', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_11',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1000, output_tokens: 500 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({
            baseURL: `http://127.0.0.1:${result.port}`,
            pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
          })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.costUsd).toBeCloseTo((1000 / 1e6) * 3 + (500 / 1e6) * 15, 10)
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('returns unknown cost without pricing', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_12',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 100, output_tokens: 10 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.costUsd).toBe('unknown')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('secret handling', () => {
    it('resolves API key from env at query time', async () => {
      const result = await createMockServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_13',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}`, apiKeyEnv: 'CUSTOM_API_KEY' })
        const model = new AnthropicModel(spec)
        process.env.CUSTOM_API_KEY = 'custom-key-value'
        try {
          const response = await model.query(makeRequest())
          expect(response.raw).toBeDefined()
        } finally {
          delete process.env.CUSTOM_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('throws when API key env var is missing', async () => {
      const spec = makeSpec({ apiKeyEnv: 'MISSING_KEY' })
      const model = new AnthropicModel(spec)
      await expect(model.query(makeRequest())).rejects.toThrow('API key environment variable not set')
    })
  })

  describe('stop reason mapping', () => {
    it('maps tool_use to tool_calls', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_sr',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tc1', name: 'move', input: {} }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.finishReason).toBe('tool_calls')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('maps end_turn to stop', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_sr2',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.finishReason).toBe('stop')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('maps max_tokens to max_tokens', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_sr3',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'partial' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          const response = await model.query(makeRequest())
          expect(response.finishReason).toBe('max_tokens')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('baseURL', () => {
    it('appends /v1/messages to baseURL', async () => {
      let capturedUrl: string | undefined
      const result = await createMockServer((req, res) => {
        capturedUrl = req.url ?? undefined
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_url',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedUrl).toBe('/v1/messages')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('strips trailing slashes from baseURL before appending /v1/messages', async () => {
      let capturedUrl: string | undefined
      const result = await createMockServer((req, res) => {
        capturedUrl = req.url ?? undefined
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          id: 'msg_url2',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }))
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}/` })
          const model = new AnthropicModel(spec)
          await model.query(makeRequest())
          expect(capturedUrl).toBe('/v1/messages')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('timeout', () => {
    it('throws when request exceeds perTurnTimeoutMs', async () => {
      const result = await createMockServer((_req, _res) => {
        // Never respond — keep connection open
        setTimeout(() => {}, 10000)
      })
      try {
        process.env.ANTHROPIC_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new AnthropicModel(spec, { perTurnTimeoutMs: 50 })
          await expect(model.query(makeRequest())).rejects.toThrow('request timed out after 50ms')
        } finally {
          delete process.env.ANTHROPIC_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })
})
