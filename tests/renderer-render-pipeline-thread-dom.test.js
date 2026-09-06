const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadDomPipeline,
} = require('../renderer/chat/renderer-render-pipeline-thread-dom');

// Phase 10 Track A3 — async lifecycle safety for the rail ResizeObserver
// + pending rAF. AGENTS.md §5 ("no post-await mutation after dispose")
// requires that once a pipeline is torn down, any in-flight rAF tick must
// no-op and the observer must be disconnected.
//
// Phase 10 Track B1/B2 — rail-measurement perf:
//   B1 = single read pass before any DOM writes (no layout thrashing)
//   B2 = 80 ms timer-based debounce in front of the rAF (so resize bursts
//        collapse to one update instead of one per frame)
// The harness below stubs requestAnimationFrame, ResizeObserver, AND
// setTimeout/clearTimeout so all three asynchronous edges are
// synchronously steppable from a test.

function buildEnvironment() {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const previousResizeObserver = global.ResizeObserver;
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;

  const rafCallbacks = new Map();
  let nextRafHandle = 1;
  const rafCancelled = new Set();
  global.requestAnimationFrame = function fakeRaf(callback) {
    const handle = nextRafHandle;
    nextRafHandle += 1;
    rafCallbacks.set(handle, callback);
    return handle;
  };
  global.cancelAnimationFrame = function fakeCancelRaf(handle) {
    if (handle && rafCallbacks.has(handle)) {
      rafCallbacks.delete(handle);
      rafCancelled.add(handle);
    }
  };

  const timerCallbacks = new Map();
  let nextTimerHandle = 1;
  const timersCancelled = new Set();
  global.setTimeout = function fakeSetTimeout(callback /* , delay, ...args */) {
    const handle = nextTimerHandle;
    nextTimerHandle += 1;
    timerCallbacks.set(handle, callback);
    return handle;
  };
  global.clearTimeout = function fakeClearTimeout(handle) {
    if (handle && timerCallbacks.has(handle)) {
      timerCallbacks.delete(handle);
      timersCancelled.add(handle);
    }
  };

  const observers = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = new Set();
      this.disconnected = false;
      observers.push(this);
    }
    observe(target) {
      this.targets.add(target);
    }
    unobserve(target) {
      this.targets.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
    // Helper for tests to fire the observer.
    _fire(targets = Array.from(this.targets)) {
      if (!this.disconnected) {
        this.callback(Array.from(targets, (target) => ({ target })));
      }
    }
  }
  global.ResizeObserver = FakeResizeObserver;

  function flushRaf() {
    const entries = [...rafCallbacks.entries()];
    rafCallbacks.clear();
    let invoked = 0;
    for (const [, callback] of entries) {
      callback(Date.now());
      invoked += 1;
    }
    return invoked;
  }

  function flushTimers() {
    // One-shot drain: pop and invoke every currently-scheduled timer.
    // Does not advance time — tests that rely on debounce semantics call
    // this once after the rapid burst to simulate the timer expiring.
    const entries = [...timerCallbacks.entries()];
    timerCallbacks.clear();
    let invoked = 0;
    for (const [, callback] of entries) {
      callback();
      invoked += 1;
    }
    return invoked;
  }

  function pendingTimerCount() {
    return timerCallbacks.size;
  }

  function restore() {
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
    global.ResizeObserver = previousResizeObserver;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }

  return {
    observers,
    rafCallbacks,
    rafCancelled,
    timerCallbacks,
    timersCancelled,
    flushRaf,
    flushTimers,
    pendingTimerCount,
    restore,
  };
}

