import { describe, expect, it } from 'vitest'
import { TacticalMemory, serializeKnownMap } from '../src/model/tactical-memory.js'
import type { Cell } from '../src/types/coords.js'
import type { WorldView } from '../src/types/events.js'

function worldview(turn: number, enemyX: number): WorldView {
  return {
    position: { x: turn, y: 2 },
    hp: 2,
    facing: 90,
    localScan: [],
    flaredCells: [],
    inEnemyFlare: turn === 2 ? [{ firerId: 'tank-2', expiryTurn: 6 }] : [],
    remainingActions: 2,
    turn,
    isMyTurn: true,
    aliveEnemyCount: 3,
    visibleEnemies: [{
      id: 'tank-1',
      position: { x: enemyX, y: 8 },
      hp: turn < 3 ? 2 : 1,
    }],
  }
}

describe('serializeKnownMap', () => {
  it('compresses rows and preserves obstacle coordinates and heights', () => {
    const cells: Cell[] = [
      { coord: { x: 0, y: 2 }, terrain: 'open', obstacleHeight: 0 },
      { coord: { x: 1, y: 2 }, terrain: 'open', obstacleHeight: 0 },
      { coord: { x: 2, y: 2 }, terrain: 'obstacle', obstacleHeight: 3 },
      { coord: { x: 5, y: 2 }, terrain: 'open', obstacleHeight: 0 },
    ]

    expect(serializeKnownMap(cells)).toContain('y=2: x=0-2,5; obstacles=2(h3)')
  })

  it('is substantially smaller than repeated cell JSON for a full map', () => {
    const cells: Cell[] = Array.from({ length: 25 }, (_, y) =>
      Array.from({ length: 25 }, (_, x): Cell => ({
        coord: { x, y },
        terrain: (x + y) % 10 === 0 ? 'obstacle' : 'open',
        obstacleHeight: (x + y) % 10 === 0 ? 3 : 0,
      })),
    ).flat()

    const compact = serializeKnownMap(cells)
    expect(compact.length).toBeLessThan(JSON.stringify(cells).length / 10)
  })
})

describe('TacticalMemory', () => {
  it('deterministically retains sightings, movement, combat, and exposure', () => {
    const memory = new TacticalMemory()
    memory.observe(worldview(1, 10))
    memory.observe(worldview(2, 9))
    memory.recordAction(
      3,
      { id: 'shell-1', tool: { kind: 'fire_shell', angle: 90, power: 8 } },
      { kind: 'hit', targetId: 'tank-1', damage: 1 },
      worldview(3, 8),
    )

    const rendered = memory.render()
    expect(rendered).toContain('tank-1: T1 (10,8) HP2 -> T2 (9,8) HP2 -> T3 (8,8) HP1')
    expect(rendered).toContain('T1 (1,2) -> T2 (2,2) -> T3 (3,2)')
    expect(rendered).toContain('fire_shell(angle=90,power=8) => hit:tank-1,damage=1')
    expect(rendered).toContain('visible in tank-2 flare until T6')
  })
})
