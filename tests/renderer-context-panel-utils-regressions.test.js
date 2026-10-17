const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createContextPanelController } = require('../renderer/features/renderer-context-panel-utils.js');

test('dispose cancels the delayed composer layout update after a panel toggle', () => {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timers = new Map();
  let nextTimerId = 0;
  let updates = 0;
  global.setTimeout = (callback) => {
    nextTimerId += 1;
    timers.set(nextTimerId, callback);
    return nextTimerId;
  };
  global.clearTimeout = (timerId) => timers.delete(timerId);

  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: {
        updateComposerSafeOffset() { updates += 1; },
        escapeHtml: String,
      },
      constants: {},
    });
    controller.bind();
    documentRef.getElementById('toggle').click();
    assert.equal(updates, 1);

    controller.dispose();
    for (const callback of timers.values()) callback();

    assert.equal(updates, 1);
    assert.equal(timers.size, 0);
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

function bindWithStoredPreference(stored) {
  const dom = new JSDOM('<button id="toggle"></button><aside id="panel"></aside>');
  const documentRef = dom.window.document;
  const originalLocalStorage = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => (stored === undefined ? null : JSON.stringify(stored)),
      setItem() {},
    },
  });
  try {
    const controller = createContextPanelController({
      state: { ui: { activeView: 'chat' } },
      dom: {
        chatContextPanel: documentRef.getElementById('panel'),
        contextPanelToggle: documentRef.getElementById('toggle'),
      },
      callbacks: { updateComposerSafeOffset() {}, escapeHtml: String },
      constants: {},
    });
    controller.bind();
    const collapsed = documentRef.getElementById('panel').classList.contains('collapsed');
    controller.dispose();
    return collapsed;
  } finally {
    if (originalLocalStorage === undefined) {
      delete globalThis.localStorage;
    } else {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
    }
  }
}

test('the context panel starts collapsed unless the user explicitly expanded it', () => {
  assert.equal(bindWithStoredPreference(undefined), true, 'fresh profile collapses');
  assert.equal(bindWithStoredPreference({}), true, 'stored prefs without the key collapse');
  assert.equal(bindWithStoredPreference({ collapsed: true }), true);
  assert.equal(bindWithStoredPreference({ collapsed: false }), false, 'an explicit expand is honored');
});

// Row 59 checkpoint 2: the context panel dropped its Artifacts list (the session rail's Outputs row opens
// the artifact review panel). It keeps the toggle, the Diagnostic log and Activity.
const orbitCard = require('../renderer/inventory/orbit-card.js');

const RAIL_MARKUP = '<aside id="panel">'
  + '<section id="contextArtifactSection"><div class="context-section-header">'
  + '<button id="contextPanelToggle" type="button"></button></div></section>'
  + '<section class="logs-collapsed" id="contextLogSection">'
  + '<button id="contextLogDisclosure" type="button" aria-expanded="false"><span id="contextLogCount">0</span></button>'
  + '<div id="contextSessionLogs" hidden></div></section></aside>';

function mountRail(t, { logs = [], sidePanel = null, activity = null } = {}) {
  const jsdom = new JSDOM(`<!doctype html><body>${RAIL_MARKUP}</body>`);
  const doc = jsdom.window.document;
  const ctx = { logs };
  const calls = { views: [], artifactReads: 0, ownerLines: [] };
  const state = { ui: { activeView: 'chat' }, currentSessionId: 's1', artifacts: {} };
  const originalI18n = globalThis.jennyI18n;
  const originalActivity = globalThis.rendererChatActivity;
  globalThis.jennyI18n = { tag: () => 'en' };
  if (activity) globalThis.rendererChatActivity = activity;
  const callbacks = {
    escapeHtml: orbitCard.escapeHtml,
    updateComposerSafeOffset() {},
    setActiveView: view => calls.views.push(view),
    getArtifactsForSession: () => { calls.artifactReads += 1; return [{ id: 'a1', title: 'Plan' }]; },
    getLogEntries: () => ctx.logs,
    openArtifactTarget: () => Promise.resolve(),
    sidePanel: sidePanel ? { ...sidePanel, syncOwnerLine: (panel, mode) => calls.ownerLines.push(mode), getSessionId: () => 's1' } : null,
  };
  const controller = createContextPanelController({
    state,
    dom: {
      chatContextPanel: doc.getElementById('panel'),
      contextSessionLogs: doc.getElementById('contextSessionLogs'),
      contextPanelToggle: doc.getElementById('contextPanelToggle'),
      // A stale composition may still hand these over: the panel ignores them.
      contextArtifactList: doc.getElementById('contextArtifactList'),
      contextArtifactExpand: doc.getElementById('contextArtifactExpand'),
    },
    callbacks,
    constants: {},
  });
  controller.bind();
  controller.renderContextPanel();
  t.after(() => {
    controller.dispose();
    if (originalI18n === undefined) delete globalThis.jennyI18n;
    else globalThis.jennyI18n = originalI18n;
    if (originalActivity === undefined) delete globalThis.rendererChatActivity;
    else globalThis.rendererChatActivity = originalActivity;
  });
  return { doc, window: jsdom.window, controller, ctx, calls, state };
}

