'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTimelineVirtualizer,
} = require('../renderer/chat/renderer-chat-timeline-virtualizer');
const {
  buildEnvironment,
  bulkEntries,
  makeChatTimeline,
  makeFakeDocument,
  makeRoot,
} = require('./helpers/renderer-chat-timeline-virtualizer-helpers');

test('render strategies are mutually exclusive across the feature-flag matrix', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const cases = [
    { count: 81, boundsEnabled: true, contentVisibilityEnabled: true, expected: 'dom-window' },
    { count: 80, boundsEnabled: true, contentVisibilityEnabled: true, expected: 'content-visibility' },
    { count: 81, boundsEnabled: false, contentVisibilityEnabled: true, expected: 'content-visibility' },
    { count: 81, boundsEnabled: false, contentVisibilityEnabled: false, expected: 'none' },
  ];
  for (const scenario of cases) {
    const v = createTimelineVirtualizer({
      chatTimeline: makeChatTimeline(bulkEntries(scenario.count)),
      document: makeFakeDocument(),
      boundsEnabled: scenario.boundsEnabled,
      contentVisibilityEnabled: scenario.contentVisibilityEnabled,
    });
    v.rebuild();
    assert.equal(v._internals.getStrategy(), scenario.expected, JSON.stringify(scenario));
    v.dispose();
  }
});

test('missing IntersectionObserver remounts retained rows and degrades to fully mounted', (t) => {
  const previousIO = global.IntersectionObserver;
  global.IntersectionObserver = undefined;
  t.after(() => { global.IntersectionObserver = previousIO; });
  const logs = [];
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: {},
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
  });
  t.after(() => v.dispose());

  v.rebuild();
  assert.equal(v._internals.getStrategy(), 'none');
  assert.equal(v._internals.hasObserver(), false);
  assert.equal(v._internals.getBudgetStats().observerFallbacks, 1);
  assert.deepEqual(logs.at(-1), {
    level: 'WARN',
    event: 'chat.timeline_virtualizer_fallback',
    details: { reason: 'observer_unavailable', articleCount: 100, fallbackCount: 1 },
  });
  assert.equal(entries.some((entry) => entry.getAttribute('data-virtualized') === 'true'), false);
  v.rebuild();
  assert.equal(v._internals.getBudgetStats().observerFallbacks, 1, 'fallback is sticky for this owner');
});

test('IntersectionObserver observe failure remounts rows and degrades to fully mounted', (t) => {
  const previousIO = global.IntersectionObserver;
  class ThrowingIntersectionObserver {
    observe() { throw new Error('synthetic observer failure'); }
    unobserve() {}
    disconnect() {}
  }
  global.IntersectionObserver = ThrowingIntersectionObserver;
  t.after(() => { global.IntersectionObserver = previousIO; });
  const logs = [];
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    appendClientLog(level, event, details) { logs.push({ level, event, details }); },
  });
  t.after(() => v.dispose());

  v.rebuild();

  assert.equal(v._internals.getStrategy(), 'none');
  assert.equal(v._internals.hasObserver(), false);
  assert.equal(v._internals.getBudgetStats().observeFailures, 1);
  assert.equal(v._internals.getBudgetStats().observerFallbacks, 1);
  assert.equal(entries.some((entry) => entry.getAttribute('data-virtualized') === 'true'), false);
  assert.deepEqual(logs.at(-1), {
    level: 'WARN',
    event: 'chat.timeline_virtualizer_fallback',
    details: { reason: 'observe_failed', articleCount: 100, fallbackCount: 1 },
  });
  v.rebuild();
  assert.equal(v._internals.getBudgetStats().observeFailures, 1, 'does not retry a failed observer');
  assert.equal(v._internals.getBudgetStats().observerFallbacks, 1);
});

test('width invalidation keeps bounded placeholders and compensates when each visible row mounts', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const timers = [];
  const resizeObservers = [];
  const chatThreadScroll = { clientWidth: 800 };
  const anchorCalls = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe() {}
    disconnect() {}
  }
  const win = {
    ResizeObserver: FakeResizeObserver,
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
  };
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    chatThreadScroll,
    document: makeFakeDocument(),
    window: win,
    captureReaderAnchor() { anchorCalls.push('capture'); },
    restoreReaderAnchor() { anchorCalls.push('restore'); },
  });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[25], isIntersecting: false }]);
  assert.equal(entries[25].getAttribute('data-virtualized'), 'true');

  anchorCalls.length = 0;
  chatThreadScroll.clientWidth = 640;
  resizeObservers[0].callback();

  assert.equal(entries[25].getAttribute('data-virtualized'), 'true');
  assert.deepEqual(anchorCalls, ['restore']);
  assert.equal(timers.length, 1);
  timers[0]();
  assert.equal(v._internals.getStrategy(), 'dom-window');
  env.observers[1]._fire([{ target: entries[25], isIntersecting: true }]);
  assert.equal(entries[25].getAttribute('data-virtualized'), null);
  assert.deepEqual(anchorCalls, ['restore', 'capture', 'restore']);
});

