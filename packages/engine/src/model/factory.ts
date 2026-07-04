import type { Model } from './types.js'
import type { ModelSpec } from '../config/schema.js'
import { HttpModel } from './http-model.js'
import { AnthropicModel } from './anthropic-model.js'
import { OpenAIResponsesModel } from './openai-responses-model.js'

export interface CreateModelOptions {
  perTurnTimeoutMs?: number
}

export function createModel(spec: ModelSpec, options?: CreateModelOptions): Model {
  if (spec.protocol === 'anthropic-messages') {
    return new AnthropicModel(spec, options)
  }
  if (spec.protocol === 'openai-responses') {
    return new OpenAIResponsesModel(spec, options)
  }
  if (spec.protocol === 'openai-chat') {
    return new HttpModel(spec, options)
  }
  const baseURL = spec.baseURL.toLowerCase()
  if (baseURL.includes('anthropic.com') || baseURL.includes('claude')) {
    return new AnthropicModel(spec, options)
  }
  return new HttpModel(spec, options)
}
