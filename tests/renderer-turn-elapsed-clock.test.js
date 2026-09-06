const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTurnElapsedClock,
  formatElapsedLabel,
} = require('../renderer/chat/renderer-turn-elapsed-clock');

const SELECTOR = '[data-turn-elapsed][data-elapsed-started-at]';

function createFakeNode(startedAt) {
  const attrs = new Map([['data-turn-elapsed', 'true']]);
  if (startedAt !== undefined) {
    attrs.set('data-elapsed-started-at', String(startedAt));
  }
  let text = '';
  let writes = 0;
  return {
    get textContent() { return text; },
    set textContent(value) { text = String(value); writes += 1; },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    removeAttribute(name) { attrs.delete(name); },
    hasAttribute(name) { return attrs.has(name); },
    get writes() { return writes; },
  };
}

function createFakeRoot(nodes) {
  return {
    querySelectorAll(selector) {
      if (selector !== SELECTOR) return [];
      return nodes.filter((node) =>
        node.hasAttribute('data-turn-elapsed')
        && node.hasAttribute('data-elapsed-started-at'));
    },
  };
}

function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  return {
    intervals,
    setInterval(callback, ms) {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    advance() {
      for (const entry of Array.from(intervals.values())) {
        entry.callback();
      }
    },
  };
}

test('formatElapsedLabel uses M:SS and H:MM:SS labels', () => {
  assert.equal(formatElapsedLabel(7000), '0:07');
  assert.equal(formatElapsedLabel(62000), '1:02');
  assert.equal(formatElapsedLabel(3729000), '1:02:09');
  assert.equal(formatElapsedLabel(-1), '');
});

test('running node paints on sync and updates on each 1-second tick', () => {
  const node = createFakeNode(1000);
  const timers = createFakeTimers();
  let now = 8000;
  const clock = createTurnElapsedClock({
    getRoot: () => createFakeRoot([node]),
    getNow: () => now,
    timers,
  });

  clock.sync();
  assert.equal(node.textContent, '0:07');
  assert.equal(clock.isRunning(), true);
  assert.equal(timers.intervals.values().next().value.ms, 1000);

  now = 9000;
  timers.advance();
  assert.equal(node.textContent, '0:08');
});

test('node without its own finite anchor is skipped', () => {
  const missing = createFakeNode();
  const malformed = createFakeNode('not-a-time');
  const root = { querySelectorAll: () => [missing, malformed] };
  const clock = createTurnElapsedClock({
    getRoot: () => root,
    getNow: () => 9000,
    timers: createFakeTimers(),
  });

  clock.sync();
  assert.equal(missing.textContent, '');
  assert.equal(malformed.textContent, '');
  assert.equal(missing.writes, 0);
  assert.equal(malformed.writes, 0);
  clock.stop();
});

test('unchanged labels do not churn textContent', () => {
  const node = createFakeNode(1000);
  const timers = createFakeTimers();
  let now = 8100;
  const clock = createTurnElapsedClock({
    getRoot: () => createFakeRoot([node]),
    getNow: () => now,
    timers,
  });

  clock.sync();
  assert.equal(node.writes, 1);
  now = 8900;
  timers.advance();
  assert.equal(node.textContent, '0:07');
  assert.equal(node.writes, 1);
  clock.stop();
});

test('a settled stripped node no longer matches and the interval stops', () => {
  const node = createFakeNode(1000);
  const timers = createFakeTimers();
  const root = createFakeRoot([node]);
  const clock = createTurnElapsedClock({
    getRoot: () => root,
    getNow: () => 5000,
    timers,
  });

  clock.sync();
  node.removeAttribute('data-turn-elapsed');
  node.removeAttribute('data-elapsed-started-at');
  timers.advance();

  assert.equal(clock.isRunning(), false);
  assert.equal(timers.intervals.size, 0);
  assert.equal(node.textContent, '0:04');
});

test('null root is a no-op and never starts an interval', () => {
  const timers = createFakeTimers();
  const clock = createTurnElapsedClock({ getRoot: () => null, timers });

  assert.doesNotThrow(() => clock.sync());
  assert.doesNotThrow(() => clock.stop());
  assert.equal(clock.isRunning(), false);
  assert.equal(timers.intervals.size, 0);
});