test('host-change rebuild detects a width epoch even before ResizeObserver delivers', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const timers = [];
  const chatThreadScroll = { clientWidth: 720 };
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    chatThreadScroll,
    document: makeFakeDocument(),
    window: {
      addEventListener() {},
      removeEventListener() {},
      setTimeout(callback) { timers.push(callback); return timers.length; },
      clearTimeout() {},
    },
  });
  t.after(() => v.dispose());
  v.rebuild();
  const firstGeneration = v._internals.getBudgetStats().observerGeneration;

  chatThreadScroll.clientWidth = 360;
  v.rebuild();

  assert.equal(v._internals.getBudgetStats().scheduledLayoutTasks, 1);
  assert.ok(v._internals.getBudgetStats().observerGeneration > firstGeneration);
  timers.shift()();
  assert.equal(v._internals.getStrategy(), 'dom-window');
  assert.equal(v._internals.getBudgetStats().scheduledLayoutTasks, 0);
});

test('placeholder geometry preserves fractional row heights without cumulative rounding', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(100);
  entries[50]._height = 63.375;
  const v = createTimelineVirtualizer({ chatTimeline: makeChatTimeline(entries), document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();

  env.observers[0]._fire([{ target: entries[50], isIntersecting: false }]);

  assert.equal(entries[50].style.minHeight, '63.375px');
});

test('intersection-enter supersedes a deferred leave before it can unmount the row', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const frames = [];
  const win = {
    requestAnimationFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelAnimationFrame() {},
  };
  const entries = bulkEntries(200);
  const target = entries[12];
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: win,
  });
  t.after(() => v.dispose());
  v.rebuild();

  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(frames.length, 1);
  env.observers[0]._fire([{ target, isIntersecting: true }]);
  frames.shift()();

  assert.equal(target.getAttribute('data-virtualized'), null);
  assert.equal(v._internals.getBudgetStats().queueDepth, 0);
  assert.equal(frames.length, 0);
});

test('intersection-enter batches reader-anchor work across restored entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const anchorCalls = [];
  const statsReasons = [];
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    captureReaderAnchor() { anchorCalls.push('capture'); },
    restoreReaderAnchor() { anchorCalls.push('restore'); },
    onStatsChange(_stats, reason) { statsReasons.push(reason); },
  });
  t.after(() => v.dispose());
  v.rebuild();
  const targets = entries.slice(20, 23);
  env.observers[0]._fire(targets.map((target) => ({ target, isIntersecting: false })));
  assert.ok(targets.every((target) => target.getAttribute('data-virtualized') === 'true'));
  anchorCalls.length = 0;
  statsReasons.length = 0;

  env.observers[0]._fire(targets.map((target) => ({ target, isIntersecting: true })));

  assert.ok(targets.every((target) => target.getAttribute('data-virtualized') === null));
  assert.deepEqual(anchorCalls, ['capture', 'restore']);
  assert.deepEqual(statsReasons, ['intersection'], 'the observer publishes one batch result');
});

test('repeated offscreen records do not serialize intact virtualized placeholders', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const target = entries[24];
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
  });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');

  let placeholderHtml = target.innerHTML;
  let htmlReads = 0;
  Object.defineProperty(target, 'innerHTML', {
    configurable: true,
    get() { htmlReads += 1; return placeholderHtml; },
    set(value) { placeholderHtml = value; },
  });
  env.observers[0]._fire([{ target, isIntersecting: false }]);

  assert.equal(htmlReads, 0, 'an intact offscreen placeholder stays on the marker-only fast path');
  Object.defineProperty(target, 'innerHTML', {
    configurable: true,
    writable: true,
    value: placeholderHtml,
  });
});

