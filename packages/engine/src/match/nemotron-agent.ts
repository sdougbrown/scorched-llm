import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS, inBounds } from '../geometry/coords.js'
import { supercover } from '../geometry/supercover.js'

/** Persistent memory for Nemotron agent. */
interface NemotronMemory {
  /** Last known position of the enemy tank. */
  lastKnownEnemyPos: Coordinate | null
  /** Turn when the enemy was last seen. */
  lastSeenTurn: number
  /** Enemy movement history for prediction. */
  enemyHistory: Array<{ turn: number; position: Coordinate }>
  /** My previous position. */
  myPrevPosition: Coordinate | null
  /** Shots fired history for trajectory analysis. */
  shotHistory: Array<{ turn: number; angle: number; power: number; result: string; targetPos: Coordinate }>
  /** Map dimensions. */
  mapWidth: number
  mapHeight: number
  /** Whether we've fired a flare this turn. */
  flareFiredThisTurn: boolean
  /** Turns since we had intel on enemy. */
  turnsSinceIntel: number
  /** Enemy movement pattern: 'stationary', 'mobile', 'normal' */
  enemyPattern: string
  /** Known obstacle cells. */
  knownObstacles: Set<string>
  /** Last shell damage dealt. */
  lastShellDamage: number
  /** Current tactical state. */
  state: 'hunt' | 'engage' | 'flank' | 'reposition' | 'idle'
  /** Flare directions already tried this match (to avoid repetition). */
  flareHistory: Set<string>
  /** Predicted enemy position. */
  predictedEnemyPos: Coordinate | null
}

/** Configuration constants. */
const MAX_SHELL_RANGE = 10
const LOCAL_SCAN_RADIUS = 3
const MAX_HP = 2
const HITS_TO_KILL = 2
const FLARE_RADIUS = 2

/** Compute bearing from 'from' to 'to' in degrees (0=N, 90=E, 180=S, 270=W). */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Convert bearing to nearest compass direction. */
function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round(b / 45) % 8
  return dirs[idx]
}

/** Get opposite direction. */
function oppositeDirection(dir: Direction): Direction {
  const opposites: Record<Direction, Direction> = {
    N: 'S', NE: 'SW', E: 'W', SE: 'NW',
    S: 'N', SW: 'NE', W: 'E', NW: 'SE',
  }
  return opposites[dir]
}

/** Convert angle to delta vector. */
function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/** Check if a shell trajectory from shooter at angle/power would hit target. */
function wouldShellHit(
  shooter: Coordinate,
  angle: number,
  power: number,
  target: Coordinate,
  knownObstacles: Set<string>,
  obstacleHeight: number = 3
): boolean {
  const delta = angleToDelta(angle)
  const targetPos: Coordinate = {
    x: Math.round(shooter.x + delta.dx * power),
    y: Math.round(shooter.y + delta.dy * power),
  }
  const trajectoryCells = supercover(shooter, targetPos).slice(1)

  for (let i = 0; i < trajectoryCells.length; i++) {
    const cell = trajectoryCells[i]
    if (cell.x === target.x && cell.y === target.y) {
      const progress = (i + 1) / trajectoryCells.length
      const arc = 4 * progress * (1 - progress)
      const shellHeight = 1 + (5 - 1) * arc
      for (const obsKey of knownObstacles) {
        const [ox, oy] = obsKey.split(',').map(Number)
        if (ox === cell.x && oy === cell.y) {
          if (shellHeight <= obstacleHeight) return false
          break
        }
      }
      return true
    }
  }
  return false
}

