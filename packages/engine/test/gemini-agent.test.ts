import { describe, it, expect, vi } from 'vitest'
import { createGeminiAgent } from '../src/match/gemini-agent.js'
import type { WorldView } from '../src/types/events.js'
import type { ToolCall } from '../src/types/tool.js'
import type { Coordinate } from '../src/types/coords.js'
import type { ToolSpec } from '../src/match/fake-agents.js'

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: [
      { coord: { x: 5, y: 5 }, terrain: 'open', obstacleHeight: 0 },
      { coord: { x: 5, y: 4 }, terrain: 'open', obstacleHeight: 0 },
    ],
    flaredCells: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 1,
    isMyTurn: true,
    aliveEnemyCount: 1,
    ...overrides,
  }
}

const TOOLS_SPEC: ToolSpec[] = [
  {
    name: 'move',
    description: 'Move',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string' },
        distance: { type: 'integer', maximum: 3 },
      },
    },
  },
  {
    name: 'fire_shell',
    description: 'Fire',
    parameters: {
      type: 'object',
      properties: {
        angle: { type: 'number' },
        power: { type: 'number', maximum: 10 },
      },
    },
  },
]

describe('GeminiAgent', () => {
  it('has the correct name', () => {
    const agent = createGeminiAgent('tank-0')
    expect(agent.name).toBe('gemini-tank-0')
  })

  it('returns a pass when it is not my turn', async () => {
    const agent = createGeminiAgent('tank-0')
    const calls = await agent.takeTurn(makeWorldView({ isMyTurn: false }), TOOLS_SPEC)
    const formattedCalls = Array.isArray(calls) ? calls : calls.toolCalls
    expect(formattedCalls).toBeDefined()
    expect(formattedCalls.length).toBe(1)
    expect(formattedCalls[0].tool.kind).toBe('pass')
  })

  it('blind fires at last known enemy position when not visible', async () => {
    const enemyPos: Coordinate = { x: 5, y: 3 } // Directly North, distance 2
    const agent = createGeminiAgent('tank-0', enemyPos, 1)
    const result = await agent.takeTurn(makeWorldView({ aliveEnemyCount: 1 }), TOOLS_SPEC)
    const calls = Array.isArray(result) ? result : result.toolCalls

    const shellCall = calls.find((c) => c.tool.kind === 'fire_shell')
    expect(shellCall).toBeDefined()
    expect(shellCall!.tool.kind).toBe('fire_shell')
    // North is 0 degrees
    expect(shellCall!.tool).toMatchObject({ kind: 'fire_shell', angle: 0, power: 2 })
  })

  it('performs interactive execution when executeTool is provided', async () => {
    const agent = createGeminiAgent('tank-0')
    const executeTool = vi.fn().mockImplementation(async (call: ToolCall) => {
      return {
        result: { kind: 'ok' },
        worldview: makeWorldView({
          position: { x: 5, y: 5 },
          remainingActions: 1,
          visibleEnemies: [{ id: 'tank-1', position: { x: 5, y: 3 }, hp: 2 }],
        }),
        turnEnded: false,
      }
    })

    // Turn 1, starts with enemy not visible but we flare or move
    const result = await agent.takeTurn(
      makeWorldView({
        position: { x: 5, y: 5 },
        visibleEnemies: [{ id: 'tank-1', position: { x: 5, y: 3 }, hp: 2 }],
      }),
      TOOLS_SPEC,
      executeTool,
    )

    // Should have called fire_shell directly because the enemy is visible and shot is clear
    expect(executeTool).toHaveBeenCalled()
    const firstCall = executeTool.mock.calls[0][0] as ToolCall
    expect(firstCall.tool.kind).toBe('fire_shell')
  })
})
