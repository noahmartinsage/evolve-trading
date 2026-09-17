export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Rng {
  next(): number
  norm(): number
}

export function makeRng(seed: number): Rng {
  const base = mulberry32(seed)
  let spare: number | null = null
  return {
    next: () => base(),
    norm(): number {
      if (spare !== null) {
        const s = spare
        spare = null
        return s
      }
      let u: number
      do {
        u = base()
      } while (u <= Number.EPSILON)
      const v = base()
      const mag = Math.sqrt(-2 * Math.log(u))
      spare = mag * Math.sin(2 * Math.PI * v)
      return mag * Math.cos(2 * Math.PI * v)
    },
  }
}
