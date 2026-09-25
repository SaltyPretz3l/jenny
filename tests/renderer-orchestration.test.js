'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createController } = require('../renderer/shell/renderer-orchestration-controller');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');
const view = require('../renderer/shell/renderer-orchestration-view');
const controllers = require('../renderer/shell/renderer-orchestration-controller');
const limits = { local: { runnable_turns: 1, inference_requests: 1, descendants: 8, descendant_depth: 2 },
  cloud: { runnable_turns: 2, inference_requests: 2, descendants: 16, descendant_depth: 3 },
  resources: { tool_operations: 4, native_processes: 2, tests: 1 } };
const clone = value => JSON.parse(JSON.stringify(value));
const work = (id = 'work_a', revision = 1) => ({ work_id: id, session_id: 'session_a', turn_id: 'turn_a', purpose: '<script>alert(1)</script>', status: 'pending', revision });
function snapshot() {
  return { ok: true, enabled: true, read_only: false, closing: false, work: [work()], next_cursor: 'page_2',
    lanes: { configured_limits: { local: limits.local, cloud: limits.cloud }, effective_limits: { local: limits.local, cloud: limits.cloud }, counts: { active_leases: 0, quarantined: 0 } },
    resources: { configured_limits: limits.resources, effective_limits: limits.resources, counts: { waiter_count: 0, quarantined_count: 0 } } };
}
const detail = (id, revision) => ({ ok: true, work: work(id, revision), coordination: { editable: true, children: [], child_count: 0 } });
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function harness(api = {}) {
  const dom = new JSDOM('<div id="sessionOrchestrationMount"></div>');
  const state = { ui: { activeView: 'settings', activeSettingsSection: 'runtimeLimits' }, currentSessionId: 'session_a', sessions: [] };
  const calls = [];
  const bridge = { getSnapshot: async payload => { calls.push(['snapshot', payload]); return snapshot(); },
    getWork: async payload => detail(payload.work_id, 1), ...api };
  const timers = [];
  const windowRef = { document: dom.window.document, crypto: { randomUUID: () => 'fixed_id' },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {}, jennyShell: { sessionRuntime: bridge } };
  const host = windowRef.document.getElementById('sessionOrchestrationMount');
  const controller = createController({ windowRef, host, state,
    isVisible: () => state.ui.activeView === 'settings' && state.ui.activeSettingsSection === 'runtimeLimits' });
  const input = (key, value) => { const el = host.querySelector(`[data-draft="${key}"]`); el.value = value; el.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const click = action => host.querySelector(`[data-action="runtime-${action}"]`).click();
  return { controller, host, state, calls, timers, input, click, windowRef };
}
test('opening and polling are bounded reads; hidden view does not fetch; there is no Start form', async () => {
  let starts = 0;
  const h = harness({ start: async () => { starts += 1; return { ok: true, work_id: 'work_a' }; } });
  h.controller.bind(); await settle();
  assert.equal(h.calls.length, 1); assert.deepEqual(h.calls[0][1], { limit: 25, cursor: null });
  assert.equal(h.host.querySelector('script'), null);
  // Owner decision 2026-09-20: the composer is the only surface that starts work.
  assert.equal(h.host.querySelector('[data-action="runtime-start"]'), null);
  assert.equal(h.host.querySelector('[data-draft="purpose"]'), null);
  assert.match(h.host.textContent, /Runtime limits/);
  assert.equal(starts, 0);
  h.state.ui.activeView = 'chat'; const reads = h.calls.length; h.timers.at(-1)(); await settle();
  assert.equal(h.calls.length, reads); h.controller.dispose();
});
test('selection and disposal fence delayed details without cancelling durable work', async () => {
  const first = deferred(); let cancelled = 0;
  const h = harness({ getWork: payload => payload.work_id === 'work_a' ? first.promise : Promise.resolve(detail('work_b', 4)), cancel: async () => { cancelled++; } });
  h.controller.bind(); await settle();
  const pending = h.controller.inspect('work_a'); await h.controller.inspect('work_b');
  first.resolve(detail('work_a', 1)); await pending;
  assert.equal(h.controller.getState().detail.work.work_id, 'work_b');
  h.controller.dispose(); assert.equal(cancelled, 0);
});
test('pending and limit edits keep their original revision despite polling; drafts and focus survive', async () => {
  let revision = 1; let snap = snapshot(); const updates = [];
  const h = harness({ getSnapshot: async () => clone(snap), getWork: async () => detail('work_a', revision),
    updatePending: async payload => { updates.push(payload); return { ok: false }; },
    updateLimits: async payload => { updates.push(payload); return { ok: false }; } });
  h.controller.bind(); await settle(); await h.controller.inspect('work_a');
  h.input('edit', 'New instructions'); h.input('limit_local_runnable_turns', '3');
  const field = h.host.querySelector('[data-draft="edit"]'); field.focus(); field.setSelectionRange(2, 4);
  revision = 7; snap.lanes.configured_limits = clone(snap.lanes.configured_limits); snap.lanes.configured_limits.local.runnable_turns = 5;
  await h.controller.refresh();
  assert.equal(h.host.ownerDocument.activeElement.selectionStart, 2);
  assert.equal(h.host.querySelector('[data-draft="edit"]').value, 'New instructions');
  h.click('edit'); await settle(); assert.equal(updates[0].expected_revision, 1);
  h.click('limits'); await settle(); assert.equal(updates[1].expected_limits.local.runnable_turns, 1);
  assert.equal(updates[1].patch.local.runnable_turns, 3); h.controller.dispose();
});
test('OFF blocks Resume while history, cancellation and settings remain inspectable', async () => {
  const h = harness({ getSnapshot: async () => ({ ...snapshot(), enabled: false }), getWork: async () => ({ ...detail('work_a', 1), work: { ...work(), status: 'paused' } }) });
  h.controller.bind(); await settle(); await h.controller.inspect('work_a');
  assert.match(h.host.textContent, /Runtime is off/);
  assert.equal(h.host.querySelector('[data-action="runtime-resume"]').disabled, true);
  assert.equal(h.host.querySelector('[data-action="runtime-cancel"]').disabled, false);
  assert.equal(h.host.querySelector('[data-action="runtime-limits"]').disabled, false); h.controller.dispose();
});
test('the Developer > Runtime limits binder loads the console lazily in dependency order and drops a late load after disposal', async () => {
  function bindLimits(h) {
    const binder = createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef,
      getLazySectionDom: () => ({ sessionOrchestrationMount: h.host }), callbacks: {} });
    let cleanup = null;
    binder.bindSection('runtimeLimits', { registerSectionListener() {}, markSectionBound() {}, addCleanup(fn) { cleanup = fn; }, finalizeSectionBindings() { return true; } });
    return cleanup;
  }
  const h = harness(); const loads = []; const pending = deferred();
  h.windowRef.scriptLoaderUtils = { ensureScript: async ({ src }) => { loads.push(src); await pending.promise;
    h.windowRef.rendererOrchestrationView = view; h.windowRef.rendererOrchestrationController = controllers; return true; } };
  const cleanup = bindLimits(h);
  assert.equal(loads.length, 1);
  cleanup(); pending.resolve(); await settle(); assert.equal(h.calls.length, 0, 'disposed before load: no fetch');
  const h2 = harness(); const order = [];
  h2.windowRef.scriptLoaderUtils = { ensureScript: async ({ src }) => { order.push(src);
    if (src.endsWith('-view.js')) h2.windowRef.rendererOrchestrationView = view;
    else h2.windowRef.rendererOrchestrationController = controllers; return true; } };
  const cleanup2 = bindLimits(h2); await settle();
  assert.deepEqual(order, ['renderer/shell/renderer-orchestration-view.js', 'renderer/shell/renderer-orchestration-controller.js']);
  assert.equal(h2.calls.length, 1); assert.match(h2.host.textContent, /Runtime limits/); cleanup2();
});

