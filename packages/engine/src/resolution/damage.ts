import type { GameState } from '../types/state.js'

export function applyDamage(
  state: GameState,
  tankId: string,
  damage: number,
): { newState: GameState; eliminated: string | null } {
  const tankIndex = state.tanks.findIndex((t) => t.id === tankId)
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
      if (t.id !== tankId) return t
      const newHp = t.hp - damage
      if (newHp <= 0) {
        return { ...t, hp: 0, alive: false }
      }
      return { ...t, hp: newHp }
    }),
  }

  const newTarget = newState.tanks[tankIndex]
  return {
    newState,
    eliminated: newTarget.alive ? null : tankId,
  }
}
