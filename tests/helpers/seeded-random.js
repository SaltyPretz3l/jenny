'use strict';

// A small seeded generator (mulberry32) for fuzz tests, so a failure can be replayed from its seed.
// Returns a function giving numbers in [0, 1).

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { seededRandom };
