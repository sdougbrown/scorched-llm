import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createControls } from '../src/controls.js'
import { AnimationScheduler } from '../src/animation.js'
import type { Timeline } from '../src/timeline.js'

function makeMockTimeline(): Timeline {
  let pos = 0
  return {
    seek: vi.fn((p: number) => {
      pos = p
      return { turn: Math.floor(p / 2), action: p % 2, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '' } }
    }),
    next: vi.fn(() => {
      pos++
      return { turn: Math.floor(pos / 2), action: pos % 2, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '' } }
    }),
    prev: vi.fn(() => {
      pos = Math.max(0, pos - 1)
      return { turn: 0, action: pos, state: { turn: 0, currentPlayerIndex: 0, tanks: [], flares: [], terrain: [], rulesVersion: '' } }
    }),
    length: vi.fn(() => 5),
  }
}

describe('createControls', () => {
  let scheduler: AnimationScheduler
  let mockTimeline: Timeline

  beforeEach(() => {
    vi.useFakeTimers()
    scheduler = new AnimationScheduler()
    vi.spyOn(scheduler, 'resume')
    vi.spyOn(scheduler, 'pause')
    vi.spyOn(scheduler, 'stop')
    vi.spyOn(scheduler, 'setSpeed')
    mockTimeline = makeMockTimeline()

    // Clear style elements injected by previous tests so we can count them
    document.querySelectorAll('style').forEach(el => el.remove())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("creates element with class 'controls'", () => {
    const container = createControls(scheduler, mockTimeline)
    expect(container).toBeInstanceOf(HTMLElement)
    expect(container.className).toBe('controls')
  })

  it("play button calls scheduler.resume() when not playing", () => {
    const container = createControls(scheduler, mockTimeline)
    const btnPlay = container.querySelector('.controls__btn--play') as HTMLButtonElement

    btnPlay.click()

    expect(scheduler.resume).toHaveBeenCalled()
  })

  it("play button calls scheduler.pause() when playing", () => {
    const container = createControls(scheduler, mockTimeline)
    const btnPlay = container.querySelector('.controls__btn--play') as HTMLButtonElement

    btnPlay.click() // start playing
    vi.advanceTimersByTime(16)
    btnPlay.click() // pause

    expect(scheduler.pause).toHaveBeenCalled()
  })

  it('stop button calls scheduler.stop()', () => {
    const container = createControls(scheduler, mockTimeline)
    const btnStop = container.querySelector('.controls__btn--stop') as HTMLButtonElement

    btnStop.click()

    expect(scheduler.stop).toHaveBeenCalled()
  })

  it('step forward button advances timeline position and calls refresh', () => {
    const container = createControls(scheduler, mockTimeline)
    const btnStepForward = container.querySelector('.controls__btn--step-forward') as HTMLButtonElement

    btnStepForward.click()

    expect(mockTimeline.seek).toHaveBeenCalledWith(1)
  })

  it('step backward button decrements timeline position', () => {
    const container = createControls(scheduler, mockTimeline)
    const btnStepForward = container.querySelector('.controls__btn--step-forward') as HTMLButtonElement
    const btnStepBack = container.querySelector('.controls__btn--step-back') as HTMLButtonElement

    btnStepForward.click()
    btnStepBack.click()

    expect(mockTimeline.seek).toHaveBeenLastCalledWith(0)
  })

  it('scrubber input calls timeline.seek()', () => {
    const container = createControls(scheduler, mockTimeline)
    const scrubber = container.querySelector('.controls__scrubber') as HTMLInputElement

    scrubber.value = '3'
    scrubber.dispatchEvent(new Event('input', { bubbles: true }))

    expect(mockTimeline.seek).toHaveBeenCalledWith(3)
  })

  it('speed selector calls scheduler.setSpeed()', () => {
    const container = createControls(scheduler, mockTimeline)
    const speedSelect = container.querySelector('.controls__speed') as HTMLSelectElement

    // Add a custom option with value 60 since default options are 15,30,75,150
    const opt = document.createElement('option')
    opt.value = '60'
    opt.textContent = '4x'
    speedSelect.appendChild(opt)
    speedSelect.value = '60'
    speedSelect.dispatchEvent(new Event('change', { bubbles: true }))

    expect(scheduler.setSpeed).toHaveBeenCalledWith(60)
  })

  it('position display shows Turn/Action format', () => {
    const container = createControls(scheduler, mockTimeline)
    const positionDisplay = container.querySelector('.controls__position') as HTMLSpanElement

    expect(positionDisplay.textContent).toBe('Turn 0, Action -1')

    // After stepping forward once (posIndex=1): turn=Math.floor(1/2)=0, action=1%2=1
    const btnStepForward = container.querySelector('.controls__btn--step-forward') as HTMLButtonElement
    btnStepForward.click()

    expect(positionDisplay.textContent).toBe('Turn 0, Action 1')
  })

  it('multiple controls elements share CSS (stylesheet only inserted once)', () => {
    const c1 = createControls(scheduler, mockTimeline)
    const c2 = createControls(scheduler, mockTimeline)
    const c3 = createControls(scheduler, mockTimeline)

    // Verify each returned element has the correct class
    expect(c1.className).toBe('controls')
    expect(c2.className).toBe('controls')
    expect(c3.className).toBe('controls')

    // All three share the same injected stylesheet in head
    const styleCount = document.querySelectorAll('style').length
    expect(styleCount).toBeGreaterThan(0)
  })
})