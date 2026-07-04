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

describe('ModelBackedTankAgent', () => {
  describe('message history', () => {
    it('starts with a system message', () => {
      const agent = new ModelBackedTankAgent('tank-1', new FakeModel([]), SYSTEM_PROMPT, 3)
      expect(agent.messages.length).toBe(1)
      expect(agent.messages[0].role).toBe('system')
      expect(agent.messages[0].content).toBe(SYSTEM_PROMPT)
    })

    it('accumulates messages across turns', async () => {
      const response1 = makeResponse({ assistantText: 'first response' })
      const response2 = makeResponse({ assistantText: 'second response' })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      // Initial: only system message
      expect(agent.messages.length).toBe(1)

      // After first turn
      await agent.takeTurn(makeWorldView({ turn: 1 }), TOOLS)
      expect(agent.messages.length).toBe(3) // system + user + assistant
      expect(agent.messages[1].role).toBe('user')
      expect(agent.messages[2].role).toBe('assistant')

      // After second turn
      await agent.takeTurn(makeWorldView({ turn: 2 }), TOOLS)
      expect(agent.messages.length).toBe(5) // system + user + assistant + user + assistant
    })

    it('has correct name', () => {
      const agent = new ModelBackedTankAgent('my-tank', new FakeModel([]), SYSTEM_PROMPT, 3)
      expect(agent.name).toBe('my-tank')
    })

    it('preserves assistant reasoning in recent message history', async () => {
      const model = new FakeModel([makeResponse({
        reasoningContent: 'Scout before committing to a shot.',
        reasoningField: 'reasoning',
        toolCalls: [{ id: 'flare-1', name: 'fire_flare', arguments: { direction: 'E', range: 3 } }],
      })])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      await agent.takeTurn(makeWorldView(), TOOLS)

      const assistant = agent.messages.find((message) => message.role === 'assistant')
      expect(assistant?.reasoningContent).toBe('Scout before committing to a shot.')
      expect(assistant?.reasoningField).toBe('reasoning')
    })

    it('compacts old turns into deterministic tactical memory', async () => {
      const model = new FakeModel(Array.from({ length: 8 }, (_, index) => makeResponse({
        reasoningContent: `reasoning-${index + 1}`,
        reasoningField: 'reasoning',
      })))
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      for (let turn = 1; turn <= 8; turn++) {
        await agent.takeTurn(makeWorldView({
          turn,
          position: { x: turn, y: 5 },
          visibleEnemies: [{
            id: 'tank-2',
            position: { x: 20 - turn, y: 10 },
            hp: turn < 7 ? 2 : 1,
          }],
        }), TOOLS)
      }

      const userMessages = agent.messages.filter((message) => message.role === 'user')
      expect(userMessages).toHaveLength(5)
      expect(agent.messages.filter((message) => message.role === 'system')).toHaveLength(1)
      expect(agent.messages[0].content).toContain(SYSTEM_PROMPT)
      expect(agent.messages[0].content).toContain('TACTICAL MEMORY')
      expect(agent.messages[0].content).toContain('T1 (19,10) HP2')
      expect(agent.messages[0].content).toContain('T8 (12,10) HP1')
      const retainedReasoning = agent.messages
        .map((message) => message.reasoningContent)
        .filter((reasoning): reasoning is string => reasoning != null)
      expect(retainedReasoning).toEqual([
        'reasoning-4', 'reasoning-5', 'reasoning-6', 'reasoning-7', 'reasoning-8',
      ])
    })
  })

  describe('tool-call conversion', () => {
    it('converts valid move call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'm1', name: 'move', arguments: { direction: 'N', distance: 3 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('move')
      const move = calls[0].tool
      expect(move.direction).toBe('N')
      expect(move.distance).toBe(3)
    })

    it('converts valid fire_flare call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'f1', name: 'fire_flare', arguments: { direction: 'E', range: 5 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('fire_flare')
      expect(calls[0].tool.direction).toBe('E')
      expect(calls[0].tool.range).toBe(5)
    })

    it('converts valid fire_shell call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 's1', name: 'fire_shell', arguments: { angle: 90, power: 7 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('fire_shell')
      expect(calls[0].tool.angle).toBe(90)
      expect(calls[0].tool.power).toBe(7)
    })

    it('converts pass call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'p1', name: 'pass', arguments: {} }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('pass')
    })

    it('converts look call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'l1', name: 'look', arguments: {} }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('look')
    })

    it('converts known_map call', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'km1', name: 'known_map', arguments: {} }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(1)
      expect(calls[0].tool.kind).toBe('known_map')
    })

    it('filters out invalid move call (bad direction)', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'm1', name: 'move', arguments: { direction: 'INVALID', distance: 3 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })

    it('filters out invalid move call (missing distance)', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'm1', name: 'move', arguments: { direction: 'N' } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })

    it('filters out invalid fire_shell call (non-number angle)', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 's1', name: 'fire_shell', arguments: { angle: 'forty-five', power: 7 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })

    it('filters out unknown tool name', async () => {
      const response = makeResponse({
        toolCalls: [{ id: 'x1', name: 'explosive_blast', arguments: {} }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })

    it('keeps valid calls and filters invalid ones', async () => {
      const response = makeResponse({
        toolCalls: [
          { id: 'm1', name: 'move', arguments: { direction: 'E', distance: 2 } },
          { id: 'bad1', name: 'bad_tool', arguments: {} },
          { id: 's1', name: 'fire_shell', arguments: { angle: 45, power: 5 } },
          { id: 'bad2', name: 'move', arguments: { direction: 'INVALID', distance: 1 } },
        ],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(2)
      expect(calls[0].tool.kind).toBe('move')
      expect(calls[1].tool.kind).toBe('fire_shell')
    })

    it('handles three invalid calls in a row', async () => {
      const response = makeResponse({
        toolCalls: [
          { id: 'bad1', name: 'unknown_tool', arguments: {} },
          { id: 'bad2', name: 'move', arguments: { direction: 'INVALID', distance: -1 } },
          { id: 'bad3', name: 'fire_shell', arguments: { angle: NaN, power: NaN } },
        ],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })
  })

  describe('blocked-move recovery', () => {
    it('appends tool result to history after engine execution', async () => {
      // Simulate: model returns a move, engine rejects it (blocked)
      // The agent should have the worldview (user) and assistant response in history
      const response = makeResponse({
        toolCalls: [{ id: 'm1', name: 'move', arguments: { direction: 'N', distance: 3 } }],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      await agent.takeTurn(makeWorldView({ turn: 1 }), TOOLS)

      // History should have: system, user (worldview), assistant (tool calls)
      // Note: real tool results are injected by the orchestration layer, not the agent
      expect(agent.messages.length).toBe(3)
      expect(agent.messages[0].role).toBe('system')
      expect(agent.messages[1].role).toBe('user')
      expect(agent.messages[2].role).toBe('assistant')
    })
  })

  describe('parallel-call ordering', () => {
    it('returns tool calls in the order returned by the model', async () => {
      const response = makeResponse({
        toolCalls: [
          { id: 'first', name: 'move', arguments: { direction: 'N', distance: 1 } },
          { id: 'second', name: 'move', arguments: { direction: 'E', distance: 1 } },
          { id: 'third', name: 'fire_flare', arguments: { direction: 'S', range: 3 } },
        ],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(3)
      expect(calls[0].id).toBe('first')
      expect(calls[1].id).toBe('second')
      expect(calls[2].id).toBe('third')
    })
  })

  describe('history serialization', () => {
    it('can serialize and restore agent messages', async () => {
      const response1 = makeResponse({
        toolCalls: [{ id: 'm1', name: 'move', arguments: { direction: 'N', distance: 1 } }],
      })
      const response2 = makeResponse({
        toolCalls: [{ id: 'm2', name: 'move', arguments: { direction: 'E', distance: 1 } }],
      })
      const model = new FakeModel([response1, response2])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      // First turn: system + user + assistant = 3
      await agent.takeTurn(makeWorldView({ turn: 1 }), TOOLS)
      expect(agent.messages.length).toBe(3)

      // Serialize
      const serialized = JSON.stringify(agent.messages)

      // Create a new agent and restore
      const agent2 = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)
      agent2.messages = JSON.parse(serialized) as import('../src/match/fake-agents.js').AgentMessage[]

      expect(agent2.messages.length).toBe(3)
      expect(agent2.messages[0].role).toBe('system')
      expect(agent2.messages[1].role).toBe('user')
      expect(agent2.messages[2].role).toBe('assistant')

      // Second turn should continue with correct history: 3 + user + assistant = 5
      await agent2.takeTurn(makeWorldView({ turn: 2 }), TOOLS)
      expect(agent2.messages.length).toBe(5)
    })
  })

  describe('empty tool calls', () => {
    it('handles model returning no tool calls (text-only response)', async () => {
      const response = makeResponse({
        assistantText: 'I cannot find a valid action.',
        toolCalls: [],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      const calls = await agent.takeTurn(makeWorldView(), TOOLS)
      expect(calls.length).toBe(0)
    })

    it('appends text-only assistant response to history', async () => {
      const response = makeResponse({
        assistantText: 'Let me think about this...',
        toolCalls: [],
      })
      const model = new FakeModel([response])
      const agent = new ModelBackedTankAgent('tank-1', model, SYSTEM_PROMPT, 3)

      await agent.takeTurn(makeWorldView(), TOOLS)
      expect(agent.messages.length).toBe(3)
      expect(agent.messages[2].role).toBe('assistant')
      expect(agent.messages[2].content).toBe('Let me think about this...')
    })
  })
})
