import { describe, it, expect } from 'vitest'
import { createModel } from '../src/model/factory.js'
import { HttpModel } from '../src/model/http-model.js'
import { AnthropicModel } from '../src/model/anthropic-model.js'
import type { ModelSpec } from '../src/config/schema.js'

function makeSpec(overrides: Partial<ModelSpec> = {}): ModelSpec {
  return {
    name: 'test-model',
    baseURL: 'http://localhost:9999',
    model: 'test',
    ...overrides,
  }
}

describe('createModel', () => {
  it('returns AnthropicModel for anthropic.com URL', () => {
    const spec = makeSpec({ baseURL: 'https://api.anthropic.com' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(AnthropicModel)
  })

  it('returns AnthropicModel for claude URL', () => {
    const spec = makeSpec({ baseURL: 'https://claude.example.com' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(AnthropicModel)
  })

  it('returns HttpModel for OpenAI URL', () => {
    const spec = makeSpec({ baseURL: 'https://api.openai.com' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(HttpModel)
  })

  it('returns HttpModel for localhost', () => {
    const spec = makeSpec({ baseURL: 'http://localhost:11434' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(HttpModel)
  })

  it('returns HttpModel for Groq URL', () => {
    const spec = makeSpec({ baseURL: 'https://api.groq.com' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(HttpModel)
  })

  it('returns HttpModel for OpenRouter URL', () => {
    const spec = makeSpec({ baseURL: 'https://openrouter.ai/api/v1' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(HttpModel)
  })

  it('returns HttpModel for local vLLM', () => {
    const spec = makeSpec({ baseURL: 'http://localhost:8000/v1' })
    const model = createModel(spec)
    expect(model).toBeInstanceOf(HttpModel)
  })
})