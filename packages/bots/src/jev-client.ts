import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk'

/**
 * Provider-agnostic "System One" decision interface.
 *
 * A decision client answers typed questions (choice / score / noul) about a
 * state blob. It holds no conversation memory: every `ask` is independent,
 * code owns all arithmetic, and the client only supplies judgment over the
 * closed sets it is offered. Jev (api.typesafe.ai) is the first
 * implementation; jev-clones and pre-existing classifiers (e.g. GLiNER) can
 * be trialed by implementing this interface.
 */

export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string }

export type DecisionAnswer =
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'noul'; noul: number }

export interface DecisionUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUsd: number | 'unknown'
  latencyMs: number
}

export interface DecisionResponse {
  answers: Record<string, DecisionAnswer>
  usage: DecisionUsage
}

export interface DecisionClient {
  /** Identifier recorded in traces (e.g. 'jev-latest', 'gliner-x'). */
  readonly id: string
  ask(state: unknown, questions: Record<string, DecisionQuestion>): Promise<DecisionResponse>
}

export interface TypeSafeClientOptions {
  model?: string
  apiKey?: string
  /** USD per million input tokens; output tokens are free on Jev. */
  pricePerMillionInputUsd?: number
}

function readApiKey(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    return readFileSync(join(process.env.HOME ?? '~', '.secrets', 'jev'), 'utf8').trim()
  } catch {
    throw new Error(
      'No Jev API key: set TYPESAFE_API_KEY or place the key in ~/.secrets/jev',
    )
  }
}

/** DecisionClient backed by the TypeSafe (Jev) API. */
export class TypeSafeDecisionClient implements DecisionClient {
  readonly id: string
  private client: TypeSafeClient
  private model: string
  private pricePerMillionInputUsd: number

  constructor(options: TypeSafeClientOptions = {}) {
    this.id = options.model ?? 'jev-latest'
    this.model = this.id
    this.pricePerMillionInputUsd = options.pricePerMillionInputUsd ?? 0.042
    this.client = new TypeSafeClient({
      apiKey: readApiKey(options.apiKey),
    })
  }

  async ask(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
  ): Promise<DecisionResponse> {
    const started = Date.now()
    const payloadQuestions: Record<string, unknown> = {}
    for (const [id, q] of Object.entries(questions)) {
      if (q.type === 'choice') {
        payloadQuestions[id] = choice(q.instructions, q.criteria)
      } else if (q.type === 'score') {
        payloadQuestions[id] = score(
          q.instructions,
          q.criteria as [string, string, ...string[]],
        )
      } else {
        payloadQuestions[id] = noul(q.instructions)
      }
    }

    const response = await this.client.systemOne({
      state: state as Parameters<typeof this.client.systemOne>[0]['state'],
      model: this.model,
      questions: payloadQuestions as Parameters<typeof this.client.systemOne>[0]['questions'],
    })

    const answers: Record<string, DecisionAnswer> = {}
    for (const [id, answer] of Object.entries(response.answers)) {
      if (answer.type === 'choice') {
        answers[id] = {
          type: 'choice',
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: (answer.probabilities ?? {}) as Record<string, number>,
        }
      } else if (answer.type === 'score') {
        answers[id] = { type: 'score', score: answer.score, confidence: answer.confidence }
      } else {
        answers[id] = { type: 'noul', noul: answer.noul }
      }
    }

    const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 }
    return {
      answers,
      usage: {
        model: response.model ?? this.model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        costUsd:
          (usage.input_tokens * this.pricePerMillionInputUsd) / 1_000_000,
        latencyMs: Date.now() - started,
      },
    }
  }
}
