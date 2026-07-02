import { describe, it, expect, beforeEach } from 'vitest'
import { createStatsOverlay, updateStatsOverlay } from '../src/stats-overlay.js'
import type { MatchLog, ActionEvent } from '@scorched-llm/engine'

function makeAction(overrides: Partial<ActionEvent> = {}) {
  return {
    kind: 'move' as const,
    call: { id: 'c1', tool: { kind: 'move', direction: 'N', distance: 1 } },
    result: { kind: 'ok' as const },
    snapshot: undefined,
    ...overrides,
  }
}

function makeValidLog(overrides: Partial<MatchLog> = {}): MatchLog {
  const baseTerrain = Array.from({ length: 10 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => ({ coord: { x, y }, terrain: 'open' as const, obstacleHeight: 0 }))
  )
  return {
    schemaVersion: '1.0.0',
    metadata: { matchId: 'test-match', createdAt: '2024-01-01', promptVersion: 'v1', adapterVersions: {} },
    config: {
      rulesVersion: '1.0.0', seed: 42,
      map: { width: 10, height: 10, obstacleDensity: 0.1, generatorVersion: '1', obstacleHeight: 5 },
      players: [
        { label: 'A', startPosition: { x: 0, y: 0 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
        { label: 'B', startPosition: { x: 9, y: 9 }, model: { name: 'test', baseURL: 'http://localhost:11434', model: 'test' } },
      ],
      fog: { localRadius: 2, flareRadius: 3, flareDuration: 'one-round-global' as const },
      actionEconomy: 'double',
      shell: { maxRange: 8, apexHeight: 10, tankHeight: 2 },
      lethality: { hitsToKill: 2 },
      turnLimit: 20,
      perTurnTimeoutMs: 60000,
      maxToolCallsPerTurn: 4,
    },
    initialState: {
      turn: 0, currentPlayerIndex: 0,
      tanks: [
        { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
        { id: 'B', position: { x: 9, y: 9 }, hp: 2, maxHp: 2, alive: true, facing: 180, damageDealt: 0, hitsLanded: 0 },
      ],
      flares: [],
      terrain: baseTerrain,
      rulesVersion: '1.0.0',
    },
    turns: [],
    result: { terminationReason: 'turn-limit', placements: [] },
    ...overrides,
  }
}

describe('stats-overlay', () => {
  describe('createStatsOverlay', () => {
    it('creates element with class stats-overlay', () => {
      const overlay = createStatsOverlay()
      expect(overlay).toBeInstanceOf(HTMLElement)
      expect(overlay.className).toBe('stats-overlay')
    })

    it('shows No match loaded empty state', () => {
      const overlay = createStatsOverlay()
      const emptyEl = overlay.querySelector('.stats-overlay__empty')
      expect(emptyEl).not.toBeNull()
      expect(emptyEl?.textContent).toContain('No match loaded')
    })
  })

  describe('updateStatsOverlay', () => {
    let panel: HTMLElement

    beforeEach(() => {
      panel = createStatsOverlay()
    })

    it('renders match info (termination reason, turn count, match ID)', () => {
      const log = makeValidLog()
      updateStatsOverlay(panel, log)
      const header = panel.querySelector('.stats-overlay__header')
      expect(header).not.toBeNull()
      expect(header?.textContent).toContain('Termination:')
      expect(header?.textContent).toContain('Turn Limit')
      expect(header?.textContent).toContain('Total turns:')
      expect(header?.textContent).toContain('0')
      expect(header?.textContent).toContain('Match ID:')
      expect(header?.textContent).toContain('test-match')
    })

    it('renders one card per tank from initialState', () => {
      const log = makeValidLog()
      updateStatsOverlay(panel, log)
      const cards = panel.querySelectorAll('.stats-card')
      expect(cards.length).toBe(2)
    })

    it('shows tank HP and max HP', () => {
      const log = makeValidLog()
      updateStatsOverlay(panel, log)
      const statLabels = panel.querySelectorAll('.stats-card__stat-label')
      const statValues = panel.querySelectorAll('.stats-card__stat-value')
      // Find the HP stat value
      let foundHp = false
      for (let i = 0; i < statLabels.length; i++) {
        if (statLabels[i].textContent?.includes('HP') && !statLabels[i].textContent?.includes('Damage')) {
          const val = statValues[i]?.textContent
          expect(val).toContain('/2')
          foundHp = true
          break
        }
      }
      expect(foundHp).toBe(true)
    })

    it('shows alive/dead status', () => {
      const logAlive = makeValidLog({
        initialState: {
          ...makeValidLog().initialState,
          tanks: [
            { id: 'A', position: { x: 0, y: 0 }, hp: 2, maxHp: 2, alive: true, facing: 0, damageDealt: 0, hitsLanded: 0 },
            { id: 'B', position: { x: 9, y: 9 }, hp: 0, maxHp: 2, alive: false, facing: 180, damageDealt: 0, hitsLanded: 0 },
          ],
        },
      } as Partial<MatchLog>)
      updateStatsOverlay(panel, logAlive)
      const statuses = panel.querySelectorAll('.stats-card__status')
      expect(statuses.length).toBe(2)
      const texts = Array.from(statuses).map(s => s.textContent)
      expect(texts).toContain('Alive')
      expect(texts).toContain('Destroyed')
      expect(panel.querySelector('.stats-card__status--alive')).not.toBeNull()
      expect(panel.querySelector('.stats-card__status--dead')).not.toBeNull()
    })

    it('shows action counts by type', () => {
      const log = makeValidLog({
        turns: [
          {
            player: 'A',
            turn: 1,
            actions: [
              { ...makeAction(), kind: 'move' },
              { ...makeAction(), kind: 'move' },
              { ...makeAction(), kind: 'shell' },
            ],
            modelTrace: undefined,
          },
        ],
      } as Partial<MatchLog>)
      updateStatsOverlay(panel, log)
      const tags = panel.querySelectorAll('.stats-card__action-tag')
      const tagTexts = Array.from(tags).map(t => t.textContent)
      expect(tagTexts).toContain('Move: 2')
      expect(tagTexts).toContain('Shell: 1')
    })

    it('shows token/cost/latency stats from modelTrace', () => {
      const log = makeValidLog({
        turns: [
          {
            player: 'A',
            turn: 1,
            actions: [makeAction()],
            modelTrace: { tokensIn: 100, tokensOut: 50, costUsd: 0.02, latencyMs: 1500 },
          },
        ],
      } as Partial<MatchLog>)
      updateStatsOverlay(panel, log)
      const traceItems = panel.querySelectorAll('.stats-card__trace-item')
      const traceTexts = Array.from(traceItems).map(t => t.textContent ?? '')
      expect(traceTexts.some(t => t.includes('Tokens in:'))).toBe(true)
      expect(traceTexts.some(t => t.includes('Tokens out:'))).toBe(true)
      expect(traceTexts.some(t => t.includes('Avg latency:'))).toBe(true)
      expect(traceTexts.some(t => t.includes('Cost:'))).toBe(true)
    })

    it('shows placement rank from result.placements', () => {
      const log = makeValidLog({
        result: {
          terminationReason: 'last-standing',
          placements: [
            { tankId: 'A', rank: 1, tieGroup: undefined },
            { tankId: 'B', rank: 2, tieGroup: undefined },
          ],
        },
      } as Partial<MatchLog>)
      updateStatsOverlay(panel, log)
      const placements = panel.querySelectorAll('.stats-card__placement')
      expect(placements.length).toBe(2)
      const placementTexts = Array.from(placements).map(p => p.textContent)
      expect(placementTexts.some(t => t?.includes('1st'))).toBe(true)
      expect(placementTexts.some(t => t?.includes('2nd'))).toBe(true)
    })

    it('aggregates stats across multiple turns', () => {
      const log = makeValidLog({
        turns: [
          {
            player: 'A',
            turn: 1,
            actions: [{ ...makeAction(), kind: 'move' }, { ...makeAction(), kind: 'shell' }],
            modelTrace: { tokensIn: 100, tokensOut: 50, costUsd: 0.01, latencyMs: 1000 },
          },
          {
            player: 'A',
            turn: 2,
            actions: [{ ...makeAction(), kind: 'move' }],
            modelTrace: { tokensIn: 120, tokensOut: 60, costUsd: 0.015, latencyMs: 1200 },
          },
        ],
      } as Partial<MatchLog>)
      updateStatsOverlay(panel, log)
      const tags = panel.querySelectorAll('.stats-card__action-tag')
      const tagTexts = Array.from(tags).map(t => t.textContent)
      expect(tagTexts).toContain('Move: 2')
      expect(tagTexts).toContain('Shell: 1')
      const traceItems = panel.querySelectorAll('.stats-card__trace-item')
      const traceTexts = Array.from(traceItems).map(t => t.textContent ?? '')
      // Should aggregate tokens: 100 + 120 = 220
      expect(traceTexts.some(t => t.includes('Tokens in: 220'))).toBe(true)
      // Should aggregate tokens out: 50 + 60 = 110
      expect(traceTexts.some(t => t.includes('Tokens out: 110'))).toBe(true)
      // Avg latency should be average: (1000 + 1200) / 2 = 1100
      expect(traceTexts.some(t => t.includes('Avg latency: 1100ms'))).toBe(true)
      // Cost should be total: 0.01 + 0.015 = 0.025
      expect(traceTexts.some(t => t.includes('$0.0250'))).toBe(true)
      // Trace count should reflect number of turns with modelTrace
      const tracesSection = panel.querySelector('.stats-card__traces')
      expect(tracesSection?.textContent).toContain('Model Traces (2 turns)')
    })
  })
})