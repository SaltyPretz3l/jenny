const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createContextPanelController } = require('../renderer/features/renderer-chat-activity.js');
const orbitCard = require('../renderer/inventory/orbit-card.js');

// Row 115 slice 2a: the context panel is Activity's host and nothing else. No bar button opens it,
// it lists no log, and it is collapsed unless Activity is open.

// With the real Activity host, so a stored destination or collapsed flag really is read.
function bindWithStoredPreference(stored) {
  const dom = new JSDOM('<div id="chatPane0"><div data-chat-node="chatTimelineUtilityCluster"></div></div><aside id="panel"></aside>', { url: 'http://localhost/' });
  if (stored !== undefined) dom.window.localStorage.setItem('jenny.contextPanel.v1', JSON.stringify(stored));
  const documentRef = dom.window.document;
  const controller = createContextPanelController({
    state: { ui: { activeView: 'chat' } },
    dom: { chatContextPanel: documentRef.getElementById('panel') },
    callbacks: { updateComposerSafeOffset() {} },
  });
  controller.bind();
  controller.renderContextPanel();
  const result = {
    collapsed: documentRef.getElementById('panel').classList.contains('collapsed'),
    barButtons: documentRef.querySelectorAll('[data-chat-node="chatTimelineUtilityCluster"] > :not([hidden])').length,
  };
  controller.dispose();
  return result;
}

test('the context panel is collapsed whatever an older version stored, and adds no button to the bar', () => {
  for (const stored of [undefined, {}, { collapsed: true }, { collapsed: false }, { collapsed: false, destination: 'context' }]) {
    const { collapsed, barButtons } = bindWithStoredPreference(stored);
    assert.equal(collapsed, true, `collapsed for ${JSON.stringify(stored)}: a stored expand would leave an empty column with no way to close it`);
    assert.equal(barButtons, 0, 'the bar gets no context panel toggle');
  }
});

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

const RAIL_MARKUP = '<aside id="panel"><div class="context-panel-scroll"></div></aside>';

function mountRail(t, { sidePanel = null, activity = null, setActiveView = true } = {}) {
  const jsdom = new JSDOM(`<!doctype html><body>${RAIL_MARKUP}</body>`);
  const doc = jsdom.window.document;
  const calls = { views: [], ownerLines: [] };
  const state = { ui: { activeView: 'chat' }, currentSessionId: 's1' };
  const callbacks = {
    updateComposerSafeOffset() {},
    sidePanel: sidePanel ? { ...sidePanel, syncOwnerLine: (panel, mode) => calls.ownerLines.push(mode), getSessionId: () => 's1' } : null,
  };
  if (setActiveView) callbacks.setActiveView = view => calls.views.push(view);
  const controller = createContextPanelController({ state, dom: { chatContextPanel: doc.getElementById('panel') }, callbacks, createActivity: activity ? activity.createChatActivity : () => null });
  controller.bind();
  controller.renderContextPanel();
  t.after(() => controller.dispose());
  return { doc, window: jsdom.window, controller, calls, state };
}

test('the panel shows no log feed and no disclosure: Diagnostics owns the log', (t) => {
  const rail = mountRail(t);
  rail.state.logs = [{ ts: Date.now(), event: 'chat.send' }];
  rail.controller.renderContextPanel();
  assert.equal(rail.doc.querySelector('.context-log-line, .context-log-feed, .context-section-disclosure'), null);
  assert.equal(rail.doc.getElementById('panel').textContent.trim(), '', 'an empty host until Activity mounts into it');
});

test('collapseForOwnerClose closes Activity and reports whether anything was open', (t) => {
  let open = true;
  const fakeActivity = { createChatActivity: () => ({
    render() {}, bind() {}, dispose() {}, isOpen: () => open,
    close() { const was = open; open = false; return was; }, open() { open = true; return true; },
  }) };
  const rail = mountRail(t, { activity: fakeActivity });
  assert.equal(rail.controller.collapseForOwnerClose(), true);
  assert.equal(rail.controller.collapseForOwnerClose(), false, 'nothing left to close');
});

test('dispose disposes Activity', (t) => {
  let disposed = 0;
  const fakeActivity = { createChatActivity: () => ({ render() {}, bind() {}, dispose() { disposed += 1; }, isOpen: () => false, open: () => true }) };
  const rail = mountRail(t, { activity: fakeActivity });
  rail.controller.dispose();
  assert.equal(disposed, 1);
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
  assert.deepEqual(rail.calls.views, [], 'an Activity that opened does not leave the chat');
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.ownerLines.at(-1), 'activity');
  open = false;
  rail.controller.renderContextPanel();
  assert.equal(rail.calls.ownerLines.at(-1), 'context');
});

test('View activity with Activity unavailable (its flag is off) goes to Diagnostics, syncing nothing extra', (t) => {
  const fakeActivity = { createChatActivity: () => ({ render() {}, bind() {}, dispose() {}, isOpen: () => false, open: () => false }) };
  const rail = mountRail(t, { sidePanel: { claim: () => false }, activity: fakeActivity });
  const before = rail.calls.ownerLines.length;
  assert.equal(rail.controller.openActivity(), true, 'the session rail row still opens something');
  assert.deepEqual(rail.calls.views, ['logs']);
  assert.equal(rail.calls.ownerLines.length, before);
});

test('without a view switcher an unavailable Activity reports that nothing opened', (t) => {
  const fakeActivity = { createChatActivity: () => ({ render() {}, bind() {}, dispose() {}, isOpen: () => false, open: () => false }) };
  const rail = mountRail(t, { activity: fakeActivity, setActiveView: false });
  assert.equal(rail.controller.openActivity(), false);
});
