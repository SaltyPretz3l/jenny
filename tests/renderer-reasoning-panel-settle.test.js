// Regression coverage for the reasoning-panel clipping bug: an expanded
// .reasoning-row-panel's max-height is pinned to a single scrollHeight
// snapshot. If that snapshot runs before layout/fonts settle (or the panel
// reflows afterward, e.g. a dock-width resize), the pinned px value can land
// short and clip the last text line mid-glyph. The fix settles the panel to
// max-height:none (via the reasoning-row-panel--settled CSS class) shortly
// after the pin, so no stale measurement can clip a resting panel.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JSDOM,
  createImmediateRevealController,
  createStreamRevealController,
  disposeTrackedRevealDoms,
  trackRevealDom,
} = require('./helpers/renderer-stream-reveal-harness');

const {
  createThinkingViewportHarness,
} = require('./helpers/renderer-viewport-utils-helpers');

const {
  settleThinkingPanelNow,
  clearThinkingPanelSettle,
  armThinkingPanelSettle,
  SETTLED_CLASS,
} = require('../renderer/shell/renderer-thinking-panel-settle-utils');

test.afterEach(() => {
  disposeTrackedRevealDoms();
});

// --- Pure helper unit tests (no DOM timing dependency) --------------------

test('settleThinkingPanelNow adds the settled class unless reduced motion is active', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  panel.style.maxHeight = '120px';

  settleThinkingPanelNow(panel, false);
  assert.ok(panel.classList.contains(SETTLED_CLASS));
  assert.equal(panel.style.maxHeight, '');

  panel.classList.remove(SETTLED_CLASS);
  settleThinkingPanelNow(panel, true);
  assert.equal(panel.classList.contains(SETTLED_CLASS), false, 'reduced motion skips settling (max-height is already none)');
});

test('clearThinkingPanelSettle removes the settled class so a later expand does not inherit it', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded reasoning-row-panel--settled"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  clearThinkingPanelSettle(panel);
  assert.equal(panel.classList.contains(SETTLED_CLASS), false);
});

// defaultView is a getter-only accessor on jsdom's Document (no setter), so
// these tests stub window.setTimeout directly rather than swapping out
// ownerDocument.defaultView.
function stubWindowTimeout(dom) {
  let timeoutCallback = null;
  dom.window.setTimeout = (cb) => { timeoutCallback = cb; return 1; };
  return { get: () => timeoutCallback };
}

test('armThinkingPanelSettle settles on transitionend (filtered to max-height) and ignores unrelated events', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);
  panel.style.maxHeight = '120px';

  armThinkingPanelSettle(panel, { skip: false, ifLive: (fn) => fn, transitionMs: 999 });

  // An unrelated property's transitionend must not settle the panel early.
  const unrelatedEvent = new dom.window.Event('transitionend');
  Object.defineProperty(unrelatedEvent, 'propertyName', { value: 'opacity' });
  panel.dispatchEvent(unrelatedEvent);
  assert.equal(panel.classList.contains(SETTLED_CLASS), false);

  const maxHeightEvent = new dom.window.Event('transitionend');
  Object.defineProperty(maxHeightEvent, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(maxHeightEvent);

  assert.ok(panel.classList.contains(SETTLED_CLASS), 'transitionend on max-height settles the panel');
  assert.equal(panel.style.maxHeight, '');
  assert.equal(typeof timer.get(), 'function', 'the timer fallback is still armed alongside the listener');
});

test('armThinkingPanelSettle falls back to the timer when transitionend never fires (jsdom / no-transition paths)', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);
  panel.style.maxHeight = '120px';

  armThinkingPanelSettle(panel, { skip: false, ifLive: (fn) => fn, transitionMs: 260 });
  assert.equal(panel.classList.contains(SETTLED_CLASS), false, 'not settled until the timer (or transitionend) fires');

  timer.get()();
  assert.ok(panel.classList.contains(SETTLED_CLASS));
  assert.equal(panel.style.maxHeight, '');
});

test('armThinkingPanelSettle is a no-op once the panel has collapsed before settling', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);

  // Panel starts already collapsed (no 'expanded' class) — simulates a rapid
  // expand-then-collapse before the settle timer fires.
  armThinkingPanelSettle(panel, { skip: false, ifLive: (fn) => fn, transitionMs: 260 });
  timer.get()();
  assert.equal(panel.classList.contains(SETTLED_CLASS), false, 'must not settle a panel that is no longer expanded');
});

