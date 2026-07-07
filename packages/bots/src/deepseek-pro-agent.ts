import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, ToolSpec } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import { euclidean, DIRECTION_DELTAS } from '@scorched-llm/engine'

// ── Memory ────────────────────────────────────────────────────────────────────

interface DeepSeekMemory {
  enemyPos: Coordinate | null
  lastSeenTurn: number
  searchStep: number
  /** Positions of enemy flares we've observed — used to triangulate. */
  enemyFlareCenters: Coordinate[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = ((Math.round(b / 45) % 8) + 8) % 8
  return dirs[idx]
}

function bestDirectionTo(from: Coordinate, target: Coordinate, maxDist: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestDist = Infinity
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let dirBestDist = Infinity
    for (let step = 1; step <= maxDist; step++) {
      const d = euclidean({ x: from.x + delta.dx * step, y: from.y + delta.dy * step }, target)
      if (d < dirBestDist) dirBestDist = d
    }
    if (dirBestDist < bestDist) { bestDist = dirBestDist; best = dir }
  }
  return best
}

function supercover(start: Coordinate, end: Coordinate): Coordinate[] {
  if (start.x === end.x && start.y === end.y) return [{ x: start.x, y: start.y }]
  const dx = end.x - start.x, dy = end.y - start.y
  const lenSq = dx * dx + dy * dy
  const minX = Math.min(start.x, end.x), maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y), maxY = Math.max(start.y, end.y)
  const hits: Array<{ cell: Coordinate; t: number }> = []

  for (let cx = minX; cx <= maxX; cx++) {
    for (let cy = minY; cy <= maxY; cy++) {
      let t0 = 0, t1 = 1
      const p = [-dx, dx, -dy, dy]
      const q = [start.x - (cx - 0.5), (cx + 0.5) - start.x, start.y - (cy - 0.5), (cy + 0.5) - start.y]
      let ok = true
      for (let i = 0; i < 4; i++) {
        if (Math.abs(p[i]) < 1e-12) { if (q[i] < 0) { ok = false; break } }
        else { const r = q[i] / p[i]; if (p[i] < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r) }
        if (t0 > t1) { ok = false; break }
      }
      if (ok) hits.push({ cell: { x: cx, y: cy }, t: lenSq === 0 ? 0 : (t0 + t1) / 2 })
    }
  }
  hits.sort((a, b) => {
    if (Math.abs(a.t - b.t) > 1e-12) return a.t - b.t
    if (a.cell.y !== b.cell.y) return a.cell.y - b.cell.y
    return a.cell.x - b.cell.x
  })
  return hits.map((h) => h.cell)
}

function shellPathIsClear(
  shooter: Coordinate, angle: number, power: number, knownCells: Map<string, Cell>,
): boolean {
  if (power <= 0) return false
  const rad = (angle * Math.PI) / 180
  const target: Coordinate = {
    x: Math.round(shooter.x + Math.sin(rad) * power),
    y: Math.round(shooter.y - Math.cos(rad) * power),
  }
  const sampled = supercover(shooter, target).slice(1)
  const N = sampled.length
  if (N === 0) return true
  for (let i = 0; i < sampled.length; i++) {
    const cell = sampled[i]
    const known = knownCells.get(`${cell.x},${cell.y}`)
    if (known && known.terrain === 'obstacle') {
      if (1 + 16 * ((i + 1) / N) * (1 - (i + 1) / N) <= known.obstacleHeight) return false
    }
  }
  return true
}

function safeMoveDistance(from: Coordinate, direction: Direction, maxDist: number, localScan: Cell[]): number {
  const delta = DIRECTION_DELTAS[direction]
  const scanMap = new Map<string, Cell>()
  for (const cell of localScan) scanMap.set(`${cell.coord.x},${cell.coord.y}`, cell)
  let safe = 0
  for (let step = 1; step <= maxDist; step++) {
    const cell = scanMap.get(`${from.x + delta.dx * step},${from.y + delta.dy * step}`)
    if (cell && cell.terrain === 'obstacle') break
    safe = step
  }
  return safe
}

function computeShellPower(shooter: Coordinate, target: Coordinate, knownCells: Map<string, Cell>): number {
  const dist = Math.round(euclidean(shooter, target))
  const angle = bearing(shooter, target)
  let power = Math.max(1, Math.min(dist, 10))
  if (!shellPathIsClear(shooter, angle, power, knownCells)) {
    for (let tryPower = power - 1; tryPower >= 2; tryPower--) {
      if (shellPathIsClear(shooter, angle, tryPower, knownCells)) { power = tryPower; break }
    }
  }
  return power
}

