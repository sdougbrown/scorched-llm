import { describe, it, expect, beforeEach } from 'vitest'
import { createTracePanel, updateTracePanel } from '../src/trace-panel.js'
import type { TurnEvent } from '@scorched-llm/engine'

function makeTurn(overrides: Partial<TurnEvent> = {}): TurnEvent {
  return {
    turn: 0,
    player: 'A',
    actions: [
      {
        kind: 'shell' as const,
        call: { id: 'c1', tool: { kind: 'fire_shell', angle: 45, power: 70 } },
        result: { kind: 'hit' as const, targetId: 'B', damage: 1 },
        snapshot: undefined,
      },
    ],
    worldview: {
      position: { x: 0, y: 0 },
      hp: 2,
      facing: 0,
      localScan: [],
      flaredCells: [],
      inEnemyFlare: [],
      remainingActions: 2,
      turn: 0,
      isMyTurn: true,
      aliveEnemyCount: 1,
    },
    ...overrides,
  }
}

describe('createTracePanel', () => {
  it("creates an element with class 'trace-panel'", () => {
    const panel = createTracePanel('tank-1')
    expect(panel.className).toBe('trace-panel')
  })

  it('initial content shows "No data yet" empty state', () => {
    const panel = createTracePanel('tank-1')
    const content = panel.querySelector('.trace-panel__content')
    expect(content).not.toBeNull()
    expect(content!.textContent).toBe('No data yet')
  })

  it('sets the tank id on the title and dataset', () => {
    const panel = createTracePanel('alpha')
    const title = panel.querySelector('.trace-panel__title')
    expect(title?.textContent).toBe('Tank: alpha')
    expect(panel.dataset.tankId).toBe('alpha')
  })
})

describe('updateTracePanel', () => {
  let panel: HTMLElement

  beforeEach(() => {
    panel = createTracePanel('tank-x')
  })

  it('renders assistant text when present', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
        assistantText: 'Thinking about firing...',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const pre = panel.querySelector('.trace-panel__assistant')
    expect(pre?.textContent).toBe('Thinking about firing...')
  })

  it('renders tool call entries', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [{ id: 'c1', tool: { kind: 'fire_shell', angle: 45, power: 70 } }],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const calls = panel.querySelectorAll('.trace-panel__call')
    expect(calls.length).toBe(1)
  })

  it('shows tool kind and parameters', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [{ id: 'c1', tool: { kind: 'move', direction: 'north', distance: 3 } }],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const params = panel.querySelector('.trace-panel__call-params')
    expect(params?.textContent).toContain('move(direction=north, distance=3)')
  })

  it('shows hit result with target and damage', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [{ id: 'c1', tool: { kind: 'fire_shell', angle: 45, power: 70 } }],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const resultSpan = panel.querySelector('.trace-panel__call-result')
    expect(resultSpan?.textContent).toBe('hit(B, 1 damage)')
  })

  it('shows token/cost/latency stats', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [],
        tokensIn: 256,
        tokensOut: 128,
        costUsd: 0.012,
        latencyMs: 450,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const labels = Array.from(panel.querySelectorAll('.trace-panel__stat-label')).map(
      (el) => el.textContent,
    )
    const values = Array.from(panel.querySelectorAll('.trace-panel__stat-value')).map(
      (el) => el.textContent,
    )
    expect(labels.join(',')).toContain('Tokens In')
    expect(labels.join(',')).toContain('Tokens Out')
    expect(labels.join(',')).toContain('Cost')
    expect(labels.join(',')).toContain('Latency')
    expect(values.join(',')).toContain('256')
    expect(values.join(',')).toContain('128')
    expect(values.join(',')).toContain('$0.012')
    expect(values.join(',')).toContain('450ms')
  })

  it('shows blocked result kind', () => {
    const turn = makeTurn({
      actions: [
        {
          kind: 'move' as const,
          call: { id: 'c2', tool: { kind: 'move', direction: 'north', distance: 1 } },
          result: { kind: 'blocked' as const, reason: 'wall in the way' },
          snapshot: undefined,
        },
      ],
      modelTrace: {
        toolCalls: [{ id: 'c2', tool: { kind: 'move', direction: 'north', distance: 1 } }],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const resultSpan = panel.querySelector('.trace-panel__call-result')
    expect(resultSpan?.textContent).toContain('blocked')
    expect(resultSpan?.textContent).toContain('wall in the way')
  })

  it('handles missing modelTrace gracefully by showing "No trace data"', () => {
    const turn = makeTurn({ modelTrace: undefined })
    updateTracePanel(panel, turn, 'tank-x')
    const empty = panel.querySelector('.trace-panel__empty')
    expect(empty?.textContent).toBe('No trace data')
  })

  it('does not render .trace-panel__calls when there are no tool calls', () => {
    const turn = makeTurn({
      modelTrace: {
        toolCalls: [],
        tokensIn: 100,
        tokensOut: 50,
        costUsd: 0.003,
        latencyMs: 200,
        finishReason: 'stop',
      },
    })
    updateTracePanel(panel, turn, 'tank-x')
    const calls = panel.querySelector('.trace-panel__calls')
    expect(calls).toBeNull()
  })
})