import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { ToolSpec, TankAgent } from './fake-agents.js'

// ─── Memory ───────────────────────────────────────────────────────────────────

interface EnemySighting {
  turn: number
  x: number
  y: number
  hp: number
}

interface StepMemory {
  sightings: Map<string, EnemySighting[]>
  knownMap: Record<string, { terrain: 'open' | 'obstacle'; obstacleHeight: number }>
  lastScanDir: number // radians, rotates when we have no sightings
  flaresLaunched: number
  shotsFired: number
  shotsHit: number
  scanPhase: 'hunt' | 'confirm' // hunt = sweep, confirm = target known pos
  confirmedTarget: { x: number; y: number } | null
  confirmTurnsRemaining: number
}

function pushSighting(
  memory: StepMemory,
  enemyId: string,
  sighting: EnemySighting,
): void {
  const list = memory.sightings.get(enemyId) ?? []
  list.push(sighting)
  if (list.length > 30) list.splice(0, list.length - 30)
  memory.sightings.set(enemyId, list)
}

function lastSighting(
  memory: StepMemory,
  enemyId: string,
): EnemySighting | undefined {
  return memory.sightings.get(enemyId)?.at(-1)
}

function bestRecentSighting(memory: StepMemory): EnemySighting | undefined {
  let best: EnemySighting | undefined
  for (const [, list] of memory.sightings) {
    const recent = list.at(-1)
    if (recent && (!best || recent.turn > best.turn)) best = recent
  }
  return best
}

// ─── Geometry helpers ─────────────────────────────────────────────────────────

function euclidean(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  return Math.sqrt(dx * dx + dy * dy)
}

function bearingDeg(fromX: number, fromY: number, toX: number, toY: number): number {
  const dx = toX - fromX
  const dy = toY - fromY // positive = south
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function wrapAngle(a: number): number {
  a = a % 360
  return a < 0 ? a + 360 : a
}

/** Map a bearing (0=N, 90=E, …) to the nearest 8-way compass direction. */
function dirFromBearing(angle: number): 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW' {
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const
  return dirs[Math.round(wrapAngle(angle) / 45) % 8]
}

/** Direction deltas. */
const DELTAS: Record<string, { dx: number; dy: number }> = {
  N: { dx: 0, dy: -1 },
  NE: { dx: 1, dy: -1 },
  E: { dx: 1, dy: 0 },
  SE: { dx: 1, dy: 1 },
  S: { dx: 0, dy: 1 },
  SW: { dx: -1, dy: 1 },
  W: { dx: -1, dy: 0 },
  NW: { dx: -1, dy: -1 },
}

/** Cardinal directions used for systematic flare scanning. */
const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

function isOpen(
  x: number,
  y: number,
  width: number,
  height: number,
  knownMap: Record<string, { terrain: string; obstacleHeight: number }>,
): boolean {
  if (x < 0 || x >= width || y < 0 || y >= height) return false
  const cell = knownMap[`${x},${y}`]
  return cell ? cell.terrain === 'open' : true // unknown cells assumed open (risky but avoids over-caution)
}

/**
 * Pick the best single-step move toward `tx,ty` choosing among the 8
 * compass directions, preferring open cells and positions closer to target.
 */
function bestStep(
  fromX: number,
  fromY: number,
  tx: number,
  ty: number,
  width: number,
  height: number,
  knownMap: Record<string, { terrain: string; obstacleHeight: number }>,
): { dir: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW'; score: number } | null {
  let best: { dir: typeof CARDINALS[number]; score: number } | null = null

  for (const dir of CARDINALS) {
    const d = DELTAS[dir]
    const nx = fromX + d.dx
    const ny = fromY + d.dy
    if (!isOpen(nx, ny, width, height, knownMap)) continue

    const dist = euclidean(nx, ny, tx, ty)
    // Strongly prefer diagonal moves when both axes need correction
    const axisMatch = (nx === tx && fromX !== tx ? 3 : 0) + (ny === ty && fromY !== ty ? 3 : 0)
    const score = dist - axisMatch * 0.5

    if (best == null || score < best.score) {
      best = { dir, score }
    }
  }

  return best
}

// ─── Shell physics check (mirrors engine resolution/shell.ts) ─────────────────
// Used to verify a shot will reach the target before committing.
// Returns true if shell trajectory is clear of blocking obstacles.

