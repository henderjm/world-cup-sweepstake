// Tiny deterministic PRNG helpers shared by every seeded-but-reproducible demo
// derivation (score generation, injuries, form). Pulled out of fantasyDemo.js
// once a second module (fantasyDemoPlayerState.js) needed the same primitives,
// rather than duplicating an RNG in two places - exactly the kind of
// implementation-detail drift that has to stay identical for "same seed, same
// season" to hold as new demo features layer on top of the score generator.

// FNV-1a style string hash, folded into a 32-bit unsigned int: gives an
// independent-looking seed per (seed, ...parts) tuple without needing to carry
// sequential RNG state between calls, so any single draw can be recomputed in
// isolation (and unit-tested) from its own inputs alone.
export function hashSeed(...parts) {
  let hash = 2166136261 >>> 0;
  const str = parts.join(":");
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

// mulberry32: a small, fast, deterministic PRNG. Same seed in, same sequence
// of floats in [0, 1) out, every time, on any JS engine - the property the
// "a given seed replays identically" requirement depends on.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
