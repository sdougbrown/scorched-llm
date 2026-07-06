import { describe, it, expect } from 'vitest'
import { createGpt54Agent } from '../src/match/gpt-5.4-agent.js'
import type { WorldView } from '../src/types/events.js'
import type { Cell, Coordinate } from '../src/types/coords.js'

function openCell(x: number, y: number): Cell {
  return { coord: { x, y }, terrain: 'open', obstacleHeight: 0 }
}

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: [],
    flaredCells: [],
    activeFlares: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 1,
    isMyTurn: true,
    aliveEnemyCount: 1,
    visibleEnemies: [],
    ...overrides,
  }
}

describe('gpt-5.4 agent', () => {
  it('has the expected name', () => {
    expect(createGpt54Agent('tank-0').name).toBe('gpt-5.4-tank-0')
  })

  it('fires at a visible enemy when the lane is clear', async () => {
    const agent = createGpt54Agent('tank-0', { shellMaxRange: 10, moveMax: 5 })
    const enemy: Coordinate = { x: 8, y: 8 }
    const calls = await agent.takeTurn(
      makeWorldView({
        localScan: [openCell(5, 5), openCell(6, 6), openCell(7, 7), openCell(8, 8)],
        visibleEnemies: [{ id: 'tank-1', position: enemy, hp: 1 }],
      }),
      [],
    )
    expect(calls[0]?.tool.kind).toBe('fire_shell')
    if (calls[0]?.tool.kind === 'fire_shell') {
      expect(calls[0].tool.angle).toBeCloseTo(135, 0)
      expect(calls[0].tool.power).toBe(4)
    }
  })

  it('moves before shooting when the target is just outside shell range', async () => {
    const agent = createGpt54Agent('tank-0', { shellMaxRange: 10, moveMax: 3 })
    const calls = await agent.takeTurn(
      makeWorldView({
        localScan: [
          openCell(5, 5),
          openCell(6, 6),
          openCell(7, 7),
          openCell(8, 8),
          openCell(9, 9),
          openCell(10, 10),
          openCell(11, 11),
          openCell(12, 12),
          openCell(13, 13),
        ],
        visibleEnemies: [{ id: 'tank-1', position: { x: 13, y: 13 }, hp: 2 }],
      }),
      [],
    )
    expect(calls[0]?.tool.kind).toBe('move')
    expect(calls.some((call) => call.tool.kind === 'fire_shell')).toBe(true)
  })

  it('uses a flare while hunting a remembered enemy outside vision', async () => {
    const agent = createGpt54Agent('tank-0', { flareMaxRange: 3, flareRadius: 2, moveMax: 3 })
    await agent.takeTurn(
      makeWorldView({
        turn: 1,
        visibleEnemies: [{ id: 'tank-1', position: { x: 19, y: 5 }, hp: 2 }],
        localScan: [openCell(5, 5), openCell(6, 5), openCell(7, 5), openCell(8, 5)],
      }),
      [],
    )

    const calls = await agent.takeTurn(
      makeWorldView({
        turn: 2,
        aliveEnemyCount: 1,
        visibleEnemies: [],
        localScan: [openCell(5, 5), openCell(6, 5)],
      }),
      [],
    )

    expect(calls.some((call) => call.tool.kind === 'fire_flare')).toBe(true)
  })
})
