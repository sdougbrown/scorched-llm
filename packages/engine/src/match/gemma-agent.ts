import type { WorldView } from '../types/events.js'
import type { ToolCall } from '../types/tool.js'
import type { TankAgent, AgentMessage, ToolSpec } from './fake-agents.js'
import type { Coordinate, Direction } from '../types/coords.js'
import { euclidean, DIRECTION_DELTAS } from '../geometry/coords.js'

interface AgentMemory {
  lastKnownEnemyPos: Coordinate | null
  lastSeenTurn: number
}

function bestDirectionTo(from: Coordinate, target: Coordinate, maxDist: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  let best: Direction = 'N'
  let bestDist = Infinity

  for (const dir of dirs) {
    const delta = DIRECTION_DELTAS[dir]
    let dirBestDist = Infinity
    for (let step = 1; step <= maxDist; step++) {
      const cx = from.x + delta.dx * step
      const cy = from.y + delta.dy * step
      const d = euclidean({ x: cx, y: cy }, target)
      if (d < dirBestDist) dirBestDist = d
    }
    if (dirBestDist < bestDist) {
      bestDist = dirBestDist
      best = dir
    }
  }
  return best
}

function bearing(from: Coordinate, to: Coordinate): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let angle = Math.atan2(dx, -dy) * (180 / Math.PI)
  if (angle < 0) angle += 360
  return angle
}

function bearingToDirection(b: number): Direction {
  const dirs: Direction[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const idx = Math.round(b / 45) % 8
  return dirs[idx < 0 ? idx + 8 : idx]
}

export function createGemmaAgent(tankId: string): TankAgent {
  const memory: AgentMemory = {
    lastKnownEnemyPos: null,
    lastSeenTurn: -999,
  }

  return {
    name: `gemma-${tankId}`,
    messages: [] as AgentMessage[],
    takeTurn: async (worldview: WorldView): Promise<ToolCall[]> => {
      const calls: ToolCall[] = []
      if (!worldview.isMyTurn) return [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]

      // Update memory from visible enemies
      if (worldview.visibleEnemies && worldview.visibleEnemies.length > 0) {
        memory.lastKnownEnemyPos = worldview.visibleEnemies[0].position
        memory.lastSeenTurn = worldview.turn
      }

      const enemyVisible = worldview.visibleEnemies && worldview.visibleEnemies.length > 0
      const hasIntel = memory.lastKnownEnemyPos !== null && (worldview.turn - memory.lastSeenTurn <= 3)

      // 1. Attack
      if (hasIntel && memory.lastKnownEnemyPos) {
        const angle = bearing(worldview.position, memory.lastKnownEnemyPos)
        const dist = euclidean(worldview.position, memory.lastKnownEnemyPos)
        // Heuristic: power scales with distance, capped at 10
        const power = Math.max(1, Math.min(Math.ceil(dist * 0.5), 10))
        calls.push({
          id: `shell-${worldview.turn}`,
          tool: { kind: 'fire_shell', angle, power },
        })
      }

      // 2. Movement: Keep distance if wounded, advance if healthy
      if (memory.lastKnownEnemyPos) {
        const dist = euclidean(worldview.position, memory.lastKnownEnemyPos)
        let dir: Direction
        if (worldview.hp < 3 && dist < 8) {
          // Retreat
          const retreatPos = { x: worldview.position.x - (memory.lastKnownEnemyPos!.x - worldview.position.x), y: worldview.position.y - (memory.lastKnownEnemyPos!.y - worldview.position.y) }
          dir = bestDirectionTo(worldview.position, retreatPos, 5)
        } else if (dist > 5) {
          // Advance
          dir = bestDirectionTo(worldview.position, memory.lastKnownEnemyPos, 5)
        } else {
          // Maintain/Slightly shift
          dir = 'N' 
        }
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: dir, distance: 1 },
        })
      } else {
        // Search: Move to center
        const center = { x: 10, y: 10 }
        calls.push({
          id: `move-${worldview.turn}`,
          tool: { kind: 'move', direction: bestDirectionTo(worldview.position, center, 5), distance: 1 },
        })
      }

      // 3. Intel: Flare if blind or intel is stale
      if (!enemyVisible && (!hasIntel || worldview.turn - memory.lastSeenTurn >= 2)) {
        const flareDir = memory.lastKnownEnemyPos 
          ? bearingToDirection(bearing(worldview.position, memory.lastKnownEnemyPos))
          : 'N'
        calls.push({
          id: `flare-${worldview.turn}`,
          tool: { kind: 'fire_flare', direction: flareDir, range: 7 },
        })
      }

      return calls.length > 0 ? calls : [{ id: `pass-${worldview.turn}`, tool: { kind: 'pass' } }]
    },
  }
}
