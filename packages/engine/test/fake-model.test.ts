import { describe, it, expect } from 'vitest'
import { FakeModel } from '../src/model/fake-model.js'
import type { NormalizedModelResponse, ModelRequest } from '../src/model/types.js'

function makeResponse(overrides: Partial<NormalizedModelResponse> = {}): NormalizedModelResponse {
  return {
    assistantText: 'ok',
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
    latencyMs: 10,
    finishReason: 'stop',
    ...overrides,
  }
}

describe('FakeModel', () => {
  it('returns responses from queue in order', async () => {
    const responses: NormalizedModelResponse[] = [
      makeResponse({ assistantText: 'first' }),
      makeResponse({ assistantText: 'second' }),
      makeResponse({ assistantText: 'third' }),
    ]
    const model = new FakeModel(responses)

    const r1 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r1.assistantText).toBe('first')

    const r2 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r2.assistantText).toBe('second')

    const r3 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r3.assistantText).toBe('third')
  })

  it('tracks call count', async () => {
    const model = new FakeModel([makeResponse()])
    expect(model.callCount_).toBe(0)

    await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(model.callCount_).toBe(1)

    await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(model.callCount_).toBe(2)
  })

  it('returns default response when queue is empty', async () => {
    const model = new FakeModel([])
    const response = await model.query({ messages: [], tools: [] } as ModelRequest)

    expect(response.assistantText).toBe('pass')
    expect(response.toolCalls).toEqual([])
    expect(response.tokensIn).toBe(0)
    expect(response.tokensOut).toBe(0)
    expect(response.costUsd).toBe(0)
    expect(response.latencyMs).toBe(1)
    expect(response.finishReason).toBe('stop')
  })

  it('returns default response after queue is exhausted', async () => {
    const model = new FakeModel([makeResponse({ assistantText: 'queued' })])

    const r1 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r1.assistantText).toBe('queued')

    const r2 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r2.assistantText).toBe('pass')

    const r3 = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(r3.assistantText).toBe('pass')
  })

  it('returns tool calls from the queue', async () => {
    const response = makeResponse({
      toolCalls: [
        { id: 'tc1', name: 'move', arguments: { direction: 'N', distance: 3 } },
        { id: 'tc2', name: 'fire_shell', arguments: { angle: 45, power: 7 } },
      ],
    })
    const model = new FakeModel([response])

    const result = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(result.toolCalls.length).toBe(2)
    expect(result.toolCalls[0].name).toBe('move')
    expect(result.toolCalls[0].arguments).toEqual({ direction: 'N', distance: 3 })
    expect(result.toolCalls[1].name).toBe('fire_shell')
    expect(result.toolCalls[1].arguments).toEqual({ angle: 45, power: 7 })
  })

  it('preserves finishReason and raw fields', async () => {
    const response = makeResponse({
      finishReason: 'tool_calls',
      raw: { providerSpecific: true, nested: { data: 42 } },
    })
    const model = new FakeModel([response])

    const result = await model.query({ messages: [], tools: [] } as ModelRequest)
    expect(result.finishReason).toBe('tool_calls')
    expect(result.raw).toEqual({ providerSpecific: true, nested: { data: 42 } })
  })
})