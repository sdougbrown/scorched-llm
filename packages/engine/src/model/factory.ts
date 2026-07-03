import type { Model } from './types.js'
import type { ModelSpec } from '../config/schema.js'
import { HttpModel } from './http-model.js'
import { AnthropicModel } from './anthropic-model.js'

export interface CreateModelOptions {
  perTurnTimeoutMs?: number
}

export function createModel(spec: ModelSpec, options?: CreateModelOptions): Model {
  const baseURL = spec.baseURL.toLowerCase()
  if (baseURL.includes('anthropic.com') || baseURL.includes('claude')) {
    return new AnthropicModel(spec, options)
  }
  return new HttpModel(spec, options)
}