/**
 * Infer a rough enemy position from their flare.
 * The enemy must be along the opposite direction from the flare center,
 * at some unknown range. We assume range ≈ 5 (typical).
 */
function inferPositionFromEnemyFlare(
  flareCenter: Coordinate, myPos: Coordinate,
): Coordinate | null {
  // Try each direction: enemy is at flareCenter + opposite delta * roughly 5
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    // The enemy fired in this direction to reach flareCenter
    // So enemy is in the opposite direction from flareCenter
    const ex = flareCenter.x - delta.dx * 5
    const ey = flareCenter.y - delta.dy * 5
    if (ex >= 0 && ex < 20 && ey >= 0 && ey < 20) {
      return { x: ex, y: ey }
    }
  }
  return null
}

// ── Search pattern ────────────────────────────────────────────────────────────

const SEARCH_PATTERN: Array<{ dir: Direction; range: number }> = [
  { dir: 'N',  range: 9 },
  { dir: 'E',  range: 7 },
  { dir: 'S',  range: 9 },
  { dir: 'W',  range: 7 },
  { dir: 'NE', range: 8 },
  { dir: 'SW', range: 8 },
  { dir: 'NW', range: 8 },
  { dir: 'SE', range: 8 },
]

const EXPLORE_TARGETS: Coordinate[] = [
  { x: 10, y: 10 },
  { x: 5, y: 5 },
  { x: 15, y: 15 },
  { x: 5, y: 15 },
  { x: 15, y: 5 },
]

// ── Agent ─────────────────────────────────────────────────────────────────────

