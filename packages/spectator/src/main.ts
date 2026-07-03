import { createArenaRenderer, getTankColor } from './arena.js'
import type { ArenaRenderer } from './arena.js'
import { createTimeline } from './timeline.js'
import type { Timeline } from './timeline.js'
import { AnimationScheduler } from './animation.js'
import { createMatchLoader } from './match-loader.js'
import { createControls } from './controls.js'
import { createTracePanel, updateTracePanel } from './trace-panel.js'
import { createStatsOverlay, updateStatsOverlay } from './stats-overlay.js'
import { LiveWatcher } from './live-watcher.js'
import type { MatchLog } from '@scorched-llm/engine'


const stateRef: { current: AppState | null } = { current: null }

const CSS = `
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

html, body {
  height: 100%;
  overflow: hidden;
  background: #0d0d1a;
  color: #e0e0e0;
  font-family: 'Segoe UI', system-ui, sans-serif;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  background: #1a1a2e;
  border-bottom: 1px solid #2a2a4a;
  min-height: 36px;
  flex-shrink: 0;
  z-index: 10;
}

.app__header__title {
  font-size: 15px;
  font-weight: 700;
  color: #7f5af0;
  white-space: nowrap;
}

.app__header__info {
  font-size: 12px;
  color: #888;
  margin-left: 12px;
  white-space: nowrap;
}

.app__header__spacer {
  flex: 1;
}

.app__btn {
  background: #2a2a3e;
  color: #ddd;
  border: 1px solid #444;
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
  transition: background 0.15s;
}

.app__btn:hover {
  background: #3a3a5e;
}

.app__arena-container {
  flex: 1 1 auto;
  position: relative;
  overflow: hidden;
  background: #0a0a14;
  min-width: 0;
  min-height: 0;
}

.app__arena-container canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.app__main {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.app__traces {
  width: min(380px, 40vw);
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  min-height: 0;
  overscroll-behavior: contain;
  overflow-y: auto;
  overflow-x: hidden;
  background: #0d0d1a;
  border-left: 1px solid #2a2a4a;
}

.app__controls {
  flex-shrink: 0;
  z-index: 10;
}

.app__stats {
  flex-shrink: 0;
  max-height: 45vh;
  overflow-y: auto;
  z-index: 10;
}

.app__stats--hidden {
  display: none;
}

.app__loader {
  display: flex;
  align-items: center;
  justify-content: center;
  position: absolute;
  inset: 0;
  background: rgba(10, 10, 20, 0.9);
  z-index: 100;
  transition: opacity 0.2s ease;
}

.app__loader--hidden {
  display: none;
}

.app__error {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 20, 0.95);
  z-index: 200;
}

.app__error--hidden {
  display: none;
}

.app__error__message {
  color: #e74c3c;
  font-size: 16px;
  text-align: center;
  padding: 24px;
  background: #1a1a2e;
  border: 1px solid #e74c3c;
  border-radius: 8px;
  max-width: 500px;
}

.app__header__live {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #888;
}

.app__header__live--hidden {
  display: none;
}

.app__live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e74c3c;
  display: inline-block;
}

.app__live-dot--connecting {
  background: #f39c12;
}

.app__live-dot--complete {
  background: #2ecc71;
}

.app__live-text {
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.app__live-text--connecting {
  color: #f39c12;
}

.app__live-text--complete {
  color: #2ecc71;
}
`

let stylesheetInjected = false

function ensureStylesheet(): void {
  if (stylesheetInjected) return
  const styleEl = document.createElement('style')
  styleEl.textContent = CSS
  document.head.appendChild(styleEl)
  stylesheetInjected = true
}

interface AppState {
  log: MatchLog | null
  scheduler: AnimationScheduler | null
  timeline: Timeline | null
  renderer: ArenaRenderer | null
  controlsEl: HTMLElement | null
  tracePanels: Map<string, HTMLElement>
  statsEl: HTMLElement | null
  loaderEl: HTMLElement | null
  errorEl: HTMLElement | null
  posIndex: number
  resizeHandler: (() => void) | null
  liveBadgeEl: HTMLElement | null
  liveStopBtn: HTMLButtonElement | null
  headerInfoEl: HTMLElement | null
  watcher: LiveWatcher | null
  buildCtx: BuildContext | null
}

