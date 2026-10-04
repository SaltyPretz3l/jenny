'use strict';

/* Split view W2-2a -- each pane's composer rail reads and writes ITS session.
 *
 * Before this slice pane 1's toolbar had no model pill, no effort control and
 * no run-mode chip, and pane 0's rail showed the FOCUSED pane's session (the
 * chrome read the active session). Now pane 0's rail reads pane 0's session
 * (renderer-render-pipeline-chrome.js getPaneRuntimePreferences) and pane 1
 * mounts its own rail (renderer/chat/renderer-pane-composer-rail.js) whose
 * writes carry pane 1's session (bindComposerRailEvents -> the activity
 * controller's `sessionId`), and a send resolves the REQUESTED session's
 * preferences (resolveSendRuntimePreferences `fromSession`).
 *
 * The real shell (jsdom harness) with two panes: pane 0 on session-a (model
 * qwen3.5:9b, effort high, run mode ask), pane 1 on session-b (llava:7b, low,
 * auto). The first two tests pin the one-pane identity at unit level.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { createSettingsEventBindings } = require('../renderer/chat/renderer-chat-event-settings-bindings.js');
const { resolvePaneRuntimePreferences } = require('../renderer/chat/renderer-render-pipeline-chrome.js');

const MODELS = [
  { id: 'qwen3.5:9b', engine_type: 'ollama', capabilities: { reasoning_efforts: ['low', 'medium', 'high'] } },
  { id: 'llava:7b', engine_type: 'ollama', capabilities: { reasoning_efforts: ['low', 'medium', 'high'] } },
];

function buildSummary(id, title, prefs) {
  return {
    id,
    title,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: prefs.model,
    reasoning_effort: prefs.effort,
    run_mode: prefs.runMode,
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function transcript(sessionId, text) {
  return [
    { id: `user_${sessionId}`, role: 'user', content: `Question for ${text}`, status: 'complete' },
    { id: `assistant_${sessionId}`, role: 'assistant', content: `Answer from ${text}.`, status: 'complete', finalizedAt: new Date().toISOString() },
  ];
}

const SESSIONS = () => [
  buildSummary('session-a', 'Alpha', { model: 'qwen3.5:9b', effort: 'high', runMode: 'ask' }),
  buildSummary('session-b', 'Beta', { model: 'llava:7b', effort: 'low', runMode: 'auto' }),
];

async function bootApp(t, { openSessionIds = ['session-a', 'session-b'], extraShell = {} } = {}) {
  const app = await loadRendererApp({ shell: {
    sessions: SESSIONS(),
    workspaceState: { activeSessionId: 'session-a', openSessionIds },
    sessionMessagePayloads: {
      'session-a': { data: transcript('session-a', 'pane zero') },
      'session-b': { data: transcript('session-b', 'pane one') },
    },
    models: { list: () => ({ object: 'list', active_model: '', available: true, reason: '', data: MODELS }) },
    ...extraShell,
  } });
  t.after(() => app.dispose());
  const { window } = app;
  await waitForUi(window, 150);
  // The harness store keeps run_mode out of setPreferences; record every write
  // and echo the full mapped preferences back as the persisted summary.
  const writes = [];
  window.jennyShell.sessions.setPreferences = async (sessionId, preferences) => {
    writes.push({ sessionId, preferences: JSON.parse(JSON.stringify(preferences)) });
    const session = window.__rendererState.sessions.find((entry) => entry.id === sessionId) || {};
    return { ...session, ...preferences };
  };
  return { app, window, doc: window.document, writes };
}

async function openTwoPanes(t, options = {}) {
  const booted = await bootApp(t, options);
  const { window } = booted;
  if (typeof options.beforeOpen === 'function') options.beforeOpen(window);
  const composition = window.rendererAppPaneComposition.getPaneComposition();
  assert.equal(composition.toggleSplit(), true, 'precondition: the chord opens session-b beside');
  await waitForUi(window, 150);
  const pane1 = composition.getPane(1);
  assert.ok(pane1 && pane1.rail, 'pane 1 is mounted with a rail');
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'pane 0 keeps focus');
  return { ...booted, composition, pane1 };
}

function railOf(pane1) {
  return pane1.rail.dom;
}

function pillLabel(pill) {
  return pill.querySelector('.inv-chip-label').textContent;
}

function runModeClass(chip) {
  return ['ask', 'auto', 'plan'].find((mode) => chip.classList.contains(`composer-run-mode-${mode}`));
}

function focusPaneOne(window, pane1) {
  pane1.dom.chatInput.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
}

test('pane 0 keeps today\'s settings listener order with the rail listeners inside it (pin)', (t) => {
  const dom = new JSDOM(`<!doctype html><body>
    <div id="toastViewport"></div><select id="composerModelSelect"></select><select id="composerEffortSelect"></select>
    <div id="composerRunModeSlot"></div>
  </body>`);
  const previousDocument = global.document;
  global.document = dom.window.document;
  t.after(() => { global.document = previousDocument; dom.window.close(); });
  const doc = dom.window.document;
  const bindings = createSettingsEventBindings({
    toastViewport: doc.getElementById('toastViewport'),
    composerModelSelect: doc.getElementById('composerModelSelect'),
    composerEffortSelect: doc.getElementById('composerEffortSelect'),
    state: { ui: {} },
    TOAST_SOURCE: {},
    ACTIVITY_SCOPE: {},
    getCurrentRuntimePreferences: () => ({}),
    toastActionHandlers: new Map(),
  });
  const order = [];
  bindings.bindSettingsEvents((target, type) => { order.push(`${target.id}:${type}`); }, {});
  t.after(() => bindings.dispose());
  assert.deepEqual(order, [
    'toastViewport:click',
    'composerModelSelect:change',
    'composerEffortSelect:change',
    'composerRunModeSlot:click',
  ]);
});

test('with one pane the pane preferences ARE the current preferences (shape and values)', () => {
  const session = { id: 'session-a', preferred_model: 'm', reasoning_effort: 'high', run_mode: 'ask', plan_mode: false };
  const fromSession = (entry) => ({ preferredModel: entry.preferred_model, reasoningEffort: entry.reasoning_effort, runMode: entry.run_mode, planMode: entry.plan_mode === true, contextPreferences: {} });
  const state = { currentSessionId: 'session-a', sessions: [session] };
  const current = () => fromSession(state.sessions.find((entry) => entry.id === state.currentSessionId));
  assert.deepEqual(resolvePaneRuntimePreferences({ state, sessionId: 'session-a', fromSession, current }), current());
  const draft = { preferredModel: '', reasoningEffort: 'default', contextPreferences: {} };
  assert.equal(resolvePaneRuntimePreferences({ state, sessionId: '', fromSession, current: () => draft }), draft, 'no session: the current (draft) object itself');
  assert.equal(resolvePaneRuntimePreferences({ state, sessionId: 'session-a', fromSession: null, current: () => draft }), draft, 'no reader: the current object itself');
});

test('one pane: pane 0\'s carriers and run-mode slot render byte-identically (pin)', async (t) => {
  const { window, doc } = await bootApp(t, { openSessionIds: ['session-a'] });
  assert.equal(window.rendererAppPaneComposition.getPaneComposition().getPaneCount(), 1);
  assert.equal(doc.getElementById('composerModelSelect').innerHTML,
    '<option value="">Use default</option><option value="qwen3.5:9b" data-engine-type="ollama" selected="">qwen3.5:9b</option>'
    + '<option value="llava:7b" data-engine-type="ollama">llava:7b</option>');
  assert.equal(doc.getElementById('composerModelSelect').value, 'qwen3.5:9b');
  assert.equal(doc.getElementById('composerEffortSelect').innerHTML,
    '<option value="default">Use default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>');
  assert.equal(doc.getElementById('composerEffortSelect').value, 'high');
  const slot = doc.getElementById('composerRunModeSlot');
  assert.equal(slot.children.length, 2, 'the chip, then the popover\'s Ask / Auto / Plan segments');
  assert.equal(slot.firstElementChild.id, 'composerRunModeChip');
  assert.equal(slot.firstElementChild.getAttribute('class'), 'inv-chip composer-run-mode-chip composer-run-mode-ask');
  assert.equal(slot.firstElementChild.querySelector('.inv-chip-label').textContent, 'Ask');
  const segments = slot.lastElementChild;
  assert.equal(segments.classList.contains('composer-run-mode-segments'), true);
  assert.deepEqual([...segments.querySelectorAll('[data-run-mode-option]')].map((node) => [node.getAttribute('data-run-mode-option'), node.getAttribute('aria-pressed')]),
    [['ask', 'true'], ['auto', 'false'], ['plan', 'false']]);
});

test('each pane\'s rail names its own session: select values, pill label, run-mode chip', async (t) => {
  const { doc, pane1 } = await openTwoPanes(t);
  const rail = railOf(pane1);
  assert.equal(pane1.root.contains(rail.composerModelSelect), true, 'pane 1 owns its carriers');
  assert.equal(rail.composerModelSelect.hasAttribute('id'), false, 'no duplicated ids in the clone');
  const railIds = [rail.composerRunModeSlot, rail.composerModelPillSlot, pane1.root.querySelector('[data-chat-node="composerModeChips"]')]
    .flatMap((host) => [host, ...host.querySelectorAll('*')]).filter((node) => node.id).map((node) => node.id);
  assert.deepEqual(railIds, ['composerModelPopoverPane1'], 'the only id in pane 1\'s rail is its popover\'s per-pane id');
  assert.equal(rail.composerModelPopover.id, 'composerModelPopoverPane1');
  assert.equal(rail.composerModelPill.getAttribute('aria-controls'), 'composerModelPopoverPane1');

  assert.equal(doc.getElementById('composerModelSelect').value, 'qwen3.5:9b');
  assert.equal(doc.getElementById('composerEffortSelect').value, 'high');
  assert.equal(rail.composerModelSelect.value, 'llava:7b');
  assert.equal(rail.composerEffortSelect.value, 'low');

  assert.equal(pillLabel(doc.getElementById('composerModelPill')).startsWith('qwen3.5'), true, pillLabel(doc.getElementById('composerModelPill')));
  assert.equal(pillLabel(rail.composerModelPill).startsWith('llava'), true, pillLabel(rail.composerModelPill));

  assert.equal(runModeClass(doc.getElementById('composerRunModeChip')), 'ask');
  const chip1 = rail.composerRunModeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
  assert.equal(runModeClass(chip1), 'auto');
  assert.equal(chip1.hasAttribute('id'), false);
  assert.equal(chip1.getAttribute('title').startsWith('Auto · '), true, 'pane 1 chip carries its own run-mode hint');
  assert.notEqual(chip1.getAttribute('title'), doc.getElementById('composerRunModeChip').getAttribute('title'));

  // Rail contents first, then Stop, then Send (W1-4c order kept). W3-3: the two
  // slots sit in the settings group, the summary pill follows it.
  const railChildren = [...pane1.root.querySelector('.composer-rail').children];
  assert.deepEqual(railChildren.map((node) => node.getAttribute('data-chat-node') || node.getAttribute('data-inv-chip') || node.className.split(' ')[0]),
    ['composerSettingsGroup', 'composer-settings-summary', 'composer-stop-button', 'composer-send']);
  assert.deepEqual([...rail.composerSettingsGroup.children].map((node) => node.getAttribute('data-chat-node')),
    ['composerRunModeSlot', 'composerModelPillSlot']);
});

test('pane 1 has no run-mode hint row: its queued notice is its own caption and its row anchors the loading line', async (t) => {
  const { pane1 } = await openTwoPanes(t);
  assert.equal(pane1.queuedNotice.className, 'chat-pane-queued', 'the queued notice no longer borrows the hint class');
  assert.equal(pane1.root.querySelector('.composer-run-mode-hint'), null);
  const row = pane1.root.querySelector('[data-chat-node="composerModeChips"]');
  assert.ok(row, 'the pane mode row is addressable');
  assert.equal(row.querySelector('[data-chat-node="composerRunModeHint"]'), null);
});

test('focusing pane 1 leaves pane 0\'s rail byte-identical', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const railZero = doc.querySelector('#chatPane0 .composer-rail');
  const before = railZero.innerHTML;
  const hintBefore = doc.getElementById('composerRunModeChip').getAttribute('title');
  focusPaneOne(window, pane1);
  await waitForUi(window, 150);
  assert.equal(window.__rendererState.currentSessionId, 'session-b', 'precondition: pane 1 is focused');
  assert.equal(railZero.innerHTML, before);
  assert.equal(doc.getElementById('composerRunModeChip').getAttribute('title'), hintBefore);
  assert.equal(doc.getElementById('composerModelSelect').value, 'qwen3.5:9b');
});

test('a model change in pane 1 persists to session-b only', async (t) => {
  const { window, doc, writes, pane1 } = await openTwoPanes(t);
  const select = railOf(pane1).composerModelSelect;
  select.value = 'qwen3.5:9b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 80);
  assert.equal(writes.length, 1, 'one preference write');
  assert.equal(writes[0].sessionId, 'session-b');
  assert.equal(writes[0].preferences.preferred_model, 'qwen3.5:9b');
  assert.equal(writes[0].preferences.run_mode, 'auto', 'session-b\'s own run mode rides the write (session-a is in Ask)');
  assert.equal(writes[0].preferences.reasoning_effort, 'default', 'the effort is re-normalized for the new model in the same patch (CMP-AI-0005)');
  const sessions = window.__rendererState.sessions;
  assert.equal(sessions.find((entry) => entry.id === 'session-a').preferred_model, 'qwen3.5:9b');
  assert.equal(sessions.find((entry) => entry.id === 'session-a').reasoning_effort, 'high', 'session-a untouched');
  assert.equal(sessions.find((entry) => entry.id === 'session-b').preferred_model, 'qwen3.5:9b');
  assert.equal(pillLabel(railOf(pane1).composerModelPill).startsWith('qwen3.5'), true, 'pane 1\'s pill follows the write');
  assert.equal(doc.getElementById('composerModelSelect').value, 'qwen3.5:9b');
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'the change never moved focus');
});

test('a run-mode chip click in pane 1 cycles session-b only', async (t) => {
  const { window, doc, writes, pane1 } = await openTwoPanes(t);
  const chip1 = railOf(pane1).composerRunModeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
  chip1.click();
  await waitForUi(window, 80);
  assert.deepEqual(writes.map((entry) => [entry.sessionId, entry.preferences.run_mode]), [['session-b', 'plan']]);
  const sessions = window.__rendererState.sessions;
  assert.equal(sessions.find((entry) => entry.id === 'session-b').run_mode, 'plan');
  assert.equal(sessions.find((entry) => entry.id === 'session-a').run_mode, 'ask');
  assert.equal(runModeClass(chip1), 'plan', 'pane 1\'s chip shows the new mode');
  assert.equal(runModeClass(doc.getElementById('composerRunModeChip')), 'ask', 'pane 0\'s chip keeps session-a\'s mode');
});

test('a send from pane 1 while pane 0 is focused carries session-b\'s model, effort and run mode', async (t) => {
  const { window, pane1 } = await openTwoPanes(t);
  window.localStorage.setItem('jenny.auto-run-warning-ack.v2:project_general', '1');
  pane1.dom.chatInput.value = 'hello from beta';
  pane1.dom.chatInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  pane1.sendButton.click();
  await waitForUi(window, 80);
  const calls = window.jennyShell.__state.chatCalls;
  assert.equal(calls.length, 1, 'one send');
  assert.equal(calls[0].sessionId, 'session-b');
  assert.equal(calls[0].preferredModel, 'llava:7b');
  assert.equal(calls[0].reasoningEffort, 'low');
  assert.equal(calls[0].approvalMode, 'auto_run', 'session-b runs in Auto');
  assert.equal(calls[0].planMode, false);
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'the send never moved focus');
});

test('closing pane 1 leaves no rail listener, observer or picker behind; pane 0\'s picker still opens', async (t) => {
  const tracked = { listeners: [], observers: [] };
  const { window, doc, composition, pane1 } = await openTwoPanes(t, {
    beforeOpen(win) {
      const proto = win.EventTarget.prototype;
      const originalAdd = proto.addEventListener;
      const originalRemove = proto.removeEventListener;
      proto.addEventListener = function add(type, handler, options) {
        tracked.listeners.push({ target: this, type, handler, signal: options && typeof options === 'object' ? options.signal : null, removed: false });
        return originalAdd.call(this, type, handler, options);
      };
      proto.removeEventListener = function remove(type, handler, options) {
        tracked.listeners.filter((entry) => entry.target === this && entry.type === type && entry.handler === handler)
          .forEach((entry) => { entry.removed = true; });
        return originalRemove.call(this, type, handler, options);
      };
      const OriginalObserver = win.MutationObserver;
      win.MutationObserver = class TrackedObserver extends OriginalObserver {
        constructor(callback) {
          super(callback);
          this.record = { targets: [], disconnected: false };
          tracked.observers.push(this.record);
        }
        observe(target, options) { this.record.targets.push(target); return super.observe(target, options); }
        disconnect() { this.record.disconnected = true; return super.disconnect(); }
      };
      t.after(() => { proto.addEventListener = originalAdd; proto.removeEventListener = originalRemove; win.MutationObserver = OriginalObserver; });
    },
  });
  const pickerZero = window.rendererComposerModelPicker.instance;
  const rail = pane1.rail;
  const paneOneRoot = pane1.root;
  const railHosts = [rail.dom.composerRunModeSlot, rail.dom.composerModelPillSlot, paneOneRoot.querySelector('[data-chat-node="composerModeChips"]')];
  const inRail = (target) => target && target.nodeType === 1 && railHosts.some((host) => host.contains(target));
  assert.ok(rail.getPicker(), 'precondition: pane 1 holds a picker');
  assert.notEqual(rail.getPicker(), pickerZero, 'pane 1\'s picker is not the singleton');
  const railObservers = tracked.observers.filter((record) => record.targets.some((target) => paneOneRoot.contains(target)));
  assert.equal(railObservers.length > 0, true, 'precondition: pane 1\'s carrier observer is tracked');

  assert.equal(composition.toggleSplit(), true, 'the chord closes the non-focused pane');
  await waitForUi(window, 120);
  assert.equal(composition.getPane(1), null);
  assert.equal(rail.getPicker(), null, 'the pane picker instance is released');
  assert.equal(window.rendererComposerModelPicker.instance, pickerZero, 'pane 0\'s picker singleton is intact');
  assert.deepEqual(railObservers.filter((record) => !record.disconnected), [], 'every rail observer is disconnected');
  const leaked = tracked.listeners
    .filter((entry) => !entry.removed && !(entry.signal && entry.signal.aborted))
    .filter((entry) => entry.target === doc || entry.target === window || inRail(entry.target))
    .map((entry) => `${entry.target === doc ? 'document' : entry.target === window ? 'window' : 'rail'}:${entry.type}:${entry.target.className || entry.target.tagName || ''}`);
  assert.deepEqual(leaked, [], 'no document, window or rail listener survives the close');

  const pillZero = doc.getElementById('composerModelPill');
  pillZero.click();
  await waitForUi(window, 40);
  assert.equal(doc.getElementById('composerModelPopover').hidden, false, 'pane 0\'s pill still opens pane 0\'s popover');
  assert.notEqual(doc.querySelector('#composerModelPopover [data-picker-model="qwen3.5:9b"]'), null, 'and pane 0\'s picker renders it');
});

test('an effort change in pane 1 persists to session-b with session-b\'s own model', async (t) => {
  const { window, writes, pane1 } = await openTwoPanes(t);
  const effort = railOf(pane1).composerEffortSelect;
  assert.deepEqual([...effort.options].map((option) => option.value), ['default', 'low', 'medium', 'high']);
  effort.value = 'medium';
  effort.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 80);
  assert.deepEqual(writes.map((entry) => [entry.sessionId, entry.preferences.reasoning_effort, entry.preferences.preferred_model]),
    [['session-b', 'medium', 'llava:7b']]);
  assert.equal(window.__rendererState.sessions.find((entry) => entry.id === 'session-a').reasoning_effort, 'high');
  assert.equal(pillLabel(railOf(pane1).composerModelPill), 'llava · 7b · Med', pillLabel(railOf(pane1).composerModelPill));
});

test('Alt+P with pane 1 focused toggles session-b\'s plan mode and pane 1\'s chip follows', async (t) => {
  const { window, doc, writes, pane1 } = await openTwoPanes(t);
  focusPaneOne(window, pane1);
  await waitForUi(window, 120);
  assert.equal(window.__rendererState.currentSessionId, 'session-b', 'precondition: pane 1 is focused');
  await window.rendererRunModeControl.togglePlanMode();
  await waitForUi(window, 80);
  assert.deepEqual(writes.map((entry) => [entry.sessionId, entry.preferences.run_mode]), [['session-b', 'plan']]);
  const chip1 = railOf(pane1).composerRunModeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
  assert.equal(runModeClass(chip1), 'plan', 'the pane that shows the session re-syncs after the write');
  assert.equal(runModeClass(doc.getElementById('composerRunModeChip')), 'ask', 'pane 0 keeps session-a\'s mode');
});

/* W3-3: one toolbar fit per composer. Widths come from prototype getters so
   the REAL measure runs (jsdom has no layout): each pane's toolbar reports its
   own clientWidth and every toolbar item 90px. Pane 1's 320px toolbar cannot
   hold its line; pane 0's 5000px one can. */
