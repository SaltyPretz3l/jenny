// Settle→follow re-drive coverage for renderer-viewport-thinking-panel-utils
// (first dedicated test file for the W5-split module; moved out of
// renderer-viewport-utils.test.js 2026-08-29 to respect the file-size ceiling).
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { createThinkingViewportHarness } = require('./helpers/renderer-viewport-utils-helpers');
const { createImmediateRevealController, disposeTrackedRevealDoms } = require('./helpers/renderer-stream-reveal-harness');

test.afterEach(() => disposeTrackedRevealDoms());

const {
  createViewportThinkingPanelUtils,
} = require('../renderer/shell/renderer-viewport-thinking-panel-utils.js');

test('user collapse stays visible through post-layout frames until its hide timer', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => 300 });
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames();
    h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames();
    assert.equal(panel.hidden, false, 'post-layout sync must not truncate the user collapse');
    h.flushTimeouts();
    assert.equal(panel.hidden, true);
    assert.equal(panel.hasAttribute('data-collapsing'), false);
  } finally { h.restore(); }
});

test('user collapse clips the expanded panel until its hide timer', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames(); h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames();
    assert.equal(panel.classList.contains('expanded'), true, 'collapse frame keeps .expanded for a pure clip');
    assert.equal(panel.dataset.collapsing, 'true');
    assert.equal(panel.style.maxHeight, '0px');
    assert.equal(panel.hidden, false);
    h.flushTimeouts();
    assert.equal(panel.classList.contains('expanded'), false);
    assert.equal(panel.hidden, true);
    assert.equal(panel.hasAttribute('data-collapsing'), false);
    assert.equal(panel.style.maxHeight, '', 'the hide timer drops the 0px pin');
  } finally { h.restore(); }
});

test('disposing mid user-collapse finishes the collapse instead of stranding data-collapsing', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames(); h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames();
    assert.equal(panel.dataset.collapsing, 'true');
    h.controller.disposeViewportController();
    assert.equal(panel.hasAttribute('data-collapsing'), false);
    assert.equal(panel.classList.contains('expanded'), false);
    assert.equal(panel.hidden, true);
    assert.equal(panel.style.maxHeight, '');
  } finally { h.restore(); }
});

test('a stream patch during user collapse keeps the panel visible', () => {
  const previous = { window: global.window, document: global.document };
  const stack = (text) => `<div class="reasoning-row-stack" data-reasoning-row-version="2">
    <div class="reasoning-row-block expanded" data-thinking-id="think_1" data-phase-key="think_1" data-reasoning-status="streaming">
      <button class="reasoning-row-header" data-reasoning-toggle data-message-id="assistant_stream" data-phase-key="think_1" aria-controls="panel1">Toggle</button>
      <div id="panel1" class="reasoning-row-panel expanded" data-thinking-id="think_1" data-phase-key="think_1"><div class="reasoning-row-panel-body">${text}</div></div>
    </div></div>`;
  const { dom, timeline, controller } = createImmediateRevealController(`<div id="timeline">
    <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
      <div class="chat-message-content">${stack('chunk 1')}</div></article></div>`);
  global.window = dom.window; global.document = dom.window.document;
  const frames = [];
  const viewport = createViewportThinkingPanelUtils({ state: { ui: {} }, dom: { chatTimeline: timeline },
    controllers: { thinkingController: { isPhaseExpanded: () => false }, reducedMotionQuery: { matches: false } },
    callbacks: { escapeSelectorValue: (v) => v },
    scheduling: { scheduleTransientViewportFrame: (cb) => frames.push(cb), scheduleTransientViewportTimer() {}, schedulePostLayoutViewportSync() {} } });
  try {
    controller.commitFullRender({ currentSessionId: 's', structureSignature: 10,
      streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
      streamingArticleMessageId: 'assistant_stream' });
    const panel = timeline.querySelector('.reasoning-row-panel');
    viewport.syncThinkingBlockNode('assistant_stream', 'think_1');
    frames.splice(0).forEach((cb) => cb());
    controller.queuePatch({ currentSessionId: 's', structureSignature: 10, latestAssistantMessageId: 'assistant_stream',
      streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
      messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
      buildMessageNodeState: () => ({ bubbleInnerHtml: null, thinkingMarkup: stack('chunk 2').replaceAll(' expanded', ''),
        innerHtml: '', pending: true, entryReveal: false, status: 'streaming', finalizedAt: '' }) });
    viewport.syncRenderedThinkingPanels(timeline);
    assert.equal(panel.hidden, false, 'stream-patch sync must not truncate the user collapse');
    assert.equal(panel.querySelector('.reasoning-row-panel-body').textContent, 'chunk 2');
  } finally {
    viewport.disposeThinkingPanelWork();
    global.window = previous.window; global.document = previous.document;
  }
});

