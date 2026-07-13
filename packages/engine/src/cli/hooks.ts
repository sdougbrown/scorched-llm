import type { MatchLog } from '../types/log.js'
import type { MatchConfig } from '../config/schema.js'
import type { TankAgent } from '../match/fake-agents.js'

export interface CliRunProgress {
  currentMatch: number
  totalMatches: number
}

export interface CliRunHooks {
  onLiveLog?: (log: MatchLog, progress: CliRunProgress) => void
  /**
   * Factories for scripted tank entrants, keyed by their `scripted` config
   * name. The engine ships only the aggressive/conservative baselines;
   * entrants live in @scorched-llm/bots and are injected by the runner.
   */
  scriptedAgents?: Record<string, (tankId: string, config: MatchConfig) => TankAgent>
}