test('offscreen unmount work is capped at 64 entries per presentation frame', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const frames = new Map();
  let nextFrame = 1;
  const win = {
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) { frames.delete(handle); },
  };
  const entries = bulkEntries(200);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: win,
    requestEntryMarkup(entry) { return `<div>rebuilt-${entry.getAttribute('data-message-id')}</div>`; },
  });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire(entries.map((target) => ({ target, isIntersecting: false })));
  assert.equal(frames.size, 1);

  const [firstHandle, firstFrame] = frames.entries().next().value;
  frames.delete(firstHandle);
  firstFrame(16);
  assert.equal(v._internals.getBudgetStats().materializedArticles, 136);
  assert.equal(v._internals.getBudgetStats().queueDepth, 136);

  let guard = 0;
  while (frames.size && guard < 10) {
    const [handle, callback] = frames.entries().next().value;
    frames.delete(handle);
    callback(32 + guard * 16);
    guard += 1;
  }
  assert.equal(v._internals.getBudgetStats().queueDepth, 0);
  assert.equal(v._internals.getBudgetStats().normalMaterializedArticles, 0);
});

test('dispose cancels queued unmount work and all later public calls are inert', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const frames = new Map();
  let nextFrame = 1;
  const win = {
    requestAnimationFrame(callback) {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) { frames.delete(handle); },
  };
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: win,
  });
  v.rebuild();
  env.observers[0]._fire(entries.map((target) => ({ target, isIntersecting: false })));
  assert.equal(frames.size, 1);
  v.dispose();
  assert.equal(frames.size, 0);
  const statsAfterDispose = JSON.stringify(v._internals.getBudgetStats());
  v.rebuild();
  v.refreshScope(makeRoot({ messageId: 'ignored' }));
  v._internals.processUnmountQueue();
  assert.equal(JSON.stringify(v._internals.getBudgetStats()), statsAfterDispose);
  assert.equal(entries.some((entry) => entry.getAttribute('data-virtualized') === 'true'), false);
});

test('reconstruction recovery coalesces a burst but rearms after the completed canonical render', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const frames = new Map();
  let nextFrame = 1;
  let rerenders = 0;
  const win = {
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) { frames.delete(handle); },
  };
  const entries = bulkEntries(164);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: win,
    requestEntryMarkup() { throw new Error('synthetic reconstruction failure'); },
    requestCanonicalRerender() { rerenders += 1; },
  });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire(entries.map((target) => ({ target, isIntersecting: false })));
  while (v._internals.getBudgetStats().queueDepth > 0) {
    const [handle, callback] = frames.entries().next().value;
    frames.delete(handle);
    callback(16);
  }

  env.observers[0]._fire([
    { target: entries[0], isIntersecting: true },
    { target: entries[1], isIntersecting: true },
  ]);
  assert.equal(frames.size, 1, 'same-burst failures share one recovery frame');
  let [handle, callback] = frames.entries().next().value;
  frames.delete(handle);
  callback(32);
  assert.equal(rerenders, 1);

  env.observers[0]._fire([{ target: entries[2], isIntersecting: true }]);
  assert.equal(frames.size, 1, 'later failure can request a fresh repair');
  [handle, callback] = frames.entries().next().value;
  frames.delete(handle);
  callback(48);
  assert.equal(rerenders, 2);
});

for (const articleCount of [500, 1000, 5000]) {
  test(`${articleCount}-row corpus settles at the 160 normal-materialized target`, (t) => {
    const env = buildEnvironment();
    t.after(() => env.restore());
    const frames = new Map();
    let nextFrame = 1;
    const win = {
      performance: { now: () => 0 },
      requestAnimationFrame(callback) {
        const handle = nextFrame++;
        frames.set(handle, callback);
        return handle;
      },
      cancelAnimationFrame(handle) { frames.delete(handle); },
    };
    const entries = bulkEntries(articleCount, { height: 150 });
    const v = createTimelineVirtualizer({
      chatTimeline: makeChatTimeline(entries),
      document: makeFakeDocument(),
      window: win,
      requestEntryMarkup(entry) {
        return `<div>canonical-${entry.getAttribute('data-message-id')}</div>`;
      },
    });
    t.after(() => v.dispose());
    v.rebuild();
    env.observers[0]._fire(entries.map((target, index) => ({
      target,
      isIntersecting: index < 160,
    })));

    let frameCount = 0;
    while (frames.size && frameCount < 100) {
      const [handle, callback] = frames.entries().next().value;
      frames.delete(handle);
      callback((frameCount + 1) * 16);
      frameCount += 1;
    }
    const stats = v._internals.getBudgetStats();
    assert.equal(stats.queueDepth, 0);
    assert.equal(stats.normalMaterializedArticles, 160);
    assert.ok(stats.serializedMarkupEntries <= stats.serializedMarkupCap);
    assert.ok(frameCount <= Math.ceil((articleCount - 160) / 64));
  });
}
