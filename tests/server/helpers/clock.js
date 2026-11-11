'use strict';

// An injected test clock: a function that returns the current time in ms, with
// advance(ms) and set(value).

function createClock(start = 1_800_000_000_000) {
  let now = start;
  const clock = () => now;
  clock.advance = (ms) => { now += ms; };
  clock.set = (value) => { now = value; };
  return clock;
}

module.exports = { createClock };