/** Calculate optimal firing solution for a target at distance. */
function calculateFiringSolution(
  shooter: Coordinate,
  target: Coordinate,
  knownObstacles: Set<string>
): { angle: number; power: number; confidence: number } | null {
  const dist = euclidean(shooter, target)
  if (dist < 1 || dist > MAX_SHELL_RANGE) return null

  const directAngle = bearing(shooter, target)
  const directPower = Math.round(dist)

  // Test direct shot
  if (wouldShellHit(shooter, directAngle, directPower, target, knownObstacles)) {
    return { angle: directAngle, power: directPower, confidence: 0.9 }
  }

  // Try small angle adjustments (±15 degrees in 3-degree steps)
  for (let offset = -15; offset <= 15; offset += 3) {
    if (offset === 0) continue
    const testAngle = (directAngle + offset + 360) % 360
    if (wouldShellHit(shooter, testAngle, directPower, target, knownObstacles)) {
      return { angle: testAngle, power: directPower, confidence: 0.7 }
    }
  }

  // Try power adjustments
  for (let powerOffset = -1; powerOffset <= 1; powerOffset++) {
    if (powerOffset === 0) continue
    const testPower = Math.max(1, Math.min(MAX_SHELL_RANGE, directPower + powerOffset))
    if (wouldShellHit(shooter, directAngle, testPower, target, knownObstacles)) {
      return { angle: directAngle, power: testPower, confidence: 0.6 }
    }
  }

  return { angle: directAngle, power: Math.max(1, Math.min(MAX_SHELL_RANGE, directPower)), confidence: 0.3 }
}

/** Predict enemy next position based on movement history. */
function predictEnemyPosition(
  history: Array<{ turn: number; position: Coordinate }>,
): Coordinate | null {
  if (history.length < 2) return null

  const recent = history.slice(-3)
  const moves = []
  for (let i = 1; i < recent.length; i++) {
    const dx = recent[i].position.x - recent[i-1].position.x
    const dy = recent[i].position.y - recent[i-1].position.y
    if (dx !== 0 || dy !== 0) {
      moves.push({ dx, dy })
    }
  }
  if (moves.length === 0) return null

  const avgDx = moves.reduce((sum, m) => sum + m.dx, 0) / moves.length
  const avgDy = moves.reduce((sum, m) => sum + m.dy, 0) / moves.length

  const lastPos = recent[recent.length - 1].position
  return {
    x: Math.round(lastPos.x + avgDx),
    y: Math.round(lastPos.y + avgDy)
  }
}

/** Find best direction to move toward target, avoiding known obstacles. */
function findBestMoveDirection(
  from: Coordinate,
  target: Coordinate,
  knownObstacles: Set<string>,
  mapWidth: number,
  mapHeight: number,
  maxDist: number = 2
): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestScore = -Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let score = 0
    let valid = true

    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step

      if (!inBounds({ x: cx, y: cy }, mapWidth, mapHeight)) {
        valid = false
        break
      }

      const key = `${cx},${cy}`
      if (knownObstacles.has(key)) {
        valid = false
        break
      }

      const dist = euclidean({ x: cx, y: cy }, target)
      score -= dist * 0.3

      // Small cover bonus
      for (const obsKey of knownObstacles) {
        const [ox, oy] = obsKey.split(',').map(Number)
        const obsDist = euclidean({ x: cx, y: cy }, { x: ox, y: oy })
        if (obsDist <= 1.5) score += 1
      }
    }

    if (valid && score > bestScore) {
      bestScore = score
      best = dir
    }
  }

  return best
}

/** Check if we have line of sight to enemy (no obstacles blocking). */
function hasLineOfSight(
  from: Coordinate,
  to: Coordinate,
  knownObstacles: Set<string>
): boolean {
  const cells = supercover(from, to).slice(1, -1)
  for (const cell of cells) {
    if (knownObstacles.has(`${cell.x},${cell.y}`)) return false
  }
  return true
}

/** Determine enemy movement pattern. */
function analyzeEnemyPattern(history: Array<{ turn: number; position: Coordinate }>): string {
  if (history.length < 3) return 'unknown'

  const recent = history.slice(-5)
  let totalDist = 0

  for (let i = 1; i < recent.length; i++) {
    totalDist += euclidean(recent[i-1].position, recent[i].position)
  }

  const avgMove = totalDist / (recent.length - 1)

  if (avgMove < 0.5) return 'stationary'
  if (avgMove > 1.5) return 'mobile'
  return 'normal'
}

