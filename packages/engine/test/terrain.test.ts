import { describe, it, expect } from 'vitest'
import { generateTerrain } from '../src/terrain/generate.js'
import { createRng } from '../src/rng/rng.js'

describe('generateTerrain', () => {
  it('generates a 5x5 grid with seed 42 and 0.3 density', () => {
    const mapConfig = {
      width: 5,
      height: 5,
      obstacleDensity: 0.3,
      generatorVersion: 'v1',
      obstacleHeight: 3,
    }
    const rng = createRng(42)
    const terrain = generateTerrain(mapConfig, rng)

    expect(terrain.length).toBe(5)
    for (const row of terrain) {
      expect(row.length).toBe(5)
    }

    const obstacles: Array<[number, number]> = []
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const cell = terrain[y][x]
        expect(cell.coord).toEqual({ x, y })
        if (cell.terrain === 'obstacle') {
          expect(cell.obstacleHeight).toBe(3)
          obstacles.push([x, y])
        } else {
          expect(cell.obstacleHeight).toBe(0)
        }
      }
    }

    expect(obstacles).toEqual([
      [1, 0],
      [3, 0],
      [2, 1],
      [0, 2],
      [2, 2],
      [4, 3],
      [0, 4],
      [3, 4],
      [4, 4],
    ])
  })

  it('deterministic: same seed + config produces same terrain', () => {
    const mapConfig = {
      width: 10,
      height: 10,
      obstacleDensity: 0.5,
      generatorVersion: 'v1',
      obstacleHeight: 5,
    }
    const a = generateTerrain(mapConfig, createRng(12345))
    const b = generateTerrain(mapConfig, createRng(12345))
    expect(a).toEqual(b)
  })

  it('0 density produces all open cells', () => {
    const mapConfig = {
      width: 3,
      height: 3,
      obstacleDensity: 0,
      generatorVersion: 'v1',
      obstacleHeight: 1,
    }
    const terrain = generateTerrain(mapConfig, createRng(0))
    for (const row of terrain) {
      for (const cell of row) {
        expect(cell.terrain).toBe('open')
        expect(cell.obstacleHeight).toBe(0)
      }
    }
  })

  it('1 density produces all obstacle cells', () => {
    const mapConfig = {
      width: 3,
      height: 3,
      obstacleDensity: 1,
      generatorVersion: 'v1',
      obstacleHeight: 2,
    }
    const terrain = generateTerrain(mapConfig, createRng(0))
    for (const row of terrain) {
      for (const cell of row) {
        expect(cell.terrain).toBe('obstacle')
        expect(cell.obstacleHeight).toBe(2)
      }
    }
  })

  it('throws on unknown generator version', () => {
    const mapConfig = {
      width: 3,
      height: 3,
      obstacleDensity: 0.5,
      generatorVersion: 'v2',
      obstacleHeight: 1,
    }
    expect(() => generateTerrain(mapConfig, createRng(0))).toThrow(
      'Unknown terrain generator version: v2'
    )
  })
})
