const test = require('node:test');
const assert = require('node:assert/strict');

const { createTimelineVirtualizer } = require('../renderer/chat/renderer-chat-timeline-virtualizer');

const {
  buildEnvironment,
  bulkEntries,
  makeArticle,
  makeChatTimeline,
  makeFakeDocument,
  makeRoot,
} = require('./helpers/renderer-chat-timeline-virtualizer-helpers');
// ---- Tests -----------------------------------------------------------------

test('rebuild does not create observer below threshold', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(50);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  assert.equal(env.observers.length, 0, 'no observer should be constructed below threshold');
  assert.equal(v._internals.hasObserver(), false);
});

test('rebuild constructs observer above threshold and observes every entry', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].observed.size, 200);
  assert.equal(env.observers[0].options.rootMargin, '12000px 0px', 'density-derived margin is capped');
});

test('intersection-leave virtualizes entry into placeholder; mount restores', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  const target = entries[42];
  const originalInner = target.innerHTML;
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');
  assert.match(target.innerHTML, /chat-entry-virtualized/);
  assert.equal(target.style.minHeight, '400px');
  assert.equal(target.getAttribute('aria-hidden'), null, 'semantic placeholder stays in the accessibility tree');
  assert.equal(target.getAttribute('tabindex'), '-1');
  // Pinned attributes preserved
  assert.equal(target.getAttribute('data-message-id'), 'm42');
  // bulkEntries alternates roles (even = user, odd = assistant); m42 is user.
  assert.equal(target.getAttribute('aria-label'), 'Your message', 'accessible name remains stable');
  assert.match(target.innerHTML, /data-virtualized-summary="true"/);
  // Mount restores
  env.observers[0]._fire([{ target, isIntersecting: true }]);
  assert.equal(target.getAttribute('data-virtualized'), null);
  assert.equal(target.getAttribute('aria-hidden'), null);
  assert.equal(target.style.minHeight, '');
  assert.equal(target.innerHTML, originalInner);
});

test('intersection-enter restores a queued entry immediately without a mount-frame delay', (t) => {
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
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument(), window: win });
  t.after(() => v.dispose());
  v.rebuild();
  const target = entries[12];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(frames.length, 1, 'offscreen removal is queued to one presentation frame');
  frames.shift()();
  assert.equal(target.getAttribute('data-virtualized'), 'true');
  target._measureCount = 0;

  env.observers[0]._fire([{ target, isIntersecting: true }]);

  assert.equal(target.getAttribute('data-virtualized'), null);
  assert.equal(target._measureCount, 0, 'mount batch must not read layout');
  assert.equal(frames.length, 0, 'visible mount must not schedule a deferred frame');
});

test('virtualized row and tool-call indexes can synchronously remount matching entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  entries[33] = makeArticle({
    messageId: 'm33',
    rowIds: ['row-33'],
    toolCallIds: ['call-33'],
    innerHtml: '<div class="chat-row" data-row-id="row-33" data-tool-call-id="call-33">tool</div>',
  });
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();

  env.observers[0]._fire([{ target: entries[33], isIntersecting: false }]);
  assert.equal(entries[33].getAttribute('data-virtualized'), 'true');

  assert.equal(v.ensureMountedForRowId('row-33'), true);
  assert.equal(entries[33].getAttribute('data-virtualized'), null);

  env.observers[0]._fire([{ target: entries[33], isIntersecting: false }]);
  assert.equal(v.ensureMountedForToolCallId('call-33'), true);
  assert.equal(entries[33].getAttribute('data-virtualized'), null);
});