test('a pause requested on a running turn reads as requested, never as already paused', () => {
  const dom = new JSDOM('<div id="host"></div>');
  const host = dom.window.document.getElementById('host');
  const coordination = { editable: false, children: [], child_count: 0 };
  const control = { kind: 'pause', requested_at: '2026-09-16T12:00:00.000Z' };
  const model = { snapshot: snapshot(), draft: {}, sessionId: 'session_a', sessionLabel: 'Session A' };

  view.render(host, { ...model, detail: { ok: true, work: { ...work(), status: 'running', control }, coordination } });
  assert.match(host.textContent, /Pause requested/);
  assert.equal(/\bPaused\b/.test(host.textContent), false, 'a request is not a pause');
  assert.equal(host.querySelector('[data-action="runtime-pause"]').disabled, true, 'a pause already asked for is not asked for twice');
  view.render(host, { ...model, detail: { ok: true, work: { ...work(), status: 'running', control: null }, coordination } });
  assert.equal(host.querySelector('[data-action="runtime-pause"]').disabled, false);

  // Settled work says Paused, and cancellation still supersedes a pause intent.
  view.render(host, { ...model, detail: { ok: true, work: { ...work(), status: 'paused', control }, coordination } });
  assert.match(host.textContent, /Paused/);
  assert.equal(/Pause requested/.test(host.textContent), false);
  view.render(host, { ...model, detail: { ok: true, coordination,
    work: { ...work(), status: 'running', control: { kind: 'cancel', requested_at: control.requested_at } } } });
  assert.match(host.textContent, /Cancellation requested/);
  dom.window.close();
});

test('runtime controls render translated labels, tooltips and interpolation in pseudo, RTL and CJK locales', () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  for (const tag of ['qps-ploc', 'ar', 'ja', 'zh-CN', 'zh-TW']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${tag}.json`), 'utf8'));
    const strings = catalog.strings || catalog;
    const context = vm.createContext({ inventoryActionButton: require('../renderer/inventory/action-button'),
      inventoryTextField: require('../renderer/inventory/text-field'), jennyI18n: { t: (key, fallback, params) =>
        String(strings[key] || fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/shell/renderer-orchestration-view.js'), 'utf8'), context);
    const dom = new JSDOM(`<html dir="${tag === 'ar' ? 'rtl' : 'ltr'}"><body><div id="host"></div></body></html>`);
    const host = dom.window.document.getElementById('host');
    context.rendererOrchestrationView.render(host, { snapshot: snapshot(), draft: {}, sessionId: 'session_a', sessionLabel: '会話 العربية' });
    const refresh = host.querySelector('[data-action="runtime-refresh"]');
    assert.equal(refresh.textContent.trim(), strings['common.refresh']);
    assert.equal(refresh.getAttribute('aria-label'), strings['common.refresh']);
    assert.equal(refresh.getAttribute('title'), strings['common.refresh']);
    assert.equal(refresh.tagName, 'BUTTON'); assert.equal(refresh.getAttribute('type'), 'button');
    assert.equal(host.querySelector('[data-action="runtime-start"]'), null);
    assert.equal(host.querySelector('h3').textContent, strings['runtime.ui.limits']);
    assert.equal(host.textContent.includes('{active}'), false);
    assert.ok(host.textContent.includes(strings['runtime.ui.off']) === false);
    dom.window.close();
  }
});
