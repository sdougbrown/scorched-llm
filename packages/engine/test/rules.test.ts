import { describe, it, expect } from 'vitest'
import { createTurnRules } from '../src/rules/turn-rules.js'
import type { TurnConditions, MoveAction, FlareAction, ShellAction } from '../src/rules/turn-rules.js'

const defaultConditions: TurnConditions = {
  remainingActions: 2,
  moveBudgetRemaining: 5,
  invalidStreak: 0,
  isDoubleMode: true,
}

describe('createTurnRules — single mode', () => {
  const rules = createTurnRules('single')

  it('enables move1 by default', () => {
    const av = rules.check({}, defaultConditions)
    expect(av.move1.enabled).toBe(true)
  })

  it('disables move2 without move1', () => {
    const av = rules.check({}, defaultConditions)
    expect(av.move2.enabled).toBe(false)
  })

  it('enables move2 after move1', () => {
    const av = rules.check({ move1: { direction: 'N', distance: 1 } as MoveAction }, defaultConditions)
    expect(av.move2.enabled).toBe(true)
  })

  it('disables all actions after one action taken', () => {
    const singleCond: TurnConditions = { ...defaultConditions, remainingActions: 0 }
    const av = rules.check({}, singleCond)
    expect(av.move1.enabled).toBe(false)
    expect(av.move2.enabled).toBe(false)
    expect(av.flare.enabled).toBe(false)
    expect(av.shell.enabled).toBe(false)
  })

  it('enables pass when no action taken', () => {
    const av = rules.check({}, defaultConditions)
    expect(av.pass.enabled).toBe(true)
  })

  it('disables pass after move1 taken', () => {
    const av = rules.check({ move1: { direction: 'N', distance: 1 } as MoveAction }, defaultConditions)
    expect(av.pass.enabled).toBe(false)
  })

  it('disables pass after flare taken', () => {
    const av = rules.check({ flare: { direction: 'N', range: 3 } as FlareAction }, defaultConditions)
    expect(av.pass.enabled).toBe(false)
  })

  it('oneOf: flare and shell mutually exclusive', () => {
    const av = rules.check({ flare: { direction: 'N', range: 3 } as FlareAction }, defaultConditions)
    expect(av.flare.enabled).toBe(true)
    expect(av.shell.enabled).toBe(false)
  })

  it('oneOf: shell disables flare', () => {
    const av = rules.check({ shell: { angle: 45, power: 5 } as ShellAction }, defaultConditions)
    expect(av.shell.enabled).toBe(true)
    expect(av.flare.enabled).toBe(false)
  })

  it('movement budget: allows within budget', () => {
    const cond: TurnConditions = { ...defaultConditions, moveBudgetRemaining: 3 }
    const av = rules.check({ move1: { direction: 'N', distance: 2 } as MoveAction }, cond)
    expect(av.move1.enabled).toBe(true)
  })

  it('movement budget: blocks when exceeded', () => {
    const cond: TurnConditions = { ...defaultConditions, moveBudgetRemaining: 2 }
    const av = rules.check({ move1: { direction: 'N', distance: 3 } as MoveAction }, cond)
    expect(av.move1.enabled).toBe(false)
  })

  it('three-strike: disables all fields at streak 3', () => {
    const cond: TurnConditions = { ...defaultConditions, invalidStreak: 3 }
    const av = rules.check({}, cond)
    expect(av.move1.enabled).toBe(false)
    expect(av.move2.enabled).toBe(false)
    expect(av.flare.enabled).toBe(false)
    expect(av.shell.enabled).toBe(false)
    expect(av.pass.enabled).toBe(false)
  })

  it('three-strike: allows at streak 2', () => {
    const cond: TurnConditions = { ...defaultConditions, invalidStreak: 2 }
    const av = rules.check({}, cond)
    expect(av.move1.enabled).toBe(true)
  })
})

describe('createTurnRules — double mode', () => {
  const rules = createTurnRules('double')

  it('allows two actions', () => {
    const cond: TurnConditions = { ...defaultConditions, remainingActions: 1 }
    const av = rules.check({ move1: { direction: 'N', distance: 1 } as MoveAction }, cond)
    expect(av.move2.enabled).toBe(true)
  })

  it('disables all actions after two actions', () => {
    const cond: TurnConditions = { ...defaultConditions, remainingActions: 0 }
    const av = rules.check(
      {
        move1: { direction: 'N', distance: 1 } as MoveAction,
        move2: { direction: 'N', distance: 1 } as MoveAction,
      },
      cond,
    )
    expect(av.move1.enabled).toBe(false)
    expect(av.flare.enabled).toBe(false)
  })

  it('move1 + flare is valid in double mode', () => {
    const cond: TurnConditions = { ...defaultConditions, remainingActions: 1 }
    const av = rules.check({ move1: { direction: 'N', distance: 1 } as MoveAction }, cond)
    expect(av.flare.enabled).toBe(true)
  })

  it('move1 + move2 respects cumulative budget', () => {
    const cond: TurnConditions = { ...defaultConditions, moveBudgetRemaining: 3 }
    const av = rules.check(
      {
        move1: { direction: 'N', distance: 2 } as MoveAction,
        move2: { direction: 'N', distance: 2 } as MoveAction,
      },
      cond,
    )
    expect(av.move1.enabled).toBe(false)
    expect(av.move2.enabled).toBe(false)
  })

  it('move1 + move2 within budget', () => {
    const cond: TurnConditions = { ...defaultConditions, moveBudgetRemaining: 5 }
    const av = rules.check(
      {
        move1: { direction: 'N', distance: 2 } as MoveAction,
        move2: { direction: 'N', distance: 2 } as MoveAction,
      },
      cond,
    )
    expect(av.move1.enabled).toBe(true)
    expect(av.move2.enabled).toBe(true)
  })
})

describe('createTurnRules — pass conflicts', () => {
  const rules = createTurnRules('single')

  it('pass disabled after any game action', () => {
    const av = rules.check({ shell: { angle: 0, power: 1 } as ShellAction }, defaultConditions)
    expect(av.pass.enabled).toBe(false)
  })

  it('pass enabled with no actions', () => {
    const av = rules.check({}, defaultConditions)
    expect(av.pass.enabled).toBe(true)
  })
})

describe('createTurnRules — failed-call recovery', () => {
  const rules = createTurnRules('double')

  it('allows actions after streak < 3', () => {
    const cond: TurnConditions = { ...defaultConditions, invalidStreak: 1 }
    const av = rules.check({}, cond)
    expect(av.move1.enabled).toBe(true)
  })

  it('blocks all actions at streak 3', () => {
    const cond: TurnConditions = { ...defaultConditions, invalidStreak: 3 }
    const av = rules.check({}, cond)
    expect(av.move1.enabled).toBe(false)
    expect(av.pass.enabled).toBe(false)
  })
})
