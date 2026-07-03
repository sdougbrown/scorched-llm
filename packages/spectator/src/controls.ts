import type { AnimationScheduler } from './animation.js'
import type { Timeline, TimelinePosition } from './timeline.js'

const CSS = `
.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #1a1a2e;
  border-top: 1px solid #333;
  color: #ccc;
  font-family: sans-serif;
  font-size: 14px;
}

.controls__btn {
  background: #2a2a3e;
  color: #ddd;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 6px 10px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: background 0.15s;
  flex-shrink: 0;
}

.controls__btn:hover {
  background: #3a3a5e;
}

.controls__btn:active {
  background: #4a4a6e;
}

.controls__scrubber {
  flex: 1 1 auto;
  min-width: 60px;
  height: 6px;
  accent-color: #6c63ff;
  cursor: pointer;
}

.controls__position {
  white-space: nowrap;
  font-size: 13px;
  color: #aaa;
  flex-shrink: 0;
  min-width: 100px;
  text-align: center;
}

.controls__speed {
  background: #2a2a3e;
  color: #ddd;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 6px;
  font-size: 13px;
  cursor: pointer;
  flex-shrink: 0;
}

.controls__speed:focus {
  outline: none;
  border-color: #6c63ff;
}

.controls__speed option {
  background: #2a2a3e;
  color: #ddd;
}
`

export function createControls(
  scheduler: AnimationScheduler,
  timeline: Timeline,
): HTMLElement {
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)

  const container = document.createElement('div')
  container.className = 'controls'

  const btnPlay = document.createElement('button')
  btnPlay.className = 'controls__btn controls__btn--play'
  btnPlay.textContent = '\u25B6'

  const btnStop = document.createElement('button')
  btnStop.className = 'controls__btn controls__btn--stop'
  btnStop.textContent = '\u23F9'

  const btnStepBack = document.createElement('button')
  btnStepBack.className = 'controls__btn controls__btn--step-back'
  btnStepBack.textContent = '\u23EE'

  const btnStepForward = document.createElement('button')
  btnStepForward.className = 'controls__btn controls__btn--step-forward'
  btnStepForward.textContent = '\u23ED'

  const maxVal = Math.max(timeline.length() - 1, 0)
  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.min = '0'
  scrubber.max = String(maxVal)
  scrubber.value = '0'
  scrubber.className = 'controls__scrubber'

  const positionDisplay = document.createElement('span')
  positionDisplay.className = 'controls__position'
  positionDisplay.textContent = 'Turn 0, Action -1'

  const speedSelect = document.createElement('select')
  speedSelect.className = 'controls__speed'

  const speedOptions: Array<[string, number]> = [
    ['1x', 15],
    ['2x', 30],
    ['5x', 75],
    ['10x', 150],
  ]

  for (const [label, value] of speedOptions) {
    const opt = document.createElement('option')
    opt.value = String(value)
    opt.textContent = label
    speedSelect.appendChild(opt)
  }

  container.append(btnPlay, btnStop, btnStepBack, btnStepForward, scrubber, positionDisplay, speedSelect)

  let posIndex = 0
  let playing = false
  let rafId: number | null = null

  function refresh(render: boolean = false): void {
    const pos: TimelinePosition =
      (render ? scheduler.renderAt(posIndex) : null) ?? timeline.seek(posIndex)
    positionDisplay.textContent = `Turn ${pos.turn}, Action ${pos.action}`
    scrubber.value = String(posIndex)
  }

  btnPlay.addEventListener('click', (): void => {
    if (playing) {
      scheduler.pause()
      playing = false
      btnPlay.textContent = '\u25B6'
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
        rafId = null
      }
    } else {
      scheduler.resume()
      playing = true
      btnPlay.textContent = '\u23F8'
      rafId = requestAnimationFrame(tick)
    }
  })

  btnStop.addEventListener('click', (): void => {
    scheduler.pause()
    playing = false
    posIndex = 0
    refresh(true)
    btnPlay.textContent = '\u25B6'
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  })

  btnStepBack.addEventListener('click', (): void => {
    if (posIndex > 0) {
      posIndex--
      refresh(true)
    }
  })

  btnStepForward.addEventListener('click', (): void => {
    if (posIndex < timeline.length() - 1) {
      posIndex++
      refresh(true)
    }
  })

  scrubber.addEventListener('input', (event: Event): void => {
    const target = event.target as HTMLInputElement
    posIndex = Number(target.value)
    refresh(true)
  })

  speedSelect.addEventListener('change', (event: Event): void => {
    const target = event.target as HTMLSelectElement
    const fps = Number(target.value)
    scheduler.setSpeed(fps)
  })

  function tick(): void {
    if (!playing) return
    if (posIndex < timeline.length() - 1) {
      posIndex++
    } else {
      playing = false
      btnPlay.textContent = '\u25B6'
      rafId = null
      return
    }
    refresh()
    rafId = requestAnimationFrame(tick)
  }

  return container
}