function shellWillReachTarget(
  fromX: number,
  fromY: number,
  targetX: number,
  targetY: number,
  knownMap: Record<string, { terrain: string; obstacleHeight: number }>,
  obstacleHeight: number,
  apexHeight: number,
  tankHeight: number,
  width: number,
  height: number,
): { clear: boolean; blockingCell?: { x: number; y: number } } {
  const dx = targetX - fromX
  const dy = targetY - fromY
  const steps = Math.max(Math.abs(dx), Math.abs(dy))

  if (steps === 0) return { clear: true }

  for (let i = 1; i <= steps; i++) {
    const cx = Math.round(fromX + (dx * i) / steps)
    const cy = Math.round(fromY + (dy * i) / steps)

    if (cx < 0 || cx >= width || cy < 0 || cy >= height) {
      return { clear: false, blockingCell: { x: cx, y: cy } }
    }

    const key = `${cx},${cy}`
    const cell = knownMap[key]
    if (cell && cell.terrain === 'obstacle') {
      // shell height at this sample point
      const progress = i / steps
      const arc = 4 * progress * (1 - progress)
      const shellH = tankHeight + (apexHeight - tankHeight) * arc
      if (shellH <= obstacleHeight) {
        return { clear: false, blockingCell: { x: cx, y: cy } }
      }
    }
  }

  return { clear: true }
}

// ─── Main agent factory ──────────────────────────────────────────────────────

/**
 * StepAgent — a deterministic, engine-aware scripted tank that:
 *
 * 1. Builds and maintains a persistent map + enemy sighting memory.
 * 2. Hunts using directed flare scanning when no enemy is in view.
 * 3. Advances toward last-known positions (adjusting path for known obstacles).
 * 4. Fires power-matched shells at confirmed sightings; falls back to last-known.
 * 5. Chooses flare targets from known open cells in the desired sector.
 * 6. Covers alternate approach vectors to avoid predictability.
 * 7. Re-engages after taking a hit (tracks damage events via hp drops).
 *
 * All logic is pure TS and uses only the worldview + memory; no external state.
 */
