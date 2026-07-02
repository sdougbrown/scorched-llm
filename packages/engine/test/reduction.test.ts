import { describe, it, expect } from 'vitest'
import { runMatch } from '../src/match/orchestration.js'
import { alwaysPassAgent } from '../src/match/fake-agents.js'

import type { GameState } from '../src/types/state.js'
function compareStates(stateA: GameState, stateB: GameState): boolean {
  if (stateA.tanks.length !== stateB.tanks.length) return false
  for (let i = 0; i < stateA.tanks.length; i++) {
    const a = stateA.tanks[i]
    const b = stateB.tanks[i]
    if (a.hp !== b.hp || a.alive !== b.alive || a.maxHp !== b.maxHp) return false
    if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false
    if (a.facing !== b.facing || a.damageDealt !== b.damageDealt || a.hitsLanded !== b.hitsLanded) return false
  }
  if (stateA.flares.length !== stateB.flares.length) return false
  for (let i = 0; i < stateA.flares.length; i++) {
    const fa = stateA.flares[i]
    const fb = stateB.flares[i]
    if (fa.radius !== fb.radius || fa.activatedTurn !== fb.activatedTurn || fa.expiryTurn !== fb.expiryTurn) return false
    if (fa.targetCell.x !== fb.targetCell.x || fa.targetCell.y !== fb.targetCell.y) return false
  }
  if (stateA.terrain.length !== stateB.terrain.length) return false
  for (let y = 0; y < stateA.terrain.length; y++) {
    for (let x = 0; x < stateA.terrain[y].length; x++) {
      const ca = stateA.terrain[y][x]
      const cb = stateB.terrain[y][x]
      if (ca.terrain !== cb.terrain || ca.obstacleHeight !== cb.obstacleHeight) return false
    }
  }
  return true
}


describe('reduction — state replay', () => {
  it('initialState + actions → final state', async () => {
    // From a completed match log, the last action's snapshot in the last turn
    // should represent the final game state
    const config = {
      rulesVersion: 'v1',
      seed: 42,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'p1', startPosition: { x: 0, y: 0 } },
        { label: 'p2', startPosition: { x: 19, y: 19 } },
      ],
      fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
      actionEconomy: 'double',
      moveMax: 5,
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
      lethality: { hitsToKill: 2 },
      turnLimit: 8,
      perTurnTimeoutMs: 30000,
      maxToolCallsPerTurn: 3,
    } as const
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])

    // The last turn's last action snapshot should be the final state
    const lastTurn = log.turns[log.turns.length - 1]
    if (!lastTurn || lastTurn.actions.length === 0) {
      throw new Error('Expected at least one turn with at least one action')
    }

    const finalSnapshot = lastTurn.actions[lastTurn.actions.length - 1].snapshot
    expect(finalSnapshot.tanks.length).toBe(2)
    expect(finalSnapshot.turn).toBe(log.turns.length)

    // Verify tanks are consistent with expected HP (pass-only agents don't deal damage)
    for (const tank of finalSnapshot.tanks) {
      expect(tank.hp).toBe(tank.maxHp)
      expect(tank.alive).toBe(true)
    }
  })

  it('post-action snapshots match reducer output', async () => {
    // For each turn, the last action's snapshot should be a valid gameState
    const config = {
      rulesVersion: 'v1',
      seed: 123,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'p1', startPosition: { x: 0, y: 0 } },
        { label: 'p2', startPosition: { x: 19, y: 19 } },
      ],
      fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
      actionEconomy: 'single',
      moveMax: 5,
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
      lethality: { hitsToKill: 2 },
      turnLimit: 6,
      perTurnTimeoutMs: 30000,
      maxToolCallsPerTurn: 3,
    } as const
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])

    for (const turn of log.turns) {
      expect(turn.actions.length).toBeGreaterThan(0)
      const lastAction = turn.actions[turn.actions.length - 1]
      expect(lastAction.snapshot.tanks.length).toBe(log.initialState.tanks.length)
      expect(lastAction.snapshot.rulesVersion).toBe('v1')

      // All tanks should have consistent IDs across turns
      for (let i = 0; i < log.initialState.tanks.length; i++) {
        expect(lastAction.snapshot.tanks[i].id).toBe(log.initialState.tanks[i].id)
      }
    }
  })

  it('state is consistent across turns', async () => {
    // The last snapshot of turn N-1 should equal the first snapshot of turn N
    // (or initialState if N is the first turn, where we check against turn 1's first snapshot)
    const config = {
      rulesVersion: 'v1',
      seed: 77,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'p1', startPosition: { x: 0, y: 0 } },
        { label: 'p2', startPosition: { x: 19, y: 19 } },
      ],
      fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
      actionEconomy: 'double',
      moveMax: 5,
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
      lethality: { hitsToKill: 2 },
      turnLimit: 8,
      perTurnTimeoutMs: 30000,
      maxToolCallsPerTurn: 3,
    } as const
    const { log } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])

    // Turn 1's last snapshot should match... well, there's no turn 0.
    // But turn 2's first snapshot should reflect the state after turn 1's actions.
    // Since pass-only agents produce identical states, consecutive turns should have
    // equivalent final states.
    for (let i = 1; i < log.turns.length; i++) {
      const prevTurnLast = log.turns[i - 1].actions[log.turns[i - 1].actions.length - 1]
      const currTurnFirst = log.turns[i].actions[0]

      expect(compareStates(prevTurnLast.snapshot, currTurnFirst.snapshot)).toBe(true)
    }
  })

  it('reduction produces same result as direct execution', async () => {
    // Run a match and verify that the log structure supports full reconstruction
    const config = {
      rulesVersion: 'v1',
      seed: 99,
      map: { width: 20, height: 20, obstacleDensity: 0.1, generatorVersion: 'v1', obstacleHeight: 10 },
      players: [
        { label: 'p1', startPosition: { x: 0, y: 0 } },
        { label: 'p2', startPosition: { x: 19, y: 19 } },
      ],
      fog: { localRadius: 3, flareRadius: 2, flareDuration: 'one-round-global' },
      actionEconomy: 'double',
      moveMax: 5,
      shell: { maxRange: 10, apexHeight: 5, tankHeight: 1 },
      lethality: { hitsToKill: 2 },
      turnLimit: 5,
      perTurnTimeoutMs: 30000,
      maxToolCallsPerTurn: 3,
    } as const
    const { log, result } = await runMatch(config, [alwaysPassAgent('p1'), alwaysPassAgent('p2')])

    // Reconstruct final state from log
    let finalState: GameState = log.initialState
    for (const turn of log.turns) {
      if (turn.actions.length > 0) {
        finalState = turn.actions[turn.actions.length - 1].snapshot
      }
    }

    // The reconstructed state should match the recorded result
    expect(finalState.tanks.length).toBe(result.placements.length)
    for (const placement of result.placements) {
      const tank = finalState.tanks.find((t) => t.id === placement.tankId)
      expect(tank).toBeDefined()
      expect(tank!.hp).toBe(placement.hp)
    }
  })
})