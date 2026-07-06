import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type {
  TankAgent,
  AgentMessage,
  ToolSpec,
  ToolExecutor,
  AgentTurnResult,
} from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS, inBounds } from '../geometry/coords.js'

const DIRS: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']

interface EnemyIntel {
  id: string
  position: Coordinate
  hp: number
  turn: number
}

interface Memory {
  enemies: Map<string, EnemyIntel>
  obstacles: Set<string>
  scanned: Set<string>
  maxRange: number
  moveMax: number
  mapW: number
  mapH: number
  searchIdx: number
  configured: boolean
}

function k(c: Coordinate): string {
  return `${c.x},${c.y}`
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let a = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (a < 0) a += 360
  return a
}

function bearingToDir(b: number): Direction {
  return DIRS[Math.round((((b % 360) + 360) % 360) / 45) % 8]
}

function updateIntel(m: Memory, wv: WorldView): void {
  for (const cell of wv.localScan) {
    if (cell.terrain === 'obstacle') m.obstacles.add(k(cell.coord))
    m.scanned.add(k(cell.coord))
  }
  for (const fc of wv.flaredCells) {
    if (fc.cell.terrain === 'obstacle') m.obstacles.add(k(fc.cell.coord))
    m.scanned.add(k(fc.cell.coord))
  }
  if (wv.visibleEnemies) {
    for (const e of wv.visibleEnemies) {
      m.enemies.set(e.id, {
        id: e.id,
        position: { ...e.position },
        hp: e.hp,
        turn: wv.turn,
      })
    }
  }
}

function detectMode(m: Memory, wv: WorldView): void {
  if (m.configured) return
  m.configured = true
  if (wv.aliveEnemyCount >= 2) {
    m.maxRange = 12
    m.moveMax = 3
    m.mapW = 25
    m.mapH = 25
  } else if (wv.remainingActions <= 1) {
    m.maxRange = 10
    m.moveMax = 2
    m.mapW = 15
    m.mapH = 15
  }
}

function pickTarget(m: Memory, wv: WorldView): EnemyIntel | null {
  let best: EnemyIntel | null = null
  let bestScore = -Infinity
  for (const [, intel] of m.enemies) {
    const age = wv.turn - intel.turn
    if (age > 4) continue
    const dist = euclidean(wv.position, intel.position)
    if (dist > m.maxRange + 2) continue
    const score = 100 - dist * 3 - age * 10 + (intel.hp <= 1 ? 20 : 0)
    if (score > bestScore) {
      bestScore = score
      best = intel
    }
  }
  return best
}

function solve(
  from: Coordinate,
  to: Coordinate,
  maxRange: number,
): { angle: number; power: number } | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 0.5 || dist > maxRange + 0.5) return null

  const baseAngle = bearing(from, to)
  const basePower = Math.max(1, Math.min(Math.round(dist), maxRange))

  for (const da of [0, -0.5, 0.5, -1, 1, -2, 2, -3, 3]) {
    for (const dp of [0, -1, 1]) {
      const a = ((baseAngle + da) % 360 + 360) % 360
      const p = basePower + dp
      if (p < 1 || p > maxRange) continue
      const rad = (a * Math.PI) / 180
      const tx = Math.round(from.x + Math.sin(rad) * p)
      const ty = Math.round(from.y - Math.cos(rad) * p)
      if (tx === to.x && ty === to.y) return { angle: a, power: p }
    }
  }

  return { angle: baseAngle, power: basePower }
}

function pathClear(
  from: Coordinate,
  to: Coordinate,
  m: Memory,
): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dist = Math.sqrt(dx * dx + dy * dy)
  if (dist < 5) return true

  const nx = dx / dist
  const ny = dy / dist

  const c1 = { x: Math.round(from.x + nx), y: Math.round(from.y + ny) }
  if (m.obstacles.has(k(c1))) return false

  const cL = { x: Math.round(to.x - nx), y: Math.round(to.y - ny) }
  if (m.obstacles.has(k(cL))) return false

  return true
}

function safe(
  from: Coordinate,
  dir: Direction,
  dist: number,
  m: Memory,
): boolean {
  const d = DIRECTION_DELTAS[dir]
  for (let s = 1; s <= dist; s++) {
    const c = { x: from.x + d.dx * s, y: from.y + d.dy * s }
    if (!inBounds(c, m.mapW, m.mapH) || m.obstacles.has(k(c))) return false
  }
  return true
}