function buildApp(): AppState {
  ensureStylesheet()

  const root = document.getElementById('app')
  if (!root) {
    throw new Error('#app element not found')
  }

  root.innerHTML = ''
  root.className = 'app'

  const state: AppState = {
    log: null,
    scheduler: null,
    timeline: null,
    renderer: null,
    controlsEl: null,
    tracePanels: new Map(),
    statsEl: null,
    loaderEl: null,
    errorEl: null,
    posIndex: 0,
    resizeHandler: null,
    liveBadgeEl: null,
    liveStopBtn: null,
    headerInfoEl: null,
    watcher: null,
    buildCtx: null,
  }

  // Header
  const header = document.createElement('div')
  header.className = 'app__header'

  const titleEl = document.createElement('span')
  titleEl.className = 'app__header__title'
  titleEl.textContent = 'Spectator'

  const infoEl = document.createElement('span')
  infoEl.className = 'app__header__info'

  const spacer = document.createElement('div')
  spacer.className = 'app__header__spacer'

  const statsToggleBtn = document.createElement('button')
  statsToggleBtn.className = 'app__btn'
  statsToggleBtn.textContent = 'Stats'
  statsToggleBtn.addEventListener('click', (): void => {
    if (state.statsEl) {
      state.statsEl.classList.toggle('app__stats--hidden')
    }
  })

  header.append(titleEl, infoEl, spacer, statsToggleBtn)
  root.appendChild(header)

  // Live badge + stop button (hidden by default)
  const liveBadgeEl = document.createElement('span')
  liveBadgeEl.className = 'app__header__live app__header__live--hidden'

  const liveDot = document.createElement('span')
  liveDot.className = 'app__live-dot'

  const liveText = document.createElement('span')
  liveText.className = 'app__live-text app__live-text--connecting'
  liveText.textContent = 'CONNECTING'

  liveBadgeEl.appendChild(liveDot)
  liveBadgeEl.appendChild(liveText)

  const liveStopBtn = document.createElement('button')
  liveStopBtn.className = 'app__btn'
  liveStopBtn.textContent = 'Stop'

  const liveControlsContainer = document.createElement('div')
  liveControlsContainer.className = 'app__header__live app__header__live--hidden'
  liveControlsContainer.style.alignItems = 'center'
  liveControlsContainer.style.gap = '6px'
  liveControlsContainer.appendChild(liveBadgeEl)
  liveControlsContainer.setAttribute('hidden', '')
  liveControlsContainer.appendChild(liveStopBtn)

  header.insertBefore(liveControlsContainer, spacer)

  // Arena container
  const arenaContainer = document.createElement('div')
  arenaContainer.className = 'app__arena-container'

  const canvas = document.createElement('canvas')
  arenaContainer.appendChild(canvas)

  // Traces panel
  const tracesEl = document.createElement('div')
  tracesEl.className = 'app__traces'

  const mainEl = document.createElement('div')
  mainEl.className = 'app__main'
  mainEl.append(arenaContainer, tracesEl)
  root.appendChild(mainEl)

  // Controls placeholder — will be replaced on match load
  const controlsPlaceholder = document.createElement('div')
  controlsPlaceholder.className = 'app__controls'
  root.appendChild(controlsPlaceholder)
  state.controlsEl = controlsPlaceholder

  // Stats overlay
  const statsEl = document.createElement('div')
  statsEl.className = 'app__stats app__stats--hidden'
  statsEl.appendChild(createStatsOverlay())
  root.appendChild(statsEl)
  state.statsEl = statsEl

  // Loader overlay
  const loaderEl = document.createElement('div')
  loaderEl.className = 'app__loader'
  root.appendChild(loaderEl)
  state.loaderEl = loaderEl

  // Error overlay (hidden by default)
  const errorEl = document.createElement('div')
  errorEl.className = 'app__error app__error--hidden'
  const errorMsg = document.createElement('div')
  errorMsg.className = 'app__error__message'
  errorEl.appendChild(errorMsg)
  root.appendChild(errorEl)
  state.errorEl = errorEl

  // Match loader widget — placed inside loader overlay
  const matchLoader = createMatchLoader((log: MatchLog): void => {
    onLoadMatch(state, log, {
      arenaContainer,
      canvas,
      tracesEl,
      controlsPlaceholder,
      headerInfo: infoEl,
    })
  })
  loaderEl.appendChild(matchLoader)

  state.liveBadgeEl = liveBadgeEl
  state.liveStopBtn = liveStopBtn
  state.headerInfoEl = infoEl

  liveStopBtn.addEventListener('click', (): void => {
    stopLiveWatch(state, {
      arenaContainer,
      canvas,
      tracesEl,
      controlsPlaceholder,
      headerInfo: infoEl,
    })
  })

  return state
}

