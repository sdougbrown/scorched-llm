import type { Model } from './types.js'
import type { ModelSpec } from '../config/schema.js'
import { HttpModel } from './http-model.js'
import { AnthropicModel } from './anthropic-model.js'

export function createModel(spec: ModelSpec): Model {
  const baseURL = spec.baseURL.toLowerCase()
  if (baseURL.includes('anthropic.com') || baseURL.includes('claude')) {
    return new AnthropicModel(spec)
  }
  return new HttpModel(spec)
}