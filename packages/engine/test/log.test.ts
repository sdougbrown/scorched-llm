import { describe, expect, it } from 'vitest'
import { compactGameState, isCompactSnapshot, reconstructGameState } from '../src/types/log.js'
import type { GameState } from '../src/types/state.js'

function state(): GameState {
  return {
    turn: 4,
    currentPlayerIndex: 1,
    tanks: [{
      id: 'tank-1', position: { x: 3, y: 4 }, hp: 1, maxHp: 2, alive: true,
      facing: 90, damageDealt: 2, hitsLanded: 1,
    }],
    flares: [{
      id: 'flare-1', targetCell: { x: 4, y: 4 }, radius: 2,
      firerId: 'tank-1', activatedTurn: 4, expiryTurn: 6,
    }],
    terrain: [[{ coord: { x: 0, y: 0 }, terrain: 'open', obstacleHeight: 0 }]],
    rulesVersion: 'v1',
  }
}

describe('compact replay snapshots', () => {
  it('reconstructs compact dynamic state with immutable initial terrain', () => {
    const full = state()
    const compact = compactGameState(full)

    expect(isCompactSnapshot(compact)).toBe(true)
    expect(compact).not.toHaveProperty('terrain')
    expect(reconstructGameState(compact, full)).toEqual(full)
  })

  it('does not share mutable coordinates with the live state', () => {
    const full = state()
    const compact = compactGameState(full)
    compact.tanks[0].position.x = 99
    compact.flares[0].targetCell.y = 99

    expect(full.tanks[0].position.x).toBe(3)
    expect(full.flares[0].targetCell.y).toBe(4)
  })

  it('keeps legacy full snapshots unchanged', () => {
    const full = state()

    expect(isCompactSnapshot(full)).toBe(false)
    expect(reconstructGameState(full, state())).toBe(full)
  })
})