function moveToward(
  from: Coordinate,
  target: Coordinate,
  m: Memory,
): { direction: Direction; distance: number } | null {
  let best: { direction: Direction; distance: number } | null = null
  let bestDist = Infinity
  for (const dir of DIRS) {
    for (let d = m.moveMax; d >= 1; d--) {
      if (!safe(from, dir, d, m)) continue
      const delta = DIRECTION_DELTAS[dir]
      const dest = { x: from.x + delta.dx * d, y: from.y + delta.dy * d }
      const nd = euclidean(dest, target)
      if (nd < bestDist) {
        bestDist = nd
        best = { direction: dir, distance: d }
      }
    }
  }
  return best
}

function dodgeFrom(
  from: Coordinate,
  threatDir: Direction,
  m: Memory,
): { direction: Direction; distance: number } | null {
  const ti = DIRS.indexOf(threatDir)
  for (const offset of [2, 6, 3, 5, 4, 1, 7]) {
    const dir = DIRS[(ti + offset) % 8]
    for (let d = m.moveMax; d >= 1; d--) {
      if (safe(from, dir, d, m)) return { direction: dir, distance: d }
    }
  }
  return null
}

function anyMove(
  from: Coordinate,
  m: Memory,
): { direction: Direction; distance: number } | null {
  for (const dir of DIRS) {
    for (let d = m.moveMax; d >= 1; d--) {
      if (safe(from, dir, d, m)) return { direction: dir, distance: d }
    }
  }
  return null
}

function flareRevealCount(
  cx: number,
  cy: number,
  m: Memory,
  flareRadius: number,
): number {
  let count = 0
  for (let dy = -flareRadius; dy <= flareRadius; dy++) {
    for (let dx = -flareRadius; dx <= flareRadius; dx++) {
      if (dx * dx + dy * dy > flareRadius * flareRadius) continue
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || x >= m.mapW || y < 0 || y >= m.mapH) continue
      if (!m.scanned.has(`${x},${y}`)) count++
    }
  }
  return count
}

function pickSearchDirection(pos: Coordinate, m: Memory): Direction {
  let bestDir = DIRS[0]
  let bestCount = -1
  for (const dir of DIRS) {
    const delta = DIRECTION_DELTAS[dir]
    let count = 0
    for (let r = 1; r <= 10; r++) {
      const cx = pos.x + delta.dx * r
      const cy = pos.y + delta.dy * r
      if (cx < 0 || cx >= m.mapW || cy < 0 || cy >= m.mapH) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 4) continue
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || x >= m.mapW || y < 0 || y >= m.mapH) continue
          if (!m.scanned.has(`${x},${y}`)) count++
        }
      }
    }
    if (count > bestCount) {
      bestCount = count
      bestDir = dir
    }
  }
  return bestDir
}

function pickSearchFlare(
  pos: Coordinate,
  m: Memory,
): { direction: Direction; range: number } | null {
  const flareRadius = 2
  let best: { direction: Direction; range: number; score: number } | null =
    null
  for (const dir of DIRS) {
    const delta = DIRECTION_DELTAS[dir]
    for (let r = Math.min(m.maxRange, 9); r >= 3; r -= 2) {
      const tx = pos.x + delta.dx * r
      const ty = pos.y + delta.dy * r
      if (!inBounds({ x: tx, y: ty }, m.mapW, m.mapH)) continue
      const score = flareRevealCount(tx, ty, m, flareRadius)
      if (!best || score > best.score) {
        best = { direction: dir, range: r, score }
      }
    }
  }
  if (best && best.score > 0) return { direction: best.direction, range: best.range }
  m.searchIdx++
  return null
}

