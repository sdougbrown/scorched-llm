import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { HttpModel } from '../src/model/http-model.js'
import type { ModelSpec } from '../src/config/schema.js'
import type { ModelRequest } from '../src/model/types.js'

function makeSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    name: 'test-model',
    baseURL: 'http://localhost:9999',
    model: 'gpt-4',
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

describe('HttpModel', () => {
  describe('success: tool calls', () => {
    let server: http.Server
    let port: number

    beforeEach(async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'tc1',
                  type: 'function',
                  function: { name: 'move', arguments: JSON.stringify({ direction: 'N', distance: 3 }) },
                },
              ],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }))
      })
      server = result.server
      port = result.port
    })

    afterEach(async () => { await closeServer(server) })

    it('returns normalized tool calls', async () => {
      process.env.OPENAI_API_KEY = 'test-key'
      try {
        const spec = makeSpec({ baseURL: `http://127.0.0.1:${port}` })
        const model = new HttpModel(spec)
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
        delete process.env.OPENAI_API_KEY
      }
    })

    it('handles text-only response', async () => {
      let handlerCalled = false
      const result = await createMockServer((_req, res) => {
        handlerCalled = true
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'I will pass this turn.', tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 50, completion_tokens: 10 },
        }))
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          const response = await model.query(makeRequest())
          expect(handlerCalled).toBe(true)
          expect(response.assistantText).toBe('I will pass this turn.')
          expect(response.toolCalls).toEqual([])
          expect(response.finishReason).toBe('stop')
        } finally {
          delete process.env.OPENAI_API_KEY
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
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          await expect(model.query(makeRequest())).rejects.toThrow('HttpModel: 400')
        } finally {
          delete process.env.OPENAI_API_KEY
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
            choices: [{
              message: { role: 'assistant', content: 'ok', tool_calls: null },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }))
        }
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
          expect(callCount).toBe(2)
        } finally {
          delete process.env.OPENAI_API_KEY
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
            choices: [{
              message: { role: 'assistant', content: 'ok', tool_calls: null },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }))
        }
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
          expect(callCount).toBe(2)
        } finally {
          delete process.env.OPENAI_API_KEY
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
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }))
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({
            baseURL: `http://127.0.0.1:${result.port}`,
            pricing: { inputPerMillionUsd: 5, outputPerMillionUsd: 15 },
          })
          const model = new HttpModel(spec)
          const response = await model.query(makeRequest())
          expect(response.costUsd).toBeCloseTo((1000 / 1e6) * 5 + (500 / 1e6) * 15, 6)
        } finally {
          delete process.env.OPENAI_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('returns unknown cost without pricing', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: '', tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }))
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          const response = await model.query(makeRequest())
          expect(response.costUsd).toBe('unknown')
        } finally {
          delete process.env.OPENAI_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('secret handling', () => {
    it('resolves API key from env at query time', async () => {
      const result = await createMockServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: 'ok', tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }))
      })
      try {
        const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}`, apiKeyEnv: 'TEST_API_KEY' })
        const model = new HttpModel(spec)
        process.env.TEST_API_KEY = 'test-key-123'
        try {
          const response = await model.query(makeRequest())
          expect(response.assistantText).toBe('ok')
        } finally {
          delete process.env.TEST_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })

    it('sends request without Authorization header when API key env var is missing', async () => {
      let capturedAuth: string | undefined
      const result = await createMockServer((req, res) => {
        capturedAuth = req.headers.authorization
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }))
      })
      try {
        const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}`, apiKeyEnv: 'MISSING_KEY' })
        delete process.env.MISSING_KEY
        const model = new HttpModel(spec)
        await model.query(makeRequest())
        expect(capturedAuth).toBeUndefined()
      } finally {
        await closeServer(result.server)
      }
    })
  })

  describe('request format', () => {
    it('sends correct OpenAI format with tools', async () => {
      let capturedBody: unknown
      const result = await createMockServer((req, res) => {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => { capturedBody = JSON.parse(body) })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          choices: [{
            message: { role: 'assistant', content: null, tool_calls: null },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }))
      })
      try {
        process.env.OPENAI_API_KEY = 'test-key'
        try {
          const spec = makeSpec({ baseURL: `http://127.0.0.1:${result.port}` })
          const model = new HttpModel(spec)
          await model.query(makeRequest())
          expect(capturedBody).toBeDefined()
          const body = capturedBody as Record<string, unknown>
          expect(body.model).toBe('gpt-4')
          expect(Array.isArray(body.messages)).toBe(true)
          expect(body.messages.length).toBeGreaterThan(0)
          expect(body.messages[0]).toHaveProperty('role', 'system')
          expect(Array.isArray(body.tools)).toBe(true)
          expect(body.tools[0]).toHaveProperty('type', 'function')
          expect(body.tools[0].function).toHaveProperty('name', 'move')
        } finally {
          delete process.env.OPENAI_API_KEY
        }
      } finally {
        await closeServer(result.server)
      }
    })
  })
})
