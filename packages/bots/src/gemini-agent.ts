import type { WorldView } from '@scorched-llm/engine'
import type { ToolCall } from '@scorched-llm/engine'
import type { TankAgent, AgentMessage, ToolSpec, ToolExecutor, AgentTurnResult } from '@scorched-llm/engine'
import type { Coordinate, Direction, Cell } from '@scorched-llm/engine'
import { DIRECTION_DELTAS, euclidean } from '@scorched-llm/engine'
import { supercover } from '@scorched-llm/engine'

/** Compute a clockwise bearing (degrees from north, 0–360) from `from` to `to`. */
function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y // dy positive = south
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

/** Compute shell height at sample index i out of N cells after the shooter. */
function shellHeight(i: number, N: number, apexHeight: number, tankHeight: number): number {
  if (N <= 0) return tankHeight
  const progress = (i + 1) / N
  const arc = 4 * progress * (1 - progress)
  return tankHeight + (apexHeight - tankHeight) * arc
}

/** Check if there is a clear shot from `from` to `to` avoiding obstacles. */
function checkClearShot(
  from: Coordinate,
  to: Coordinate,
  knownCells: Record<string, Cell>,
  apexHeight = 5,
  tankHeight = 1,
): boolean {
  const path = supercover(from, to)
  if (path.length <= 1) return true
  const sampledCells = path.slice(1)
  const N = sampledCells.length

  for (let i = 0; i < N; i++) {
    const cell = sampledCells[i]
    const cellHeight = shellHeight(i, N, apexHeight, tankHeight)
    const terrainCell = knownCells[`${cell.x},${cell.y}`]
    if (terrainCell && terrainCell.terrain === 'obstacle' && cellHeight <= terrainCell.obstacleHeight) {
      return false // Blocked by obstacle
    }
  }
  return true
}

interface PathStep {
  direction: Direction
  distance: number
  pos: Coordinate
}

/** BFS pathfinder that returns the shortest path to target, avoiding known obstacles. */
function findPath(
  from: Coordinate,
  to: Coordinate,
  knownCells: Record<string, Cell>,
  maxMoveDistance: number,
  width: number,
  height: number,
  otherTankPositions: Coordinate[],
): PathStep[] {
  const queue: Array<{ pos: Coordinate; path: PathStep[]; cost: number }> = [
    { pos: from, path: [], cost: 0 },
  ]
  const visited = new Set<string>()
  visited.add(`${from.x},${from.y}`)

  let bestPath: PathStep[] = []
  let bestDist = euclidean(from, to)

  while (queue.length > 0) {
    const { pos, path, cost } = queue.shift()!
    const dist = euclidean(pos, to)

    if (dist < bestDist) {
      bestDist = dist
      bestPath = path
    }

    if (pos.x === to.x && pos.y === to.y) {
      return path
    }

    const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
    for (const dir of dirs) {
      const delta = DIRECTION_DELTAS[dir]
      for (let d = 1; d <= maxMoveDistance; d++) {
        const nx = pos.x + delta.dx * d
        const ny = pos.y + delta.dy * d
        const nextPos = { x: nx, y: ny }

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          break
        }

        const cellKey = `${nx},${ny}`
        const cell = knownCells[cellKey]
        if (cell && cell.terrain === 'obstacle') {
          break
        }

        const isOccupied = otherTankPositions.some((p) => p.x === nx && p.y === ny)
        if (isOccupied) {
          break
        }

        if (!visited.has(cellKey)) {
          visited.add(cellKey)
          const newStep: PathStep = { direction: dir, distance: d, pos: nextPos }
          queue.push({ pos: nextPos, path: [...path, newStep], cost: cost + d })
        }
      }
    }
  }

  return bestPath
}

/** Find a cell reachable in 1 move that is behind cover relative to the enemy. */
function findCoverCell(
  myPos: Coordinate,
  enemyPos: Coordinate,
  knownCells: Record<string, Cell>,
  maxMoveDistance: number,
  width: number,
  height: number,
  otherTankPositions: Coordinate[],
  apexHeight = 5,
  tankHeight = 1,
): Coordinate | null {
  const candidates: Coordinate[] = []
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    for (let d = 1; d <= maxMoveDistance; d++) {
      const nx = myPos.x + delta.dx * d
      const ny = myPos.y + delta.dy * d
      const nextPos = { x: nx, y: ny }

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) break
      const cell = knownCells[`${nx},${ny}`]
      if (cell && cell.terrain === 'obstacle') break
      if (otherTankPositions.some((p) => p.x === nx && p.y === ny)) break

      candidates.push(nextPos)
    }
  }

  const coverCandidates = candidates.filter((c) => {
    return !checkClearShot(c, enemyPos, knownCells, apexHeight, tankHeight)
  })

  if (coverCandidates.length > 0) {
    // Prefer cover cells that are closer to the enemy to stay in striking/sight range
    coverCandidates.sort((a, b) => euclidean(a, enemyPos) - euclidean(b, enemyPos))
    return coverCandidates[0]
  }

  return null
}

