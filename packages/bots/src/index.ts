import type { MatchConfig, TankAgent } from '@scorched-llm/engine'
import { createDeepSeekAgent } from './deepseek-agent.js'
import { createDeepSeekProAgent } from './deepseek-pro-agent.js'
import { createFableAgent } from './fable-agent.js'
import { createFableFreshAgent } from './fable-fresh-agent.js'
import { createGeminiAgent } from './gemini-agent.js'
import { createGemmaAgent } from './gemma-agent.js'
import { createGlmAgent } from './glm-agent.js'
import { createGpt54Agent } from './gpt-5.4-agent.js'
import { createGpt55Agent } from './gpt-5.5-agent.js'
import { createGptOssAgent } from './gpt-oss-agent.js'
import { createHaikuAgent } from './haiku-agent.js'
import { createKimiAgent } from './kimi-agent.js'
import { createMimoAgent } from './mimo-agent.js'
import { createMinimaxAgent } from './minimax-agent.js'
import { createNemotronAgent } from './nemotron-agent.js'
import { createNorthAgent } from './north-agent.js'
import { createOpusAgent, opusOptionsFromConfig } from './opus-agent.js'
import { createOpus46Agent } from './opus-4.6-agent.js'
import { createQwen27BAgent } from './qwen-agent.js'
import { createQwen35BAgent } from './qwen35b-agent.js'
import { createSonnetAgent } from './sonnet-agent.js'
import { createSonnet46Agent } from './sonnet-4.6-agent.js'
import { createSonnet5bAgent } from './sonnet-5b-agent.js'
import { createStepAgent } from './step-agent.js'

export * from './deepseek-agent.js'
export * from './deepseek-pro-agent.js'
export * from './fable-agent.js'
export * from './fable-fresh-agent.js'
export * from './gemini-agent.js'
export * from './gemma-agent.js'
export * from './glm-agent.js'
export * from './gpt-5.4-agent.js'
export * from './gpt-5.5-agent.js'
export * from './gpt-oss-agent.js'
export * from './haiku-agent.js'
export * from './kimi-agent.js'
export * from './mimo-agent.js'
export * from './minimax-agent.js'
export * from './nemotron-agent.js'
export * from './north-agent.js'
export * from './opus-agent.js'
export * from './opus-4.6-agent.js'
export * from './qwen-agent.js'
export * from './qwen35b-agent.js'
export * from './sonnet-agent.js'
export * from './sonnet-4.6-agent.js'
export * from './sonnet-5b-agent.js'
export * from './step-agent.js'

function geometryOptions(config: MatchConfig): {
  shellMaxRange: number
  moveMax: number
  mapWidth: number
  mapHeight: number
} {
  return {
    shellMaxRange: config.shell.maxRange,
    moveMax: config.moveMax ?? config.fog.flareRadius,
    mapWidth: config.map.width,
    mapHeight: config.map.height,
  }
}

/**
 * Registry of every tournament entrant, keyed by its `scripted` config name.
 * The engine CLI consumes this via `CliRunHooks.scriptedAgents`; the engine
 * itself knows nothing about entrants (aggressive/conservative baselines
 * excepted — they are part of the engine spec).
 */
export const SCRIPTED_AGENTS: Record<string, (tankId: string, config: MatchConfig) => TankAgent> = {
  fable: (tankId, config) => createFableAgent(tankId, config),
  'fable-fresh': (tankId, config) => createFableFreshAgent(tankId, config),
  glm: (tankId, config) => createGlmAgent(tankId, geometryOptions(config)),
  deepseek: (tankId) => createDeepSeekAgent(tankId),
  'deepseek-pro': (tankId) => createDeepSeekProAgent(tankId),
  'qwen-27b': (tankId) => createQwen27BAgent(tankId),
  qwen35b: (tankId) => createQwen35BAgent(tankId),
  haiku: (tankId) => createHaikuAgent(tankId),
  sonnet: (tankId, config) => createSonnetAgent(tankId, config),
  'sonnet-5b': (tankId) => createSonnet5bAgent(tankId),
  'sonnet-4.6': (tankId) => createSonnet46Agent(tankId),
  opus: (tankId, config) => createOpusAgent(tankId, opusOptionsFromConfig(config)),
  'opus-4.6': (tankId) => createOpus46Agent(tankId),
  'gpt-5.4': (tankId, config) => createGpt54Agent(tankId, {
    shellMaxRange: config.shell.maxRange,
    moveMax: config.moveMax ?? config.fog.flareRadius,
    flareMaxRange: config.fog.flareRadius,
    flareRadius: config.fog.flareRadius,
  }),
  'gpt-5.5': (tankId) => createGpt55Agent(tankId),
  'gpt-oss': (tankId) => createGptOssAgent(tankId),
  gemini: (tankId) => createGeminiAgent(tankId),
  gemma: (tankId) => createGemmaAgent(tankId),
  kimi: (tankId, config) => createKimiAgent(tankId, geometryOptions(config)),
  minimax: (tankId) => createMinimaxAgent(tankId),
  mimo: (tankId) => createMimoAgent(tankId),
  step: (tankId) => createStepAgent(tankId),
  nemotron: (tankId) => createNemotronAgent(tankId),
  north: (tankId) => createNorthAgent(tankId),
}

/** Every registered entrant name. */
export const BOT_NAMES: string[] = Object.keys(SCRIPTED_AGENTS)
