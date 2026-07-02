import type { Model, ModelRequest, NormalizedModelResponse } from './types.js'

/** Default response returned when the fake model queue is exhausted. */
function defaultResponse(): NormalizedModelResponse {
  return {
    assistantText: 'pass',
    toolCalls: [],
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 1,
    finishReason: 'stop',
  }
}

/** Deterministic fake model that returns pre-scripted responses in order. */
export class FakeModel implements Model {
  private queue: NormalizedModelResponse[]
  private callCount: number

  constructor(responses: NormalizedModelResponse[]) {
    this.queue = [...responses]
    this.callCount = 0
  }

  get callCount_(): number {
    return this.callCount
  }

  async query(_request: ModelRequest): Promise<NormalizedModelResponse> {
    this.callCount++
    if (this.queue.length > 0) {
      return this.queue.shift()!
    }
    return defaultResponse()
  }
}