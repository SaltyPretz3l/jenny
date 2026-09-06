// Settle→follow re-drive coverage for renderer-viewport-thinking-panel-utils
// (first dedicated test file for the W5-split module; moved out of
// renderer-viewport-utils.test.js 2026-08-29 to respect the file-size ceiling).
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  createViewportThinkingPanelUtils,
} = require('../renderer/shell/renderer-viewport-thinking-panel-utils.js');

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
  let panelHeight = 100;
  Object.defineProperty(panel, 'scrollHeight', {
    configurable: true,
    get() { return panelHeight; },
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