test('virtualized row and tool-call indexes prune detached entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  entries[34] = makeArticle({
    messageId: 'm34',
    rowIds: ['row-34'],
    toolCallIds: ['call-34'],
    innerHtml: '<div class="chat-row" data-row-id="row-34" data-tool-call-id="call-34">tool</div>',
  });
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();

  env.observers[0]._fire([{ target: entries[34], isIntersecting: false }]);
  assert.equal(entries[34].getAttribute('data-virtualized'), 'true');
  assert.deepEqual(v._internals.getVirtualIndexSizes(), { rows: 1, tools: 1 });
  entries[34].isConnected = false;

  v.rebuild();
  assert.deepEqual(v._internals.getVirtualIndexSizes(), { rows: 0, tools: 0 });

  assert.equal(v.ensureMountedForRowId('row-34'), false);
  assert.equal(v.ensureMountedForToolCallId('call-34'), false);
  assert.equal(entries[34].getAttribute('data-virtualized'), 'true');
});

test('viewport resize rebuilds observation after debounce', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const timers = [];
  const listeners = new Map();
  const win = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) {
      if (listeners.get(type) === handler) listeners.delete(type);
    },
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout() {},
  };
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument(), window: win });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[9], isIntersecting: false }]);
  assert.equal(entries[9].getAttribute('data-virtualized'), 'true');

  listeners.get('resize')();
  assert.equal(timers.length, 1);
  timers[0]();

  assert.equal(env.observers.length, 2, 'resize rebuilds a fresh observer');
});

test('streaming-row pin: an article containing .chat-bubble-streaming never unmounts', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  entries[10].innerHTML = '<div class="chat-bubble-streaming">…</div>';
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[10], isIntersecting: false }]);
  assert.equal(entries[10].getAttribute('data-virtualized'), null);
  assert.match(entries[10].innerHTML, /chat-bubble-streaming/);
});

test('active-turn-root pin: entries inside the active root never unmount', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  // Wire entries[5] into a thread-root with id "active-turn"
  const root = makeRoot({ messageId: 'active-turn' });
  root._children.push(entries[5]);
  entries[5]._parent = root;
  const chatTimeline = makeChatTimeline(entries);
  let activeId = '';
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    getActiveTurnRootMessageId: () => activeId,
  });
  t.after(() => v.dispose());
  v.rebuild();
  // First, with no active id set — should unmount normally.
  env.observers[0]._fire([{ target: entries[5], isIntersecting: false }]);
  assert.equal(entries[5].getAttribute('data-virtualized'), 'true', 'unmounts when not pinned');
  // Restore and set active id; second leave should be pinned.
  env.observers[0]._fire([{ target: entries[5], isIntersecting: true }]);
  activeId = 'active-turn';
  env.observers[0]._fire([{ target: entries[5], isIntersecting: false }]);
  assert.equal(entries[5].getAttribute('data-virtualized'), null, 'pin while active turn matches');
});

test('focused-entry pin: an entry containing document.activeElement never unmounts', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const doc = makeFakeDocument();
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: doc });
  t.after(() => v.dispose());
  v.rebuild();
  doc.activeElement = entries[7];
  env.observers[0]._fire([{ target: entries[7], isIntersecting: false }]);
  assert.equal(entries[7].getAttribute('data-virtualized'), null);
});

test('ensureMounted restores a virtualized entry synchronously', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[15], isIntersecting: false }]);
  assert.equal(entries[15].getAttribute('data-virtualized'), 'true');
  v.ensureMounted(entries[15]);
  assert.equal(entries[15].getAttribute('data-virtualized'), null);
  assert.match(entries[15].innerHTML, /payload-15/);
});

test('refreshScope re-observes only entries inside the scoped root', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const root = makeRoot({ messageId: 'turn-x' });
  root._children.push(entries[10], entries[11], entries[12]);
  entries[10]._parent = root;
  entries[11]._parent = root;
  entries[12]._parent = root;
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  const observedBefore = env.observers[0].observed.size;
  // refreshScope is intended for after an outerHTML swap — observe is
  // idempotent so the size stays the same here, but the call must not
  // throw or disconnect.
  v.refreshScope(root);
  assert.equal(env.observers[0].observed.size, observedBefore);
  assert.equal(env.observers[0].disconnected, false);
});

