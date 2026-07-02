import type { GameState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { Coordinate } from '../types/coords.js'
import type { ActionResult } from '../types/tool.js'
import { supercover } from '../geometry/supercover.js'
import { blocked, miss, hit } from '../action-result/index.js'

export interface ShellTrajectory {
  sampledCells: Coordinate[]
  impactPoint: Coordinate
}

/**
 * Convert a clockwise bearing (degrees from north) to a delta vector.
 * 0° → N (dy=-1), 90° → E (dx=1), 180° → S (dy=1), 270° → W (dx=-1)
 */
function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/**
 * Compute shell height at sample index i out of N total samples.
 * Parabola: height = apexHeight * (1 - (2i/N - 1)^2)
 * Peaks at i = N/2 with height = apexHeight, ends at i=0 and i=N with height 0.
 */
function shellHeight(i: number, N: number, apexHeight: number): number {
  if (N <= 0) return apexHeight
  const t = (2 * i) / N - 1
  return apexHeight * (1 - t * t)
}

export function fireShell(
  state: GameState,
  config: MatchConfig,
  firerId: string,
  angle: number,
  power: number,
): { newState: GameState; result: ActionResult; trajectory: ShellTrajectory } {
  const firer = state.tanks.find((t) => t.id === firerId)
  if (!firer || !firer.alive) {
    return {
      newState: state,
      result: blocked('Firer not found or not alive'),
      trajectory: { sampledCells: [], impactPoint: { x: 0, y: 0 } },
    }
  }

  const maxRange = config.shell.maxRange
  if (power < 1 || power > maxRange) {
    return {
      newState: state,
      result: blocked(`Power must be between 1 and ${maxRange}`),
      trajectory: { sampledCells: [], impactPoint: { x: 0, y: 0 } },
    }
  }

  // Compute target position from angle and power
  const delta = angleToDelta(angle)
  const targetPos: Coordinate = {
    x: Math.round(firer.position.x + delta.dx * power),
    y: Math.round(firer.position.y + delta.dy * power),
  }

  const width = state.terrain[0]?.length ?? 0

  // Compute trajectory via supercover
  const trajectoryCells = supercover(firer.position, targetPos)

  // Skip the shooter's cell (index 0 is the starting cell)
  const sampledCells = trajectoryCells.slice(1)

  const apexHeight = config.shell.apexHeight

  // Check each sample cell in order
  for (let i = 0; i < sampledCells.length; i++) {
    const cell = sampledCells[i]
    const cellHeight = shellHeight(i, sampledCells.length, apexHeight)

    // Check if out of bounds
    if (cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= state.terrain.length) {
      const impactPointIdx = sampledCells.length > 0 ? Math.min(i, sampledCells.length - 1) : i
      const impactPoint = sampledCells[impactPointIdx] ?? targetPos
      return {
        newState: state,
        result: miss(),
        trajectory: { sampledCells, impactPoint },
      }
    }

    // Check if shell is blocked by obstacle
    const terrainCell = state.terrain[cell.y][cell.x]
    if (terrainCell.terrain === 'obstacle' && cellHeight <= terrainCell.obstacleHeight) {
      return {
        newState: state,
        result: blocked('Shell blocked by obstacle'),
        trajectory: { sampledCells, impactPoint: cell },
      }
    }

    // Check if shell hits a living tank (not the shooter)
    for (const tank of state.tanks) {
      if (tank.id === firerId || !tank.alive) continue
      if (tank.position.x === cell.x && tank.position.y === cell.y) {
        return {
          newState: state,
          result: hit(tank.id, 1),
          trajectory: { sampledCells, impactPoint: cell },
        }
      }
    }
  }

  // Shell reached target without hitting anything — miss
  return {
    newState: state,
    result: miss(),
    trajectory: { sampledCells, impactPoint: targetPos },
  }
}