function installToolbarWidths(win, t, widths) {
  const proto = win.HTMLElement.prototype;
  const reads = [];
  const originalOffset = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'clientWidth', { configurable: true, get() {
    if (!this.classList.contains('composer-toolbar')) return 0;
    const paneId = this.closest('.chat-pane') ? this.closest('.chat-pane').dataset.paneId : '';
    reads.push(paneId);
    return widths[paneId] || 0;
  } });
  Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return this.closest('.composer-toolbar') ? 90 : 0; } });
  t.after(() => { delete proto.clientWidth; Object.defineProperty(proto, 'offsetWidth', originalOffset); });
  const observers = [];
  win.ResizeObserver = class FakeResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = []; this.disconnected = false; observers.push(this); }
    observe(target) { this.targets.push(target); }
    disconnect() { this.disconnected = true; }
  };
  return { reads, observers };
}

test('W3-3: a narrow pane 1 collapses while pane 0 stays expanded; its summary follows the model and the run mode', async (t) => {
  let widths = null;
  const { window, doc, pane1, composition } = await openTwoPanes(t, {
    beforeOpen(win) { widths = installToolbarWidths(win, t, { 0: 5000, 1: 320 }); },
  });
  await waitForUi(window, 80);
  const composerOne = pane1.root.querySelector('.composer');
  const summary = pane1.root.querySelector('.composer-settings-summary');
  assert.equal(composerOne.hasAttribute('data-toolbar-compact'), true, 'pane 1 collapsed');
  assert.equal(pane1.root.hasAttribute('data-composer-compact'), true, 'its root mirrors it for the sprite rule');
  assert.equal(summary.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(summary.getAttribute('aria-controls'), 'composerSettingsGroupPane1');
  assert.equal(widths.observers.filter((observer) => observer.targets.includes(pane1.root.querySelector('.composer-toolbar'))).length, 1,
    'one ResizeObserver on pane 1\'s toolbar');

  // Pane 0 re-measures when its model label changes (the rail mutation path) and stays expanded.
  const readsBefore = widths.reads.filter((paneId) => paneId === '0').length;
  doc.getElementById('composerModelPill').querySelector('.inv-chip-label').textContent = 'a much longer model label';
  await waitForUi(window, 80);
  assert.equal(widths.reads.filter((paneId) => paneId === '0').length > readsBefore, true, 'pane 0 measured after its label changed');
  assert.equal(doc.querySelector('#chatPane0 .composer').hasAttribute('data-toolbar-compact'), false, 'pane 0 stays expanded');
  assert.equal(doc.getElementById('chatPane0').hasAttribute('data-composer-compact'), false);

  // Session-b is in Auto; the label is the pill's label behind the amber tag.
  const pill = railOf(pane1).composerModelPill;
  assert.equal(summary.querySelector('.composer-settings-summary-mode').textContent, 'Auto \u00b7');
  assert.equal(summary.querySelector('.inv-chip-label').textContent, `Auto \u00b7 ${pillLabel(pill)}`);
  const select = railOf(pane1).composerModelSelect;
  select.value = 'qwen3.5:9b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 80);
  assert.equal(pillLabel(pill).startsWith('qwen3.5'), true, 'precondition: pane 1\'s pill follows the write');
  assert.equal(summary.querySelector('.inv-chip-label').textContent, `Auto \u00b7 ${pillLabel(pill)}`, 'the summary follows the model');
  railOf(pane1).composerRunModeSlot.querySelector('[data-inv-chip="composer-run-mode"]').click();
  await waitForUi(window, 80);
  assert.equal(summary.querySelector('.composer-settings-summary-mode').textContent, 'Plan \u00b7', 'plan mode shows the Plan tag');

  // The popover opens from the pill and Escape returns focus to it.
  summary.click();
  assert.equal(composerOne.hasAttribute('data-settings-open'), true);
  assert.equal(summary.getAttribute('aria-expanded'), 'true');
  assert.equal(railOf(pane1).composerSettingsGroup.contains(doc.activeElement), true, 'focus moves into the settings');
  doc.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(composerOne.hasAttribute('data-settings-open'), false);
  assert.equal(doc.activeElement, summary);

  // Closing pane 1 disposes its fit: observer disconnected, pill gone.
  const paneOneObserver = widths.observers.find((observer) => observer.targets.includes(pane1.root.querySelector('.composer-toolbar')));
  assert.equal(composition.toggleSplit(), true);
  await waitForUi(window, 120);
  assert.equal(paneOneObserver.disconnected, true);
  assert.equal(summary.isConnected, false);
});

test('gate: with pane 1 focused, a change on pane 0\'s model select writes pane 0\'s session', async (t) => {
  const { window, doc, writes, pane1 } = await openTwoPanes(t);
  focusPaneOne(window, pane1);
  await waitForUi(window, 120);
  assert.equal(window.__rendererState.currentSessionId, 'session-b', 'precondition: pane 1 is focused');
  const select = doc.getElementById('composerModelSelect');
  select.value = 'llava:7b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 80);
  assert.deepEqual(writes.map((entry) => [entry.sessionId, entry.preferences.preferred_model]), [['session-a', 'llava:7b']]);
  const sessions = window.__rendererState.sessions;
  assert.equal(sessions.find((entry) => entry.id === 'session-b').preferred_model, 'llava:7b', 'session-b keeps its own model');
  assert.equal(window.__rendererState.currentSessionId, 'session-b', 'the write never moved focus');
});

test('gate C13: focus moves with an unchanged run mode rewrite nothing in pane 0\'s run-mode chip', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  const chip = doc.getElementById('composerRunModeChip');
  const iconNode = chip.querySelector('.inv-chip-icon').firstElementChild;
  const labelNode = chip.querySelector('.inv-chip-label').firstChild;
  const records = [];
  const observer = new window.MutationObserver((batch) => { records.push(...batch); });
  observer.observe(chip, { attributes: true, childList: true, subtree: true, characterData: true });
  t.after(() => observer.disconnect());
  focusPaneOne(window, pane1);
  await waitForUi(window, 120);
  doc.getElementById('chatInput').dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
  await waitForUi(window, 120);
  assert.equal(window.__rendererState.currentSessionId, 'session-a', 'precondition: focus went to pane 1 and back');
  records.push(...observer.takeRecords());
  assert.deepEqual(records.map((record) => `${record.type}:${record.attributeName || ''}`), [], 'no chip write');
  assert.equal(chip.querySelector('.inv-chip-icon').firstElementChild, iconNode, 'the icon markup was not rebuilt');
  assert.equal(chip.querySelector('.inv-chip-label').firstChild, labelNode, 'the label text was not rewritten');
});