test('ordinary rebuilds reuse the observer and diff only changed membership', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  const originalObserver = env.observers[0];

  const added = makeArticle({ messageId: 'm-added' });
  chatTimeline._entries.push(added);
  v.rebuild();
  assert.equal(env.observers.length, 1);
  assert.strictEqual(env.observers[0], originalObserver);
  assert.equal(originalObserver.observed.size, 201);

  chatTimeline._entries.splice(10, 1);
  v.rebuild();
  assert.equal(env.observers.length, 1);
  assert.equal(originalObserver.observed.size, 200);
});

test('callbacks from a stale observer generation cannot queue or mutate entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const timers = [];
  const listeners = new Map();
  const win = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { if (listeners.get(type) === handler) listeners.delete(type); },
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
  };
  const entries = bulkEntries(100);
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(entries),
    document: makeFakeDocument(),
    window: win,
  });
  t.after(() => v.dispose());
  v.rebuild();
  const staleGeneration = v._internals.getBudgetStats().observerGeneration;
  listeners.get('resize')();
  timers.shift()();
  assert.ok(v._internals.getBudgetStats().observerGeneration > staleGeneration);

  v._internals.onIntersect([{ target: entries[5], isIntersecting: false }], staleGeneration);
  assert.equal(entries[5].getAttribute('data-virtualized'), null);
  assert.equal(v._internals.getBudgetStats().queueDepth, 0);
});

test('dispose disconnects observer, clears indexes, and short-circuits subsequent calls', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  v.rebuild();
  env.observers[0]._fire([{ target: entries[3], isIntersecting: false }]);
  assert.equal(entries[3].getAttribute('data-virtualized'), 'true');
  v.dispose();
  assert.equal(env.observers[0].disconnected, true);
  assert.deepEqual(v._internals.getVirtualIndexSizes(), { rows: 0, tools: 0 });
  assert.deepEqual(
    {
      serializedMarkupEntries: v._internals.getBudgetStats().serializedMarkupEntries,
      observers: v._internals.getBudgetStats().observers,
      scheduledLayoutTasks: v._internals.getBudgetStats().scheduledLayoutTasks,
    },
    {
      serializedMarkupEntries: 0,
      observers: 0,
      scheduledLayoutTasks: 0,
    },
    'dispose releases every strong-reference and async-work owner measured by the R2 budget surface'
  );
  // rebuild after dispose is a no-op
  v.rebuild();
  assert.equal(env.observers.length, 1, 'no new observer constructed after dispose');
});

test('onAfterMount callback fires on remount with entry + container', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const calls = [];
  const v = createTimelineVirtualizer({
    chatTimeline,
    document: makeFakeDocument(),
    onAfterMount: (entryEl, containerEl) => calls.push({ entryEl, containerEl }),
  });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[2], isIntersecting: false }]);
  env.observers[0]._fire([{ target: entries[2], isIntersecting: true }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entryEl, entries[2]);
  assert.equal(calls[0].containerEl, entries[2]);
});

test('aria-busy invariant: streaming entry stays mounted while siblings virtualize', (t) => {
  // syncTimelineBusyState reads chatTimeline.querySelector('.chat-bubble-streaming').
  // If virtualization unmounted the streaming row by mistake, the probe
  // would silently drop aria-busy back to false mid-stream. This test
  // asserts the contract.
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  entries[100].innerHTML = '<div class="chat-bubble-streaming">streaming…</div>';
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  // Force-leave on every entry to simulate a deep scroll.
  const records = entries.map((target) => ({ target, isIntersecting: false }));
  env.observers[0]._fire(records);
  // The streaming entry must still be mounted (probe finds the bubble).
  assert.notEqual(chatTimeline.querySelector('.chat-bubble-streaming'), null);
});

