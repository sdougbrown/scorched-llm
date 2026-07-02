import type { MatchConfig } from '@scorched-llm/engine'
import type { Timeline, TimelinePosition } from './timeline.js'
import type { ArenaRenderer } from './arena.js'

export class AnimationScheduler {
  private playing = false
  private currentIndex = 0
  private fps = 30
  private rafId: number | null = null
  private lastFrameTime = 0
  private frameInterval = 1000 / 30
  private timeline: Timeline | null = null
  private renderer: ArenaRenderer | null = null
  private config: MatchConfig | null = null

  play(timeline: Timeline, renderer: ArenaRenderer, config: MatchConfig, fps: number = 30): void {
    this.timeline = timeline
    this.renderer = renderer
    this.config = config
    this.fps = fps
    this.frameInterval = 1000 / fps
    this.playing = true
    this.currentIndex = 0
    this.lastFrameTime = performance.now()
    this.tick()
  }

  pause(): void {
    this.playing = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  resume(): void {
    if (this.timeline && this.renderer && this.config) {
      this.playing = true
      this.lastFrameTime = performance.now()
      this.tick()
    }
  }

  stop(): void {
    this.pause()
    this.currentIndex = 0
    this.timeline = null
    this.renderer = null
    this.config = null
  }

  setSpeed(fps: number): void {
    this.fps = fps
    this.frameInterval = 1000 / fps
  }

  get isPlaying(): boolean {
    return this.playing
  }

  getCurrentPosition(): TimelinePosition | null {
    if (!this.timeline) return null
    return this.timeline.seek(this.currentIndex)
  }

  private tick = (): void => {
    if (!this.playing || !this.timeline || !this.renderer || !this.config) return

    const now = performance.now()
    const elapsed = now - this.lastFrameTime

    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now - (elapsed % this.frameInterval)

      const pos = this.timeline.seek(this.currentIndex)
      this.renderer.render(pos.state, this.config, { showFog: true, showTrajectories: false, animate: true })

      this.currentIndex++

      if (this.currentIndex >= this.timeline.length()) {
        this.currentIndex = 0
      }
    }

    if (this.playing) {
      this.rafId = requestAnimationFrame(this.tick)
    }
  }
}