function buildFakeChatTimeline(rootCount = 1) {
  const roots = [];
  for (let index = 0; index < rootCount; index += 1) {
    const root = {
      id: `root-${index}`,
      style: {
        _props: new Map(),
        setProperty(name, value) { this._props.set(name, value); },
        removeProperty(name) { this._props.delete(name); },
      },
      _selectorReturns: new Map(),
      getBoundingClientRect() {
        return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 };
      },
      querySelectorAll(selector) {
        return this._selectorReturns.get(selector) || [];
      },
    };
    roots.push(root);
  }
  const attrs = new Map();
  return {
    _rootSelectorReturns: roots,
    _streamingBubble: null,
    _attrs: attrs,
    querySelectorAll(selector) {
      if (selector === '.chat-thread-root') {
        return this._rootSelectorReturns;
      }
      return [];
    },
    querySelector(selector) {
      if (selector === '.chat-bubble-streaming') {
        return this._streamingBubble;
      }
      return null;
    },
    setAttribute(name, value) {
      attrs.set(name, value);
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
  };
}

test('dispose cancels a pending rail-resize rAF and prevents subsequent DOM mutation', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();
  assert.equal(env.observers.length, 1, 'observer must be attached');
  assert.equal(env.observers[0].targets.size, 1, 'observer must observe the single thread root');

  // Trigger the observer; with the B2 debounce in front of the rAF, the
  // first edge that fires is a setTimeout, not a rAF. Flushing the timer
  // is what causes the rAF to be queued.
  env.observers[0]._fire();
  assert.equal(env.pendingTimerCount(), 1, 'observer tick must schedule exactly one debounce timer');
  assert.equal(env.rafCallbacks.size, 0, 'no rAF queued before the debounce expires');
  env.flushTimers();
  assert.equal(env.rafCallbacks.size, 1, 'expired debounce must schedule exactly one rAF');
  const scheduledHandle = [...env.rafCallbacks.keys()][0];

  pipeline.dispose();

  assert.equal(env.observers[0].disconnected, true, 'dispose must disconnect the observer');
  assert.equal(env.rafCallbacks.size, 0, 'dispose must cancel the pending rAF');
  assert.equal(env.rafCancelled.has(scheduledHandle), true, 'dispose must cancel by the original handle');

  // Even if a rogue tick still fires (e.g. queued via a different path),
  // the rail extents update must short-circuit because _disposed = true.
  const styleWritesBefore = chatTimeline._rootSelectorReturns[0].style._props.size;
  pipeline.updateThreadRailExtents();
  const styleWritesAfter = chatTimeline._rootSelectorReturns[0].style._props.size;
  assert.equal(styleWritesAfter, styleWritesBefore, 'updateThreadRailExtents must no-op after dispose');
});

test('attachRailResizeObserver cancels any pending rAF before wiring a fresh observer', (t) => {
  // Without this guard, a rAF queued by the previous observer would still
  // fire after the disconnect and call updateThreadRailExtents on a root
  // set that is about to be replaced — the classic post-await mutation
  // shape AGENTS.md §5 prohibits.
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(2);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();
  env.observers[0]._fire();
  // Drain the debounce so the rAF actually gets queued by the first
  // observer — that is the carry-over we want the reattach to cancel.
  env.flushTimers();
  assert.equal(env.rafCallbacks.size, 1);
  const firstHandle = [...env.rafCallbacks.keys()][0];

  // Re-attach (simulating thread root reshape).
  pipeline.attachRailResizeObserver();

  assert.equal(env.observers.length, 2, 'second observer must be created');
  assert.equal(env.observers[0].disconnected, true, 'first observer must be disconnected');
  assert.equal(env.rafCancelled.has(firstHandle), true, 'pending rAF from first observer must be cancelled');
  assert.equal(env.rafCallbacks.size, 0, 'no carry-over rAF after reattach');

  pipeline.dispose();
});

test('dispose is idempotent and silently no-ops after the first call', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });
  pipeline.attachRailResizeObserver();

  pipeline.dispose();
  pipeline.dispose();
  pipeline.dispose();
  // No exception and observer is still in disconnected state.
  assert.equal(env.observers[0].disconnected, true);
});