test('below-threshold rebuild remounts any previously-virtualized entries', (t) => {
  // Scenario: a long conversation virtualized N entries; user deleted
  // most messages and reopened a short conversation. A subsequent
  // rebuild should restore everything cleanly, not leave stale
  // placeholders.
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  env.observers[0]._fire([{ target: entries[20], isIntersecting: false }]);
  assert.equal(entries[20].getAttribute('data-virtualized'), 'true');
  // Now shrink to below threshold and rebuild
  chatTimeline._entries.length = 10;
  v.rebuild();
  // Of those 10, entry[20] is no longer in the timeline; but if it had
  // been kept (e.g. entries[5] virtualized), rebuild would remount it.
  // Re-virtualize a still-present entry, shrink to <80, rebuild, expect remount.
  chatTimeline._entries.length = 0;
  for (let i = 0; i < 200; i += 1) chatTimeline._entries.push(entries[i]);
  v.rebuild();
  env.observers[env.observers.length - 1]._fire([{ target: entries[3], isIntersecting: false }]);
  assert.equal(entries[3].getAttribute('data-virtualized'), 'true');
  chatTimeline._entries.length = 10; // 10 < 80
  v.rebuild();
  assert.equal(entries[3].getAttribute('data-virtualized'), null, 'restored on below-threshold rebuild');
});

test('a keyed morph while virtualized invalidates the stash instead of restoring stale HTML', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  const target = entries[42];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');

  // Simulate the full-render keyed morph: the article element survives, its
  // content is rewritten fresh, and the morph strips the virtualizer-owned
  // attributes (target-only attributes are removed by syncElementAttributes).
  const morphedHtml = '<div class="chat-bubble-markdown">payload-42 EDITED</div>';
  target.innerHTML = morphedHtml;
  target.removeAttribute('data-virtualized');
  target.removeAttribute('aria-hidden');
  target.style.minHeight = '';

  // Intersection-enter after the morph must NOT restore the stale snapshot.
  env.observers[0]._fire([{ target, isIntersecting: true }]);
  assert.equal(target.innerHTML, morphedHtml, 'stale stash must not overwrite morphed content');

  // The entry re-virtualizes from its fresh content on the next leave...
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.match(target.innerHTML, /chat-entry-virtualized/);
  // ...and the next restore returns the post-morph content, not the original.
  env.observers[0]._fire([{ target, isIntersecting: true }]);
  assert.equal(target.innerHTML, morphedHtml, 'restore returns the post-morph content');
});

test('rebuild drops stale stashes so id lookups do not resurrect morphed entries', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(200);
  entries[42] = makeArticle({
    messageId: 'm42',
    role: 'user',
    height: 400,
    innerHtml: '<div class="chat-bubble-markdown">payload-42</div>',
    toolCallIds: ['call_morph_42'],
  });
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  const target = entries[42];
  env.observers[0]._fire([{ target, isIntersecting: false }]);
  assert.equal(target.getAttribute('data-virtualized'), 'true');

  const morphedHtml = '<div class="chat-bubble-markdown">fresh tool row</div>';
  target.innerHTML = morphedHtml;
  target.removeAttribute('data-virtualized');
  target.removeAttribute('aria-hidden');
  target.style.minHeight = '';

  // The post-render rebuild sweep drops the stale stash...
  v.rebuild();
  // ...so the tool-call-id index no longer offers a stale restore.
  assert.equal(v.ensureMountedForToolCallId('call_morph_42'), false);
  assert.equal(target.innerHTML, morphedHtml, 'morphed content stays untouched');
});

// CTL-017: the documented contract is "virtualization engages only when entry
// count is greater than 80" (header comment), but rebuild() disabled only when
// entries.length < threshold, so exactly-threshold engaged. Pin the documented
// boundary: AT threshold stays fully mounted, one past threshold engages.

test('rebuild stays fully mounted at exactly the threshold entry count (CTL-017)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(80);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  assert.equal(env.observers.length, 0, 'exactly-80 must NOT construct an observer (> 80 contract)');
  assert.equal(v._internals.hasObserver(), false);
});

test('rebuild engages one entry past the threshold (CTL-017)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const entries = bulkEntries(81);
  const chatTimeline = makeChatTimeline(entries);
  const v = createTimelineVirtualizer({ chatTimeline, document: makeFakeDocument() });
  t.after(() => v.dispose());
  v.rebuild();
  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].observed.size, 81);
});

