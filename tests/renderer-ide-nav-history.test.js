'use strict';

/* Unit tests for the Workspace IDE cursor navigation history
 * (renderer-ide-nav-history): record -> back -> forward semantics, forward-stack
 * truncation on a new jump after back, the bounded oldest-drop, coalescing of
 * same-location / small same-file moves, big-leap recording, the re-entrancy
 * guard, and pruneClosed dropping closed paths. Pure module - no DOM. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeNavHistory } = require('../renderer/features/renderer-ide-nav-history');

// Builds a nav history whose reveal records every (path, line, col) it walks to.
function build(overrides) {
  const reveals = [];
  const nav = createIdeNavHistory({
    reveal: (path, line, col) => { reveals.push({ path, line, col }); },
    ...overrides,
  });
  return { nav, reveals, last: () => reveals[reveals.length - 1] || null };
}

test('records cross-file jumps and walks back then forward', () => {
  const { nav, reveals, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'b.js', line: 1, col: 1 });
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 });

  // At the oldest entry, Back is a no-op (no further reveal).
  assert.equal(nav.back(), false);
  assert.equal(reveals.length, 2);

  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'b.js', line: 1, col: 1 });
  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'c.js', line: 1, col: 1 });

  // At the newest entry, Forward is a no-op.
  assert.equal(nav.forward(), false);
  assert.equal(reveals.length, 4);
});

test('back/forward are no-ops on an empty history', () => {
  const { nav, reveals } = build();
  assert.equal(nav.back(), false);
  assert.equal(nav.forward(), false);
  assert.equal(reveals.length, 0);
});

test('a new jump after going back truncates the forward stack', () => {
  const { nav, reveals, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  nav.back(); // -> b
  nav.back(); // -> a (index now at oldest)
  reveals.length = 0;

  // New jump from 'a' drops the forward stack (b, c are gone).
  nav.recordNavigation('d.js', 1, 1);

  assert.equal(nav.forward(), false, 'no forward stack after a fresh jump');
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 });
  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'd.js', line: 1, col: 1 });
  assert.equal(nav.forward(), false);
});

test('coalesces same-location and small same-file moves into one entry', () => {
  const { nav, reveals, last } = build(); // default minLineDelta = 10
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('a.js', 1, 1); // exact dup
  nav.recordNavigation('a.js', 4, 7); // small delta (3 < 10) -> coalesced
  nav.recordNavigation('b.js', 1, 1);

  // Only two entries exist (a, b); Back lands on the coalesced 'a' with the
  // last-seen line/column, not the original.
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 4, col: 7 });
  assert.equal(nav.back(), false, 'the dup + small move did not add entries');
  assert.equal(reveals.length, 1);
});

test('records a big same-file leap as a distinct entry', () => {
  const { nav, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('a.js', 50, 1); // delta 49 >= 10 -> a real jump

  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 });
  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 50, col: 1 });
});

test('bounds the stack and drops the oldest entry', () => {
  const { nav, last } = build({ limit: 3 });
  for (let i = 0; i < 5; i += 1) {
    nav.recordNavigation(`f${i}.js`, 1, 1);
  }
  // Only the newest 3 survive (f2, f3, f4).
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'f3.js', line: 1, col: 1 });
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'f2.js', line: 1, col: 1 });
  assert.equal(nav.back(), false, 'f0/f1 were dropped by the cap');
});

test('pruneClosed drops entries whose file is no longer open', () => {
  const { nav, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  // 'b' closed; current entry 'c' survives so the index re-points to it.
  nav.pruneClosed(['a.js', 'c.js']);
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 }, 'b is skipped');
  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'c.js', line: 1, col: 1 });
});

test('pruneClosed clamps the index when the current entry is removed', () => {
  const { nav, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1); // current = c

  nav.pruneClosed(['a.js', 'b.js']); // c removed -> clamp onto b
  assert.equal(nav.forward(), false, 'nothing forward of the clamped current');
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 });
  assert.equal(nav.forward(), true);
  assert.deepEqual(last(), { path: 'b.js', line: 1, col: 1 });
});

test('pruneClosed to empty resets, and recording resumes cleanly', () => {
  const { nav, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.pruneClosed([]);
  assert.equal(nav.back(), false);
  assert.equal(nav.forward(), false);

  nav.recordNavigation('d.js', 9, 2);
  nav.recordNavigation('e.js', 1, 1);
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'd.js', line: 9, col: 2 });
});

test('pruneClosed accepts a Set of open paths', () => {
  const { nav, last } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.pruneClosed(new Set(['a.js']));
  assert.equal(nav.back(), false, 'only a survives; index clamps onto it');
  // Recording forward of a still works.
  nav.recordNavigation('c.js', 1, 1);
  assert.equal(nav.back(), true);
  assert.deepEqual(last(), { path: 'a.js', line: 1, col: 1 });
});

test('a reveal-triggered record during back/forward is suppressed (no stack corruption)', () => {
  const reveals = [];
  let nav;
  // Simulates the real wiring: reveal moves the caret, which would re-enter
  // recordNavigation via onCursorActivity. The guard must drop that record.
  nav = createIdeNavHistory({
    reveal: (path, line, col) => {
      reveals.push({ path, line, col });
      nav.recordNavigation(path, line + 100, 1); // a "cursor move" from the reveal
    },
  });
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  nav.back(); // -> b ; the re-entrant record must NOT truncate the forward stack
  assert.deepEqual(reveals[reveals.length - 1], { path: 'b.js', line: 1, col: 1 });
  // Forward still reaches c (proof the re-entrant record was ignored).
  assert.equal(nav.forward(), true);
  assert.deepEqual(reveals[reveals.length - 1], { path: 'c.js', line: 1, col: 1 });
});

test('an async reveal holds the guard until it settles', async () => {
  let resolveReveal;
  let nav;
  const reveals = [];
  // The real wiring's reveal (handleSearchResultOpen) is async: it opens the
  // file then positions the caret. The guard must stay up across that tail.
  nav = createIdeNavHistory({
    reveal: (path, line, col) => {
      reveals.push({ path, line, col });
      nav.recordNavigation(path, line + 100, 1); // synchronous re-entrant move
      return new Promise((resolve) => { resolveReveal = resolve; });
    },
  });
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  nav.back(); // async reveal -> b
  nav.recordNavigation('z.js', 1, 1); // arrives while reveal pending -> dropped
  resolveReveal();
  await Promise.resolve(); // let .then(release) run

  assert.equal(nav.forward(), true, 'forward stack intact across the async reveal');
  assert.deepEqual(reveals[reveals.length - 1], { path: 'c.js', line: 1, col: 1 });
});

test('overlapping async reveals keep recording blocked until both settle', async () => {
  const pending = [];
  const nav = createIdeNavHistory({
    reveal: () => new Promise((resolve) => { pending.push(resolve); }),
  });
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.recordNavigation('c.js', 1, 1);

  assert.equal(nav.back(), true);
  assert.equal(nav.back(), true);
  pending[0]();
  await Promise.resolve();
  nav.recordNavigation('z.js', 1, 1);
  pending[1]();
  await Promise.resolve();

  assert.equal(nav.forward(), true, 'the pending second reveal prevented z.js from truncating history');
});

test('clear() empties the history', () => {
  const { nav } = build();
  nav.recordNavigation('a.js', 1, 1);
  nav.recordNavigation('b.js', 1, 1);
  nav.clear();
  assert.equal(nav.back(), false);
  assert.equal(nav.forward(), false);
});

test('the factory exposes exactly the documented surface', () => {
  const { nav } = build();
  assert.deepEqual(
    Object.keys(nav).sort(),
    ['back', 'clear', 'forward', 'pruneClosed', 'recordNavigation']
  );
});