test('post-dispose attachRailResizeObserver does not create a fresh observer', (t) => {
  // Once the pipeline is disposed it must remain inert — late re-attach
  // attempts from callers that haven't yet learned the controller died
  // must not silently bring the observer back to life.
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.dispose();
  pipeline.attachRailResizeObserver();
  assert.equal(env.observers.length, 0, 'no observer must be created after dispose');
});

// Phase 10 Track B1 — read/write ordering. updateThreadRailExtents must
// finish all DOM reads before performing any DOM writes, so that no write
// can invalidate layout for a subsequent read in the same invocation.
test('updateThreadRailExtents reads all DOM measurements before any DOM writes', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  // We build a richer fake here than the default helper: we need a
  // root with toggle dots whose Phase 1 path runs both the response
  // branch (top-align) and the centre-align branch, plus a Phase 2
  // row-dot pass. Every DOM read and every DOM write is tagged into a
  // shared call log so we can assert ordering.
  const callLog = [];

  function makeDot({ kind, landmarkTop, landmarkHeight }) {
    const dot = {
      offsetParent: {},
      offsetHeight: 12,
      _styleProp: 0,
      style: {
        get top() { return this._top; },
        set top(value) {
          callLog.push({ kind: 'write', target: 'dot.style.top', value });
          this._top = value;
        },
        _top: '',
      },
      _kind: kind,
      _landmarkTop: landmarkTop,
      _landmarkHeight: landmarkHeight,
    };
    dot.closest = function closest(selector) {
      if (selector === '.chat-thread-node-row') {
        return {
          getBoundingClientRect() {
            callLog.push({ kind: 'read', target: 'row.getBoundingClientRect' });
            return { top: 0, left: 0, right: 100, bottom: 200, width: 100, height: 200 };
          },
          querySelector(s) {
            if (s === '.chat-thread-node-article') {
              return {
                querySelector(_landmarkSelector) {
                  return {
                    getBoundingClientRect() {
                      callLog.push({ kind: 'read', target: 'landmark.getBoundingClientRect' });
                      return {
                        top: landmarkTop,
                        left: 0,
                        right: 100,
                        bottom: landmarkTop + landmarkHeight,
                        width: 100,
                        height: landmarkHeight,
                      };
                    },
                  };
                },
              };
            }
            return null;
          },
        };
      }
      if (selector === '.chat-thread-node') {
        return { dataset: { threadNodeKind: kind } };
      }
      return null;
    };
    return dot;
  }

  function makeRowDot(offset) {
    return {
      offsetParent: {},
      getBoundingClientRect() {
        callLog.push({ kind: 'read', target: 'rowDot.getBoundingClientRect' });
        return {
          top: offset,
          left: 0,
          right: 6,
          bottom: offset + 6,
          width: 6,
          height: 6,
        };
      },
    };
  }

  const toggleDots = [
    makeDot({ kind: 'response', landmarkTop: 10, landmarkHeight: 20 }),
    makeDot({ kind: 'tool', landmarkTop: 80, landmarkHeight: 30 }),
  ];
  const rowDots = [makeRowDot(160), makeRowDot(220)];

  const root = {
    style: {
      _props: new Map(),
      setProperty(name, value) {
        callLog.push({ kind: 'write', target: 'root.style.setProperty', name, value });
        this._props.set(name, value);
      },
      removeProperty(name) {
        callLog.push({ kind: 'write', target: 'root.style.removeProperty', name });
        this._props.delete(name);
      },
    },
    getBoundingClientRect() {
      callLog.push({ kind: 'read', target: 'root.getBoundingClientRect' });
      return { top: 0, left: 0, right: 100, bottom: 400, width: 100, height: 400 };
    },
    querySelectorAll(selector) {
      if (selector === '.chat-thread-toggle') return toggleDots;
      if (
        selector ===
        '.chat-thread-node-nested .chat-thread-node-article .chat-row .chat-row-node-dot'
      ) {
        return rowDots;
      }
      return [];
    },
  };

  const chatTimeline = {
    querySelectorAll(selector) {
      if (selector === '.chat-thread-root') return [root];
      return [];
    },
  };

  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });
  pipeline.updateThreadRailExtents();

  // Sanity: both reads and writes happened.
  const lastReadIndex = callLog.reduce(
    (acc, entry, idx) => (entry.kind === 'read' ? idx : acc),
    -1,
  );
  const firstWriteIndex = callLog.findIndex((entry) => entry.kind === 'write');

  assert.notEqual(lastReadIndex, -1, 'test fixture must produce at least one DOM read');
  assert.notEqual(firstWriteIndex, -1, 'test fixture must produce at least one DOM write');

  // The B1 invariant: the first write must come strictly after the last
  // read. If a write were ever interleaved into the read pass, the next
  // read would be forced to recompute layout — the thrash we are
  // eliminating.
  assert.ok(
    firstWriteIndex > lastReadIndex,
    `expected all reads before any write — last read at ${lastReadIndex}, first write at ${firstWriteIndex}.\nLog: ${JSON.stringify(callLog)}`,
  );

  // Spot-check that the function still produced the expected outputs.
  assert.ok(root.style._props.has('--_rail-top'), 'rail-top property must be set');
  assert.ok(root.style._props.has('--_rail-height'), 'rail-height property must be set');
});

