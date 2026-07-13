import type { MatchConfig } from '../config/schema.js'
import type { TankAgent } from '../match/fake-agents.js'
import { createAggressiveAgent, createConservativeAgent } from '../match/scripted-agents.js'
import type { CliRunHooks } from './hooks.js'

/**
 * Resolve a `scripted` config name to an agent. The engine knows only its
 * two spec baselines; every tournament entrant is injected via hooks.
 */
export function resolveScriptedAgent(
  kind: string,
  tankId: string,
  config: MatchConfig,
  hooks: CliRunHooks,
): TankAgent {
  if (kind === 'aggressive') return createAggressiveAgent(tankId)
  if (kind === 'conservative') return createConservativeAgent(tankId)
  const factory = hooks.scriptedAgents?.[kind]
  if (factory) return factory(tankId, config)
  throw new Error(`Unknown scripted type: ${kind}`)
}
