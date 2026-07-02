import { describe, it, expect } from 'vitest'

// Spectator smoke test verifies the module graph resolves correctly.
describe('spectator', () => {
  it('resolves engine dependency', async () => {
    const mod = await import('@scorched-llm/engine')
    expect(mod.VERSION).toBe('0.0.0')
  })
})