/** Get a hunt target coordinate based on compass direction. */
function getHuntTarget(quad: 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW', mapWidth: number, mapHeight: number): Coordinate {
  const cx = Math.floor(mapWidth / 2)
  const cy = Math.floor(mapHeight / 2)
  const delta = DIRECTION_DELTAS[quad]
  return {
    x: cx + delta.dx * 6,
    y: cy + delta.dy * 6
  }
}

/** Choose next flare direction using spiral search pattern. */
function chooseNextFlareDirection(
  myPos: Coordinate,
  enemyQuadrant: Direction | null,
  flareHistory: Set<string>,
  mapWidth: number,
  mapHeight: number
): { dir: Direction; range: number } | null {
  const cx = Math.floor(mapWidth / 2)
  const cy = Math.floor(mapHeight / 2)
  
  // Spiral search pattern: start with 8 cardinal directions at different ranges
  const searchPattern: Array<{ dir: Direction; range: number }> = [
    { dir: 'N', range: 5 }, { dir: 'NE', range: 5 }, { dir: 'E', range: 5 },
    { dir: 'SE', range: 5 }, { dir: 'S', range: 5 }, { dir: 'SW', range: 5 },
    { dir: 'W', range: 5 }, { dir: 'NW', range: 5 },
    { dir: 'N', range: 7 }, { dir: 'NE', range: 7 }, { dir: 'E', range: 7 },
    { dir: 'SE', range: 7 }, { dir: 'S', range: 7 }, { dir: 'SW', range: 7 },
    { dir: 'W', range: 7 }, { dir: 'NW', range: 7 },
  ]

  // If we have a quadrant hint, prioritize that direction
  if (enemyQuadrant) {
    const prioritized = searchPattern.filter(p => p.dir === enemyQuadrant || 
      (p.dir === 'N' && (enemyQuadrant === 'NW' || enemyQuadrant === 'NE')) ||
      (p.dir === 'S' && (enemyQuadrant === 'SW' || enemyQuadrant === 'SE')) ||
      (p.dir === 'E' && (enemyQuadrant === 'NE' || enemyQuadrant === 'SE')) ||
      (p.dir === 'W' && (enemyQuadrant === 'NW' || enemyQuadrant === 'SW'))
    )
    searchPattern.unshift(...prioritized)
  }

  for (const candidate of searchPattern) {
    const key = `${candidate.dir}:${candidate.range}`
    if (!flareHistory.has(key)) {
      // Validate target is in bounds
      const delta = DIRECTION_DELTAS[candidate.dir]
      const targetX = myPos.x + delta.dx * candidate.range
      const targetY = myPos.y + delta.dy * candidate.range
      if (inBounds({ x: targetX, y: targetY }, mapWidth, mapHeight)) {
        return candidate
      }
    }
  }

  // Fallback: flare toward center
  const centerBearing = bearing(myPos, { x: cx, y: cy })
  const centerDir = bearingToDirection(centerBearing)
  const key = `${centerDir}:5`
  if (!flareHistory.has(key)) {
    return { dir: centerDir, range: 5 }
  }

  return null
}

/** Find best flanking move - move perpendicular to enemy line of sight. */
function findFlankingMove(
  from: Coordinate,
  enemy: Coordinate,
  knownObstacles: Set<string>,
  mapWidth: number,
  mapHeight: number,
  maxDist: number = 2
): Direction {
  const bearingToEnemy = bearing(from, enemy)
  const leftFlank = (bearingToEnemy + 90) % 360
  const rightFlank = (bearingToEnemy - 90 + 360) % 360
  
  const leftDir = bearingToDirection(leftFlank)
  const rightDir = bearingToDirection(rightFlank)

  const leftScore = evaluateMoveDirection(from, leftDir, enemy, knownObstacles, mapWidth, mapHeight, maxDist)
  const rightScore = evaluateMoveDirection(from, rightDir, enemy, knownObstacles, mapWidth, mapHeight, maxDist)

  return leftScore >= rightScore ? leftDir : rightDir
}

