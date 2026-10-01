// Mulberry32 deterministic 32-bit PRNG step function.
// Referentially transparent: returns [pseudoRandomFloat, nextSeedState].

export function prngStep(seed) {
  const a = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, a];
}

export function createPrng(seed) {
  let s = seed | 0;
  return function next() {
    const [v, nextSeed] = prngStep(s);
    s = nextSeed;
    return v;
  };
}
