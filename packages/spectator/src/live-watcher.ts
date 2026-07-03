import type { MatchLog } from '@scorched-llm/engine'
import { loadMatchLog } from './log-loader.js'

const POLL_INTERVAL_MS = 1500

type FetchResult = MatchLog | { error: string }

export class LiveWatcher {
  private url: string
  private onUpdate: (log: MatchLog) => void
  private onComplete: () => void
  private timerId: ReturnType<typeof setTimeout> | null
  private currentTurns: number
  private _isComplete: boolean
  private _status: 'disconnected' | 'connecting' | 'polling' | 'complete'
  private consecutiveNoChange: number

  constructor(
    url: string,
    onUpdate: (log: MatchLog) => void,
    onComplete: () => void,
  ) {
    this.url = url
    this.onUpdate = onUpdate
    this.onComplete = onComplete
    this.timerId = null
    this.currentTurns = 0
    this._isComplete = false
    this._status = 'disconnected'
    this.consecutiveNoChange = 0
  }

  start(): void {
    if (this.timerId !== null) return

    this._status = 'connecting'
    this.poll()
  }

  stop(): void {
    if (this.timerId === null) return

    clearTimeout(this.timerId)
    this.timerId = null
    this._status = 'disconnected'
    this._isComplete = false
  }

  get isComplete(): boolean {
    return this._isComplete
  }

  get status(): 'disconnected' | 'connecting' | 'polling' | 'complete' {
    return this._status
  }

  private poll(): void {
    if (this._isComplete) return

    this.fetchAndProcess().then(() => {
      if (!this._isComplete) {
        this.timerId = setTimeout(() => this.poll(), POLL_INTERVAL_MS)
      }
    })
  }

  private async fetchAndProcess(): Promise<void> {
    try {
      const response = await globalThis.fetch(this.url)

      if (!response.ok) {
        this._status = 'connecting'
        return
      }

      const text = await response.text()
      let log: MatchLog

      try {
        log = loadMatchLog(text)
      } catch {
        this._status = 'connecting'
        return
      }

      if (this._status === 'connecting') {
        this._status = 'polling'
        this.consecutiveNoChange = 0
      }

      const newTurnCount = log.turns.length

      if (newTurnCount > this.currentTurns) {
        this.onUpdate(log)
        this.currentTurns = newTurnCount
        this.consecutiveNoChange = 0
      } else {
        this.consecutiveNoChange++
      }

      const terminationReason = log.result.terminationReason
      const isTerminated =
        terminationReason === 'last-standing' ||
        terminationReason === 'mutual-destruction'

      if (isTerminated || this.consecutiveNoChange >= 2) {
        this._isComplete = true
        this._status = 'complete'
        this.onComplete()
      }
    } catch {
      if (this._status !== 'polling') {
        this._status = 'connecting'
      }
    }
  }
}