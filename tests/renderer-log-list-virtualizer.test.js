'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createLogListVirtualizer } = require('../renderer/shell/renderer-log-list-virtualizer');

// Stubbed IntersectionObserver + synthetic DOM (jsdom-free). The virtualizer
// only touches a small contract surface on these fakes.

function makeRow(id, height) {
  const attrs = new Map([
    ['class', 'log-entry log-entry-info'],
    ['data-log-index', id],
    ['tabindex', '-1'],
  ]);
  const style = { minHeight: '' };
  const row = {
    _height: height,
    isConnected: true,
    innerHTML: `<div class="log-entry-row">row ${id}</div>`,
    style,
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    hasAttribute(name) { return attrs.has(name); },
    removeAttribute(name) { attrs.delete(name); },
    contains(node) { return node === row; },
    querySelector() { return null; },
    getBoundingClientRect() { return { height: row._height, top: 0, bottom: row._height, left: 0, right: 100, width: 100 }; },
  };
  return row;
}

function makeEnv(rows) {
  const listAttrs = new Map();
  const logList = {
    _rows: rows,
    parentElement: { _scroll: true },
    querySelectorAll(selector) {
      return selector === '.log-entry[data-log-index]' ? logList._rows.slice() : [];
    },
    querySelector(selector) {
      const m = /\[data-log-index="(.*)"\]/.exec(selector);
      if (!m) return null;
      return logList._rows.find((r) => r.getAttribute('data-log-index') === m[1]) || null;
    },
    closest() { return null; },
    setAttribute(name, value) { listAttrs.set(name, String(value)); },
    getAttribute(name) { return listAttrs.has(name) ? listAttrs.get(name) : null; },
    removeAttribute(name) { listAttrs.delete(name); },
  };
  const observers = [];
  class FakeIO {
    constructor(cb, options) { this.cb = cb; this.options = options || {}; this.observed = new Set(); this.disconnected = false; observers.push(this); }
    observe(t) { this.observed.add(t); }
    unobserve(t) { this.observed.delete(t); }
    disconnect() { this.disconnected = true; this.observed.clear(); }
    _fire(records) { if (!this.disconnected) this.cb(records); }
  }
  const win = {
    IntersectionObserver: FakeIO,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (h) => clearTimeout(h),
  };
  const doc = { activeElement: null };
  return { logList, observers, win, doc, listAttrs };
}

function build(rows, threshold) {
  const env = makeEnv(rows);
  const v = createLogListVirtualizer({
    logList: env.logList,
    scrollContainer: env.logList.parentElement,
    document: env.doc,
    window: env.win,
    threshold: typeof threshold === 'number' ? threshold : 2,
  });
  return { v, env };
}

test('below threshold: no observer, not engaged, no marker', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100)];
  const { v, env } = build(rows, 5);
  v.rebuild();
  assert.equal(v._internals.hasObserver(), false);
  assert.equal(v._internals.isEngaged(), false);
  assert.equal(env.logList.getAttribute('data-logs-virtualized'), null);
});

test('at/above threshold: builds observer, observes every row, engages + marks list', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  v.rebuild();
  assert.equal(v._internals.hasObserver(), true);
  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].observed.size, 3);
  assert.equal(v._internals.isEngaged(), true);
  assert.equal(env.logList.getAttribute('data-logs-virtualized'), 'true');
});

test('off-screen row collapses to a sized placeholder; re-entry restores it', () => {
  const rows = [makeRow('a', 120), makeRow('b', 120), makeRow('c', 120)];
  const { v, env } = build(rows, 2);
  v.rebuild();
  const io = env.observers[0];

  io._fire([{ target: rows[0], isIntersecting: false }]);
  assert.equal(v._internals.isVirtualized(rows[0]), true);
  assert.match(rows[0].innerHTML, /log-entry-virtualized/);
  assert.equal(rows[0].getAttribute('data-virtualized'), 'true');
  assert.equal(rows[0].style.minHeight, '120px');
  assert.equal(v._internals.getHeightCache().get('a'), 120);

  io._fire([{ target: rows[0], isIntersecting: true }]);
  assert.equal(v._internals.isVirtualized(rows[0]), false);
  assert.match(rows[0].innerHTML, /log-entry-row/);
  assert.equal(rows[0].getAttribute('data-virtualized'), null);
});

test('the focused row is pinned and never unmounts', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  env.doc.activeElement = rows[1];
  v.rebuild();
  env.observers[0]._fire([{ target: rows[1], isIntersecting: false }]);
  assert.equal(v._internals.isVirtualized(rows[1]), false, 'focused row stays mounted');
});

test('the selected row is pinned even when focus has moved elsewhere', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  rows[1].setAttribute('aria-selected', 'true');
  v.rebuild();
  env.observers[0]._fire([{ target: rows[1], isIntersecting: false }]);
  assert.equal(v._internals.isVirtualized(rows[1]), false, 'selected row stays mounted');
});

test('ensureMounted / ensureMountedForId restore an off-screen row synchronously', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  v.rebuild();
  const io = env.observers[0];

  io._fire([{ target: rows[0], isIntersecting: false }]);
  assert.equal(v.ensureMounted(rows[0]), true);
  assert.equal(v._internals.isVirtualized(rows[0]), false);

  io._fire([{ target: rows[1], isIntersecting: false }]);
  assert.equal(v.ensureMountedForId('b'), true);
  assert.equal(v._internals.isVirtualized(rows[1]), false);
  assert.equal(v.ensureMountedForId('nope'), false);
});

test('pause remounts everything + disconnects; resume re-engages', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  v.rebuild();
  env.observers[0]._fire([{ target: rows[0], isIntersecting: false }]);
  assert.equal(v._internals.isVirtualized(rows[0]), true);

  v.pause('search');
  assert.equal(v._internals.isVirtualized(rows[0]), false, 'pause remounts');
  assert.equal(v._internals.hasObserver(), false, 'pause disconnects the observer');
  assert.ok(v._internals.getPausedReasons().has('search'));

  // A rebuild while paused must not re-engage.
  v.rebuild();
  assert.equal(v._internals.hasObserver(), false);

  v.resume('search');
  assert.equal(v._internals.hasObserver(), true, 'resume re-engages');
});

test('dispose disconnects, drops the marker, and short-circuits rebuild', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const { v, env } = build(rows, 2);
  v.rebuild();
  v.dispose();
  assert.equal(v._internals.hasObserver(), false);
  assert.equal(env.logList.getAttribute('data-logs-virtualized'), null);
  v.rebuild();
  assert.equal(v._internals.hasObserver(), false, 'rebuild is inert after dispose');
});

test('height cache evicts in LRU order at the cap', () => {
  const rows = [makeRow('a', 100), makeRow('b', 100), makeRow('c', 100)];
  const env = makeEnv(rows);
  const v = createLogListVirtualizer({
    logList: env.logList,
    document: env.doc,
    window: env.win,
    threshold: 2,
    heightCacheCap: 2,
  });
  v.rebuild();
  const io = env.observers[0];
  io._fire([{ target: rows[0], isIntersecting: false }]);
  io._fire([{ target: rows[1], isIntersecting: false }]);
  io._fire([{ target: rows[2], isIntersecting: false }]);
  const cache = v._internals.getHeightCache();
  assert.equal(cache.size, 2);
  assert.equal(cache.has('a'), false, 'oldest evicted');
  assert.equal(cache.has('c'), true, 'newest retained');
});
