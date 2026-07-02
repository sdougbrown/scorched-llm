import type { MatchConfig } from '../config/schema.js'
import type { Rng } from '../rng/rng.js'
import type { Cell, TerrainKind } from '../types/coords.js'

/**
 * Generate terrain grid from config and RNG.
 *
 * V1: basic random placement. Each cell has a probability of being an
 * obstacle equal to `obstacleDensity`. Obstacles get `obstacleHeight` from config;
 * open cells have height 0.
 *
 * Deterministic: same seed + config → same terrain.
 *
 * @param mapConfig - The map configuration from MatchConfig.
 * @param rng - Deterministic RNG instance.
 * @returns A 2D grid `terrain[y][x]` of Cell values.
 */
export function generateTerrain(mapConfig: MatchConfig['map'], rng: Rng): Cell[][] {
  const { width, height, obstacleDensity, obstacleHeight, generatorVersion } = mapConfig

  if (generatorVersion !== 'v1') {
    throw new Error(`Unknown terrain generator version: ${generatorVersion}`)
  }

  const terrain: Cell[][] = []

  for (let y = 0; y < height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < width; x++) {
      const isObstacle = rng.next() < obstacleDensity
      const terrainType: TerrainKind = isObstacle ? 'obstacle' : 'open'
      row.push({
        coord: { x, y },
        terrain: terrainType,
        obstacleHeight: isObstacle ? obstacleHeight : 0,
      })
    }
    terrain.push(row)
  }

  return terrain
}