/** Evaluate a move direction for tactical value. */
function evaluateMoveDirection(
  from: Coordinate,
  dir: Direction,
  enemy: Coordinate,
  knownObstacles: Set<string>,
  mapWidth: number,
  mapHeight: number,
  maxDist: number
): number {
  const delta = DIRECTION_DELTAS[dir]
  let score = 0
  let valid = true

  for (let step = 1; step <= maxDist; step++) {
    const cx = from.x + delta.dx * step
    const cy = from.y + delta.dy * step

    if (!inBounds({ x: cx, y: cy }, mapWidth, mapHeight)) {
      valid = false
      break
    }

    const key = `${cx},${cy}`
    if (knownObstacles.has(key)) {
      valid = false
      break
    }

    const dist = euclidean({ x: cx, y: cy }, enemy)
    if (dist >= 4 && dist <= 7) score += 10 - Math.abs(dist - 5.5)
    else if (dist < 4) score -= (4 - dist) * 3
    else score -= (dist - 7) * 1.5

    for (const obsKey of knownObstacles) {
      const [ox, oy] = obsKey.split(',').map(Number)
      const obsDist = euclidean({ x: cx, y: cy }, { x: ox, y: oy })
      if (obsDist <= 1.5) score += 3
    }
  }

  return valid ? score : -Infinity
}

