import { z } from 'zod'

export const ModelSpecSchema = z.object({
  name: z.string(),
  baseURL: z.string().url(),
  protocol: z.enum(['openai-chat', 'openai-responses', 'anthropic-messages']).optional(),
  apiKeyEnv: z.string().optional(),
  model: z.string(),
  headers: z.record(z.string()).optional(),
  extraBody: z.record(z.unknown()).optional(),
  parameters: z.object({
    temperature: z.number().optional(),
    seed: z.number().optional(),
    maxTokens: z.number().optional(),
  }).optional(),
  pricing: z.object({
    inputPerMillionUsd: z.number(),
    outputPerMillionUsd: z.number(),
  }).optional(),
})
export type ModelSpec = z.infer<typeof ModelSpecSchema>

export const ScriptedAgentSchema = z.enum(['aggressive', 'conservative', 'fable', 'glm', 'deepseek', 'qwen-27b', 'haiku', 'sonnet', 'opus', 'gpt-5.4', 'gpt-5.5', 'gemini', 'kimi', 'minimax', 'gemma', 'fable-fresh', 'sonnet-5b', 'nemotron', 'sonnet-4.6', 'deepseek-pro', 'opus-4.6', 'mimo', 'step'])
export type ScriptedAgentKind = z.infer<typeof ScriptedAgentSchema>

export const PlayerSpecSchema = z.object({
  label: z.string(),
  startPosition: z.union([
    z.object({ x: z.number().int(), y: z.number().int() }),
    z.literal('random'),
  ]),
  model: ModelSpecSchema.optional(),
  scripted: ScriptedAgentSchema.optional(),
}).refine(
  (data) => (data.model !== undefined) !== (data.scripted !== undefined),
  { message: 'PlayerSpec must have exactly one of: model, scripted' }
)
export type PlayerSpec = z.infer<typeof PlayerSpecSchema>

export const MatchConfigSchema = z.object({
  rulesVersion: z.string(),
  seed: z.number().int(),
  spawnStrategy: z.enum(['random', 'symmetric']).optional(),
  map: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
    obstacleDensity: z.number().min(0).max(1),
    generatorVersion: z.string(),
    obstacleHeight: z.number(),
  }),
  players: z.array(PlayerSpecSchema).min(2),
  fog: z.object({
    localRadius: z.number().min(0),
    flareRadius: z.number().min(1),
    flareDuration: z.literal('one-round-global'),
  }),
  actionEconomy: z.enum(['single', 'double']).default('double'),
  moveMax: z.number().int().min(1).optional(),
  shell: z.object({
    maxRange: z.number().int().min(1),
    apexHeight: z.number(),
    tankHeight: z.number(),
  }),
  lethality: z.object({
    hitsToKill: z.union([z.literal(1), z.literal(2)]),
  }).default({ hitsToKill: 2 }),
  turnLimit: z.number().int().min(1),
  perTurnTimeoutMs: z.number().int().min(0),
  maxToolCallsPerTurn: z.number().int().min(1),
})
export type MatchConfig = z.infer<typeof MatchConfigSchema>

export const DEFAULT_MATCH_CONFIG: Partial<MatchConfig> = {
  actionEconomy: 'double',
  lethality: { hitsToKill: 2 },
}

/** Apply defaults to raw config, then validate through the schema. */
export function parseMatchConfig(raw: unknown): MatchConfig {
  const withDefaults = Object.assign({}, raw) as Record<string, unknown>
  if (withDefaults.actionEconomy == null) withDefaults.actionEconomy = 'double'
  if (withDefaults.lethality == null) withDefaults.lethality = { hitsToKill: 2 }

  const result = MatchConfigSchema.parse(withDefaults)

  if (result.moveMax === undefined) {
    return { ...result, moveMax: result.fog.flareRadius } as MatchConfig
  }
  return result
}
