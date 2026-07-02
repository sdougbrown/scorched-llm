import type { GameState } from '../types/state.js'

export function applyDamage(
  state: GameState,
  targetId: string,
  firerId: string,
  damage: number,
): { newState: GameState; eliminated: string | null } {
  const tankIndex = state.tanks.findIndex((t) => t.id === targetId)
  if (tankIndex === -1) {
    return { newState: state, eliminated: null }
  }

  const target = state.tanks[tankIndex]
  if (!target.alive) {
    return { newState: state, eliminated: null }
  }

  const newState: GameState = {
    ...state,
    tanks: state.tanks.map((t) => {
      if (t.id === targetId) {
        const newHp = t.hp - damage
        return { ...t, hp: Math.max(0, newHp), alive: newHp > 0 }
      }
      if (t.id === firerId) {
        return {
          ...t,
          hitsLanded: t.hitsLanded + 1,
          damageDealt: t.damageDealt + Math.min(damage, target.hp),
        }
      }
      return t
    }),
  }

  const newTarget = newState.tanks[tankIndex]
  return {
    newState,
    eliminated: newTarget.alive ? null : targetId,
  }
}