/** Find a cell reachable in 1 move from which we have a clear shot at the enemy. */
function findFiringCell(
  myPos: Coordinate,
  enemyPos: Coordinate,
  knownCells: Record<string, Cell>,
  maxMoveDistance: number,
  width: number,
  height: number,
  otherTankPositions: Coordinate[],
  apexHeight = 5,
  tankHeight = 1,
): Coordinate | null {
  const candidates: Coordinate[] = []
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    for (let d = 1; d <= maxMoveDistance; d++) {
      const nx = myPos.x + delta.dx * d
      const ny = myPos.y + delta.dy * d
      const nextPos = { x: nx, y: ny }

      if (nx < 0 || nx >= width || ny < 0 || ny >= height) break
      const cell = knownCells[`${nx},${ny}`]
      if (cell && cell.terrain === 'obstacle') break
      if (otherTankPositions.some((p) => p.x === nx && p.y === ny)) break

      candidates.push(nextPos)
    }
  }

  const firingCandidates = candidates.filter((c) => {
    return checkClearShot(c, enemyPos, knownCells, apexHeight, tankHeight)
  })

  if (firingCandidates.length > 0) {
    firingCandidates.sort((a, b) => euclidean(a, enemyPos) - euclidean(b, enemyPos))
    return firingCandidates[0]
  }

  return null
}

/** Compute the best flare action to target a specific coordinate. */
function bestFlareAction(
  from: Coordinate,
  target: Coordinate,
  width: number,
  height: number,
): { direction: Direction; range: number } {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let bestDir: Direction = 'N'
  let bestRange = 1
  let bestDist = Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    for (let r = 1; r <= Math.max(width, height); r++) {
      const tx = from.x + delta.dx * r
      const ty = from.y + delta.dy * r
      if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
        break
      }
      const d = euclidean({ x: tx, y: ty }, target)
      if (d < bestDist) {
        bestDist = d
        bestDir = dir
        bestRange = r
      }
    }
  }

  return { direction: bestDir, range: bestRange }
}

interface EnemyMemory {
  id: string
  lastKnownPos: Coordinate
  lastSeenTurn: number
}

/**
 * GeminiAgent - highly tactical tank agent.
 * Uses interactive execution, cover navigation (peek-a-boo), BFS pathfinding,
 * and high-accuracy trajectory analysis.
 */