test('collapse then expand within one frame leaves the reasoning panel expanded and visible', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames(); h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames(); h.flushTimeouts();
    assert.equal(panel.classList.contains('expanded'), true, 'latest expand must keep .expanded');
    assert.equal(panel.hidden, false);
    assert.notEqual(panel.style.maxHeight, '0px');
  } finally { h.restore(); }
});

test('sync over settled unchanged panels performs zero geometry reads', () => {
  const dom = new JSDOM(`<div id="timeline">${Array.from({ length: 20 }, () =>
    '<div class="reasoning-row-block" data-reasoning-status="complete"><div class="reasoning-row-panel expanded reasoning-row-panel--settled"><div class="reasoning-row-panel-body">body</div></div></div>').join('')}</div>`);
  let reads = 0;
  for (const el of dom.window.document.querySelectorAll('.reasoning-row-panel, .reasoning-row-panel-body')) {
    for (const property of ['scrollHeight', 'offsetHeight']) {
      Object.defineProperty(el, property, { configurable: true, get() { reads += 1; return 100; } });
    }
    el.getBoundingClientRect = () => { reads += 1; return { height: 100 }; };
  }
  const controller = createViewportThinkingPanelUtils({ state: { ui: {} },
    dom: { chatTimeline: dom.window.document.getElementById('timeline') },
    controllers: { thinkingController: {}, reducedMotionQuery: { matches: false } },
    callbacks: {}, scheduling: {} });
  try {
    controller.syncRenderedThinkingPanels();
    reads = 0;
    controller.syncRenderedThinkingPanels();
    assert.equal(reads, 0, 'settled unchanged panels must not read geometry');
  } finally { controller.disposeThinkingPanelWork(); dom.window.close(); }
});

test('reasoning reopen reverses from the live collapse height and leaves streaming unpinned', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    const block = panel.closest('.reasoning-row-block');
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrames(); h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.flushAnimationFrame();
    const original = global.window.getComputedStyle;
    global.window.getComputedStyle = (el) => el === panel ? { maxHeight: '135.5px' } : original(el);
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    assert.equal(panel.style.maxHeight, '135.5px');
    assert.equal(panel.hasAttribute('data-collapsing'), false);
    h.flushAnimationFrames(); h.flushTimeouts();
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    block.dataset.reasoningStatus = 'streaming';
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    assert.equal(panel.style.maxHeight, 'none', 'streaming reopen never takes a px pin');
    h.flushAnimationFrames(); h.flushTimeouts();
    assert.equal(panel.style.maxHeight, 'none');
    assert.equal(panel.hidden, false);
    assert.equal(panel.classList.contains('expanded'), true);
  } finally { h.restore(); }
});

test('reasoning expand then collapse within one frame ignores the stale expand frame', () => {
  const h = createThinkingViewportHarness();
  try {
    const panel = global.document.getElementById('reasoning-panel-assistant_1-phase_1');
    let height = 300;
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, get: () => height });
    h.setExpanded(true);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    h.setExpanded(false);
    h.controller.syncThinkingBlockNode('assistant_1', 'phase_1');
    const pin = panel.style.maxHeight;
    height = 420;
    h.flushAnimationFrame();
    assert.equal(panel.style.maxHeight, pin, 'stale expand must not grow the collapsing panel');
    h.flushAnimationFrames(); h.flushTimeouts();
    assert.equal(panel.hidden, true);
    assert.equal(panel.classList.contains('expanded'), false);
    assert.equal(panel.hasAttribute('data-collapsing'), false);
  } finally { h.restore(); }
});