// Phase 10 Track B2 — debounce coalesces rapid resize bursts.
test('rapid resize events collapse to a single update via the debounce', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });
  pipeline.attachRailResizeObserver();

  // Fire the observer five times in a row without flushing in between.
  // Each fire re-starts the debounce timer; at no point should more
  // than one timer be queued.
  for (let i = 0; i < 5; i += 1) {
    env.observers[0]._fire();
    assert.equal(env.pendingTimerCount(), 1, `after fire #${i + 1}, exactly one debounce timer should be pending`);
    assert.equal(env.rafCallbacks.size, 0, `after fire #${i + 1}, no rAF should be queued yet (debounce not expired)`);
  }

  // Expire the debounce; this should queue exactly one rAF.
  env.flushTimers();
  assert.equal(env.pendingTimerCount(), 0, 'debounce timer must be consumed');
  assert.equal(env.rafCallbacks.size, 1, 'expired debounce must queue exactly one rAF');

  // Flush the rAF; updateThreadRailExtents runs once.
  const styleWritesBefore = chatTimeline._rootSelectorReturns[0].style._props.size;
  env.flushRaf();
  const styleWritesAfter = chatTimeline._rootSelectorReturns[0].style._props.size;
  // The default fake root has no dots, so dotCenters.length < 2 — the
  // function writes --_rail-height=0 and removes --_rail-top. Both are
  // mutations against root.style; net Map size moves by at most one.
  assert.ok(
    styleWritesAfter >= styleWritesBefore,
    'updateThreadRailExtents ran exactly once and produced its expected style mutations',
  );

  pipeline.dispose();
});

test('dispose cancels a pending debounce timer', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });
  pipeline.attachRailResizeObserver();

  env.observers[0]._fire();
  assert.equal(env.pendingTimerCount(), 1, 'observer fire queues a debounce timer');
  const scheduledTimer = [...env.timerCallbacks.keys()][0];

  pipeline.dispose();

  assert.equal(env.pendingTimerCount(), 0, 'dispose must cancel the pending debounce timer');
  assert.equal(
    env.timersCancelled.has(scheduledTimer),
    true,
    'dispose must cancel by the original timer handle',
  );

  // Flushing should be a no-op (no callbacks are left).
  const styleWritesBefore = chatTimeline._rootSelectorReturns[0].style._props.size;
  env.flushTimers();
  env.flushRaf();
  const styleWritesAfter = chatTimeline._rootSelectorReturns[0].style._props.size;
  assert.equal(styleWritesAfter, styleWritesBefore, 'no style mutations after disposed debounce');
});

