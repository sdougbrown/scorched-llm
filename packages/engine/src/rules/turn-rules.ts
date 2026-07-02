import { umpire, requires, oneOf, enabledWhen } from '@umpire/core'
import type { Umpire, FieldDef, FieldValues } from '@umpire/core'
import type { Direction } from '../types/coords.js'

export type MoveAction = { direction: Direction; distance: number }
export type FlareAction = { direction: Direction; range: number }
export type ShellAction = { angle: number; power: number }

export type TurnFields = {
  move1: FieldDef<MoveAction | null>
  move2: FieldDef<MoveAction | null>
  flare: FieldDef<FlareAction | null>
  shell: FieldDef<ShellAction | null>
  pass: FieldDef<boolean>
}

export interface TurnConditions extends Record<string, unknown> {
  remainingActions: number
  moveBudgetRemaining: number
  invalidStreak: number
  isDoubleMode: boolean
}

function hasAnyAction(values: FieldValues<TurnFields>): boolean {
  return (
    values.move1 != null ||
    values.move2 != null ||
    values.flare != null ||
    values.shell != null
  )
}

function getMoveDistance(action: MoveAction | null | undefined): number {
  if (action == null) return 0
  return action.distance
}

export function createTurnRules(
  _actionEconomy: 'single' | 'double',
): Umpire<TurnFields, TurnConditions> {

  const actionLimitPred = (
    _values: FieldValues<TurnFields>,
    conditions: TurnConditions,
  ): boolean => {
    return conditions.remainingActions > 0
  }

  const threeStrikePred = (
    _values: FieldValues<TurnFields>,
    conditions: TurnConditions,
  ): boolean => {
    return conditions.invalidStreak < 3
  }

  const moveBudgetPred = (
    values: FieldValues<TurnFields>,
    conditions: TurnConditions,
  ): boolean => {
    const dist1 = getMoveDistance(values.move1)
    const dist2 = getMoveDistance(values.move2)
    const total = dist1 + dist2
    return total <= conditions.moveBudgetRemaining
  }

  return umpire({
    fields: {
      move1: { default: null as MoveAction | null },
      move2: { default: null as MoveAction | null },
      flare: { default: null as FlareAction | null },
      shell: { default: null as ShellAction | null },
      pass: { default: false },
    },
    rules: [
      // move2 requires move1
      requires('move2', 'move1'),

      // Only one offensive action
      oneOf('offense', {
        flare: ['flare'],
        shell: ['shell'],
      }),

      // Pass only when no other action is taken
      enabledWhen('pass', (_values) => !hasAnyAction(_values), {
        reason: 'Cannot pass after taking an action',
      }),

      // Action count limit — disable game actions when budget exhausted
      enabledWhen('move1', actionLimitPred, {
        reason: 'Action limit reached',
      }),
      enabledWhen('move2', actionLimitPred, {
        reason: 'Action limit reached',
      }),
      enabledWhen('flare', actionLimitPred, {
        reason: 'Action limit reached',
      }),
      enabledWhen('shell', actionLimitPred, {
        reason: 'Action limit reached',
      }),

      // Cumulative movement budget
      enabledWhen('move1', moveBudgetPred, {
        reason: 'Movement budget exceeded',
      }),
      enabledWhen('move2', moveBudgetPred, {
        reason: 'Movement budget exceeded',
      }),

      // Three-strike rule
      enabledWhen('move1', threeStrikePred, {
        reason: 'Three consecutive invalid calls',
      }),
      enabledWhen('move2', threeStrikePred, {
        reason: 'Three consecutive invalid calls',
      }),
      enabledWhen('flare', threeStrikePred, {
        reason: 'Three consecutive invalid calls',
      }),
      enabledWhen('shell', threeStrikePred, {
        reason: 'Three consecutive invalid calls',
      }),
      enabledWhen('pass', threeStrikePred, {
        reason: 'Three consecutive invalid calls',
      }),
    ],
  })
}