test('a save on pane 1\'s session marks only pane 1\'s rail busy (session-keyed activity)', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  let release = null;
  window.jennyShell.sessions.setPreferences = (sessionId, preferences) => new Promise((resolve) => {
    release = () => resolve({ ...window.__rendererState.sessions.find((entry) => entry.id === sessionId), ...preferences });
  });
  const select = railOf(pane1).composerModelSelect;
  select.value = 'qwen3.5:9b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 60);
  assert.ok(release, 'precondition: the save is in flight');
  assert.equal(select.getAttribute('aria-disabled'), 'true', 'pane 1\'s model control shimmers (inert while saving)');
  const paneZeroSelect = doc.getElementById('composerModelSelect');
  assert.notEqual(paneZeroSelect.getAttribute('aria-disabled'), 'true', 'pane 0\'s model control stays usable');
  const paneZeroShell = paneZeroSelect.closest('.composer-select-shell');
  assert.equal(paneZeroShell && paneZeroShell.hasAttribute('data-busy'), false, 'pane 0 shows no busy shimmer');
  release();
  await waitForUi(window, 60);
  assert.notEqual(select.getAttribute('aria-disabled'), 'true', 'pane 1 is usable again once the save lands');
});

// Gate §D: pane 1's rail went inert during a save but never carried the busy attributes the
// shimmer CSS keys on. Its select shell now mirrors pane 0's (applyActivityAttributes), for
// pane 1's session only.
test('a save on pane 1\'s session gives pane 1\'s select shell pane 0\'s busy attributes; pane 0\'s stay clear', async (t) => {
  const { window, doc, pane1 } = await openTwoPanes(t);
  let release = null;
  window.jennyShell.sessions.setPreferences = (sessionId, preferences) => new Promise((resolve) => {
    release = () => resolve({ ...window.__rendererState.sessions.find((entry) => entry.id === sessionId), ...preferences });
  });
  const select = railOf(pane1).composerModelSelect;
  const shell = select.closest('.composer-select-shell');
  assert.ok(shell && pane1.root.contains(shell), 'precondition: pane 1 has its own select shell');
  const paneZeroShell = doc.getElementById('composerModelSelect').closest('.composer-select-shell');
  select.value = 'qwen3.5:9b';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 60);
  assert.ok(release, 'precondition: the save is in flight');
  assert.equal(shell.dataset.activityState, 'pending');
  assert.equal(shell.getAttribute('data-busy'), 'true');
  assert.equal(shell.getAttribute('aria-busy'), 'true');
  assert.equal(paneZeroShell.hasAttribute('data-busy'), false, 'pane 0 does not shimmer for session-b');
  assert.equal(paneZeroShell.dataset.activityState, undefined);
  const paneZeroEffortShell = doc.getElementById('composerEffortSelect').closest('.composer-select-shell');
  assert.equal(paneZeroEffortShell.hasAttribute('data-busy'), false);
  release();
  await waitForUi(window, 60);
  assert.equal(shell.hasAttribute('data-busy'), false, 'the shimmer stops once the save lands');
  assert.notEqual(shell.getAttribute('aria-busy'), 'true');
});

