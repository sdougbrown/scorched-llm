import type { MatchLog, GameState, ActionEvent } from '@scorched-llm/engine'

export function reduceToState(log: MatchLog, turnIndex: number, actionIndex: number): GameState {
  const clampedTurn = Math.max(0, Math.min(turnIndex, log.turns.length - 1))
  const turns = log.turns.slice(0, clampedTurn + 1)

  let state: GameState = log.initialState

  for (let t = 0; t < turns.length; t++) {
    const turn = turns[t]
    const maxAction = t === clampedTurn ? actionIndex : turn.actions.length - 1

    for (let a = 0; a <= maxAction && a < turn.actions.length; a++) {
      const action = turn.actions[a]
      if ('snapshot' in action && typeof action.snapshot !== 'undefined') {
        state = action.snapshot as GameState
      }
    }
  }

  return state
}

export function getTimelineLength(log: MatchLog): { turns: number; actionsPerTurn: number[] } {
  return {
    turns: log.turns.length,
    actionsPerTurn: log.turns.map((t) => t.actions.length),
  }
}