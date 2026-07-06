import type { GameState } from '../types/state.js'
import type { MatchConfig } from '../config/schema.js'
import type { Coordinate } from '../types/coords.js'
import type { ActionResult } from '../types/tool.js'
import { supercover } from '../geometry/supercover.js'
import { euclidean } from '../geometry/coords.js'
import { blocked, miss } from '../action-result/index.js'
import type { ShellTrajectory } from './shell.js'

/**
 * Convert a clockwise bearing (degrees from north) to a delta vector.
 * Mirrors resolution/shell.ts.
 */
function angleToDelta(angle: number): { dx: number; dy: number } {
  const rad = (angle * Math.PI) / 180
  return { dx: Math.sin(rad), dy: -Math.cos(rad) }
}

/** Same parabolic arc as a shell: tankHeight at both ends, apex halfway. */
function bombHeight(i: number, N: number, apexHeight: number, tankHeight: number): number {
  if (N <= 0) return tankHeight
  const progress = (i + 1) / N
  const arc = 4 * progress * (1 - progress)
  return tankHeight + (apexHeight - tankHeight) * arc
}

/** Splash radius is fixed to half the flare radius — one knob, not two. */
export function bombSplashRadius(config: MatchConfig): number {
  return config.fog.flareRadius / 2
}

/**
 * A bomb flies exactly like a shell (same arc, obstacles block it, the first
 * living tank on the path detonates it) but detonates on arrival: every living
 * tank within `bombSplashRadius` of the impact cell — INCLUDING the firer —
 * takes damage. Limited uses per match (`config.bomb.uses`); the caller
 * decrements `bombsRemaining`.
 */
export function fireBomb(
  state: GameState,
  config: MatchConfig,
  firerId: string,
  angle: number,
  power: number,
): { newState: GameState; result: ActionResult; trajectory: ShellTrajectory } {
  const emptyTrajectory: ShellTrajectory = { sampledCells: [], impactPoint: { x: 0, y: 0 } }
  if (!config.bomb) {
    return { newState: state, result: blocked('Bombs are not enabled in this match'), trajectory: emptyTrajectory }
  }

  const firer = state.tanks.find((t) => t.id === firerId)
  if (!firer || !firer.alive) {
    return { newState: state, result: blocked('Firer not found or not alive'), trajectory: emptyTrajectory }
  }

  if (power < 1 || power > config.bomb.maxRange) {
    return {
      newState: state,
      result: blocked(`Power must be between 1 and ${config.bomb.maxRange}`),
      trajectory: emptyTrajectory,
    }
  }

  const delta = angleToDelta(angle)
  const targetPos: Coordinate = {
    x: Math.round(firer.position.x + delta.dx * power),
    y: Math.round(firer.position.y + delta.dy * power),
  }

  const width = state.terrain[0]?.length ?? 0
  const height = state.terrain.length
  const sampledCells = supercover(firer.position, targetPos).slice(1)
  const apexHeight = config.shell.apexHeight
  const tankHeight = config.shell.tankHeight

  let impact: Coordinate | null = null
  for (let i = 0; i < sampledCells.length; i++) {
    const cell = sampledCells[i]
    if (cell.x < 0 || cell.x >= width || cell.y < 0 || cell.y >= height) {
      // Left the map before detonating — dud, no splash
      return { newState: state, result: miss(), trajectory: { sampledCells, impactPoint: cell } }
    }
    const arcHeight = bombHeight(i, sampledCells.length, apexHeight, tankHeight)
    const terrainCell = state.terrain[cell.y][cell.x]
    if (terrainCell.terrain === 'obstacle' && arcHeight <= terrainCell.obstacleHeight) {
      impact = cell
      break
    }
    const tank = state.tanks.find(
      (t) => t.id !== firerId && t.alive && t.position.x === cell.x && t.position.y === cell.y,
    )
    if (tank) {
      impact = cell
      break
    }
  }
  if (impact == null) {
    impact = targetPos
  }

  const radius = bombSplashRadius(config)
  const casualties = state.tanks
    .filter((t) => t.alive && euclidean(t.position, impact) <= radius)
    .map((t) => ({
      targetId: t.id,
      damage: Math.ceil(t.maxHp / config.lethality.hitsToKill),
    }))

  return {
    newState: state,
    result: { kind: 'splash', impact, casualties },
    trajectory: { sampledCells, impactPoint: impact },
  }
}