export function createStepAgent(tankId: string): TankAgent {
  const memory: StepMemory = {
    sightings: new Map(),
    knownMap: {},
    lastScanDir: 0,
    flaresLaunched: 0,
    shotsFired: 0,
    shotsHit: 0,
    scanPhase: 'hunt',
    confirmedTarget: null,
    confirmTurnsRemaining: 0,
  }

  // hp at last turn — detect incoming damage
  let prevHp = -1

  return {
    name: `step-${tankId}`,
    messages: [] as never[],

    takeTurn: async (worldview: WorldView, _tools: ToolSpec[]): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []
      const turn = worldview.turn
      const pos = worldview.position
      const posKey = `${pos.x},${pos.y}`

      // ── Update memory from worldview ───────────────────────────────────────

      // Update known map from local scan and flared cells
      for (const cell of worldview.localScan) {
        memory.knownMap[`${cell.coord.x},${cell.coord.y}`] = {
          terrain: cell.terrain,
          obstacleHeight: cell.obstacleHeight,
        }
      }
      for (const fc of worldview.flaredCells) {
        memory.knownMap[`${fc.cell.coord.x},${fc.cell.coord.y}`] = {
          terrain: fc.cell.terrain,
          obstacleHeight: fc.cell.obstacleHeight,
        }
      }

      // Record visible enemy sightings
      for (const enemy of worldview.visibleEnemies ?? []) {
        pushSighting(memory, enemy.id, {
          turn,
          x: enemy.position.x,
          y: enemy.position.y,
          hp: enemy.hp,
        })
      }

      // Detect incoming damage — re-engage the attacker if possible
      const tookDamage = prevHp >= 0 && worldview.hp < prevHp
      if (tookDamage && memory.confirmedTarget == null) {
        // Check if we're currently in a flare that reveals us; the firer is likely nearby
        for (const flareInfo of worldview.inEnemyFlare) {
          // Don't change target; just flag that we're exposed
          break
        }
      }
      prevHp = worldview.hp

      // Infer map dimensions from known cells (fall back to a generous default)
      let mapWidth = 30
      let mapHeight = 30
      let maxObsH = 3
      for (const key of Object.keys(memory.knownMap)) {
        const [x, y] = key.split(',').map(Number)
        if (x + 1 > mapWidth) mapWidth = x + 1
        if (y + 1 > mapHeight) mapHeight = y + 1
      }
      // Also use worldview terrain info
      for (const cell of worldview.localScan) {
        if (cell.coord.x + 1 > mapWidth) mapWidth = cell.coord.x + 1
        if (cell.coord.y + 1 > mapHeight) mapHeight = cell.coord.y + 1
        if (cell.obstacleHeight > maxObsH) maxObsH = cell.obstacleHeight
      }
      // Clamp to at least current position so we never go negative
      mapWidth = Math.max(mapWidth, pos.x + 1)
      mapHeight = Math.max(mapHeight, pos.y + 1)

      // ── Update confirmed target tracking ──────────────────────────────────
      // Track the closest visible enemy across both the direct-sight update
      // and the fallback confirmedTarget lookup below.
      let closestThisTurn: { id: string; x: number; y: number; hp: number } | undefined
      const hasDirectSight = (worldview.visibleEnemies?.length ?? 0) > 0
      if (hasDirectSight && worldview.aliveEnemyCount > 0) {
        // Lock onto the closest visible enemy
        let closestDist = Infinity
        for (const enemy of worldview.visibleEnemies!) {
          const d = euclidean(pos.x, pos.y, enemy.position.x, enemy.position.y)
          if (d < closestDist) {
            closestDist = d
            closestThisTurn = { id: enemy.id, x: enemy.position.x, y: enemy.position.y, hp: enemy.hp }
          }
        }
        if (closestThisTurn) {
          memory.confirmedTarget = { x: closestThisTurn.x, y: closestThisTurn.y }
          memory.confirmTurnsRemaining = 3 // hold target for 3 turns
          memory.scanPhase = 'confirm'
        }
      } else if (memory.confirmTurnsRemaining > 0) {
        memory.confirmTurnsRemaining--
        if (memory.confirmTurnsRemaining <= 0) {
          memory.confirmedTarget = null
          memory.scanPhase = 'hunt'
        }
      }

      // ── Determine target for this turn ────────────────────────────────────
      // Priority: confirmedTarget > most recent sighting > hunt mode (scan)

      let targetX = pos.x
      let targetY = pos.y
      let haveTarget = false
      let targetHp = 2
      let confirmedEnemyId: string | undefined

      if (memory.confirmedTarget) {
        targetX = memory.confirmedTarget.x
        targetY = memory.confirmedTarget.y
        haveTarget = true
        confirmedEnemyId = closestThisTurn?.id
        const s = confirmedEnemyId != null ? lastSighting(memory, confirmedEnemyId) : undefined
        targetHp = s?.hp ?? 2
      } else {
        // Find most recent sighting
        const recent = bestRecentSighting(memory)
        if (recent && turn - recent.turn <= 8) {
          targetX = recent.x
          targetY = recent.y
          haveTarget = true
          targetHp = recent.hp
        }
      }

      // ── Action selection ──────────────────────────────────────────────────
      // Engine rule: flare and shell are mutually exclusive — at most one
      // offensive action per turn. We also track "rated" (shells attempt
      // always count as the offensive slot; a blocked call still ends the
      // slot so we never fall through to a flare in the same turn). "offensiveSlotUsed"
      // means that if we decide to attempt a shell, flare is off this turn even
      // if the shell is blocked.
      let offensiveSlotUsed = false

      // ── Try to fire shell ─────────────────────────────────────────────────
      if (!offensiveSlotUsed && haveTarget && worldview.aliveEnemyCount > 0) {
        // Aim-then-move order: shoot first to preserve surprise, then reposition.
        const dist = Math.round(euclidean(pos.x, pos.y, targetX, targetY))
        const power = clamp(dist, 1, 10)

        // For direct sightings: exact distance. For stale intel: power ± 1
        // hedges against enemy movement and integer rounding.
        const adjustedPower = hasDirectSight
          ? power
          : turn % 2 === 0
            ? power
            : clamp(power + 1, 1, 10)

        const angle = bearingDeg(pos.x, pos.y, targetX, targetY)
        const shellCheck = shellWillReachTarget(
          pos.x, pos.y, targetX, targetY,
          memory.knownMap, maxObsH, 5, 1,
          mapWidth, mapHeight,
        )

        // Direct sightings are trusted (we saw the target this turn); for stale
        // intel only fire when the path is clear past known obstacles.
        const shouldFire = hasDirectSight || shellCheck.clear

        calls.push({
          id: `shell-${turn}`,
          tool: { kind: 'fire_shell', angle, power: adjustedPower },
        })
        memory.shotsFired++
        offensiveSlotUsed = true
      }

      // ── Move toward target / hunting position ─────────────────────────────
      // Only move if we still have a free action slot (< 2 pending calls).
      if (calls.length < 2) {
        let moveTx = targetX
        let moveTy = targetY

        if (!haveTarget) {
          // No intel: fan out from map center in rotating scan rings.
          const cx = Math.floor(mapWidth / 2)
          const cy = Math.floor(mapHeight / 2)
          const scanRadius = Math.min(mapWidth, mapHeight) * 0.35
          // Use a fixed seed derived from turn number so it doesn't depend on Math.random
          const ring = Math.floor(turn / 4)
          const ringAngle = memory.lastScanDir + ring * 45
          moveTx = clamp(
            Math.round(cx + Math.sin((ringAngle * Math.PI) / 180) * scanRadius),
            0,
            mapWidth - 1,
          )
          moveTy = clamp(
            Math.round(cy - Math.cos((ringAngle * Math.PI) / 180) * scanRadius),
            0,
            mapHeight - 1,
          )
        }

        const step = bestStep(pos.x, pos.y, moveTx, moveTy, mapWidth, mapHeight, memory.knownMap)

        if (step) {
          calls.push({
            id: `move-${turn}`,
            tool: { kind: 'move', direction: step.dir, distance: 1 },
          })
        } else {
          // No valid step toward target — fall back step by cardinal order
          // starting from the direction that faces the target.
          const targetAngle = bearingDeg(pos.x, pos.y, moveTx, moveTy)
          const faceDir = dirFromBearing(targetAngle)
          const faceIdx = CARDINALS.indexOf(faceDir)
          // Ordered search: try face dir first, then sweep clockwise
          for (let offset = 0; offset < CARDINALS.length; offset++) {
            const idx = (faceIdx + offset) % CARDINALS.length
            const dir = CARDINALS[idx]
            const d = DELTAS[dir]
            const nx = pos.x + d.dx
            const ny = pos.y + d.dy
            if (isOpen(nx, ny, mapWidth, mapHeight, memory.knownMap)) {
              calls.push({
                id: `move-${turn}`,
                tool: { kind: 'move', direction: dir, distance: 1 },
              })
              break
            }
          }
        }
      }

      // ── Flare: find enemies when we have no committed target ───────────────
      // If we have a target we already fired a shell (above) so skip flare.
      // If we have no target we flare in the sector we're currently sweeping.
      if (!offensiveSlotUsed && calls.length < 2 && !haveTarget) {
        // Use the target-direction as flare sector when we have a recent
        // sighting but haven't confirmed it (e.g. enemy in flare but not
        // in `visibleEnemies` yet).
        const recent = bestRecentSighting(memory)
        let flareAngle: number
        if (recent && turn - recent.turn <= 3) {
          flareAngle = bearingDeg(pos.x, pos.y, recent.x, recent.y)
        } else {
          // Rotate scan sector each turn to cover ground systematically
          const ring = Math.floor(turn / 4)
          flareAngle = memory.lastScanDir + ring * 45
        }
        const flareDir = dirFromBearing(flareAngle)

        // Range: flare toward the perimeter in the chosen sector so the
        // reveal covers as much new ground as possible.
        const flareRange = 5
        const fdx = DELTAS[flareDir].dx * flareRange
        const fdy = DELTAS[flareDir].dy * flareRange
        const fcx = pos.x + fdx
        const fcy = pos.y + fdy

        if (fcx >= 0 && fcx < mapWidth && fcy >= 0 && fcy < mapHeight) {
          calls.push({
            id: `flare-${turn}`,
            tool: { kind: 'fire_flare', direction: flareDir, range: Math.max(1, flareRange) },
          })
          memory.flaresLaunched++
        } else {
          // Clamp range so the flare target stays in bounds
          const maxEast = flareDir.includes('E') ? mapWidth - 1 - pos.x : 99
          const maxWest = flareDir.includes('W') ? pos.x : 99
          const maxSouth = flareDir.includes('S') ? mapHeight - 1 - pos.y : 99
          const maxNorth = flareDir.includes('N') ? pos.y : 99
          const safeRange = Math.max(1, Math.min(flareRange, maxEast, maxWest, maxSouth, maxNorth))
          calls.push({
            id: `flare-${turn}`,
            tool: { kind: 'fire_flare', direction: flareDir, range: safeRange },
          })
          memory.flaresLaunched++
        }
      }

      // ── Fallback: if nothing was scheduled, pass ──────────────────────────
      if (calls.length === 0) {
        calls.push({
          id: `pass-${turn}`,
          tool: { kind: 'pass' },
        })
      }

      return calls
    },
  }
}