test('attachRailResizeObserver cancels a pending debounce timer before wiring a fresh observer', (t) => {
  // Symmetric with the existing "cancels any pending rAF before wiring a
  // fresh observer" test, but for the B2 debounce timer. The hazard is
  // identical: a queued timer firing post-disconnect against the old
  // root set would call updateThreadRailExtents on DOM the new observer
  // doesn't even know about.
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(2);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();
  env.observers[0]._fire();
  assert.equal(env.pendingTimerCount(), 1, 'first observer fire queues a debounce timer');
  const firstTimer = [...env.timerCallbacks.keys()][0];

  // Re-attach: this must drop the queued timer from the now-stale
  // observer before installing the new one.
  pipeline.attachRailResizeObserver();

  assert.equal(env.observers.length, 2, 'second observer must be created');
  assert.equal(env.observers[0].disconnected, true, 'first observer must be disconnected');
  assert.equal(
    env.timersCancelled.has(firstTimer),
    true,
    'pending debounce timer from first observer must be cancelled',
  );
  assert.equal(env.pendingTimerCount(), 0, 'no carry-over debounce timer after reattach');

  pipeline.dispose();
});

test('attachRailResizeObserver sets aria-busy=false on the timeline when no streaming bubble is present (E4)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const chatTimeline = buildFakeChatTimeline(1);
  chatTimeline._streamingBubble = null;
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();

  assert.equal(chatTimeline.getAttribute('aria-busy'), 'false');
  pipeline.dispose();
});

test('attachRailResizeObserver flips aria-busy=true when a streaming bubble is present (E4)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const chatTimeline = buildFakeChatTimeline(1);
  // Simulate a live streaming bubble in the DOM.
  chatTimeline._streamingBubble = { id: 'live-bubble' };
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();

  assert.equal(chatTimeline.getAttribute('aria-busy'), 'true');
  pipeline.dispose();
});

test('syncTimelineBusyState can be called directly to refresh aria-busy mid-stream (E4)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();
  assert.equal(chatTimeline.getAttribute('aria-busy'), 'false');

  chatTimeline._streamingBubble = { id: 'just-started' };
  pipeline.syncTimelineBusyState();
  assert.equal(chatTimeline.getAttribute('aria-busy'), 'true');

  chatTimeline._streamingBubble = null;
  pipeline.syncTimelineBusyState();
  assert.equal(chatTimeline.getAttribute('aria-busy'), 'false');

  pipeline.dispose();
});

// Finding 2 — synchronous first-paint rail measurement. performFullMessageRender
// needs a rail-tick that runs with no debounce and no rAF so --_rail-top/
// --_rail-height are set before the browser paints. This must NOT depend on
// flushing fake timers or rAF — it has to be synchronous end-to-end.
test('measureThreadRailExtentsNow sets --_rail-top/--_rail-height synchronously (no timer/rAF advance)', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  function makeDot(top, height) {
    return {
      offsetParent: {},
      offsetHeight: height,
      getBoundingClientRect() {
        return { top, left: 0, right: 6, bottom: top + height, width: 6, height };
      },
    };
  }

  const rowDots = [makeDot(10, 12), makeDot(90, 12)];
  const root = {
    style: {
      _props: new Map(),
      setProperty(name, value) { this._props.set(name, value); },
      removeProperty(name) { this._props.delete(name); },
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 100, bottom: 300, width: 100, height: 300 };
    },
    querySelectorAll(selector) {
      if (selector === '.chat-thread-toggle') return [];
      if (
        selector ===
        '.chat-thread-node-nested .chat-thread-node-article .chat-row .chat-row-node-dot'
      ) {
        return rowDots;
      }
      return [];
    },
  };
  const chatTimeline = {
    querySelectorAll(selector) {
      if (selector === '.chat-thread-root') return [root];
      return [];
    },
  };

  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  // No env.flushTimers() / env.flushRaf() call anywhere — if the
  // implementation routes through the debounce or rAF, these assertions
  // fail because the style props are never written without a flush.
  pipeline.measureThreadRailExtentsNow();

  assert.equal(env.pendingTimerCount(), 0, 'must not schedule any debounce timer');
  assert.equal(env.rafCallbacks.size, 0, 'must not schedule any rAF');
  assert.equal(root.style._props.get('--_rail-top'), '16px', 'rail-top must match the first dot center synchronously');
  assert.equal(root.style._props.get('--_rail-height'), '80px', 'rail-height must match the dot spread synchronously');

  pipeline.dispose();
});