export function createOpus46Agent(tankId: string): TankAgent {
  const m: Memory = {
    enemies: new Map(),
    obstacles: new Set(),
    scanned: new Set(),
    maxRange: 10,
    moveMax: 2,
    mapW: 20,
    mapH: 20,
    searchIdx: 0,
    configured: false,
  }

  return {
    name: `opus-4.6-${tankId}`,
    messages: [] as AgentMessage[],

    async takeTurn(
      wv: WorldView,
      _tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> {
      if (!wv.isMyTurn) {
        return [{ id: `pass-${wv.turn}`, tool: { kind: 'pass' } }]
      }

      detectMode(m, wv)
      updateIntel(m, wv)

      if (executeTool) return reactive(wv, m, executeTool)
      return planned(wv, m)
    },
  }
}

async function reactive(
  wv: WorldView,
  m: Memory,
  exec: ToolExecutor,
): Promise<AgentTurnResult> {
  const calls: ToolCall[] = []
  let pos = { ...wv.position }
  let actions = wv.remainingActions
  let offensive = false
  let curWv = wv

  const run = async (call: ToolCall) => {
    const r = await exec(call)
    calls.push(call)
    return r
  }

  const target = pickTarget(m, curWv)
  const intelAge = target ? curWv.turn - target.turn : Infinity
  const singleAction = wv.remainingActions <= 1

  if (target && intelAge <= 2) {
    // In single-action mode with stale intel, close distance instead of firing blind
    if (singleAction && intelAge > 0) {
      const mv = moveToward(pos, target.position, m) || anyMove(pos, m)
      if (mv && actions > 0) {
        const r = await run({
          id: `move-${curWv.turn}`,
          tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
        })
        actions--
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
      return { toolCalls: calls, executed: true }
    }

    // ── Engage: fire at known position, then dodge ──
    const sol = solve(pos, target.position, m.maxRange)
    if (sol && actions > 0 && pathClear(pos, target.position, m)) {
      const r = await run({
        id: `shell-${curWv.turn}`,
        tool: { kind: 'fire_shell', angle: sol.angle, power: sol.power },
      })
      offensive = true
      actions--
      curWv = r.worldview
      updateIntel(m, curWv)
      if (r.turnEnded) return { toolCalls: calls, executed: true }
    }

    if (actions > 0) {
      const exposed = curWv.inEnemyFlare.length > 0
      let mv: { direction: Direction; distance: number } | null = null

      if (exposed || curWv.hp <= 1) {
        mv = dodgeFrom(pos, bearingToDir(bearing(pos, target.position)), m)
      } else {
        const dist = euclidean(pos, target.position)
        if (dist > 6) {
          mv = moveToward(pos, target.position, m)
        } else if (dist < 3) {
          mv = dodgeFrom(pos, bearingToDir(bearing(target.position, pos)), m)
        } else {
          const ti = DIRS.indexOf(bearingToDir(bearing(pos, target.position)))
          for (const off of [2, 6]) {
            const d = DIRS[(ti + off) % 8]
            if (safe(pos, d, m.moveMax, m)) {
              mv = { direction: d, distance: m.moveMax }
              break
            }
            if (safe(pos, d, 1, m)) {
              mv = { direction: d, distance: 1 }
              break
            }
          }
        }
      }

      mv = mv || anyMove(pos, m)
      if (mv) {
        const r = await run({
          id: `move-${curWv.turn}`,
          tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
        })
        actions--
        curWv = r.worldview
        pos = { ...curWv.position }
        updateIntel(m, curWv)
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    }

    if (actions > 0 && !offensive) {
      const freshTarget = pickTarget(m, curWv)
      if (freshTarget && curWv.turn - freshTarget.turn === 0) {
        const sol2 = solve(pos, freshTarget.position, m.maxRange)
        if (sol2 && pathClear(pos, freshTarget.position, m)) {
          const r = await run({
            id: `shell2-${curWv.turn}`,
            tool: { kind: 'fire_shell', angle: sol2.angle, power: sol2.power },
          })
          offensive = true
          actions--
          if (r.turnEnded) return { toolCalls: calls, executed: true }
        }
      }
    }
  } else if (target && curWv.turn - target.turn <= 4) {
    // ── Stale intel: advance toward last known, then flare/fire ──
    if (actions > 0) {
      const mv = moveToward(pos, target.position, m)
      if (mv) {
        const r = await run({
          id: `move-${curWv.turn}`,
          tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
        })
        actions--
        curWv = r.worldview
        pos = { ...curWv.position }
        updateIntel(m, curWv)
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    }

    const fresh = pickTarget(m, curWv)
    if (fresh && curWv.turn - fresh.turn === 0 && !offensive && actions > 0) {
      const sol = solve(pos, fresh.position, m.maxRange)
      if (sol && pathClear(pos, fresh.position, m)) {
        const r = await run({
          id: `shell2-${curWv.turn}`,
          tool: { kind: 'fire_shell', angle: sol.angle, power: sol.power },
        })
        offensive = true
        actions--
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    } else if (!offensive && actions > 0) {
      const dir = bearingToDir(bearing(pos, target.position))
      const delta = DIRECTION_DELTAS[dir]
      let range = Math.min(Math.round(euclidean(pos, target.position)), 8)
      while (range >= 1) {
        if (
          inBounds(
            { x: pos.x + delta.dx * range, y: pos.y + delta.dy * range },
            m.mapW,
            m.mapH,
          )
        )
          break
        range--
      }
      if (range >= 1) {
        const r = await run({
          id: `flare-${curWv.turn}`,
          tool: { kind: 'fire_flare', direction: dir, range },
        })
        offensive = true
        actions--
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    }

    if (actions > 0) {
      const mv2 = moveToward(pos, target.position, m) || anyMove(pos, m)
      if (mv2) {
        const r = await run({
          id: `move2-${curWv.turn}`,
          tool: { kind: 'move', direction: mv2.direction, distance: mv2.distance },
        })
        actions--
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    }
  } else {
    // ── No intel: search mode ──
    const searchDir = pickSearchDirection(pos, m)
    const shouldFlare = !singleAction || m.searchIdx % 3 === 0

    if (!offensive && actions > 0 && shouldFlare) {
      const fl = pickSearchFlare(pos, m)
      if (fl) {
        const r = await run({
          id: `flare-${curWv.turn}`,
          tool: { kind: 'fire_flare', direction: fl.direction, range: fl.range },
        })
        offensive = true
        actions--
        curWv = r.worldview
        updateIntel(m, curWv)
        if (r.turnEnded) return { toolCalls: calls, executed: true }

        const fresh = pickTarget(m, curWv)
        if (fresh && curWv.turn - fresh.turn === 0 && actions > 0) {
          const mv = moveToward(pos, fresh.position, m) || anyMove(pos, m)
          if (mv) {
            const r2 = await run({
              id: `move-${curWv.turn}`,
              tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
            })
            actions--
            if (r2.turnEnded) return { toolCalls: calls, executed: true }
          }
          return { toolCalls: calls, executed: true }
        }
      }
    }

    if (actions > 0) {
      let mv: { direction: Direction; distance: number } | null = null
      for (let d = m.moveMax; d >= 1; d--) {
        if (safe(pos, searchDir, d, m)) {
          mv = { direction: searchDir, distance: d }
          break
        }
      }
      mv = mv || anyMove(pos, m)
      if (mv) {
        const r = await run({
          id: `move2-${curWv.turn}`,
          tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
        })
        actions--
        if (r.turnEnded) return { toolCalls: calls, executed: true }
      }
    }

    if (singleAction) m.searchIdx++
  }

  return { toolCalls: calls, executed: true }
}

function planned(wv: WorldView, m: Memory): ToolCall[] {
  const calls: ToolCall[] = []
  const target = pickTarget(m, wv)

  if (target && wv.turn - target.turn <= 2) {
    const sol = solve(wv.position, target.position, m.maxRange)
    if (sol && pathClear(wv.position, target.position, m)) {
      calls.push({
        id: `shell-${wv.turn}`,
        tool: { kind: 'fire_shell', angle: sol.angle, power: sol.power },
      })
    }
    const mv =
      dodgeFrom(
        wv.position,
        bearingToDir(bearing(wv.position, target.position)),
        m,
      ) || anyMove(wv.position, m)
    if (mv) {
      calls.push({
        id: `move-${wv.turn}`,
        tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
      })
    }
  } else {
    const fl = pickSearchFlare(wv.position, m)
    if (fl) {
      calls.push({
        id: `flare-${wv.turn}`,
        tool: { kind: 'fire_flare', direction: fl.direction, range: fl.range },
      })
    }
    const center = {
      x: Math.floor(m.mapW / 2),
      y: Math.floor(m.mapH / 2),
    }
    const mv = moveToward(wv.position, center, m) || anyMove(wv.position, m)
    if (mv) {
      calls.push({
        id: `move-${wv.turn}`,
        tool: { kind: 'move', direction: mv.direction, distance: mv.distance },
      })
    }
  }

  if (calls.length === 0) {
    calls.push({ id: `pass-${wv.turn}`, tool: { kind: 'pass' } })
  }
  return calls
}
