export interface Rng {
  next(): number
  int(min: number, max: number): number
  pick<T>(arr: T[]): T
  state(): Uint8Array
  restore(s: Uint8Array): Rng
}

/**
 * Mulberry32 PRNG — 32-bit, deterministic, serializable.
 *
 * @param seed - Initial seed value.
 * @returns An Rng instance with the given seed.
 */
export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const rng = {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0
      let t = state
      t = (t ^ (t >>> 15)) * (t | 1)
      t = (t ^ (t >>> 7)) * (t | 61) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },

    int(min: number, max: number): number {
      return Math.floor(rng.next() * (max - min + 1)) + min
    },

    pick<T>(arr: T[]): T {
      return arr[rng.int(0, arr.length - 1)]
    },

    state(): Uint8Array {
      const buf = new Uint8Array(4)
      new DataView(buf.buffer).setUint32(0, state, true)
      return buf
    },

    restore(s: Uint8Array): Rng {
      state = new DataView(s.buffer).getUint32(0, true)
      return rng
    },
  }

  return rng
}