test('streaming expanded panels stay unmeasured with an unconstrained max-height', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="timeline">
      <div class="reasoning-row-block" data-reasoning-status="streaming">
        <div class="reasoning-row-panel expanded" style="max-height: 80px">
          <div class="reasoning-row-panel-body">Reasoning body</div>
        </div>
      </div>
    </div>
  </body></html>`);
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const body = panel.querySelector('.reasoning-row-panel-body');
  let geometryReads = 0;
  for (const element of [panel, body]) {
    for (const property of ['scrollHeight', 'offsetHeight']) {
      Object.defineProperty(element, property, {
        configurable: true,
        get() { geometryReads += 1; return 140; },
      });
    }
  }
  const controller = createViewportThinkingPanelUtils({
    state: { ui: { followLatest: true } },
    dom: { chatTimeline: dom.window.document.getElementById('timeline') },
    controllers: {
      thinkingController: { shouldAutoScroll: () => true },
      reducedMotionQuery: { matches: false },
    },
    callbacks: { isDisposed: () => false },
    scheduling: {},
  });

  try {
    controller.syncRenderedThinkingPanels();
    assert.equal(panel.hidden, false);
    assert.equal(panel.style.maxHeight, 'none');
    assert.equal(geometryReads, 0);
  } finally {
    controller.disposeThinkingPanelWork();
    dom.window.close();
  }
});

test('complete expanded panels remain measured and pinned', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="timeline">
      <div class="reasoning-row-block" data-reasoning-status="complete">
        <div class="reasoning-row-panel expanded" style="max-height: 80px">
          <div class="reasoning-row-panel-body">Reasoning body</div>
        </div>
      </div>
    </div>
  </body></html>`);
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  const body = panel.querySelector('.reasoning-row-panel-body');
  let geometryReads = 0;
  for (const element of [panel, body]) {
    for (const property of ['scrollHeight', 'offsetHeight']) {
      Object.defineProperty(element, property, {
        configurable: true,
        get() { geometryReads += 1; return 140; },
      });
    }
  }
  const controller = createViewportThinkingPanelUtils({
    state: { ui: { followLatest: true } },
    dom: { chatTimeline: dom.window.document.getElementById('timeline') },
    controllers: {
      thinkingController: { shouldAutoScroll: () => true },
      reducedMotionQuery: { matches: false },
    },
    callbacks: { isDisposed: () => false },
    scheduling: {},
  });

  try {
    controller.syncRenderedThinkingPanels();
    assert.ok(geometryReads > 0);
    assert.match(panel.style.maxHeight, /^\d+px$/);
  } finally {
    controller.disposeThinkingPanelWork();
    dom.window.close();
  }
});