interface BuildContext {
  arenaContainer: HTMLDivElement
  canvas: HTMLCanvasElement
  tracesEl: HTMLDivElement
  controlsPlaceholder: HTMLDivElement
  headerInfo: HTMLSpanElement
}

function onLoadMatch(
  state: AppState,
  log: MatchLog,
  ctx: BuildContext,
  startPosition: number = 0,
): void {
  // Hide loader
  state.loaderEl!.innerHTML = ''
  state.loaderEl!.classList.add('app__loader--hidden')

  // Update header
  ctx.headerInfo.textContent = `${log.metadata.matchId} — ${log.turns.length} turns`

  state.scheduler?.stop()
  if (state.resizeHandler) {
    window.removeEventListener('resize', state.resizeHandler)
  }

  // Create scheduler
  const scheduler = new AnimationScheduler()
  state.scheduler = scheduler

  // Create timeline
  const timeline = createTimeline(log)
  state.timeline = timeline

  // Create renderer
  const renderer = createArenaRenderer(ctx.canvas)
  state.renderer = renderer

  // Resize handler
  function onResize(): void {
    const rect = ctx.arenaContainer.getBoundingClientRect()
    renderer.setSize(rect.width, rect.height)
  }
  onResize()
  window.addEventListener('resize', onResize)
  state.resizeHandler = onResize

  // Start scheduler
  scheduler.play(timeline, renderer, log.config, 30, startPosition)

  // Replace controls placeholder with real controls
  const controls = createControls(scheduler, timeline)
  ;(state.controlsEl ?? ctx.controlsPlaceholder).replaceWith(controls)
  state.controlsEl = controls

  // Create trace panels for each tank
  state.tracePanels.clear()
  ctx.tracesEl.innerHTML = ''

  for (let tankIndex = 0; tankIndex < log.initialState.tanks.length; tankIndex++) {
    const tank = log.initialState.tanks[tankIndex]
    const panel = createTracePanel(
      tank.id,
      log.config.players[tankIndex],
      getTankColor(tankIndex),
    )
    state.tracePanels.set(tank.id, panel)
    ctx.tracesEl.appendChild(panel)

    let latestTurn = undefined
    for (let i = log.turns.length - 1; i >= 0; i--) {
      if (log.turns[i].player === tank.id) {
        latestTurn = log.turns[i]
        break
      }
    }
    if (latestTurn) {
      updateTracePanel(panel, latestTurn, tank.id)
    }
  }

  // Update stats overlay content
  updateStatsOverlay(state.statsEl!, log)

  state.log = log
}

function startLiveWatch(state: AppState, url: string, ctx: BuildContext): void {
  const watcher = new LiveWatcher(
    url,
    (log: MatchLog) => {
      const oldLog = state.log

      if (!oldLog) {
        onLoadMatch(state, log, ctx)
        return
      }

      const firstNewPosition = state.timeline?.length() ?? 0
      onLoadMatch(state, log, ctx, firstNewPosition)
      state.posIndex = Math.max(0, firstNewPosition)

      ctx.headerInfo.textContent = `${log.metadata.matchId} — ${log.turns.length} turns`
    },
    () => {
      const liveDot = state.liveBadgeEl!.querySelector('.app__live-dot')
      if (liveDot) {
        liveDot.className = 'app__live-dot app__live-dot--complete'
      }
      const liveText = state.liveBadgeEl!.querySelector('.app__live-text')
      if (liveText) {
        liveText.className = 'app__live-text app__live-text--complete'
        liveText.textContent = 'COMPLETE'
      }
      state.watcher!.stop()
    },
  )

  watcher.start()
  state.watcher = watcher

  state.liveBadgeEl!.classList.remove('app__header__live--hidden')
  state.liveStopBtn!.removeAttribute('hidden')

  state.loaderEl!.innerHTML = '<div class="app__loader__text">Connecting to live stream...</div>'
  state.loaderEl!.classList.remove('app__loader--hidden')
}

