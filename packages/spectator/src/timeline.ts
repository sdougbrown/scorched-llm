import type { GameState } from '@scorched-llm/engine'
import { reduceToState, getTimelineLength } from './reducer.js'
import type { MatchLog } from '@scorched-llm/engine'

export interface TimelinePosition {
  turn: number
  action: number
  state: GameState
}

export interface Timeline {
  seek(position: number): TimelinePosition
  next(): TimelinePosition
  prev(): TimelinePosition
  length(): number
}

export function createTimeline(log: MatchLog): Timeline {
  const { actionsPerTurn } = getTimelineLength(log)

  let currentPosition = 0

  const totalPositions = 1 + actionsPerTurn.reduce((sum, count) => sum + count, 0)

  function computePosition(pos: number): TimelinePosition {
    if (pos === 0) {
      return {
        turn: 0,
        action: -1,
        state: JSON.parse(JSON.stringify(log.initialState)) as GameState,
      }
    }

    let remaining = pos
    let turnIndex = 0

    while (turnIndex < actionsPerTurn.length) {
      const actionsInTurn = actionsPerTurn[turnIndex]

      if (remaining <= actionsInTurn) {
        const state = reduceToState(log, turnIndex, remaining - 1)
        return {
          turn: turnIndex,
          action: remaining - 1,
          state,
        }
      }

      remaining -= actionsInTurn
      turnIndex++
    }

    const lastTurn = actionsPerTurn.length - 1
    if (lastTurn < 0) {
      return {
        turn: 0,
        action: -1,
        state: JSON.parse(JSON.stringify(log.initialState)) as GameState,
      }
    }

    const lastActionCount = actionsPerTurn[lastTurn]
    const state = reduceToState(log, lastTurn, lastActionCount - 1)
    return {
      turn: lastTurn,
      action: lastActionCount - 1,
      state,
    }
  }

  return {
    seek(position: number): TimelinePosition {
      const clamped = Math.max(0, Math.min(position, totalPositions - 1))
      currentPosition = clamped
      return computePosition(clamped)
    },
    next(): TimelinePosition {
      const nextPos = currentPosition + 1
      if (nextPos >= totalPositions) {
        currentPosition = totalPositions - 1
      } else {
        currentPosition = nextPos
      }
      return computePosition(currentPosition)
    },
    prev(): TimelinePosition {
      const prevPos = currentPosition - 1
      if (prevPos < 0) {
        currentPosition = 0
      } else {
        currentPosition = prevPos
      }
      return computePosition(currentPosition)
    },
    length(): number {
      return totalPositions
    },
  }
}