function createThinkingPanelSettleSyncHarness({ followLatest, autoScroll }) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="timeline">
      <div class="reasoning-row-panel expanded">
        <div class="reasoning-row-panel-body">Reasoning body</div>
      </div>
    </div>
  </body></html>`);
  global.window = dom.window;
  global.document = dom.window.document;
  const panel = global.document.querySelector('.reasoning-row-panel');
  // Start mid-expansion: settled panels with no pending growth skip measurement.
  panel.style.maxHeight = '80px';
  let panelHeight = 100;
  let geometryReads = 0;
  Object.defineProperty(panel, 'scrollHeight', {
    configurable: true,
    get() { geometryReads += 1; return panelHeight; },
  });
  const scheduledSyncs = [];
  const controller = createViewportThinkingPanelUtils({
    state: { ui: { followLatest } },
    dom: { chatTimeline: global.document.getElementById('timeline') },
    controllers: {
      thinkingController: { shouldAutoScroll: () => autoScroll },
      reducedMotionQuery: { matches: false },
    },
    callbacks: { isDisposed: () => false },
    scheduling: {
      schedulePostLayoutViewportSync(options) { scheduledSyncs.push(options); },
    },
  });

  controller.syncRenderedThinkingPanels();
  panelHeight = 140;
  controller.syncRenderedThinkingPanels();

  return {
    panel,
    scheduledSyncs,
    resyncSameHeight() {
      controller.syncRenderedThinkingPanels();
    },
    grow(height) {
      panelHeight = height;
      controller.syncRenderedThinkingPanels();
    },
    get geometryReads() { return geometryReads; },
    settle() {
      const event = new dom.window.Event('transitionend');
      Object.defineProperty(event, 'propertyName', { value: 'max-height' });
      panel.dispatchEvent(event);
    },
    restore() {
      controller.disposeThinkingPanelWork();
      dom.window.close();
      global.window = previousWindow;
      global.document = previousDocument;
    },
  };
}

test('thinking panel settle schedules exactly one additional viewport sync while following', () => {
  const harness = createThinkingPanelSettleSyncHarness({
    followLatest: true,
    autoScroll: true,
  });

  try {
    harness.settle();
    harness.settle();

    assert.equal(harness.scheduledSyncs.length, 1);
    assert.deepEqual(harness.scheduledSyncs[0], {
      syncOptions: { preserveFollowLatest: true },
    });
  } finally {
    harness.restore();
  }
});

// 2026-08-29 review fix: every sync re-arms the settle and cancels the prior
// arm's listener, so a zero-growth sync landing mid-transition used to drop
// the pending growth flag and strand the follow re-drive.
test('a zero-growth re-arm between growth and settle still drives the follow sync', () => {
  const harness = createThinkingPanelSettleSyncHarness({
    followLatest: true,
    autoScroll: true,
  });

  try {
    // Same height as the last sync: re-arms the settle with no growth while
    // the growth transition from the harness setup is still pending.
    harness.resyncSameHeight();

    harness.settle();

    assert.equal(harness.scheduledSyncs.length, 1);
  } finally {
    harness.restore();
  }
});

test('thinking panel settle schedules no viewport sync when follow is inactive', () => {
  const cases = [
    { followLatest: false, autoScroll: true },
    { followLatest: true, autoScroll: false },
  ];

  for (const options of cases) {
    const harness = createThinkingPanelSettleSyncHarness(options);
    try {
      harness.settle();
      assert.equal(harness.scheduledSyncs.length, 0);
    } finally {
      harness.restore();
    }
  }
});

// 2026-09-01 review fix (motion polish S1): settle clears the inline pin so
// the CSS max-height:none rule governs — which made `'' !== px` read as growth
// on every later sync, re-arming settle whose follow re-drive scheduled the
// next sync forever. Growth is now judged on the measured height.
// S3 (R3-6): a settled panel at rest is never re-measured. Content that grows
// afterwards is carried by CSS max-height:none, with no pin and no follow
// re-drive; the follow re-drive belongs to the expand transition only.
test('a settled panel at rest that grows later is neither re-measured nor re-pinned', () => {
  const harness = createThinkingPanelSettleSyncHarness({ followLatest: true, autoScroll: true });
  try {
    harness.settle();
    const readsAfterSettle = harness.geometryReads;
    harness.grow(400);
    assert.equal(harness.geometryReads, readsAfterSettle, 'no geometry read on a settled panel at rest');
    assert.equal(harness.panel.style.maxHeight, '', 'max-height:none keeps carrying the height');
    assert.ok(harness.panel.classList.contains('reasoning-row-panel--settled'));
    harness.settle();
    assert.equal(harness.scheduledSyncs.length, 1, 'no follow re-drive for settled growth');
  } finally {
    harness.restore();
  }
});

test('a settled panel at rest is left alone by later syncs (no settle/sync loop)', () => {
  const harness = createThinkingPanelSettleSyncHarness({
    followLatest: true,
    autoScroll: true,
  });

  try {
    harness.settle();
    assert.equal(harness.scheduledSyncs.length, 1);
    assert.equal(harness.panel.style.maxHeight, '', 'settle dropped the inline pin');

    harness.resyncSameHeight();
    assert.ok(harness.panel.classList.contains('reasoning-row-panel--settled'), 'still settled');
    assert.equal(harness.panel.style.maxHeight, '', 'no re-pin on a settled panel at rest');

    harness.settle();
    assert.equal(harness.scheduledSyncs.length, 1, 'no second follow re-drive');
  } finally {
    harness.restore();
  }
});

// B3 (review batch): the settle registry lives in settle-utils so the viewport's
// clear cancels a settle armed by the stream reveal controller as well.
const {
  armThinkingPanelSettle,
  clearThinkingPanelSettle,
  SETTLED_CLASS,
} = require('../renderer/shell/renderer-thinking-panel-settle-utils');

test('clearThinkingPanelSettle cancels a settle armed by any owner, and re-arming replaces the previous arm', () => {
  const dom = new JSDOM('<div class="reasoning-row-panel expanded" style="max-height: 90px"></div>');
  const panel = dom.window.document.querySelector('.reasoning-row-panel');
  let timeoutCallback = null;
  dom.window.setTimeout = (cb) => { timeoutCallback = cb; return 1; };
  const timer = { get: () => timeoutCallback };
  let cleanups = 0;
  armThinkingPanelSettle(panel, { transitionMs: 100, onCleanup: () => { cleanups += 1; } });
  clearThinkingPanelSettle(panel);
  assert.equal(cleanups, 1, 'clearing cancels the armed settle');
  timer.get()();
  assert.equal(panel.classList.contains(SETTLED_CLASS), false, 'the cancelled timer is inert');
  assert.equal(panel.style.maxHeight, '90px');

  armThinkingPanelSettle(panel, { transitionMs: 100, onCleanup: () => { cleanups += 1; } });
  armThinkingPanelSettle(panel, { transitionMs: 100 });
  assert.equal(cleanups, 2, 're-arming cancels the previous arm');
  timer.get()();
  assert.equal(panel.classList.contains(SETTLED_CLASS), true);
  assert.equal(panel.style.maxHeight, '');
  dom.window.close();
});