test('armThinkingPanelSettle calls onSettled once on max-height transitionend', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);
  let settledCalls = 0;
  panel.style.maxHeight = '120px';

  armThinkingPanelSettle(panel, {
    skip: false,
    ifLive: (fn) => fn,
    transitionMs: 260,
    onSettled() {
      assert.equal(panel.classList.contains(SETTLED_CLASS), true);
      assert.equal(panel.style.maxHeight, '');
      settledCalls += 1;
    },
  });

  const maxHeightEvent = new dom.window.Event('transitionend');
  Object.defineProperty(maxHeightEvent, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(maxHeightEvent);
  panel.dispatchEvent(maxHeightEvent);
  timer.get()();

  assert.equal(settledCalls, 1);
});

test('armThinkingPanelSettle calls onSettled once on the timeout fallback', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);
  let settledCalls = 0;
  panel.style.maxHeight = '120px';

  armThinkingPanelSettle(panel, {
    skip: false,
    ifLive: (fn) => fn,
    transitionMs: 260,
    onSettled() { settledCalls += 1; },
  });

  timer.get()();
  timer.get()();

  assert.equal(settledCalls, 1);
  assert.equal(panel.style.maxHeight, '');
});

test('armThinkingPanelSettle does not call onSettled after cleanup', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timer = stubWindowTimeout(dom);
  let settledCalls = 0;

  const cleanup = armThinkingPanelSettle(panel, {
    skip: false,
    ifLive: (fn) => fn,
    transitionMs: 260,
    onSettled() { settledCalls += 1; },
  });
  cleanup();
  timer.get()();

  assert.equal(settledCalls, 0);
});

test('re-arming a thinking panel does not fire the stale onSettled callback', () => {
  const dom = trackRevealDom(new JSDOM('<div class="reasoning-row-panel expanded"></div>'));
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const timeoutCallbacks = [];
  dom.window.setTimeout = (callback) => {
    timeoutCallbacks.push(callback);
    return timeoutCallbacks.length;
  };
  dom.window.clearTimeout = () => {};
  let staleCalls = 0;
  let currentCalls = 0;

  const cleanupStale = armThinkingPanelSettle(panel, {
    skip: false,
    ifLive: (fn) => fn,
    transitionMs: 260,
    onSettled() { staleCalls += 1; },
  });
  cleanupStale();
  armThinkingPanelSettle(panel, {
    skip: false,
    ifLive: (fn) => fn,
    transitionMs: 260,
    onSettled() { currentCalls += 1; },
  });

  timeoutCallbacks[0]();
  timeoutCallbacks[1]();

  assert.equal(staleCalls, 0);
  assert.equal(currentCalls, 1);
});

// --- Integration: stream-reveal's flip-to-complete pin ---------------------

function reasoningStackWithStatus(text, status) {
  return `
    <div class="reasoning-row-stack" data-reasoning-row-version="2">
      <div class="reasoning-row-block expanded" data-thinking-id="think_1" data-phase-key="think_1" data-reasoning-status="${status}">
        <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" data-message-id="assistant_stream" data-thinking-id="think_1" data-phase-key="think_1">
          <span class="reasoning-row-main">${text}</span>
        </button>
        <div class="reasoning-row-panel expanded" data-thinking-id="think_1" data-phase-key="think_1">
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>
  `;
}

test('reasoning patch preserves the settled class on an expanded visible panel', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <div id="timeline">
      <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
        <div class="chat-message-content">${reasoningStackWithStatus('first chunk', 'streaming')}</div>
      </article>
    </div>
  `);
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });
  const panel = timeline.querySelector('.reasoning-row-panel');
  panel.classList.add(SETTLED_CLASS);

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackWithStatus('next chunk', 'streaming'),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.ok(panel.classList.contains(SETTLED_CLASS));
});

test('reasoning patch does not add the settled class to a collapsing panel', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <div id="timeline">
      <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
        <div class="chat-message-content">${reasoningStackWithStatus('first chunk', 'streaming')}</div>
      </article>
    </div>
  `);
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });
  const panel = timeline.querySelector('.reasoning-row-panel');
  panel.dataset.collapsing = 'true';

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackWithStatus('next chunk', 'streaming'),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.equal(panel.classList.contains(SETTLED_CLASS), false);
});