/** Create the Nemotron tank agent. */
export function createNemotronAgent(
  tankId: string,
  mapWidth: number = 20,
  mapHeight: number = 20
): TankAgent {
  const memory: NemotronMemory = {
    lastKnownEnemyPos: null,
    lastSeenTurn: -999,
    enemyHistory: [],
    myPrevPosition: null,
    shotHistory: [],
    mapWidth,
    mapHeight,
    flareFiredThisTurn: false,
    turnsSinceIntel: 999,
    enemyPattern: 'unknown',
    knownObstacles: new Set(),
    lastShellDamage: 0,
    state: 'hunt',
    flareHistory: new Set(),
    predictedEnemyPos: null,
  }

  return {
    name: `nemotron-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      _tools: ToolSpec[],
    ): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []
      const turn = worldview.turn
      const myPos = worldview.position
      const myHp = worldview.hp
      const remainingActions = worldview.remainingActions
      const aliveEnemies = worldview.aliveEnemyCount

      // Reset per-turn flag
      memory.flareFiredThisTurn = false

      // Update known obstacles from local scan and flares
      for (const cell of worldview.localScan) {
        if (cell.terrain === 'obstacle') {
          memory.knownObstacles.add(`${cell.coord.x},${cell.coord.y}`)
        }
      }
      for (const flare of worldview.flaredCells) {
        if (flare.cell.terrain === 'obstacle') {
          memory.knownObstacles.add(`${flare.cell.coord.x},${flare.cell.coord.y}`)
        }
      }

      // Track my position
      memory.myPrevPosition = { ...myPos }

      // Update enemy tracking
      const visibleEnemies = worldview.visibleEnemies ?? []
      if (visibleEnemies.length > 0) {
        // Target the closest visible enemy
        let closest = visibleEnemies[0]
        let minDist = euclidean(myPos, closest.position)
        for (const enemy of visibleEnemies) {
          const dist = euclidean(myPos, enemy.position)
          if (dist < minDist) {
            minDist = dist
            closest = enemy
          }
        }
        
        memory.lastKnownEnemyPos = { ...closest.position }
        memory.lastSeenTurn = turn
        memory.turnsSinceIntel = 0
        memory.enemyHistory.push({ turn, position: { ...closest.position } })
        if (memory.enemyHistory.length > 20) memory.enemyHistory.shift()
        memory.enemyPattern = analyzeEnemyPattern(memory.enemyHistory)
        memory.predictedEnemyPos = predictEnemyPosition(memory.enemyHistory)
        memory.state = 'engage'
      } else {
        memory.turnsSinceIntel++
        if (memory.lastKnownEnemyPos && memory.turnsSinceIntel <= 3) {
          memory.predictedEnemyPos = predictEnemyPosition(memory.enemyHistory)
        }
      }

      // Determine if we have actionable intel
      const hasIntel = memory.lastKnownEnemyPos !== null && memory.turnsSinceIntel <= 4
      const shouldFlare = !hasIntel && aliveEnemies > 0 && remainingActions > 0 && !memory.flareFiredThisTurn

      // Determine optimal engagement range
      let preferredRange = 5
      if (myHp === 1) preferredRange = 7
      if (memory.enemyPattern === 'mobile') preferredRange = 6

      // === PRIORITY 1: FIRE SHELL IF ENEMY VISIBLE AND IN RANGE ===
      if (visibleEnemies.length > 0 && remainingActions > 0) {
        for (const enemy of visibleEnemies) {
          const dist = euclidean(myPos, enemy.position)
          if (dist <= MAX_SHELL_RANGE && dist >= 1) {
            const solution = calculateFiringSolution(myPos, enemy.position, memory.knownObstacles)
            if (solution && solution.confidence > 0.4) {
              calls.push({
                id: `shell-${turn}-${calls.length}`,
                tool: { kind: 'fire_shell', angle: solution.angle, power: solution.power },
              })
              memory.shotHistory.push({
                turn,
                angle: solution.angle,
                power: solution.power,
                result: 'fired',
                targetPos: enemy.position
              })
              if (memory.shotHistory.length > 10) memory.shotHistory.shift()
              break
            }
          }
        }
      }
      // === PRIORITY 2: FIRE AT LAST KNOWN / PREDICTED POSITION IF RECENT INTEL ===
      else if (remainingActions > 0 && memory.turnsSinceIntel <= 2) {
        let targetPos = memory.lastKnownEnemyPos
        // Use predicted position if available and recent
        if (memory.predictedEnemyPos && memory.turnsSinceIntel <= 1) {
          targetPos = memory.predictedEnemyPos
        }
        
        if (targetPos) {
          const dist = euclidean(myPos, targetPos)
          if (dist <= MAX_SHELL_RANGE && dist >= 1) {
            const hasLOS = hasLineOfSight(myPos, targetPos, memory.knownObstacles)
            if (hasLOS || memory.enemyPattern === 'stationary') {
              const solution = calculateFiringSolution(myPos, targetPos, memory.knownObstacles)
              if (solution && solution.confidence > 0.3) {
                calls.push({
                  id: `shell-${turn}-${calls.length}`,
                  tool: { kind: 'fire_shell', angle: solution.angle, power: solution.power },
                })
                memory.shotHistory.push({
                  turn,
                  angle: solution.angle,
                  power: solution.power,
                  result: 'fired-blind',
                  targetPos
                })
                if (memory.shotHistory.length > 10) memory.shotHistory.shift()
              }
            }
          }
        }
      }

      // === PRIORITY 3: MOVEMENT ===
      if (remainingActions > 0 && calls.filter(c => c.tool.kind === 'move').length === 0) {
        let moveDir: Direction
        let moveDist = 1

        if (memory.lastKnownEnemyPos) {
          const distToEnemy = euclidean(myPos, memory.lastKnownEnemyPos)
          
          if (distToEnemy <= 3) {
            // Too close - retreat to preferred range
            const awayBearing = (bearing(myPos, memory.lastKnownEnemyPos) + 180) % 360
            const awayDir = bearingToDirection(awayBearing)
            const retreatTarget = {
              x: myPos.x + DIRECTION_DELTAS[awayDir].dx * 3,
              y: myPos.y + DIRECTION_DELTAS[awayDir].dy * 3
            }
            moveDir = findBestMoveDirection(myPos, retreatTarget, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 2)
            memory.state = 'reposition'
          } else if (distToEnemy > preferredRange + 2) {
            // Too far - advance toward enemy
            moveDir = findBestMoveDirection(myPos, memory.lastKnownEnemyPos, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 2)
            memory.state = 'engage'
          } else if (distToEnemy >= preferredRange - 1 && distToEnemy <= preferredRange + 1) {
            // At good range - flank or hold
            if (memory.enemyPattern === 'stationary' || memory.enemyPattern === 'mobile') {
              moveDir = findFlankingMove(myPos, memory.lastKnownEnemyPos, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 2)
              memory.state = 'flank'
            } else {
              // Small adjustment for cover
              moveDir = findBestMoveDirection(myPos, memory.lastKnownEnemyPos, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 1)
              memory.state = 'engage'
            }
          } else {
            // Adjust toward preferred range
            moveDir = findBestMoveDirection(myPos, memory.lastKnownEnemyPos, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 2)
            memory.state = 'engage'
          }
        } else {
          // No intel - hunt using spiral flare directions
          // Infer enemy quadrant from my spawn (symmetric spawn assumption)
          let enemyQuadrant: Direction | null = null
          if (turn === 1) {
            const cx = mapWidth / 2
            const cy = mapHeight / 2
            if (myPos.x < cx && myPos.y < cy) enemyQuadrant = 'SE'
            else if (myPos.x >= cx && myPos.y < cy) enemyQuadrant = 'SW'
            else if (myPos.x < cx && myPos.y >= cy) enemyQuadrant = 'NE'
            else enemyQuadrant = 'NW'
          }
          
          const nextFlare = chooseNextFlareDirection(myPos, enemyQuadrant, memory.flareHistory, memory.mapWidth, memory.mapHeight)
          let huntTarget: Coordinate
          if (nextFlare) {
            const delta = DIRECTION_DELTAS[nextFlare.dir]
            huntTarget = {
              x: myPos.x + delta.dx * nextFlare.range,
              y: myPos.y + delta.dy * nextFlare.range
            }
          } else {
            huntTarget = { x: Math.floor(memory.mapWidth / 2), y: Math.floor(memory.mapHeight / 2) }
          }
          
          moveDir = findBestMoveDirection(myPos, huntTarget, memory.knownObstacles, memory.mapWidth, memory.mapHeight, 2)
          memory.state = 'hunt'
        }

        // Validate move
        const delta = DIRECTION_DELTAS[moveDir]
        const newX = myPos.x + delta.dx * moveDist
        const newY = myPos.y + delta.dy * moveDist
        
        if (inBounds({ x: newX, y: newY }, memory.mapWidth, memory.mapHeight) &&
            !memory.knownObstacles.has(`${newX},${newY}`)) {
          calls.push({
            id: `move-${turn}-${calls.length}`,
            tool: { kind: 'move', direction: moveDir, distance: moveDist },
          })
        }
      }

      // === PRIORITY 4: FLARE FOR INTEL ===
      if (shouldFlare && remainingActions > 0 && calls.filter(c => c.tool.kind === 'fire_flare').length === 0) {
        // Infer enemy quadrant from spawn position
        let enemyQuadrant: Direction | null = null
        const cx = memory.mapWidth / 2
        const cy = memory.mapHeight / 2
        if (myPos.x < cx && myPos.y < cy) enemyQuadrant = 'SE'
        else if (myPos.x >= cx && myPos.y < cy) enemyQuadrant = 'SW'
        else if (myPos.x < cx && myPos.y >= cy) enemyQuadrant = 'NE'
        else enemyQuadrant = 'NW'

        const nextFlare = chooseNextFlareDirection(myPos, enemyQuadrant, memory.flareHistory, memory.mapWidth, memory.mapHeight)
        
        if (nextFlare) {
          const key = `${nextFlare.dir}:${nextFlare.range}`
          memory.flareHistory.add(key)
          
          calls.push({
            id: `flare-${turn}-${calls.length}`,
            tool: { kind: 'fire_flare', direction: nextFlare.dir, range: nextFlare.range },
          })
          memory.flareFiredThisTurn = true
        }
      }

      // === PRIORITY 5: PASS IF NO ACTIONS ===
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
