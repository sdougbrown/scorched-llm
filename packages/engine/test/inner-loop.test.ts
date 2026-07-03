import { describe, it, expect } from 'vitest'
import { ModelBackedTankAgent } from '../src/model/tank-agent.js'
import { FakeModel } from '../src/model/fake-model.js'
import type { NormalizedModelResponse } from '../src/model/types.js'
import type { WorldView } from '../src/types/events.js'
import type { ToolSpec } from '../src/match/fake-agents.js'

function makeWorldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    position: { x: 5, y: 5 },
    hp: 2,
    facing: 0,
    localScan: [],
    flaredCells: [],
    inEnemyFlare: [],
    remainingActions: 2,
    turn: 1,
    isMyTurn: true,
    aliveEnemyCount: 1,
    ...overrides,
  }
}

function makeResponse(overrides: Partial<NormalizedModelResponse> = {}): NormalizedModelResponse {
  return {
    assistantText: 'ok',
    toolCalls: [],
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.01,
    latencyMs: 5,
    finishReason: 'stop',
    ...overrides,
  }
}

const TOOLS: ToolSpec[] = [
  { name: 'move', description: 'Move the tank', parameters: { direction: {}, distance: {} } },
  { name: 'fire_flare', description: 'Fire a flare', parameters: { direction: {}, range: {} } },
  { name: 'fire_shell', description: 'Fire a shell', parameters: { angle: {}, power: {} } },
  { name: 'pass', description: 'Pass the turn', parameters: {} },
  { name: 'look', description: 'Look at current position', parameters: {} },
  { name: 'known_map', description: 'View known map data', parameters: {} },
]

const SYSTEM_PROMPT = 'You are a Scorched tank agent. Act strategically.'

describe('Inner-loop re-planning', () => {
  describe('partial calls with re-query', () => {
    it('re-queries when model returns finishReason tool_calls', async () => {
      // First query: model returns 1 call and says more needed
      // Second query: model returns 1 more call and stops
      const response1 = makeResponse({
        toolCalls: [{ id: 'tc1', name: 'move', arguments: { direction: 'N', distance: 1 } }],
        finishReason: 'tool_calls',
      })
      const response2 = makeResponse({
        toolCalls: [{ id: 'tc2', name: 'fire_flare', arguments: { direction: 'E', range: 3 } }],
        finishReason: 'stop',
      })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)

      expect(calls.length).toBe(2)
      expect(calls[0].tool.kind).toBe('move')
      expect(calls[1].tool.kind).toBe('fire_flare')
      // Model was queried twice (once per batch)
      expect(model.callCount_).toBe(2)
    })

    it('re-queries after an executed tool call even when the provider reports length', async () => {
      const response1 = makeResponse({
        toolCalls: [
          { id: 'tc-invalid-1', name: 'unsupported_tool', arguments: {} },
          { id: 'tc1', name: 'known_map', arguments: {} },
          { id: 'tc-invalid-2', name: 'move', arguments: { direction: 'sideways' } },
        ],
        finishReason: 'length',
      })
      const response2 = makeResponse({
        toolCalls: [{ id: 'tc2', name: 'move', arguments: { direction: 'N', distance: 1 } }],
        finishReason: 'stop',
      })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)
      const worldview = makeWorldView()

      const result = await agent.takeTurn(worldview, TOOLS, async (call) => ({
        result: { kind: 'ok' },
        worldview,
        ...(call.tool.kind === 'known_map' ? { knownMap: [] } : {}),
        turnEnded: false,
      }))

      expect(Array.isArray(result)).toBe(false)
      expect(result.toolCalls.map((call) => call.tool.kind)).toEqual(['known_map', 'move'])
      expect(model.callCount_).toBe(3)
    })

    it('accumulates full history across re-queries', async () => {
      const response1 = makeResponse({
        toolCalls: [{ id: 'tc1', name: 'move', arguments: { direction: 'N', distance: 1 } }],
        finishReason: 'tool_calls',
      })
      const response2 = makeResponse({
        toolCalls: [{ id: 'tc2', name: 'pass', arguments: {} }],
        finishReason: 'stop',
      })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      await agent.takeTurn(makeWorldView({ turn: 1 }), TOOLS)

      // History should have: system, user, assistant1, assistant2
      // (no fake tool results — real results injected by orchestration layer)
      expect(agent.messages.length).toBe(4)
      expect(agent.messages[0].role).toBe('system')
      expect(agent.messages[1].role).toBe('user')
      expect(agent.messages[2].role).toBe('assistant')
      expect(agent.messages[3].role).toBe('assistant')
    })
  })

  describe('max tool calls cap', () => {
    it('respects the max tool calls per turn', async () => {
      const responses: NormalizedModelResponse[] = []
      for (let i = 0; i < 10; i++) {
        responses.push(makeResponse({
          toolCalls: [{ id: `tc${i}`, name: 'move', arguments: { direction: 'N', distance: 1 } }],
          finishReason: 'tool_calls',
        }))
      }
      // Final response: stop
      responses.push(makeResponse({
        toolCalls: [],
        finishReason: 'stop',
      }))

      const model = new FakeModel(responses)
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)

      // Should only have 3 calls (cap)
      expect(calls.length).toBe(3)
      // Model was queried 3 times (once per call batch, each returning 1 call)
      expect(model.callCount_).toBe(3)
    })
  })

  describe('blocked move triggers re-query', () => {
    it('model gets tool result and can adapt on re-query', async () => {
      // First query: model returns a move (which will be blocked by engine)
      // Second query: model adapts and returns pass
      const response1 = makeResponse({
        toolCalls: [{ id: 'tc1', name: 'move', arguments: { direction: 'N', distance: 99 } }],
        finishReason: 'tool_calls',
      })
      const response2 = makeResponse({
        toolCalls: [{ id: 'tc2', name: 'pass', arguments: {} }],
        finishReason: 'stop',
      })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)

      // Both calls are returned (the engine would filter the blocked one)
      expect(calls.length).toBe(2)
      expect(calls[0].tool.kind).toBe('move')
      expect(calls[1].tool.kind).toBe('pass')
      expect(model.callCount_).toBe(2)
    })
  })

  describe('single query no re-query', () => {
    it('stops when model returns finishReason stop', async () => {
      const response = makeResponse({
        toolCalls: [
          { id: 'tc1', name: 'move', arguments: { direction: 'N', distance: 2 } },
          { id: 'tc2', name: 'fire_shell', arguments: { angle: 45, power: 5 } },
        ],
        finishReason: 'stop',
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)

      expect(calls.length).toBe(2)
      // Only one query since finishReason was 'stop'
      expect(model.callCount_).toBe(1)
    })

    it('stops when no tool calls returned', async () => {
      const response = makeResponse({
        assistantText: 'I cannot find a valid action.',
        toolCalls: [],
        finishReason: 'stop',
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)

      expect(calls.length).toBe(0)
      expect(model.callCount_).toBe(1)
    })
  })
})