test('stream reveal settles the flip-to-complete pin so a stale scrollHeight snapshot cannot clip the panel', () => {
  const dom = trackRevealDom(new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackWithStatus('first chunk', 'streaming')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `));
  const timeline = dom.window.document.getElementById('timeline');
  dom.window.requestAnimationFrame = (callback) => { callback(); return 1; };
  dom.window.cancelAnimationFrame = () => {};
  let settleTimeoutCallback = null;
  const realSetTimeout = dom.window.setTimeout.bind(dom.window);
  // The settle delay is read live from --motion-duration-regular plus an
  // 80ms margin; jsdom resolves no CSS vars, so the fallback token value
  // (220ms) applies and the armed delay is deterministically 300ms.
  dom.window.setTimeout = (callback, delayMs) => {
    if (delayMs === 300) {
      settleTimeoutCallback = callback;
      return 1;
    }
    return realSetTimeout(callback, delayMs);
  };

  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  // The reasoning phase flips to complete: the patch model's block now
  // carries data-reasoning-status="complete", driving the pin (not the
  // max-height:none streaming branch).
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackWithStatus('first chunk complete', 'complete'),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  const panel = timeline.querySelector('.reasoning-row-panel.expanded');
  assert.ok(panel, 'panel should still be present after the patch');
  assert.match(panel.style.maxHeight, /^\d+px$/, 'flip-to-complete pins a measured px height');
  assert.equal(panel.classList.contains('reasoning-row-panel--settled'), false, 'not settled yet — the timer has not fired');

  assert.equal(typeof settleTimeoutCallback, 'function', 'the settle timer must be armed on flip-to-complete');
  settleTimeoutCallback();

  assert.ok(
    panel.classList.contains('reasoning-row-panel--settled'),
    'once settled, CSS drops max-height to none so late reflow cannot clip the last line'
  );
  assert.equal(panel.style.maxHeight, '', 'settle drops the inline pin so the CSS rule governs');
});

// --- Integration: viewport-utils click-to-expand/collapse toggle ----------

test('syncThinkingBlockNode arms the settle pass on expand and clears it before collapsing', () => {
  const harness = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    assert.ok(panel, 'fixture must expose the reasoning panel by id');

    harness.setExpanded(true);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    // The expand branch measures height inside a rAF, then arms the settle
    // pass (transitionend + a getThinkingPanelTransitionMs timer fallback).
    harness.flushAnimationFrames();
    assert.equal(
      panel.classList.contains('reasoning-row-panel--settled'),
      false,
      'not settled yet — only armed; the harness has no CSS transitions so the fallback timer is what settles it'
    );

    harness.flushTimeouts();
    assert.ok(
      panel.classList.contains('reasoning-row-panel--settled'),
      'the fallback timer settles the panel once the expand transition has had a chance to finish'
    );

    // Collapsing must clear the settled marker before re-pinning a measured
    // height, so a later expand does not inherit a stale max-height:none.
    harness.setExpanded(false);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    assert.equal(
      panel.classList.contains('reasoning-row-panel--settled'),
      false,
      'collapse clears the settled class before animating the panel closed'
    );
  } finally {
    harness.restore();
  }
});

test('collapsing one reasoning phase hides only that panel when another phase stays expanded', () => {
  const harness = createThinkingViewportHarness();
  try {
    const firstPanel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    const secondPanel = global.document.getElementById('reasoning-panel-assistant_1-phase_2');
    harness.setPhaseExpanded('phase_1', true);
    harness.setPhaseExpanded('phase_2', true);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_2');
    harness.flushAnimationFrames();

    harness.setPhaseExpanded('phase_1', false);
    harness.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    harness.flushAnimationFrame();
    harness.flushTimeoutsByDelay(220);

    assert.equal(firstPanel.hidden, true, 'the completed collapse removes its panel from accessibility semantics');
    assert.equal(secondPanel.hidden, false, 'the independently expanded phase remains visible');
  } finally {
    harness.restore();
  }
});
