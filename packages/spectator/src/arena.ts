import type { GameState, MatchConfig, Cell } from '@scorched-llm/engine'

export const TANK_COLORS = ['#4a90d9', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c'] as const

export function getTankColor(index: number): string {
  return TANK_COLORS[index % TANK_COLORS.length]
}

export interface RenderOptions {
  showFog: boolean
  showTrajectories: boolean
  animate: boolean
}

export interface ArenaRenderer {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  render(state: GameState, config: MatchConfig, options?: Partial<RenderOptions>): void
  setSize(width: number, height: number): void
}

const GROUND_SHADES = ['#20241b', '#1d211a', '#22261d', '#1e231c'] as const
const FOG_COLOR = 'rgba(6, 7, 14, 0.62)'
const ARENA_PADDING = 18

/** Deterministic per-cell shade so open ground reads as terrain, not a flat fill. */
function groundShade(x: number, y: number): string {
  const h = (((x * 2654435761) ^ (y * 40503)) >>> 0) % GROUND_SHADES.length
  return GROUND_SHADES[h]
}

/** Multiply a hex color's channels by `factor` (>1 lightens toward white). */
function shade(hex: string, factor: number): string {
  const n = parseInt(hex.slice(1), 16)
  const ch = (v: number): number => Math.max(0, Math.min(255, Math.round(factor >= 1 ? v + (255 - v) * (factor - 1) : v * factor)))
  const r = ch((n >> 16) & 0xff)
  const g = ch((n >> 8) & 0xff)
  const b = ch(n & 0xff)
  return `rgb(${r}, ${g}, ${b})`
}

interface Layout {
  cellSize: number
  offsetX: number
  offsetY: number
  mapWidth: number
  mapHeight: number
}

export function createArenaRenderer(canvas: HTMLCanvasElement): ArenaRenderer {
  const ctx = canvas.getContext('2d')!
  let width = 800
  let height = 800
  let previousState: GameState | null = null
  let lastFrame: { state: GameState; config: MatchConfig; options: Partial<RenderOptions> } | null = null
  const destructionEffects = new Map<string, {
    position: { x: number; y: number }
    color: string
    startedAt: number
  }>()
  const destructionDurationMs = 1200

  function getLayout(state: GameState): Layout {
    const mapHeight = state.terrain.length
    const mapWidth = state.terrain[0]?.length ?? 0
    const cellSize = Math.min(
      (width - ARENA_PADDING * 2) / Math.max(1, mapWidth),
      (height - ARENA_PADDING * 2) / Math.max(1, mapHeight),
    )
    return {
      cellSize,
      offsetX: (width - mapWidth * cellSize) / 2,
      offsetY: (height - mapHeight * cellSize) / 2,
      mapWidth,
      mapHeight,
    }
  }

  function cellOrigin(layout: Layout, col: number, row: number): { x: number; y: number } {
    return {
      x: layout.offsetX + col * layout.cellSize,
      y: layout.offsetY + row * layout.cellSize,
    }
  }

  function cellCenter(layout: Layout, col: number, row: number): { x: number; y: number } {
    const o = cellOrigin(layout, col, row)
    return { x: o.x + layout.cellSize / 2, y: o.y + layout.cellSize / 2 }
  }

  function pathRoundRect(x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.min(r, w / 2, h / 2)
    ctx.beginPath()
    ctx.moveTo(x + radius, y)
    ctx.lineTo(x + w - radius, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
    ctx.lineTo(x + w, y + h - radius)
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
    ctx.lineTo(x + radius, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
    ctx.lineTo(x, y + radius)
    ctx.quadraticCurveTo(x, y, x + radius, y)
    ctx.closePath()
  }

  function drawStar(cx: number, cy: number, spikes: number, outerR: number, innerR: number): void {
    ctx.beginPath()
    for (let i = 0; i < spikes * 2; i++) {
      const r = i % 2 === 0 ? outerR : innerR
      const angle = (Math.PI * i) / spikes - Math.PI / 2
      const x = cx + r * Math.cos(angle)
      const y = cy + r * Math.sin(angle)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
    ctx.fill()
  }

  function isCellVisible(cell: Cell, state: GameState, config: MatchConfig): boolean {
    if (!config.fog) return true
    const localRadius = config.fog.localRadius
    for (const tank of state.tanks) {
      if (!tank.alive) continue
      const dx = cell.coord.x - tank.position.x
      const dy = cell.coord.y - tank.position.y
      if (Math.sqrt(dx * dx + dy * dy) <= localRadius) return true
    }
    for (const flare of state.flares) {
      const dx = cell.coord.x - flare.targetCell.x
      const dy = cell.coord.y - flare.targetCell.y
      if (Math.sqrt(dx * dx + dy * dy) <= flare.radius) return true
    }
    return false
  }

  function drawBackground(layout: Layout): void {
    ctx.fillStyle = '#0a0a14'
    ctx.fillRect(0, 0, width, height)

    // Soft glow behind the battlefield so the grid floats above the chrome
    const cx = layout.offsetX + (layout.mapWidth * layout.cellSize) / 2
    const cy = layout.offsetY + (layout.mapHeight * layout.cellSize) / 2
    const glowR = Math.max(layout.mapWidth, layout.mapHeight) * layout.cellSize * 0.75
    const glow = ctx.createRadialGradient(cx, cy, glowR * 0.2, cx, cy, glowR)
    glow.addColorStop(0, 'rgba(38, 44, 66, 0.35)')
    glow.addColorStop(1, 'rgba(10, 10, 20, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, width, height)
  }

  function drawTerrain(state: GameState, layout: Layout): void {
    const { cellSize } = layout

    // Ground pass first so obstacle tops may overhang neighbours cleanly
    for (let row = 0; row < layout.mapHeight; row++) {
      for (let col = 0; col < layout.mapWidth; col++) {
        const cell = state.terrain[row]?.[col]
        if (!cell) continue
        const { x, y } = cellOrigin(layout, col, row)
        ctx.fillStyle = groundShade(col, row)
        ctx.fillRect(x, y, cellSize + 0.5, cellSize + 0.5)
      }
    }

    for (let row = 0; row < layout.mapHeight; row++) {
      for (let col = 0; col < layout.mapWidth; col++) {
        const cell = state.terrain[row]?.[col]
        if (!cell || cell.terrain !== 'obstacle') continue
        const { x, y } = cellOrigin(layout, col, row)

        const heightRatio = Math.max(0, Math.min(1, cell.obstacleHeight / 10))
        const inset = cellSize * 0.1
        const size = cellSize - inset * 2
        const lift = cellSize * (0.08 + 0.16 * heightRatio)
        const bodyColor = shade('#454b3d', 0.9 + heightRatio * 0.25)

        // Drop shadow, extruded side, then the lit top face
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
        pathRoundRect(x + inset + cellSize * 0.05, y + inset + cellSize * 0.05, size, size, cellSize * 0.12)
        ctx.fill()

        ctx.fillStyle = shade('#454b3d', 0.55)
        pathRoundRect(x + inset, y + inset, size, size, cellSize * 0.12)
        ctx.fill()

        ctx.fillStyle = bodyColor
        pathRoundRect(x + inset, y + inset - lift, size, size, cellSize * 0.12)
        ctx.fill()

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
        ctx.lineWidth = 1
        pathRoundRect(x + inset, y + inset - lift, size, size, cellSize * 0.12)
        ctx.stroke()
      }
    }
  }

  function drawGrid(layout: Layout): void {
    const { cellSize, offsetX, offsetY, mapWidth, mapHeight } = layout
    const gridWidth = mapWidth * cellSize
    const gridHeight = mapHeight * cellSize

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
    ctx.lineWidth = 1

    for (let col = 0; col <= mapWidth; col++) {
      const x = offsetX + col * cellSize
      ctx.beginPath()
      ctx.moveTo(x, offsetY)
      ctx.lineTo(x, offsetY + gridHeight)
      ctx.stroke()
    }
    for (let row = 0; row <= mapHeight; row++) {
      const y = offsetY + row * cellSize
      ctx.beginPath()
      ctx.moveTo(offsetX, y)
      ctx.lineTo(offsetX + gridWidth, y)
      ctx.stroke()
    }

    // Arena border
    ctx.strokeStyle = 'rgba(127, 90, 240, 0.35)'
    ctx.lineWidth = 1.5
    ctx.strokeRect(offsetX, offsetY, gridWidth, gridHeight)
  }

  function flareOwnerColor(state: GameState, firerId: string): string {
    const index = state.tanks.findIndex((tank) => tank.id === firerId)
    return index >= 0 ? getTankColor(index) : '#ffd700'
  }

  function drawFlares(state: GameState, config: MatchConfig, layout: Layout): void {
    if (!config.fog) return
    const { cellSize } = layout

    for (const flare of state.flares) {
      const center = cellCenter(layout, flare.targetCell.x, flare.targetCell.y)

      // Exact reveal boundary, cell by cell
      const radiusInCells = Math.ceil(flare.radius)
      for (let dy = -radiusInCells; dy <= radiusInCells; dy++) {
        for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
          if (Math.sqrt(dx * dx + dy * dy) > flare.radius) continue
          const o = cellOrigin(layout, flare.targetCell.x + dx, flare.targetCell.y + dy)
          ctx.fillStyle = 'rgba(255, 196, 82, 0.10)'
          ctx.fillRect(o.x, o.y, cellSize, cellSize)
        }
      }

      // Warm glow over the lit disc
      const glowR = (flare.radius + 0.5) * cellSize
      const glow = ctx.createRadialGradient(center.x, center.y, cellSize * 0.2, center.x, center.y, glowR)
      glow.addColorStop(0, 'rgba(255, 205, 96, 0.34)')
      glow.addColorStop(0.65, 'rgba(255, 180, 60, 0.12)')
      glow.addColorStop(1, 'rgba(255, 170, 40, 0)')
      ctx.fillStyle = glow
      ctx.beginPath()
      ctx.arc(center.x, center.y, glowR, 0, Math.PI * 2)
      ctx.fill()

      // Star at the target cell, ringed in the firer's colour
      ctx.fillStyle = '#ffd700'
      drawStar(center.x, center.y, 5, cellSize * 0.35, cellSize * 0.15)

      ctx.strokeStyle = flareOwnerColor(state, flare.firerId)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(center.x, center.y, cellSize * 0.48, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  /** Engine bearings are clockwise from north; canvas rotation 0 points the sprite up. */
  function bearingToRotation(facing: number): number {
    return (facing * Math.PI) / 180
  }

  function drawTankSprite(color: string, cellSize: number): void {
    const cs = cellSize
    const trackW = cs * 0.16
    const trackL = cs * 0.78
    const hullW = cs * 0.46
    const hullL = cs * 0.62

    // Tracks
    ctx.fillStyle = '#20232b'
    pathRoundRect(-hullW / 2 - trackW * 0.7, -trackL / 2, trackW, trackL, trackW * 0.4)
    ctx.fill()
    pathRoundRect(hullW / 2 - trackW * 0.3, -trackL / 2, trackW, trackL, trackW * 0.4)
    ctx.fill()

    // Hull
    const hullGrad = ctx.createLinearGradient(0, -hullL / 2, 0, hullL / 2)
    hullGrad.addColorStop(0, shade(color, 1.18))
    hullGrad.addColorStop(1, shade(color, 0.72))
    ctx.fillStyle = hullGrad
    pathRoundRect(-hullW / 2, -hullL / 2, hullW, hullL, cs * 0.09)
    ctx.fill()
    ctx.strokeStyle = shade(color, 0.5)
    ctx.lineWidth = Math.max(1, cs * 0.03)
    pathRoundRect(-hullW / 2, -hullL / 2, hullW, hullL, cs * 0.09)
    ctx.stroke()

    // Barrel
    const barrelW = cs * 0.09
    ctx.fillStyle = '#2c313c'
    pathRoundRect(-barrelW / 2, -cs * 0.56, barrelW, cs * 0.42, barrelW * 0.4)
    ctx.fill()
    ctx.fillStyle = '#464c5a'
    pathRoundRect(-barrelW / 2, -cs * 0.56, barrelW, cs * 0.09, barrelW * 0.4)
    ctx.fill()

    // Turret
    ctx.fillStyle = shade(color, 0.88)
    ctx.beginPath()
    ctx.arc(0, 0, cs * 0.155, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = shade(color, 1.35)
    ctx.lineWidth = Math.max(1, cs * 0.025)
    ctx.beginPath()
    ctx.arc(0, 0, cs * 0.155, 0, Math.PI * 2)
    ctx.stroke()
  }

  function drawTanks(state: GameState, layout: Layout): void {
    const { cellSize } = layout

    for (let i = 0; i < state.tanks.length; i++) {
      const tank = state.tanks[i]
      if (!tank.alive) continue

      const center = cellCenter(layout, tank.position.x, tank.position.y)
      const color = getTankColor(i)

      // Active-turn indicator
      if (state.currentPlayerIndex === i) {
        ctx.strokeStyle = shade(color, 1.3)
        ctx.lineWidth = Math.max(1.5, cellSize * 0.04)
        ctx.setLineDash([cellSize * 0.12, cellSize * 0.1])
        ctx.beginPath()
        ctx.arc(center.x, center.y, cellSize * 0.56, 0, Math.PI * 2)
        ctx.stroke()
        ctx.setLineDash([])
      }

      ctx.save()
      ctx.translate(center.x, center.y)
      ctx.rotate(bearingToRotation(tank.facing))
      drawTankSprite(color, cellSize)
      ctx.restore()

      // HP pips beneath the sprite
      const barW = cellSize * 0.66
      const barH = Math.max(3, cellSize * 0.09)
      const barX = center.x - barW / 2
      const barY = center.y + cellSize * 0.52
      const gap = Math.max(1, cellSize * 0.03)
      const segW = (barW - gap * (tank.maxHp - 1)) / tank.maxHp
      for (let s = 0; s < tank.maxHp; s++) {
        const filled = s < tank.hp
        const hpRatio = tank.hp / tank.maxHp
        ctx.fillStyle = filled
          ? (hpRatio > 0.6 ? '#2ecc71' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c')
          : 'rgba(0, 0, 0, 0.55)'
        pathRoundRect(barX + s * (segW + gap), barY, segW, barH, barH * 0.4)
        ctx.fill()
      }
    }
  }

  function drawNamePlates(state: GameState, config: MatchConfig, layout: Layout): void {
    const { cellSize } = layout
    const fontSize = Math.max(10, Math.min(13, cellSize * 0.34))

    for (let i = 0; i < state.tanks.length; i++) {
      const tank = state.tanks[i]
      const label = config.players?.[i]?.label ?? tank.id
      const center = cellCenter(layout, tank.position.x, tank.position.y)
      const color = getTankColor(i)

      ctx.font = `600 ${fontSize}px system-ui, sans-serif`
      const textW = ctx.measureText(label).width
      const plateW = textW + 14
      const plateH = fontSize + 8

      let plateX = center.x - plateW / 2
      let plateY = center.y - cellSize * 0.72 - plateH
      if (plateY < 4) plateY = center.y + cellSize * 0.72
      plateX = Math.max(4, Math.min(width - plateW - 4, plateX))

      ctx.globalAlpha = tank.alive ? 1 : 0.55
      ctx.fillStyle = 'rgba(9, 11, 20, 0.82)'
      pathRoundRect(plateX, plateY, plateW, plateH, plateH / 2)
      ctx.fill()
      ctx.strokeStyle = tank.alive ? color : '#555'
      ctx.lineWidth = 1.5
      pathRoundRect(plateX, plateY, plateW, plateH, plateH / 2)
      ctx.stroke()

      ctx.fillStyle = tank.alive ? '#f2f2f5' : '#999'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, plateX + plateW / 2, plateY + plateH / 2 + 0.5)
      ctx.globalAlpha = 1
    }
  }

  function updateDestructionEffects(state: GameState, animate: boolean): void {
    if (previousState != null) {
      for (let i = 0; i < state.tanks.length; i++) {
        const tank = state.tanks[i]
        const previousTank = previousState.tanks.find((candidate) => candidate.id === tank.id)
        if (previousTank?.alive && !tank.alive && animate) {
          destructionEffects.set(tank.id, {
            position: { ...tank.position },
            color: getTankColor(i),
            startedAt: performance.now(),
          })
        } else if (!previousTank?.alive && tank.alive) {
          destructionEffects.delete(tank.id)
        }
      }
    }
    previousState = structuredClone(state)
  }

  function drawDestroyedTanks(state: GameState, layout: Layout): void {
    const { cellSize } = layout

    for (let i = 0; i < state.tanks.length; i++) {
      const tank = state.tanks[i]
      if (tank.alive) continue
      const center = cellCenter(layout, tank.position.x, tank.position.y)
      const radius = cellSize * 0.32

      // Scorch mark
      const scorch = ctx.createRadialGradient(center.x, center.y, radius * 0.2, center.x, center.y, radius * 1.5)
      scorch.addColorStop(0, 'rgba(0, 0, 0, 0.7)')
      scorch.addColorStop(1, 'rgba(0, 0, 0, 0)')
      ctx.fillStyle = scorch
      ctx.beginPath()
      ctx.arc(center.x, center.y, radius * 1.5, 0, Math.PI * 2)
      ctx.fill()

      ctx.fillStyle = 'rgba(24, 26, 32, 0.9)'
      ctx.beginPath()
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = getTankColor(i)
      ctx.lineWidth = Math.max(2, cellSize * 0.08)
      ctx.beginPath()
      ctx.moveTo(center.x - radius * 0.65, center.y - radius * 0.65)
      ctx.lineTo(center.x + radius * 0.65, center.y + radius * 0.65)
      ctx.moveTo(center.x + radius * 0.65, center.y - radius * 0.65)
      ctx.lineTo(center.x - radius * 0.65, center.y + radius * 0.65)
      ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.font = `${Math.max(8, cellSize * 0.2)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tank.id, center.x, center.y)
    }
  }

  function drawDestructionEffects(state: GameState, layout: Layout): void {
    const now = performance.now()
    const { cellSize } = layout

    for (const [tankId, effect] of destructionEffects) {
      const progress = (now - effect.startedAt) / destructionDurationMs
      if (progress >= 1) {
        destructionEffects.delete(tankId)
        continue
      }

      const center = cellCenter(layout, effect.position.x, effect.position.y)
      const eased = 1 - (1 - progress) ** 3
      const outerRadius = cellSize * (0.4 + eased * 1.1)

      ctx.save()
      ctx.globalAlpha = 1 - progress
      ctx.fillStyle = '#fff3b0'
      ctx.beginPath()
      ctx.arc(center.x, center.y, cellSize * (0.45 + eased * 0.35), 0, Math.PI * 2)
      ctx.fill()

      ctx.strokeStyle = '#ff5a1f'
      ctx.lineWidth = Math.max(3, cellSize * 0.12)
      ctx.beginPath()
      ctx.arc(center.x, center.y, outerRadius, 0, Math.PI * 2)
      ctx.stroke()

      ctx.strokeStyle = effect.color
      ctx.lineWidth = Math.max(2, cellSize * 0.07)
      for (let ray = 0; ray < 8; ray++) {
        const angle = (Math.PI * 2 * ray) / 8
        ctx.beginPath()
        ctx.moveTo(
          center.x + Math.cos(angle) * outerRadius * 0.55,
          center.y + Math.sin(angle) * outerRadius * 0.55,
        )
        ctx.lineTo(
          center.x + Math.cos(angle) * outerRadius,
          center.y + Math.sin(angle) * outerRadius,
        )
        ctx.stroke()
      }
      ctx.fillStyle = '#ffb199'
      ctx.font = `bold ${Math.max(11, cellSize * 0.3)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(`${tankId} DESTROYED`, center.x, center.y - outerRadius - 4)
      ctx.restore()
    }
  }

  function drawFog(state: GameState, config: MatchConfig, layout: Layout): void {
    if (!config.fog || !config.fog.localRadius) return
    const { cellSize } = layout

    for (let row = 0; row < layout.mapHeight; row++) {
      for (let col = 0; col < layout.mapWidth; col++) {
        const cell = state.terrain[row]?.[col]
        if (!cell) continue
        if (isCellVisible(cell, state, config)) continue

        const o = cellOrigin(layout, col, row)
        ctx.fillStyle = FOG_COLOR
        ctx.fillRect(o.x, o.y, cellSize + 0.5, cellSize + 0.5)
      }
    }
  }

  function drawLegend(): void {
    const legendX = width - 128
    const legendY = 10
    const legendW = 118
    const legendH = 96

    ctx.fillStyle = 'rgba(13, 15, 26, 0.88)'
    pathRoundRect(legendX, legendY, legendW, legendH, 6)
    ctx.fill()
    ctx.strokeStyle = '#2a2a4a'
    ctx.lineWidth = 1
    pathRoundRect(legendX, legendY, legendW, legendH, 6)
    ctx.stroke()

    ctx.font = '11px system-ui, sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    ctx.fillStyle = GROUND_SHADES[0]
    ctx.fillRect(legendX + 8, legendY + 8, 12, 12)
    ctx.fillStyle = '#bbb'
    ctx.fillText('Open', legendX + 26, legendY + 9)

    ctx.fillStyle = '#4c5244'
    ctx.fillRect(legendX + 8, legendY + 28, 12, 12)
    ctx.fillStyle = '#bbb'
    ctx.fillText('Obstacle', legendX + 26, legendY + 29)

    ctx.fillStyle = '#ffd700'
    ctx.beginPath()
    ctx.arc(legendX + 14, legendY + 54, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#bbb'
    ctx.fillText('Flare', legendX + 26, legendY + 49)

    ctx.fillStyle = GROUND_SHADES[0]
    ctx.fillRect(legendX + 8, legendY + 68, 12, 12)
    ctx.fillStyle = FOG_COLOR
    ctx.fillRect(legendX + 8, legendY + 68, 12, 12)
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)'
    ctx.lineWidth = 1
    ctx.strokeRect(legendX + 8, legendY + 68, 12, 12)
    ctx.fillStyle = '#bbb'
    ctx.fillText('Fog', legendX + 26, legendY + 69)
  }

  function drawTrajectories(state: GameState, layout: Layout): void {
    // Placeholder: trajectory data would come from the current action
    const alive = state.tanks.filter((t) => t.alive)
    if (alive.length < 2) return

    const a1 = cellCenter(layout, alive[0].position.x, alive[0].position.y)
    const a2 = cellCenter(layout, alive[1].position.x, alive[1].position.y)

    ctx.strokeStyle = 'rgba(231, 76, 60, 0.6)'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(a1.x, a1.y)
    const cpX = (a1.x + a2.x) / 2
    const cpY = Math.min(a1.y, a2.y) - 30
    ctx.quadraticCurveTo(cpX, cpY, a2.x, a2.y)
    ctx.stroke()
    ctx.setLineDash([])
  }

  function draw(state: GameState, config: MatchConfig, options: Partial<RenderOptions>): void {
    const { showFog = true, showTrajectories = false, animate = true } = options
    const { terrain } = state
    if (!terrain || terrain.length === 0) return

    const layout = getLayout(state)
    updateDestructionEffects(state, animate)

    ctx.clearRect(0, 0, width, height)
    drawBackground(layout)
    drawTerrain(state, layout)
    drawGrid(layout)
    drawFlares(state, config, layout)
    drawTanks(state, layout)
    if (showTrajectories) drawTrajectories(state, layout)
    if (showFog && config.fog) drawFog(state, config, layout)
    drawDestroyedTanks(state, layout)
    drawDestructionEffects(state, layout)
    drawNamePlates(state, config, layout)
    drawLegend()
  }

  return {
    canvas,
    get ctx(): CanvasRenderingContext2D { return ctx },

    render(state: GameState, config: MatchConfig, options: Partial<RenderOptions> = {}): void {
      lastFrame = { state, config, options }
      try {
        draw(state, config, options)
      } catch {
        // Never throw — rendering errors are visually silent
      }
    },

    setSize(w: number, h: number): void {
      width = w
      height = h
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      if (dpr !== 1 && typeof ctx.setTransform === 'function') {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      // Resizing clears the canvas; repaint the current frame immediately
      if (lastFrame) {
        try {
          draw(lastFrame.state, lastFrame.config, lastFrame.options)
        } catch {
          // Never throw — rendering errors are visually silent
        }
      }
    },
  }
}