test('explicit threshold override keeps the strictly-greater-than boundary (CTL-017)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const atThreshold = makeChatTimeline(bulkEntries(10));
  const v1 = createTimelineVirtualizer({
    chatTimeline: atThreshold, document: makeFakeDocument(), threshold: 10,
  });
  t.after(() => v1.dispose());
  v1.rebuild();
  assert.equal(env.observers.length, 0, 'exactly-threshold must stay fully mounted');

  const pastThreshold = makeChatTimeline(bulkEntries(11));
  const v2 = createTimelineVirtualizer({
    chatTimeline: pastThreshold, document: makeFakeDocument(), threshold: 10,
  });
  t.after(() => v2.dispose());
  v2.rebuild();
  assert.equal(env.observers.length, 1, 'threshold+1 engages');
});

// ---- Root-level layout axes ------------------------------------------------
// Regression cover for the Chat width (Default/Wide) setting. Wide mode
// changes .chat-thread-column's width via --content-column-width, but
// getLayoutWidth() measures #chatThreadScroll first and that box does NOT
// resize, so the ResizeObserver path alone never invalidates the cached row
// heights. The root-attribute observer is what actually catches it.

function makeLayoutAxisEnvironment() {
  const attrs = new Map();
  const documentElement = {
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    setAttribute(name, value) { attrs.set(name, String(value)); },
    style: { getPropertyValue() { return ''; } },
  };
  const mutationObservers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.options = null;
      this.disconnected = false;
      mutationObservers.push(this);
    }
    observe(target, options) { this.target = target; this.options = options || {}; }
    disconnect() { this.disconnected = true; }
    _fire() { if (!this.disconnected) this.callback([]); }
  }
  return {
    documentElement,
    mutationObservers,
    doc: { activeElement: null, documentElement },
    win: {
      MutationObserver: FakeMutationObserver,
      addEventListener() {},
      removeEventListener() {},
      setTimeout() { return 1; },
      clearTimeout() {},
    },
  };
}

function buildLayoutAxisVirtualizer(t) {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const axis = makeLayoutAxisEnvironment();
  const reasons = [];
  const v = createTimelineVirtualizer({
    chatTimeline: makeChatTimeline(bulkEntries(200)),
    document: axis.doc,
    window: axis.win,
    onStatsChange(_stats, reason) { reasons.push(reason); },
  });
  t.after(() => v.dispose());
  reasons.length = 0;
  return { axis, reasons };
}

test('the root-attribute observer watches the chat width axis alongside chat zoom', (t) => {
  const { axis } = buildLayoutAxisVirtualizer(t);
  assert.equal(axis.mutationObservers.length, 1, 'a root-attribute observer is installed');
  const filter = axis.mutationObservers[0].options.attributeFilter;
  assert.ok(filter.includes('data-chat-zoom'), 'chat zoom stays observed');
  assert.ok(filter.includes('data-chat-width'), 'chat width is observed');
});

test('toggling chat width invalidates the cached layout even though the scroll container never resizes', (t) => {
  const { axis, reasons } = buildLayoutAxisVirtualizer(t);
  axis.documentElement.setAttribute('data-chat-width', 'wide');
  axis.mutationObservers[0]._fire();
  assert.ok(reasons.includes('layout_invalidated'), 'a width-mode change rebuilds the height cache');
});

test('an unchanged chat width value is a no-op rather than a layout churn', (t) => {
  const { axis, reasons } = buildLayoutAxisVirtualizer(t);
  axis.documentElement.setAttribute('data-chat-width', 'wide');
  axis.mutationObservers[0]._fire();
  reasons.length = 0;
  axis.documentElement.setAttribute('data-chat-width', 'wide');
  axis.mutationObservers[0]._fire();
  assert.equal(reasons.includes('layout_invalidated'), false, 'rewriting the same value invalidates nothing');
});
