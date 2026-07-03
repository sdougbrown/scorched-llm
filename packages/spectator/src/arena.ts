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

export function createArenaRenderer(canvas: HTMLCanvasElement): ArenaRenderer {
  const ctx = canvas.getContext('2d')!
  let width = 800
  let height = 800

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

  function getCellSize(mapWidth: number, mapHeight: number): number {
    const maxDim = Math.max(mapWidth, mapHeight)
    return Math.floor(Math.min(width, height) / maxDim)
  }

  function getCellCenter(col: number, row: number, mapWidth: number, mapHeight: number): { x: number; y: number } {
    const cellSize = getCellSize(mapWidth, mapHeight)
    const gridWidth = mapWidth * cellSize
    const gridHeight = mapHeight * cellSize
    const offsetX = (width - gridWidth) / 2
    const offsetY = (height - gridHeight) / 2
    return {
      x: offsetX + col * cellSize + cellSize / 2,
      y: offsetY + row * cellSize + cellSize / 2,
    }
  }

  function isCellVisible(cell: Cell, state: GameState, config: MatchConfig): boolean {
    if (!config.fog) return true
    const localRadius = config.fog.localRadius
    // Check if cell is within local vision of any alive tank
    for (const tank of state.tanks) {
      if (!tank.alive) continue
      const dx = cell.coord.x - tank.position.x
      const dy = cell.coord.y - tank.position.y
      if (Math.sqrt(dx * dx + dy * dy) <= localRadius) return true
    }
    // Check if cell is within any flare
    for (const flare of state.flares) {
      const dx = cell.coord.x - flare.targetCell.x
      const dy = cell.coord.y - flare.targetCell.y
      if (Math.sqrt(dx * dx + dy * dy) <= flare.radius) return true
    }
    return false
  }

  function drawGrid(mapWidth: number, mapHeight: number): void {
    const cellSize = getCellSize(mapWidth, mapHeight)
    const gridWidth = mapWidth * cellSize
    const gridHeight = mapHeight * cellSize
    const offsetX = (width - gridWidth) / 2
    const offsetY = (height - gridHeight) / 2

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.1)'
    ctx.lineWidth = 0.5

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
  }

  function drawTerrain(state: GameState): void {
    const { terrain } = state
    if (!terrain || terrain.length === 0) return

    const mapHeight = terrain.length
    const mapWidth = terrain[0]?.length ?? 0

    for (let row = 0; row < mapHeight; row++) {
      for (let col = 0; col < mapWidth; col++) {
        const cell = terrain[row]?.[col]
        if (!cell) continue

        const cellSize = getCellSize(mapWidth, mapHeight)
        const gridWidth = mapWidth * cellSize
        const gridHeight = mapHeight * cellSize
        const offsetX = (width - gridWidth) / 2
        const offsetY = (height - gridHeight) / 2

        const x = offsetX + col * cellSize
        const y = offsetY + row * cellSize

        if (cell.terrain === 'obstacle') {
          ctx.fillStyle = '#6b6b5e'
          ctx.fillRect(x, y, cellSize, cellSize)
          // Height indicator
          const heightRatio = cell.obstacleHeight / 10
          const barH = cellSize * heightRatio * 0.6
          ctx.fillStyle = '#8a8a7a'
          ctx.fillRect(x + cellSize * 0.2, y + cellSize * 0.2, cellSize * 0.6, barH)
        } else {
          ctx.fillStyle = '#e8e4d9'
          ctx.fillRect(x, y, cellSize, cellSize)
        }
      }
    }
  }

  function drawFlares(state: GameState, config: MatchConfig): void {
    if (!config.fog) return

    const cellSize = getCellSize(state.terrain.length ?? 0, (state.terrain?.[0]?.length ?? 0))
    const gridWidth = (state.terrain?.[0]?.length ?? 0) * cellSize
    const gridHeight = (state.terrain?.length ?? 0) * cellSize
    const offsetX = (width - gridWidth) / 2
    const offsetY = (height - gridHeight) / 2

    for (const flare of state.flares) {
      const center = getCellCenter(flare.targetCell.x, flare.targetCell.y, state.terrain[0].length, state.terrain.length)

      // Flare overlay on affected cells
      const radiusInCells = Math.ceil(flare.radius)
      for (let dy = -radiusInCells; dy <= radiusInCells; dy++) {
        for (let dx = -radiusInCells; dx <= radiusInCells; dx++) {
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > flare.radius) continue
          const cellX = offsetX + (flare.targetCell.x + dx) * cellSize
          const cellY = offsetY + (flare.targetCell.y + dy) * cellSize
          ctx.fillStyle = 'rgba(255, 200, 50, 0.25)'
          ctx.fillRect(cellX, cellY, cellSize, cellSize)
        }
      }

      // Star at center
      ctx.fillStyle = '#ffd700'
      drawStar(center.x, center.y, 5, cellSize * 0.35, cellSize * 0.15)

      // Owner ring
      ctx.strokeStyle = TANK_COLORS[0]
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(center.x, center.y, cellSize * 0.45, 0, Math.PI * 2)
      ctx.stroke()
    }
  }

  function drawTanks(state: GameState): void {
    for (let i = 0; i < state.tanks.length; i++) {
      const tank = state.tanks[i]
      if (!tank.alive) continue

      const center = getCellCenter(tank.position.x, tank.position.y, state.terrain[0].length, state.terrain.length)
      const cellSize = getCellSize(state.terrain[0].length, state.terrain.length)
      const radius = cellSize * 0.35

      // Tank body
      ctx.fillStyle = getTankColor(i)
      ctx.beginPath()
      ctx.arc(center.x, center.y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 1
      ctx.stroke()

      // Tank ID
      ctx.fillStyle = '#fff'
      ctx.font = `${Math.max(8, cellSize * 0.25)}px sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(tank.id, center.x, center.y)

      // HP bar
      const hpRatio = tank.hp / tank.maxHp
      const barW = cellSize * 0.7
      const barH = 3
      const barX = center.x - barW / 2
      const barY = center.y + radius + 4
      ctx.fillStyle = '#333'
      ctx.fillRect(barX, barY, barW, barH)
      ctx.fillStyle = hpRatio > 0.6 ? '#2ecc71' : hpRatio > 0.3 ? '#f39c12' : '#e74c3c'
      ctx.fillRect(barX, barY, barW * hpRatio, barH)

      // Facing arrow
      const facingRad = (tank.facing * Math.PI) / 180
      const arrowLen = radius * 1.4
      const ax = center.x + arrowLen * Math.cos(facingRad)
      const ay = center.y + arrowLen * Math.sin(facingRad)
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(center.x, center.y)
      ctx.lineTo(ax, ay)
      ctx.stroke()
    }
  }

  function drawFog(state: GameState, config: MatchConfig): void {
    if (!config.fog || !config.fog.localRadius) return

    const cellSize = getCellSize(state.terrain[0].length, state.terrain.length)
    const mapWidth = state.terrain[0].length
    const mapHeight = state.terrain.length
    const gridWidth = mapWidth * cellSize
    const gridHeight = mapHeight * cellSize
    const offsetX = (width - gridWidth) / 2
    const offsetY = (height - gridHeight) / 2

    for (let row = 0; row < mapHeight; row++) {
      for (let col = 0; col < mapWidth; col++) {
        const cell = state.terrain[row]?.[col]
        if (!cell) continue
        if (isCellVisible(cell, state, config)) continue

        const x = offsetX + col * cellSize
        const y = offsetY + row * cellSize
        ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
        ctx.fillRect(x, y, cellSize, cellSize)
      }
    }
  }

  function drawLegend(mapWidth: number, mapHeight: number): void {
    const cellSize = getCellSize(mapWidth, mapHeight)
    const legendX = width - 120
    const legendY = 10
    const legendW = 110
    const legendH = 100

    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
    ctx.fillRect(legendX, legendY, legendW, legendH)
    ctx.strokeStyle = '#ccc'
    ctx.lineWidth = 1
    ctx.strokeRect(legendX, legendY, legendW, legendH)

    ctx.font = '11px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'

    // Open
    ctx.fillStyle = '#e8e4d9'
    ctx.fillRect(legendX + 5, legendY + 5, 12, 12)
    ctx.fillStyle = '#333'
    ctx.fillText('Open', legendX + 22, legendY + 5)

    // Obstacle
    ctx.fillStyle = '#6b6b5e'
    ctx.fillRect(legendX + 5, legendY + 22, 12, 12)
    ctx.fillStyle = '#333'
    ctx.fillText('Obstacle', legendX + 22, legendY + 22)

    // Flare
    ctx.fillStyle = '#ffd700'
    ctx.beginPath()
    ctx.arc(legendX + 11, legendY + 48, 6, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#333'
    ctx.fillText('Flare', legendX + 22, legendY + 42)

    // Fog
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)'
    ctx.fillRect(legendX + 5, legendY + 62, 12, 12)
    ctx.fillStyle = '#333'
    ctx.fillText('Fog', legendX + 22, legendY + 62)
  }

  function drawTrajectories(state: GameState): void {
    // Placeholder: trajectory data would come from the current action
    // For now, draw a subtle arc between the first two alive tanks
    const alive = state.tanks.filter((t) => t.alive)
    if (alive.length < 2) return

    const a1 = getCellCenter(alive[0].position.x, alive[0].position.y, state.terrain[0].length, state.terrain.length)
    const a2 = getCellCenter(alive[1].position.x, alive[1].position.y, state.terrain[0].length, state.terrain.length)

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

  return {
    canvas,
    get ctx(): CanvasRenderingContext2D { return ctx },

    render(state: GameState, config: MatchConfig, options: Partial<RenderOptions> = {}): void {
      try {
        const { showFog = true, showTrajectories = false } = options
        const { terrain } = state
        if (!terrain || terrain.length === 0) return

        const mapHeight = terrain.length
        const mapWidth = terrain[0].length

        ctx.clearRect(0, 0, width, height)

        drawTerrain(state)
        drawFlares(state, config)
        drawTanks(state)
        if (showTrajectories) drawTrajectories(state)
        if (showFog && config.fog) drawFog(state, config)
        drawGrid(mapWidth, mapHeight)
        drawLegend(mapWidth, mapHeight)
      } catch {
        // Never throw — rendering errors are visually silent
      }
    },

    setSize(w: number, h: number): void {
      width = w
      height = h
      canvas.width = w
      canvas.height = h
    },
  }
}