// Collapsed composer settings popover (owner-approved PO review 2026-09-26): pane 1's
// Ask / Auto / Plan segments lock with its run-mode chip in a read-only plugin session,
// through the render module's syncRunModeSegmentsDisabled when it exists.
test('pane 1 locks its run-mode segments with the chip in a plugin session', (t) => {
  const { createPaneComposerRail } = require('../renderer/chat/renderer-pane-composer-rail.js');
  const dom = new JSDOM(`<!doctype html><body>
    <div class="chat-pane" id="pane1"><div class="composer"><div class="composer-toolbar"><div class="composer-toolbar-right composer-rail" id="rail"></div></div></div></div>
    <div class="composer-model-pill-slot" id="composerModelPillSlot"><button type="button" class="inv-chip" data-inv-chip="composer-model"><span class="inv-chip-label">m</span></button>
      <div class="composer-model-popover" hidden><div data-composer-model-picker></div></div><select></select><select></select></div></body>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const segmentCalls = [];
  const render = {
    createRunModeSwitcherRenderer({ slot }) {
      slot.innerHTML = '<button type="button" class="inv-chip" data-inv-chip="composer-run-mode"></button>';
      return { sync() {}, destroy() {} };
    },
    syncRunModeSegmentsDisabled(slot, disabled) { segmentCalls.push([slot.className, disabled]); },
  };
  const state = { sessions: [{ id: 'session-b', session_type: 'plugin' }] };
  const mountRail = (composerV2Render) => createPaneComposerRail({
    state,
    paneRoot: doc.getElementById('pane1'),
    railEl: doc.getElementById('rail'),
    documentRef: doc,
    sessionContext: { getSessionId: () => 'session-b', paneId: 1 },
    deps: {
      composerState: { projectRunMode: (mode) => ({ runMode: mode || 'ask', planMode: false }) },
      composerV2Render,
      getRuntimePreferencesFromSession: () => ({ runMode: 'ask' }),
    },
  });
  const rail = mountRail(render);
  rail.sync();
  const chip = rail.dom.composerRunModeSlot.querySelector('[data-inv-chip="composer-run-mode"]');
  assert.equal(chip.disabled, true);
  assert.deepEqual(segmentCalls.at(-1), ['composer-run-mode-slot', true], 'the segments lock with the chip');
  state.sessions[0].session_type = 'chat';
  rail.sync();
  assert.equal(chip.disabled, false);
  assert.deepEqual(segmentCalls.at(-1), ['composer-run-mode-slot', false]);
  rail.dispose();

  // A render module without the segments export (older build) is left alone.
  const bare = mountRail({ createRunModeSwitcherRenderer: render.createRunModeSwitcherRenderer });
  assert.doesNotThrow(() => bare.sync());
  bare.dispose();
});

test('real session navigation closes the compact list and its Chat panel', async (t) => {
  const { window, doc } = await bootApp(t, { extraShell: { tools: { list: () => [{ name: 'read_file', surfaceFamily: 'files', available: true }] } } });
  const group = doc.getElementById('composerSettingsGroup');
  const composer = group.closest('.composer');
  const toolbar = group.closest('.composer-toolbar');
  Object.defineProperty(toolbar, 'clientWidth', { configurable: true, value: 100 });
  Object.defineProperty(doc.getElementById('composerModelPillSlot'), 'offsetWidth', { configurable: true, value: 300 });
  window.dispatchEvent(new window.Event('chat-surface:rehost'));
  await waitForUi(window, 40);
  assert.equal(composer.hasAttribute('data-toolbar-compact'), true);
  const summary = group.nextElementSibling;
  summary.click();
  assert.equal(composer.hasAttribute('data-settings-open'), true);
  doc.querySelector('[data-session-open="session-b"]').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-b');
  assert.equal(composer.hasAttribute('data-settings-open'), false);
  assert.equal(summary.getAttribute('aria-expanded'), 'false');

  // The Chat chip sits outside the list (the left cluster): its panel closes on navigation too.
  doc.getElementById('composerToolsChip').click();
  const panel = doc.getElementById('composerChatPanel');
  assert.equal(panel.hidden, false);
  doc.querySelector('[data-session-open="session-a"]').click();
  await waitForUi(window, 40);
  assert.equal(window.__rendererState.currentSessionId, 'session-a');
  assert.equal(panel.hidden, true);
  assert.equal(doc.getElementById('composerToolsChip').getAttribute('aria-expanded'), 'false');
});
