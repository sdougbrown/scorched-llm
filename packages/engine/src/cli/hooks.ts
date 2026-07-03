import type { MatchLog } from '../types/log.js'

export interface CliRunProgress {
  currentMatch: number
  totalMatches: number
}

export interface CliRunHooks {
  onLiveLog?: (log: MatchLog, progress: CliRunProgress) => void
}
