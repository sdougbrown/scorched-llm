import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { OpenAIResponsesModel } from '../src/model/openai-responses-model.js'
import type { ModelRequest } from '../src/model/types.js'
import type { ModelSpec } from '../src/config/schema.js'

const servers: http.Server[] = []

function createServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: (server.address() as { port: number }).port })
    })
  })
}

function request(messages: ModelRequest['messages']): ModelRequest {
  return {
    messages,
    tools: [{
      name: 'move',
      description: 'Move the tank',
      parameters: { type: 'object', properties: { direction: { type: 'string' } } },
    }],
  }
}

function spec(baseURL: string): ModelSpec {
  return {
    name: 'GPT-5.5',
    baseURL,
    protocol: 'openai-responses',
    apiKeyEnv: 'ZEN_TEST_KEY',
    model: 'gpt-5.5',
    extraBody: { reasoning: { effort: 'low', summary: 'auto' } },
    parameters: { maxTokens: 4096 },
  }
}

afterEach(async () => {
  delete process.env.ZEN_TEST_KEY
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

describe('OpenAIResponsesModel', () => {
  it('uses the Responses endpoint and normalizes reasoning and function calls', async () => {
    let path = ''
    let auth = ''
    let body: Record<string, unknown> = {}
    const { port } = await createServer((req, res) => {
      path = req.url ?? ''
      auth = req.headers.authorization ?? ''
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        body = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'completed',
          output: [
            { type: 'reasoning', id: 'r1', summary: [{ type: 'summary_text', text: 'Move into cover.' }] },
            { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'move', arguments: '{"direction":"N"}' },
          ],
          usage: { input_tokens: 25, output_tokens: 8 },
        }))
      })
    })
    process.env.ZEN_TEST_KEY = 'zen-key'

    const model = new OpenAIResponsesModel(spec(`http://127.0.0.1:${port}`))
    const result = await model.query(request([{ role: 'system', content: 'Play well.' }]))

    expect(path).toBe('/v1/responses')
    expect(auth).toBe('Bearer zen-key')
    expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto' })
    expect((body.tools as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'function', name: 'move' })
    expect(result.reasoningContent).toBe('Move into cover.')
    expect(result.toolCalls).toEqual([{ id: 'call-1', name: 'move', arguments: { direction: 'N' } }])
    expect(result.finishReason).toBe('tool_calls')
    expect(result.providerData).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'r1' })]))
  })

  it('replays native response items followed by function output', async () => {
    let body: Record<string, unknown> = {}
    const { port } = await createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        body = JSON.parse(raw)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }],
          usage: { input_tokens: 40, output_tokens: 2 },
        }))
      })
    })

    const nativeItems = [
      { type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'move', arguments: '{"direction":"N"}' },
    ]
    const model = new OpenAIResponsesModel(spec(`http://127.0.0.1:${port}`))
    const result = await model.query(request([
      { role: 'assistant', content: '[]', providerData: nativeItems },
      { role: 'tool', content: JSON.stringify({ toolCallId: 'call-1', content: '{"result":{"kind":"ok"}}' }) },
    ]))

    expect(body.input).toEqual([
      ...nativeItems,
      { type: 'function_call_output', call_id: 'call-1', output: '{"result":{"kind":"ok"}}' },
    ])
    expect(result.assistantText).toBe('Done')
  })
})