function stopLiveWatch(state: AppState, ctx: BuildContext): void {
  if (state.watcher) {
    state.watcher.stop()
    state.watcher = null
  }

  state.liveBadgeEl!.classList.add('app__header__live--hidden')
  state.liveStopBtn!.setAttribute('hidden', '')

  state.loaderEl!.innerHTML = ''
  state.loaderEl!.classList.add('app__loader--hidden')

  const matchLoader = createMatchLoader((log: MatchLog): void => {
    onLoadMatch(state, log, ctx)
  })
  state.loaderEl!.appendChild(matchLoader)
}

function setupKeyboard(): void {
  function matchesShortcut(e: KeyboardEvent, key: string, mod?: boolean): boolean {
    if (e.key !== key) return false
    if (mod && !e.metaKey && !e.ctrlKey) return false
    if (!mod && (e.metaKey || e.ctrlKey)) return false
    return true
  }

  const shortcuts: Array<{ key: string; mod?: boolean; run: () => void }> = [
    {
      key: ' ',
      run(): void {
        const s = stateRef.current
        if (!s?.scheduler) return
        if (s.scheduler.isPlaying) {
          s.scheduler.pause()
        } else {
          s.scheduler.resume()
        }
      },
    },
    {
      key: 'ArrowLeft',
      run(): void {
        const s = stateRef.current
        if (!s?.timeline || !s?.renderer || !s?.log) return
        const pos = s.timeline.prev()
        s.renderer.render(pos.state, s.log.config, { showFog: true, showTrajectories: false, animate: true })
        s.posIndex = Number(pos.action < 0 ? 0 : pos.turn + pos.action + 1)
        if (s.scheduler) {
          s.scheduler.stop()
          s.scheduler.pause()
        }
      },
    },
    {
      key: 'ArrowRight',
      run(): void {
        const s = stateRef.current
        if (!s?.timeline || !s?.renderer || !s?.log) return
        const pos = s.timeline.next()
        s.renderer.render(pos.state, s.log.config, { showFog: true, showTrajectories: false, animate: true })
        s.posIndex = Number(pos.action < 0 ? 0 : pos.turn + pos.action + 1)
        if (s.scheduler) {
          s.scheduler.stop()
          s.scheduler.pause()
        }
      },
    },
    {
      key: 'Home',
      run(): void {
        const s = stateRef.current
        if (!s?.timeline || !s?.renderer || !s?.log) return
        const pos = s.timeline.seek(0)
        s.renderer.render(pos.state, s.log.config, { showFog: true, showTrajectories: false, animate: true })
        s.posIndex = 0
        if (s.scheduler) {
          s.scheduler.stop()
          s.scheduler.pause()
        }
      },
    },
    {
      key: 'End',
      run(): void {
        const s = stateRef.current
        if (!s?.timeline || !s?.renderer || !s?.log) return
        const lastPos = s.timeline.length() - 1
        const pos = s.timeline.seek(lastPos)
        s.renderer.render(pos.state, s.log.config, { showFog: true, showTrajectories: false, animate: true })
        s.posIndex = lastPos
        if (s.scheduler) {
          s.scheduler.stop()
          s.scheduler.pause()
        }
      },
    },
    {
      key: 'Escape',
      run(): void {
        const s = stateRef.current
        if (!s?.statsEl) return
        s.statsEl.classList.toggle('app__stats--hidden')
      },
    },
  ]

  function handler(e: KeyboardEvent): void {
    for (const shortcut of shortcuts) {
      if (matchesShortcut(e, shortcut.key, shortcut.mod)) {
        e.preventDefault()
        e.stopPropagation()
        shortcut.run()
        break
      }
    }
  }

  window.addEventListener('keydown', handler)
}

export function initApp(): AppState {
  const appState = buildApp()
  stateRef.current = appState

  const hash = window.location.hash.slice(1)
  const hashParams = new URLSearchParams(hash)
  const url = hashParams.get('url')
  if (url) {
    startLiveWatch(appState, url, {
      arenaContainer: (appState.loaderEl!.parentElement as HTMLElement).querySelector('.app__arena-container') as HTMLDivElement,
      canvas: (appState.loaderEl!.parentElement as HTMLElement).querySelector('canvas') as HTMLCanvasElement,
      tracesEl: (appState.loaderEl!.parentElement as HTMLElement).querySelector('.app__traces') as HTMLDivElement,
      controlsPlaceholder: appState.controlsEl as HTMLDivElement,
      headerInfo: appState.headerInfoEl as HTMLSpanElement,
    })
  }

  setupKeyboard()
  return appState
}

initApp()