test('orbitCard renders tone, tooltip and a leading escaped status span', () => {
  const html = orbitCard({ id: 'a"1', title: '<b>T</b>', meta: 'x<y', tooltip: 'say "hi"', tone: 'muted', status: '<Failed>', statusTone: 'danger' });
  const { window } = new JSDOM(`<!doctype html><body>${html}</body>`);
  const button = window.document.querySelector('button.orbit-card');
  assert.equal(button.dataset.tone, 'muted');
  assert.equal(button.getAttribute('title'), 'say "hi"');
  assert.equal(button.dataset.orbitCardId, 'a"1');
  assert.equal(button.querySelector('.orbit-card-title').textContent, '<b>T</b>');
  const status = button.querySelector('.orbit-card-meta .orbit-card-status');
  assert.equal(status.textContent, '<Failed>');
  assert.equal(status.dataset.tone, 'danger');
  // Status leads the meta line so a long detail can never ellipsize it away.
  assert.equal(button.querySelector('.orbit-card-meta').textContent, '<Failed> · x<y');
  // Existing opts keep their existing output; the title takes its own
  // direction (2026-09-27 gate N4: English under the Arabic locale).
  assert.equal(orbitCard({ id: 'b', title: 'T', meta: 'M' }),
    '<button class="orbit-card" type="button" data-orbit-card-id="b"><span class="orbit-card-icon" aria-hidden="true"></span>'
    + '<span class="orbit-card-body"><span class="orbit-card-title" dir="auto">T</span><span class="orbit-card-meta">M</span></span></button>');
});

test('the panel no longer lists artifacts: nothing is read, rendered or listened to', (t) => {
  const rail = mountRail(t);
  rail.controller.renderContextPanel();
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.artifactReads, 0, 'the artifact source is never read');
  assert.equal(rail.doc.querySelector('.context-artifact-item'), null);
  assert.equal(rail.doc.querySelector('.orbit-card'), null);
  assert.doesNotMatch(rail.doc.getElementById('panel').textContent, /Files, images, and tool results/);
});

test('the toggle outlives the Artifacts list and still collapses and expands the panel', (t) => {
  const rail = mountRail(t);
  const panel = rail.doc.getElementById('panel');
  const toggle = rail.doc.getElementById('contextPanelToggle');
  assert.equal(panel.classList.contains('collapsed'), true, 'collapsed by default');
  toggle.click();
  assert.equal(panel.classList.contains('collapsed'), false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  toggle.click();
  assert.equal(panel.classList.contains('collapsed'), true);
});

test('the Activity disclosure toggles the feed and stays visible with zero entries', (t) => {
  const rail = mountRail(t, { logs: [] });
  const disclosure = rail.doc.getElementById('contextLogDisclosure');
  const feed = rail.doc.getElementById('contextSessionLogs');
  const section = rail.doc.getElementById('contextLogSection');
  assert.equal(disclosure.classList.contains('hidden'), false);
  assert.equal(disclosure.disabled, false);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(feed.hidden, true);
  assert.equal(section.classList.contains('logs-collapsed'), true);
  assert.equal(rail.doc.getElementById('contextLogCount').textContent, '0');

  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.equal(feed.hidden, false);
  assert.equal(section.classList.contains('logs-collapsed'), false);
  assert.equal(feed.querySelector('p.context-empty-state').textContent, 'Nothing logged yet.');

  rail.ctx.logs = [{ ts: Date.now(), event: 'chat.send' }];
  rail.controller.renderContextPanel();
  assert.equal(feed.querySelectorAll('.context-log-line').length, 1);
  assert.equal(rail.doc.getElementById('contextLogCount').textContent, '1');

  rail.ctx.logs = [];
  rail.controller.renderContextPanel();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true', 'emptying the feed keeps the user\'s expanded state');
  assert.equal(feed.hidden, false);

  disclosure.click();
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(feed.hidden, true);
  assert.equal(section.classList.contains('logs-collapsed'), true);
});

test('Activity-enabled context replaces log disclosure with diagnostic navigation',t=>{
 const rail=mountRail(t,{logs:[{event:'test'}]});rail.state.features={featureFlags:{activity_monitor:true}};
 rail.controller.renderContextPanel();const button=rail.doc.getElementById('contextLogDisclosure');
 assert.equal(button.hasAttribute('aria-expanded'),false);button.click();assert.deepEqual(rail.calls.views,['logs']);assert.equal(rail.doc.getElementById('contextSessionLogs').hidden,true);
});

test('the owner line is synced as "context" normally and as "activity" while Activity is open', (t) => {
  let open = false;
  const fakeActivity = { createChatActivity: () => ({
    render() {}, bind() {}, dispose() {}, close() { open = false; },
    isOpen: () => open,
    open() { open = true; return true; },
  }) };
  const rail = mountRail(t, { sidePanel: { claim: () => false }, activity: fakeActivity });
  assert.equal(rail.calls.ownerLines.at(-1), 'context');
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.ownerLines.at(-1), 'context');
  assert.equal(rail.controller.openActivity(), true);
  assert.equal(rail.calls.ownerLines.at(-1), 'activity', 'Activity names its owner in one-pane view too');
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.ownerLines.at(-1), 'activity');
  open = false;
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.ownerLines.at(-1), 'context');
});

test('opening Activity that does not open syncs nothing extra', (t) => {
  const fakeActivity = { createChatActivity: () => ({ render() {}, bind() {}, dispose() {}, isOpen: () => false, open: () => false }) };
  const rail = mountRail(t, { sidePanel: { claim: () => false }, activity: fakeActivity });
  const before = rail.calls.ownerLines.length;
  assert.equal(rail.controller.openActivity(), false);
  assert.equal(rail.calls.ownerLines.length, before);
});
