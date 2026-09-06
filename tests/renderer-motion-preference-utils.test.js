// UIUX-030: single motion-aware scroll-behavior gate. This is the one shared
// helper every programmatic-scroll call site (palette, workspace rail, logs,
// observability, calendar) must call so 'auto' (instant) is returned whenever
// EITHER an already-live reducedMotionQuery-shaped object says reduce OR a
// fresh OS prefers-reduced-motion query says reduce.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  prefersReducedMotion,
  resolveScrollBehavior,
} = require('../renderer/shared/renderer-motion-preference-utils');

function fakeWindow(matches) {
  return {
    matchMedia(query) {
      assert.equal(query, '(prefers-reduced-motion: reduce)');
      return { matches };
    },
  };
}

test('prefersReducedMotion reads the OS media query', () => {
  assert.equal(prefersReducedMotion(fakeWindow(true)), true);
  assert.equal(prefersReducedMotion(fakeWindow(false)), false);
});

test('prefersReducedMotion is false with no window / no matchMedia (Node, jsdom without a stub)', () => {
  assert.equal(prefersReducedMotion(null), false);
  assert.equal(prefersReducedMotion({}), false);
});

test('prefersReducedMotion swallows a throwing matchMedia and returns false', () => {
  const win = { matchMedia() { throw new Error('boom'); } };
  assert.equal(prefersReducedMotion(win), false);
});

test('resolveScrollBehavior returns smooth when neither signal requests reduced motion', () => {
  assert.equal(resolveScrollBehavior({ matches: false }, fakeWindow(false)), 'smooth');
  assert.equal(resolveScrollBehavior(null, fakeWindow(false)), 'smooth');
  assert.equal(resolveScrollBehavior(undefined, null), 'smooth');
});

test('resolveScrollBehavior returns auto when the live reducedMotionQuery says reduce', () => {
  assert.equal(resolveScrollBehavior({ matches: true }, fakeWindow(false)), 'auto');
});

test('resolveScrollBehavior returns auto when only the OS query says reduce (no live query passed)', () => {
  assert.equal(resolveScrollBehavior(null, fakeWindow(true)), 'auto');
  assert.equal(resolveScrollBehavior(undefined, fakeWindow(true)), 'auto');
});

test('resolveScrollBehavior treats a falsy/absent reducedMotionQuery.matches as not-reduced on its own', () => {
  assert.equal(resolveScrollBehavior({ matches: false }, fakeWindow(true)), 'auto', 'OS signal still wins');
  assert.equal(resolveScrollBehavior({}, fakeWindow(false)), 'smooth');
});
