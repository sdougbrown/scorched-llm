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
  private onPositionChange: ((index: number) => void) | null = null

  play(
    timeline: Timeline,
    renderer: ArenaRenderer,
    config: MatchConfig,
    fps: number = 30,
    startIndex: number = 0,
    onPositionChange?: (index: number) => void,
  ): void {
    this.timeline = timeline
    this.renderer = renderer
    this.config = config
    this.onPositionChange = onPositionChange ?? null
    this.fps = fps
    this.frameInterval = 1000 / fps
    this.playing = true
    this.currentIndex = Math.max(0, Math.min(startIndex, timeline.length() - 1))
    this.lastFrameTime = performance.now()

    // Render the first frame immediately
    const pos = timeline.seek(this.currentIndex)
    renderer.render(pos.state, config, { showFog: true, showTrajectories: false, animate: true })
    this.onPositionChange?.(this.currentIndex)
    this.currentIndex++

    if (this.currentIndex >= timeline.length()) {
      this.playing = false
    } else {
      this.tick()
    }
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

      // Render current frame immediately on resume
      const pos = this.timeline.seek(Math.max(0, this.currentIndex - 1))
      this.renderer.render(pos.state, this.config, { showFog: true, showTrajectories: false, animate: true })
      this.onPositionChange?.(Math.max(0, this.currentIndex - 1))

      this.tick()
    }
  }

  stop(): void {
    this.pause()
    this.currentIndex = 0
    this.timeline = null
    this.renderer = null
    this.config = null
    this.onPositionChange = null
  }

  setSpeed(fps: number): void {
    this.fps = fps
    this.frameInterval = 1000 / fps
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get isAtEnd(): boolean {
    return this.timeline !== null && this.currentIndex >= this.timeline.length()
  }

  getCurrentPosition(): TimelinePosition | null {
    if (!this.timeline) return null
    return this.timeline.seek(this.currentIndex)
  }

  renderAt(position: number): TimelinePosition | null {
    if (!this.timeline || !this.renderer || !this.config) return null

    this.pause()
    const clampedPosition = Math.max(0, Math.min(position, this.timeline.length() - 1))
    const pos = this.timeline.seek(clampedPosition)
    this.renderer.render(pos.state, this.config, {
      showFog: true,
      showTrajectories: false,
      animate: true,
    })
    this.onPositionChange?.(clampedPosition)
    this.currentIndex = clampedPosition + 1
    return pos
  }

  private tick = (): void => {
    if (!this.playing || !this.timeline || !this.renderer || !this.config) return

    const now = performance.now()
    const elapsed = now - this.lastFrameTime

    if (elapsed >= this.frameInterval) {
      this.lastFrameTime = now - (elapsed % this.frameInterval)

      const pos = this.timeline.seek(this.currentIndex)
      this.renderer.render(pos.state, this.config, { showFog: true, showTrajectories: false, animate: true })
      this.onPositionChange?.(this.currentIndex)

      this.currentIndex++

      if (this.currentIndex >= this.timeline.length()) {
        this.playing = false
      }
    }

    if (this.playing) {
      this.rafId = requestAnimationFrame(this.tick)
    }
  }
}
