import { describe, it, expect } from 'vitest'
import { alwaysPassAgent, fixtureCallAgent } from '../src/match/fake-agents.js'
import type { ToolCall } from '../src/types/tool.js'
import type { WorldView } from '../src/types/events.js'
import type { ToolSpec } from '../src/match/fake-agents.js'

describe('alwaysPassAgent', () => {
  it('returns pass calls', async () => {
    const agent = alwaysPassAgent('test-agent')
    const calls = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(calls.length).toBe(1)
    expect(calls[0].tool.kind).toBe('pass')
  })

  it('has correct name', () => {
    const agent = alwaysPassAgent('my-agent')
    expect(agent.name).toBe('my-agent')
  })
})

describe('fixtureCallAgent', () => {
  it('returns calls in order', async () => {
    const calls: ToolCall[] = [
      { id: 'move-1', tool: { kind: 'move', direction: 'E', distance: 3 } },
      { id: 'shell-1', tool: { kind: 'fire_shell', angle: 90, power: 5 } },
      { id: 'pass-1', tool: { kind: 'pass' } },
    ]
    const agent = fixtureCallAgent('fixture-agent', calls)
    const result1 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(result1.length).toBe(2)
    expect(result1[0].id).toBe('move-1')
    expect(result1[1].id).toBe('shell-1')

    const result2 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(result2).toEqual([calls[2]])
  })

  it('falls back to pass when exhausted', async () => {
    const calls: ToolCall[] = [
      { id: 'move-1', tool: { kind: 'move', direction: 'N', distance: 1 } },
    ]
    const agent = fixtureCallAgent('exhausted-agent', calls)

    // First call returns the scripted move
    const r1 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(r1[0].tool.kind).toBe('move')

    // Second call — all scripted calls are used up, should return pass
    const r2 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(r2[0].tool.kind).toBe('pass')
  })

  it('batches calls up to 2 per turn', async () => {
    const calls: ToolCall[] = [
      { id: 'm1', tool: { kind: 'move', direction: 'E', distance: 1 } },
      { id: 'm2', tool: { kind: 'move', direction: 'S', distance: 1 } },
      { id: 'm3', tool: { kind: 'move', direction: 'W', distance: 1 } },
      { id: 'm4', tool: { kind: 'move', direction: 'N', distance: 1 } },
      { id: 'm5', tool: { kind: 'move', direction: 'NE', distance: 1 } },
    ]
    const agent = fixtureCallAgent('batch-agent', calls)

    // First takeTurn returns first 2 calls
    const r1 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(r1.length).toBe(2)
    expect(r1[0].id).toBe('m1')
    expect(r1[1].id).toBe('m2')

    // Second takeTurn returns next 2 calls
    const r2 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(r2.length).toBe(2)
    expect(r2[0].id).toBe('m3')
    expect(r2[1].id).toBe('m4')

    // Third takeTurn returns last call
    const r3 = await agent.takeTurn({} as WorldView, [] as ToolSpec[])
    expect(r3.length).toBe(1)
    expect(r3[0].id).toBe('m5')
  })
})