export function createGeminiAgent(
  tankId: string,
  initialEnemyPos?: Coordinate,
  initialSeenTurn?: number,
): TankAgent {
  const knownCells: Record<string, Cell> = {}
  const enemyMemory: Record<string, EnemyMemory> = {}
  let maxMoveDistance = 3 // Will update from tools spec if available
  let shellMaxRange = 10  // Will update from tools spec if available

  if (initialEnemyPos) {
    enemyMemory['unknown-enemy'] = {
      id: 'unknown-enemy',
      lastKnownPos: initialEnemyPos,
      lastSeenTurn: initialSeenTurn ?? 0,
    }
  }

  return {
    name: `gemini-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (
      worldview: WorldView,
      tools: ToolSpec[],
      executeTool?: ToolExecutor,
    ): Promise<ToolCall[] | AgentTurnResult> => {
      // 1. Parse map size from scan limits
      let width = 20
      let height = 20
      for (const cell of worldview.localScan) {
        if (cell.coord.x >= width) width = cell.coord.x + 1
        if (cell.coord.y >= height) height = cell.coord.y + 1
      }
      for (const fCell of worldview.flaredCells) {
        if (fCell.cell.coord.x >= width) width = fCell.cell.coord.x + 1
        if (fCell.cell.coord.y >= height) height = fCell.cell.coord.y + 1
      }

      // 2. Set default limits based on map size
      if (width > 20 || height > 20) {
        maxMoveDistance = 3
        shellMaxRange = 12
      } else {
        maxMoveDistance = 2
        shellMaxRange = 10
      }

      // Update limit from active flares if any
      if (worldview.activeFlares && worldview.activeFlares.length > 0) {
        maxMoveDistance = worldview.activeFlares[0].radius
      }

      // 3. Update knowledge database
      for (const cell of worldview.localScan) {
        knownCells[`${cell.coord.x},${cell.coord.y}`] = cell
      }
      for (const fCell of worldview.flaredCells) {
        knownCells[`${fCell.cell.coord.x},${fCell.cell.coord.y}`] = fCell.cell
      }

      // 4. Update visible enemies
      const currentVisibleEnemies = worldview.visibleEnemies ?? []
      for (const enemy of currentVisibleEnemies) {
        enemyMemory[enemy.id] = {
          id: enemy.id,
          lastKnownPos: enemy.position,
          lastSeenTurn: worldview.turn,
        }
      }

      const calls: ToolCall[] = []

      // If it is not my turn, pass
      if (!worldview.isMyTurn) {
        return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
      }

      // Keep track of our position, remaining actions, and offensive action state
      let myPos = { ...worldview.position }
      let remainingActions = worldview.remainingActions
      let offensiveActionTaken = false
      let currentWorldView = worldview

      // Helper to execute tool call interactively if available, or buffer it
      const performAction = async (toolCall: ToolCall): Promise<boolean> => {
        calls.push(toolCall)
        remainingActions--
        if (toolCall.tool.kind === 'fire_shell' || toolCall.tool.kind === 'fire_flare') {
          offensiveActionTaken = true
        }

        if (executeTool) {
          try {
            const execResult = await executeTool(toolCall)
            currentWorldView = execResult.worldview
            myPos = { ...currentWorldView.position }
            remainingActions = currentWorldView.remainingActions

            // Update visible enemies and map from execution results
            for (const cell of currentWorldView.localScan) {
              knownCells[`${cell.coord.x},${cell.coord.y}`] = cell
            }
            for (const fCell of currentWorldView.flaredCells) {
              knownCells[`${fCell.cell.coord.x},${fCell.cell.coord.y}`] = fCell.cell
            }
            const vis = currentWorldView.visibleEnemies ?? []
            for (const enemy of vis) {
              enemyMemory[enemy.id] = {
                id: enemy.id,
                lastKnownPos: enemy.position,
                lastSeenTurn: currentWorldView.turn,
              }
            }
            return true
          } catch (e) {
            // Execution failed, fallback
            return false
          }
        }
        return false
      }

      // Turn loop: keep acting while actions are left and we haven't hit tool call limits
      let loopCount = 0
      while (remainingActions > 0 && loopCount < 5) {
        loopCount++

        // Find active target
        const visibleEnemies = currentWorldView.visibleEnemies ?? []
        const otherTanks = currentWorldView.visibleEnemies
          ? currentWorldView.visibleEnemies.map((e) => e.position)
          : []

        if (visibleEnemies.length > 0) {
          // 1. We have a visible enemy! Sort by closest.
          visibleEnemies.sort((a, b) => euclidean(myPos, a.position) - euclidean(myPos, b.position))
          const target = visibleEnemies[0]
          const targetPos = target.position

          if (!offensiveActionTaken) {
            // Check if we have clear line of sight
            const clearShot = checkClearShot(myPos, targetPos, knownCells)
            if (clearShot) {
              // Firing!
              const angle = bearing(myPos, targetPos)
              const dist = euclidean(myPos, targetPos)
              const clampedPower = Math.max(1, Math.min(dist, shellMaxRange))
              await performAction({
                id: `shell-${currentWorldView.turn}-${calls.length}`,
                tool: { kind: 'fire_shell', angle, power: clampedPower },
              })
            } else {
              // Blocked! Try to find a neighboring cell with a clear shot (peek)
              const firingCell = findFiringCell(
                myPos,
                targetPos,
                knownCells,
                maxMoveDistance,
                width,
                height,
                otherTanks,
              )
              if (firingCell) {
                // Move to the firing cell
                const path = findPath(myPos, firingCell, knownCells, maxMoveDistance, width, height, otherTanks)
                if (path.length > 0) {
                  await performAction({
                    id: `move-${currentWorldView.turn}-${calls.length}`,
                    tool: { kind: 'move', direction: path[0].direction, distance: path[0].distance },
                  })
                } else {
                  // No path found (somehow), fallback: move towards enemy
                  const dir = path.length > 0 ? path[0].direction : 'N'
                  await performAction({
                    id: `move-${currentWorldView.turn}-${calls.length}`,
                    tool: { kind: 'move', direction: dir, distance: 1 },
                  })
                }
              } else {
                // No firing cell reachable in 1 move. Move closer to the enemy
                const path = findPath(myPos, targetPos, knownCells, maxMoveDistance, width, height, otherTanks)
                if (path.length > 0) {
                  await performAction({
                    id: `move-${currentWorldView.turn}-${calls.length}`,
                    tool: { kind: 'move', direction: path[0].direction, distance: path[0].distance },
                  })
                } else {
                  break // Can't move or do anything
                }
              }
            }
          } else {
            // Offensive action already taken. Let's find cover (hide)!
            const coverCell = findCoverCell(
              myPos,
              targetPos,
              knownCells,
              maxMoveDistance,
              width,
              height,
              otherTanks,
            )
            if (coverCell) {
              const path = findPath(myPos, coverCell, knownCells, maxMoveDistance, width, height, otherTanks)
              if (path.length > 0) {
                await performAction({
                  id: `move-${currentWorldView.turn}-${calls.length}`,
                  tool: { kind: 'move', direction: path[0].direction, distance: path[0].distance },
                })
              } else {
                break
              }
            } else {
              // No cover cell. Reposition to optimal distance (2 to 3 cells away)
              const currentDist = euclidean(myPos, targetPos)
              if (currentDist < 2.5) {
                // Too close, backing away!
                const path = findPath(myPos, targetPos, knownCells, maxMoveDistance, width, height, otherTanks)
                // Opposite direction move
                const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
                let bestBackDir: Direction = 'N'
                let bestBackDist = -1
                for (const d of dirs) {
                  const delta = DIRECTION_DELTAS[d]
                  const nx = myPos.x + delta.dx
                  const ny = myPos.y + delta.dy
                  if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
                    const c = knownCells[`${nx},${ny}`]
                    if (!c || c.terrain !== 'obstacle') {
                      const newD = euclidean({ x: nx, y: ny }, targetPos)
                      if (newD > bestBackDist) {
                        bestBackDist = newD
                        bestBackDir = d
                      }
                    }
                  }
                }
                await performAction({
                  id: `move-${currentWorldView.turn}-${calls.length}`,
                  tool: { kind: 'move', direction: bestBackDir, distance: 1 },
                })
              } else {
                break // Already at a safe distance, pass remaining
              }
            }
          }
        } else {
          // 2. No visible enemy! Look at memory.
          const memories = Object.values(enemyMemory).filter(
            (m) => currentWorldView.turn - m.lastSeenTurn < 15,
          )
          if (memories.length > 0) {
            // Sort by most recent seen, then closest
            memories.sort((a, b) => b.lastSeenTurn - a.lastSeenTurn || euclidean(myPos, a.lastKnownPos) - euclidean(myPos, b.lastKnownPos))
            const lastIntel = memories[0]
            const targetPos = lastIntel.lastKnownPos

            // Move towards their last known position to spot them
            const path = findPath(myPos, targetPos, knownCells, maxMoveDistance, width, height, otherTanks)
            if (path.length > 0 && euclidean(myPos, targetPos) > 3) {
              await performAction({
                id: `move-${currentWorldView.turn}-${calls.length}`,
                tool: { kind: 'move', direction: path[0].direction, distance: path[0].distance },
              })
            } else if (!offensiveActionTaken) {
              const turnsSinceSeen = currentWorldView.turn - lastIntel.lastSeenTurn
              if (turnsSinceSeen <= 2) {
                const angle = bearing(myPos, targetPos)
                const dist = euclidean(myPos, targetPos)
                const clampedPower = Math.max(1, Math.min(dist, shellMaxRange))
                await performAction({
                  id: `shell-${currentWorldView.turn}-${calls.length}`,
                  tool: { kind: 'fire_shell', angle, power: clampedPower },
                })
              } else {
                const flareAct = bestFlareAction(myPos, targetPos, width, height)
                await performAction({
                  id: `flare-${currentWorldView.turn}-${calls.length}`,
                  tool: { kind: 'fire_flare', direction: flareAct.direction, range: flareAct.range },
                })
              }
            } else {
              break // Can't do anything else
            }
          } else {
            // 3. No memory or intel at all! Move to the center of the map.
            const center = { x: Math.floor(width / 2), y: Math.floor(height / 2) }
            if (euclidean(myPos, center) > 2) {
              const path = findPath(myPos, center, knownCells, maxMoveDistance, width, height, otherTanks)
              if (path.length > 0) {
                await performAction({
                  id: `move-${currentWorldView.turn}-${calls.length}`,
                  tool: { kind: 'move', direction: path[0].direction, distance: path[0].distance },
                })
              } else {
                break
              }
            } else if (!offensiveActionTaken) {
              // Fire flare in a random direction to search
              const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
              const randomDir = dirs[Math.floor(Math.random() * dirs.length)]
              await performAction({
                id: `flare-${currentWorldView.turn}-${calls.length}`,
                tool: { kind: 'fire_flare', direction: randomDir, range: 4 },
              })
            } else {
              break
            }
          }
        }
      }

      // If we didn't output any actions, pass
      if (calls.length === 0) {
        calls.push({
          id: `pass-${worldview.turn}`,
          tool: { kind: 'pass' },
        })
      }

      return executeTool ? { toolCalls: calls, executed: true } : calls
    },
  }
}
