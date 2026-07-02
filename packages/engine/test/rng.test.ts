import { describe, it, expect } from 'vitest'
import { createRng } from '../src/rng/rng.js'

describe('createRng', () => {
  it('produces deterministic sequence from fixed seed', () => {
    const rng = createRng(42)
    expect(rng.next()).toBeCloseTo(0.43620070652104914)
    expect(rng.next()).toBeCloseTo(0.13819245994091034)
    expect(rng.next()).toBeCloseTo(0.4265084099024534)
    expect(rng.next()).toBeCloseTo(0.17483471077866852)
    expect(rng.next()).toBeCloseTo(0.5316367850173265)
  })

  it('same seed produces same sequence', () => {
    const a = createRng(99)
    const b = createRng(99)
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next())
    }
  })

  it('next returns values in [0, 1)', () => {
    const rng = createRng(12345)
    for (let i = 0; i < 1000; i++) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('int returns values in [min, max]', () => {
    const rng = createRng(7)
    const values: number[] = []
    for (let i = 0; i < 100; i++) {
      const v = rng.int(1, 10)
      expect(v).toBeGreaterThanOrEqual(1)
      expect(v).toBeLessThanOrEqual(10)
      values.push(v)
    }
    expect(new Set(values).size).toBeGreaterThan(1)
  })

  it('pick returns an element from the array', () => {
    const rng = createRng(1)
    const arr = ['a', 'b', 'c', 'd']
    for (let i = 0; i < 20; i++) {
      const picked = rng.pick(arr)
      expect(arr).toContain(picked)
    }
  })

  it('state save and restore produces identical sequence', () => {
    const rng = createRng(42)
    const saved = rng.state()

    const firstBatch: number[] = []
    for (let i = 0; i < 10; i++) {
      firstBatch.push(rng.next())
    }

    const restored = createRng(0).restore(saved)
    const secondBatch: number[] = []
    for (let i = 0; i < 10; i++) {
      secondBatch.push(restored.next())
    }

    expect(firstBatch).toEqual(secondBatch)
  })

  it('restore returns the rng instance', () => {
    const rng = createRng(42)
    rng.next()
    const saved = rng.state()
    const returned = rng.restore(saved)
    expect(returned).toBe(rng)
  })

  it('state returns a 4-byte Uint8Array', () => {
    const rng = createRng(42)
    const s = rng.state()
    expect(s).toBeInstanceOf(Uint8Array)
    expect(s.length).toBe(4)
  })
})