export function createDeepSeekProAgent(tankId: string): TankAgent {
  const memory: DeepSeekMemory = {
    enemyPos: null,
    lastSeenTurn: -999,
    searchStep: 0,
    enemyFlareCenters: [],
  }

  return {
    name: `deepseek-pro-${tankId}`,
    messages: [],
    takeTurn: async (worldview: WorldView, _tools: ToolSpec[]): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []
      const turn = worldview.turn
      const myPos = worldview.position

      // ── 1. Update intel ─────────────────────────────────────────────
      if (worldview.visibleEnemies && worldview.visibleEnemies.length > 0) {
        memory.enemyPos = { ...worldview.visibleEnemies[0].position }
        memory.lastSeenTurn = turn
      }

      // Track enemy flares for triangulation
      if (worldview.activeFlares) {
        for (const flare of worldview.activeFlares) {
          if (flare.firerId !== tankId) {
            const key = `${flare.targetCell.x},${flare.targetCell.y}`
            const already = memory.enemyFlareCenters.some(
              (c) => `${c.x},${c.y}` === key,
            )
            if (!already) {
              memory.enemyFlareCenters.push({ ...flare.targetCell })
              // Infer position from enemy flare
              const inferred = inferPositionFromEnemyFlare(flare.targetCell, myPos)
              if (inferred && memory.enemyPos === null) {
                memory.enemyPos = inferred
                memory.lastSeenTurn = turn // mark as "inferred" intel
              }
            }
          }
        }
      }

      // ── 2. Phase determination ─────────────────────────────────────
      const enemyVisible =
        worldview.visibleEnemies !== undefined &&
        worldview.visibleEnemies.length > 0 &&
        worldview.aliveEnemyCount > 0

      const turnsSinceSeen = turn - memory.lastSeenTurn
      const hasEnemy = memory.enemyPos !== null && worldview.aliveEnemyCount > 0

      const knownCells = new Map<string, Cell>()
      for (const cell of worldview.localScan) knownCells.set(`${cell.coord.x},${cell.coord.y}`, cell)
      for (const fc of worldview.flaredCells) knownCells.set(`${fc.cell.coord.x},${fc.cell.coord.y}`, fc.cell)

      // ── ENGAGE: enemy visible now → shell + move ────────────────────
      if (enemyVisible && memory.enemyPos) {
        const power = computeShellPower(myPos, memory.enemyPos, knownCells)
        calls.push({
          id: `shell-${turn}`,
          tool: { kind: 'fire_shell', angle: bearing(myPos, memory.enemyPos), power },
        })

        const moveDir = bestDirectionTo(myPos, memory.enemyPos, 5)
        const safeDist = safeMoveDistance(myPos, moveDir, 2, worldview.localScan)
        if (safeDist >= 1) {
          calls.push({ id: `move-${turn}`, tool: { kind: 'move', direction: moveDir, distance: safeDist } })
        }
        return calls
      }

      // ── PURSUIT: enemy seen 1 turn ago → shell at last known ────────
      if (hasEnemy && turnsSinceSeen === 1) {
        const power = computeShellPower(myPos, memory.enemyPos!, knownCells)
        const angle = bearing(myPos, memory.enemyPos!)
        calls.push({ id: `shell-${turn}`, tool: { kind: 'fire_shell', angle, power } })

        const moveDir = bestDirectionTo(myPos, memory.enemyPos!, 5)
        const safeDist = safeMoveDistance(myPos, moveDir, 2, worldview.localScan)
        if (safeDist >= 1) {
          calls.push({ id: `move-${turn}`, tool: { kind: 'move', direction: moveDir, distance: safeDist } })
        }
        return calls
      }

      // ── REACQUIRE: enemy seen 2 turns ago → flare + move ────────────
      if (hasEnemy && turnsSinceSeen <= 2) {
        const flareDir = bearingToDirection(bearing(myPos, memory.enemyPos!))
        const dist = Math.round(euclidean(myPos, memory.enemyPos!))
        calls.push({
          id: `flare-${turn}`,
          tool: { kind: 'fire_flare', direction: flareDir, range: Math.max(2, Math.min(dist, 10)) },
        })

        const moveDir = bestDirectionTo(myPos, memory.enemyPos!, 5)
        const safeDist = safeMoveDistance(myPos, moveDir, 2, worldview.localScan)
        if (safeDist >= 1) {
          calls.push({ id: `move-${turn}`, tool: { kind: 'move', direction: moveDir, distance: safeDist } })
        }
        return calls
      }

      // ── HUNT: enemy unknown or stale ────────────────────────────────
      const step = memory.searchStep++

      // Every 3rd turn in HUNT mode, use double-move to cover ground faster
      if (step % 3 === 0) {
        // Rush phase: move twice toward target
        const moveTarget = memory.enemyPos ?? EXPLORE_TARGETS[Math.floor(step / 3) % EXPLORE_TARGETS.length]
        const dir1 = bestDirectionTo(myPos, moveTarget, 5)
        const dist1 = safeMoveDistance(myPos, dir1, 2, worldview.localScan)
        if (dist1 >= 1) {
          calls.push({ id: `move1-${turn}`, tool: { kind: 'move', direction: dir1, distance: dist1 } })
        }
        // Second move — from potential new position
        const myNewX = myPos.x + DIRECTION_DELTAS[dir1].dx * dist1
        const myNewY = myPos.y + DIRECTION_DELTAS[dir1].dy * dist1
        const newPos: Coordinate = { x: myNewX, y: myNewY }
        const dir2 = bestDirectionTo(newPos, moveTarget, 5)
        const dist2 = safeMoveDistance(newPos, dir2, 2, worldview.localScan)
        if (dist2 >= 1) {
          calls.push({ id: `move2-${turn}`, tool: { kind: 'move', direction: dir2, distance: dist2 } })
        }
        return calls
      }

      // Flare: use search pattern, or target known enemy position
      if (hasEnemy && step % 2 === 0) {
        const flareDir = bearingToDirection(bearing(myPos, memory.enemyPos!))
        calls.push({
          id: `flare-${turn}`,
          tool: { kind: 'fire_flare', direction: flareDir, range: 10 },
        })
      } else {
        const pattern = SEARCH_PATTERN[step % SEARCH_PATTERN.length]
        calls.push({
          id: `flare-${turn}`,
          tool: { kind: 'fire_flare', direction: pattern.dir, range: pattern.range },
        })
      }

      const moveTarget = memory.enemyPos ?? EXPLORE_TARGETS[Math.floor(step / 3) % EXPLORE_TARGETS.length]
      const moveDir = bestDirectionTo(myPos, moveTarget, 5)
      const safeDist = safeMoveDistance(myPos, moveDir, 2, worldview.localScan)
      if (safeDist >= 1) {
        calls.push({ id: `move-${turn}`, tool: { kind: 'move', direction: moveDir, distance: safeDist } })
      }

      return calls
    },
  }
}