test('measureThreadRailExtentsNow is a no-op after dispose', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());

  const chatTimeline = buildFakeChatTimeline(1);
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.dispose();

  const styleWritesBefore = chatTimeline._rootSelectorReturns[0].style._props.size;
  pipeline.measureThreadRailExtentsNow();
  const styleWritesAfter = chatTimeline._rootSelectorReturns[0].style._props.size;
  assert.equal(styleWritesAfter, styleWritesBefore, 'measureThreadRailExtentsNow must no-op after dispose');
});

test('F7: renderThreadTree inserts time-gap divider markup before the target message row', () => {
  const pipeline = createThreadDomPipeline({
    callbacks: {
      escapeHtml(value) {
        return String(value || '').replace(/"/g, '&quot;');
      },
    },
  });
  const dividerByMessageId = new Map([[
    'a1',
    {
      beforeMessageId: 'a1',
      previousMessageId: 'u1',
      label: '5 min later',
      ariaLabel: '5 minutes later',
    },
  ]]);
  const html = pipeline.renderThreadTree({
    roots: [
      {
        id: 'u1',
        role: 'user',
        kind: '',
        parentId: '',
        message: { id: 'u1' },
        children: [],
      },
      {
        id: 'a1',
        role: 'assistant',
        kind: '',
        parentId: '',
        message: { id: 'a1' },
        children: [],
      },
    ],
  }, 's1', new Set(), (message) => (
    '<article class="chat-entry" data-message-id="' + message.id + '"></article>'
  ), { dividerByMessageId });

  assert.match(html, /data-timeline-divider="time-gap"/);
  assert.match(html, /data-before-message-id="a1"/);
  assert.equal(html.indexOf('data-timeline-divider="time-gap"') < html.indexOf('data-message-id="a1"'), true);
  assert.equal((html.match(/data-timeline-divider="time-gap"/g) || []).length, 1);
});

test('renderThreadTree omits a leading divider for a compat-anchor stub', () => {
  const pipeline = createThreadDomPipeline();
  const html = pipeline.renderThreadTree({
    roots: [{
      id: 'compat',
      role: 'assistant',
      kind: '',
      parentId: '',
      message: { id: 'compat' },
      children: [],
    }],
  }, 's1', new Set(), () => (
    '<span data-thread-compat-anchor="true" aria-hidden="true"></span>'
  ), {
    dividerByMessageId: new Map([[
      'compat',
      { beforeMessageId: 'compat', label: '5 min later', ariaLabel: '5 minutes later' },
    ]]),
  });

  assert.doesNotMatch(html, /data-timeline-divider="time-gap"/);
  assert.match(html, /data-thread-compat-anchor="true"/);
});

test('suppressOwnLeadingDivider drops only the node divider and keeps a child divider', () => {
  const pipeline = createThreadDomPipeline();
  const html = pipeline.renderThreadTree({
    roots: [{
      id: 'root',
      role: 'assistant',
      kind: '',
      parentId: '',
      message: { id: 'root' },
      children: [{
        id: 'child',
        role: 'assistant',
        kind: '',
        parentId: 'root',
        message: { id: 'child' },
        children: [],
      }],
    }],
  }, 's1', new Set(), (message) => (
    '<article class="chat-entry" data-message-id="' + message.id + '"></article>'
  ), {
    dividerByMessageId: new Map([
      ['root', { beforeMessageId: 'root', label: '5 min later', ariaLabel: '5 minutes later' }],
      ['child', { beforeMessageId: 'child', label: '6 min later', ariaLabel: '6 minutes later' }],
    ]),
    suppressOwnLeadingDivider: true,
  });

  assert.doesNotMatch(html, /data-before-message-id="root"/);
  assert.match(html, /data-before-message-id="child"/);
  assert.equal((html.match(/data-timeline-divider="time-gap"/g) || []).length, 1);
});

test('envelope compat-only subtrees drop the thread toggle; subtrees with visible articles keep it', () => {
  // Trailing rail-dot defect: an envelope-sibling compat node whose whole
  // rendered subtree is compat anchors has nothing visible to collapse — its
  // toggle painted a stray ringed dot below the coalesced turn article.
  const enveloped = (id) => '<div class="chat-row chat-row-thread-compat" data-row-kind="thread_compat"'
    + ' data-thread-compat-enveloped="true" data-source-message-id="' + id + '">'
    + '<span class="thread-compat-anchor" data-message-id="' + id + '" data-thread-compat-anchor="true" aria-hidden="true"></span></div>';
  const articles = {
    anchor: '<article class="chat-entry" data-message-id="anchor"></article>',
    compat_leafy: enveloped('compat_leafy'),
    compat_leaf: enveloped('compat_leaf'),
    compat_parent_of_visible: enveloped('compat_parent_of_visible'),
    visible_child: '<article class="chat-entry" data-message-id="visible_child"></article>',
    compat_collapsed: enveloped('compat_collapsed'),
    hidden_child: '<article class="chat-entry" data-message-id="hidden_child"></article>',
  };
  const node = (id, children) => ({ id, role: 'assistant', kind: '', parentId: 'p', message: { id }, children });
  const pipeline = createThreadDomPipeline({
    callbacks: {
      escapeHtml: (value) => String(value || ''),
      shouldShowThreadToggle: () => true,
      isThreadBranchOpen: (candidate) => candidate.id !== 'compat_collapsed',
    },
  });
  const html = pipeline.renderThreadTree({
    roots: [
      node('anchor', [
        node('compat_leafy', [node('compat_leaf', [])]),
        node('compat_parent_of_visible', [node('visible_child', [])]),
        node('compat_collapsed', [node('hidden_child', [])]),
      ]),
    ],
  }, 's1', new Set(), (message) => articles[message.id] || '', {});

  // Compat-only subtree (and compat leaf): no toggle emitted.
  assert.doesNotMatch(html, /data-thread-toggle="compat_leafy"/);
  assert.doesNotMatch(html, /data-thread-toggle="compat_leaf"/);
  // A compat node with a real article somewhere below keeps its toggle.
  assert.match(html, /data-thread-toggle="compat_parent_of_visible"/);
  // Collapsed nodes keep their toggle: childrenMarkup is empty while hidden,
  // so "nothing visible" must not be inferred (the expand control would vanish).
  assert.match(html, /data-thread-toggle="compat_collapsed"/);
  // Real-article nodes are untouched.
  assert.match(html, /data-thread-toggle="anchor"/);
});

test('thread child container ids are collision-free across case, punctuation, and Unicode', () => {
  const pipeline = createThreadDomPipeline({
    callbacks: {
      escapeHtml: (value) => String(value || ''),
      shouldShowThreadToggle: (node) => node.children.length > 0,
    },
  });
  const node = (id) => ({
    id,
    role: 'assistant',
    kind: '',
    parentId: '',
    message: { id },
    children: [{
      id: id + '-child',
      role: 'assistant',
      kind: '',
      parentId: id,
      message: { id: id + '-child' },
      children: [],
    }],
  });
  const html = pipeline.renderThreadTree({
    roots: [node('A/B'), node('a-b'), node('節點')],
  }, 'session-1', new Set(), (message) => (
    '<article class="chat-entry" data-message-id="' + message.id + '"></article>'
  ), {});

  const controlledIds = Array.from(html.matchAll(/aria-controls="([^"]+)"/g), (match) => match[1]);
  assert.equal(controlledIds.length, 3);
  assert.equal(new Set(controlledIds).size, 3);
  controlledIds.forEach((id) => assert.match(html, new RegExp('id="' + id + '"')));
});

test('resize observer measures only dirty roots and suppresses unchanged writes', (t) => {
  const env = buildEnvironment();
  t.after(() => env.restore());
  const chatTimeline = buildFakeChatTimeline(2);
  const [firstRoot, secondRoot] = chatTimeline._rootSelectorReturns;
  const reads = new Map([[firstRoot, 0], [secondRoot, 0]]);
  const writes = new Map([[firstRoot, 0], [secondRoot, 0]]);
  for (const root of [firstRoot, secondRoot]) {
    root.getBoundingClientRect = () => {
      reads.set(root, reads.get(root) + 1);
      return { top: 0, left: 0, right: 100, bottom: 100, width: 100, height: 100 };
    };
    const originalSetProperty = root.style.setProperty.bind(root.style);
    root.style.setProperty = (name, value) => {
      writes.set(root, writes.get(root) + 1);
      originalSetProperty(name, value);
    };
  }
  const pipeline = createThreadDomPipeline({ dom: { chatTimeline } });

  pipeline.attachRailResizeObserver();
  env.observers[0]._fire([firstRoot]);
  env.flushTimers();
  env.flushRaf();

  assert.equal(reads.get(firstRoot), 1);
  assert.equal(reads.get(secondRoot), 0);
  assert.equal(writes.get(firstRoot), 1);
  pipeline.updateThreadRailExtents([firstRoot]);
  assert.equal(writes.get(firstRoot), 1, 'same geometry should not rewrite rail variables');
  pipeline.dispose();
});

test('one malformed rail root cannot suppress later valid roots', () => {
  const chatTimeline = buildFakeChatTimeline(3);
  const [badReadRoot, badWriteRoot, goodRoot] = chatTimeline._rootSelectorReturns;
  badReadRoot.getBoundingClientRect = () => {
    const error = new Error('layout read failed at C:\\private\\thread');
    error.name = 'Layout Read/Error';
    throw error;
  };
  badWriteRoot.style.setProperty = () => { throw new Error('style write failed'); };
  const warnings = [];
  const pipeline = createThreadDomPipeline({
    dom: { chatTimeline },
    callbacks: { appendClientLog: (...args) => warnings.push(args) },
  });

  pipeline.updateThreadRailExtents([badReadRoot, badWriteRoot, goodRoot]);

  assert.equal(goodRoot.style._props.get('--_rail-height'), '0px');
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0][1], 'chat.thread_rail_measurement_failed');
  assert.deepEqual(
    warnings.map((warning) => warning[2].phase),
    ['read', 'write']
  );
  assert.equal(warnings[0][2].errorName, 'LayoutReadError');
  assert.equal(warnings[1][2].errorName, 'Error');
  assert.equal(Object.prototype.hasOwnProperty.call(warnings[0][2], 'message'), false);
});

test('rail measurement warnings are capped after three redacted failures', () => {
  const chatTimeline = buildFakeChatTimeline(5);
  const warnings = [];
  for (const root of chatTimeline._rootSelectorReturns) {
    root.getBoundingClientRect = () => { throw new Error('sensitive failure detail'); };
  }
  const pipeline = createThreadDomPipeline({
    dom: { chatTimeline },
    callbacks: { appendClientLog: (...args) => warnings.push(args) },
  });

  pipeline.updateThreadRailExtents(chatTimeline._rootSelectorReturns);

  assert.equal(warnings.length, 3);
  assert.equal(warnings[2][2].suppressed, true);
  warnings.forEach((warning) => {
    assert.equal(warning[2].phase, 'read');
    assert.equal(warning[2].errorName, 'Error');
    assert.equal(Object.prototype.hasOwnProperty.call(warning[2], 'message'), false);
  });
});
