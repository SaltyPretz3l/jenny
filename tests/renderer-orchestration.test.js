'use strict';
// Diagnostics › Runs + Settings › Developer › Runtime limits: one controller, one poller.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const controllers = require('../renderer/shell/renderer-orchestration-controller');
const runsView = require('../renderer/shell/renderer-runs-view');
const limitsView = require('../renderer/shell/renderer-runtime-limits-view');
const { createSettingsSectionBinders } = require('../renderer/shell/renderer-settings-section-binders');

const { NOW, clone, item, snapshot, detail, settle, deferred, harness } = require('./helpers/runs-orchestration-harness');

test('a chat send (purpose "chat") renders its chat title, project and state, not the word chat', async () => {
  const h = harness();
  h.controller.bind(); await settle();
  const row = h.runsHost.querySelector('.runs-row[data-work-id="work_a"]');
  assert.equal(row.querySelector('.runs-row-title').textContent, 'Quarterly report');
  assert.match(row.querySelector('.runs-row-meta').textContent, /^General · queued · 1st in line · /);
  assert.equal(h.calls[0][1].view, 'runs');
  assert.equal(h.calls[0][1].finished_since, new Date(controllers.localMidnight(NOW)).toISOString());
  const untitled = harness({}, { sessions: [] });
  untitled.controller.bind(); await settle();
  assert.equal(untitled.runsHost.querySelector('.runs-row-title').textContent, 'Untitled chat');
  h.controller.dispose(); untitled.controller.dispose();
});

test('loading is not "Runtime is off"; off shows only when a snapshot says enabled:false', async () => {
  const gate = deferred();
  const h = harness({ getSnapshot: () => gate.promise });
  h.controller.bind();
  assert.match(h.runsHost.textContent, /Loading runs/);
  assert.doesNotMatch(h.runsHost.textContent, /Runtime is off/);
  h.show('limits'); h.controller.wake();
  assert.match(h.limitsHost.textContent, /Loading limits/);
  h.show('runs');
  gate.resolve(snapshot([], { enabled: false })); await settle();
  assert.match(h.runsHost.textContent, /Runtime is off/);
  assert.doesNotMatch(h.runsHost.textContent, /Loading runs/);
  h.controller.dispose();
});

test('a read error clears after the next successful refresh', async () => {
  let fail = true;
  const h = harness({ getSnapshot: async () => (fail ? { ok: false, error: { reason: 'runtime_unavailable' } } : snapshot()) });
  h.controller.bind(); await settle();
  const message = h.runsHost.querySelector('[data-runs-message]');
  assert.match(message.textContent, /unavailable/);
  assert.equal(message.hidden, false);
  assert.doesNotMatch(h.runsHost.textContent, /Runtime is off/, 'a failed read is not "off"');
  fail = false; await h.controller.refresh();
  assert.equal(message.textContent, '');
  assert.equal(message.hidden, true);
  h.controller.dispose();
});

test('keyboard focus and the row element survive two polls, including a changed row', async () => {
  const h = harness();
  h.controller.bind(); await settle();
  const pause = () => h.runsHost.querySelector('[data-action="runs-withdraw"]');
  const row = h.runsHost.querySelector('.runs-row');
  pause().focus();
  assert.equal(h.document.activeElement, pause());
  await h.controller.refresh();
  assert.equal(h.document.activeElement, pause(), 'unchanged poll keeps focus');
  assert.equal(h.runsHost.querySelector('.runs-row'), row, 'row element is patched, not rebuilt');
  h.setSnapshot(snapshot([item('work_a', { queue_position: 2, revision: 2 })]));
  await h.controller.refresh();
  assert.equal(h.runsHost.querySelector('.runs-row'), row);
  assert.equal(h.document.activeElement?.dataset.focusKey, 'work_a:withdraw', 'focus follows its key across a changed poll');
  assert.match(row.querySelector('.runs-row-meta').textContent, /2nd in line/);
  h.controller.dispose();
});

test('an unchanged snapshot skips rendering entirely', async () => {
  const h = harness();
  h.controller.bind(); await settle();
  const header = h.runsHost.querySelector('[data-runs-count]');
  let mutations = 0;
  const observer = new h.dom.window.MutationObserver(records => { mutations += records.length; });
  observer.observe(h.runsHost, { subtree: true, childList: true, characterData: true, attributes: true });
  await h.controller.refresh(); await h.controller.refresh(); await settle();
  assert.equal(mutations, 0);
  assert.equal(header.textContent, '0 running · 1 waiting');
  observer.disconnect(); h.controller.dispose();
});

test('the poll stops when the window is hidden or no section is shown, and resumes on visibility', async () => {
  const h = harness();
  h.controller.bind(); await settle();
  assert.equal(h.controller.isPolling(), true);
  let visibility = 'hidden';
  Object.defineProperty(h.document, 'visibilityState', { configurable: true, get: () => visibility });
  const reads = h.snapshotReads();
  h.timers.at(-1)(); await settle();
  assert.equal(h.snapshotReads(), reads, 'hidden window: no read');
  assert.equal(h.controller.isPolling(), false, 'hidden window: no timer');
  visibility = 'visible';
  h.document.dispatchEvent(new h.dom.window.Event('visibilitychange')); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'visible again: one read now');
  assert.equal(h.controller.isPolling(), true);
  h.state.ui.activeView = 'chat';
  h.timers.at(-1)(); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'no section on screen: no read');
  assert.equal(h.controller.isPolling(), false);
  h.show('runs'); h.controller.wake(); await settle();
  assert.equal(h.snapshotReads(), reads + 2);
  h.controller.dispose();
});

test('groups render in order with the verbs of each state; finished is today-only and collapsed', async () => {
  const h = harness({}, { sessions: [] });
  h.setSnapshot(snapshot([
    item('work_f', { status: 'completed', group: 'finished', queue_position: null, created_at: '2026-09-27T09:00:00.000Z', updated_at: '2026-09-27T10:00:00.000Z' }),
    item('work_old', { status: 'failed', group: 'finished', queue_position: null, updated_at: '2026-09-26T10:00:00.000Z' }),
    item('work_w', { created_at: '2026-09-27T13:00:00.000Z' }),
    item('work_r', { status: 'running', group: 'running', queue_position: null, progress: { steps: 3, tool_calls: 7 } }),
    item('work_n', { status: 'paused', group: 'needs_you', queue_position: null, recovery_kind: 'restart_paused' }),
    item('work_x', { status: 'needs_attention', group: 'needs_you', queue_position: null }),
  ]));
  h.controller.bind(); await settle();
  const shown = [...h.runsHost.querySelectorAll('.runs-group:not([hidden])')].map(node => node.dataset.group);
  assert.deepEqual(shown, ['needs_you', 'running', 'waiting', 'finished']);
  const labels = [...h.runsHost.querySelectorAll('.runs-group:not([hidden]) .runs-group-label')].map(node => node.textContent);
  assert.deepEqual(labels, ['Needs you', 'Running', 'Waiting', 'Finished today · 1']);
  const verbs = id => [...h.runsHost.querySelectorAll(`.runs-row[data-work-id="${id}"] .runs-row-actions [data-action]`)].map(node => node.dataset.action);
  assert.deepEqual(verbs('work_n'), ['runs-resume', 'runs-stop', 'runs-open']);
  assert.deepEqual(verbs('work_x'), ['runs-stop', 'runs-open'], 'needs-attention work cannot be resumed, only stopped');
  assert.deepEqual(verbs('work_r'), ['runs-pause', 'runs-stop']);
  assert.deepEqual(verbs('work_w'), ['runs-withdraw']);
  assert.deepEqual(verbs('work_f'), [], 'finished work offers no Cancel or Stop');
  assert.equal(h.runsHost.querySelector('[data-work-id="work_old"]'), null, "yesterday's finished work ages out");
  assert.match(h.runsHost.querySelector('[data-work-id="work_n"] .runs-row-meta').textContent, /paused when Jenny restarted/);
  assert.match(h.runsHost.querySelector('[data-work-id="work_x"] .runs-row-meta').textContent, /needs your attention/);
  assert.match(h.runsHost.querySelector('[data-work-id="work_r"] .runs-row-meta').textContent, /step 3 · 7 tool calls/);
  assert.equal(h.runsHost.querySelector('[data-work-id="work_n"] .runs-dot').dataset.tone, 'attention');
  assert.equal(h.runsHost.querySelector('[data-work-id="work_r"] .runs-dot').dataset.tone, 'running');
  assert.equal(h.runsHost.querySelector('[data-work-id="work_w"] .runs-dot').dataset.tone, 'muted');
  assert.match(h.runsHost.querySelector('[data-runs-count]').textContent, /1 running · 1 waiting/);
  const finishedList = h.runsHost.querySelector('.runs-group[data-group="finished"] .runs-list');
  assert.equal(finishedList.hidden, true, 'finished today is collapsed by default');
  h.click('[data-action="runs-finished-toggle"]');
  assert.equal(finishedList.hidden, false);
  h.controller.dispose();
});

test('Stop asks inline first; Keep running backs out and Stop cancels at the row revision', async () => {
  const cancels = [];
  const h = harness({ cancel: async payload => { cancels.push(payload); return { ok: true, status: 'requested', work_id: payload.work_id } } });
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null, revision: 4 })]));
  h.controller.bind(); await settle();
  h.click('[data-action="runs-stop"]');
  assert.match(h.runsHost.querySelector('.runs-confirm').textContent, /Stop this run\?/);
  assert.equal(h.document.activeElement?.dataset.action, 'runs-stop-confirm', 'focus moves to the confirm');
  assert.equal(cancels.length, 0);
  h.click('[data-action="runs-stop-keep"]');
  assert.equal(h.runsHost.querySelector('.runs-confirm'), null);
  assert.equal(h.document.activeElement?.dataset.action, 'runs-stop');
  h.click('[data-action="runs-stop"]'); h.click('[data-action="runs-stop-confirm"]'); await settle();
  assert.deepEqual(cancels, [{ work_id: 'work_a', expected_revision: 4 }]);
  assert.match(h.runsHost.textContent, /Stop requested/);
  h.controller.dispose();
});

test('selecting a row expands its detail inline with a pre-filled instructions box that survives polls', async () => {
  const updates = [];
  const h = harness({ updatePending: async payload => { updates.push(payload); return { ok: true }; },
    getWork: async payload => detail(item(payload.work_id), { budget: { charged: { inference_requests: 2, input_tokens: 1200, output_tokens: 300 },
      limits: { inference_requests: 8, input_tokens: 32768, output_tokens: 8192 } }, child_count: 1,
      children: [{ work_id: 'work_child', purpose: 'Research sources', status: 'running' }] }) });
  h.controller.bind(); await settle();
  h.click('.runs-row-main'); await settle();
  const row = h.runsHost.querySelector('.runs-row');
  assert.equal(row.classList.contains('is-selected'), true);
  assert.equal(row.querySelector('.runs-row-main').getAttribute('aria-expanded'), 'true');
  const box = row.querySelector('[data-draft="edit"]');
  assert.equal(box.value, 'Summarise the report');
  assert.match(row.textContent, /2 of 8/);
  assert.match(row.textContent, /1,200 of 32,768 in · 300 of 8,192 out/);
  assert.equal(row.querySelector('[data-action="runs-child"]').textContent, 'Research sources');
  box.value = 'Summarise the report in French';
  box.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  box.focus(); box.setSelectionRange(3, 6);
  await h.controller.refresh(); await h.controller.refresh();
  const after = row.querySelector('[data-draft="edit"]');
  assert.equal(after.value, 'Summarise the report in French');
  assert.equal(h.document.activeElement, after);
  assert.equal(after.selectionStart, 3);
  h.click('[data-action="runs-edit"]'); await settle();
  assert.deepEqual(updates, [{ work_id: 'work_a', expected_revision: 1, prompt: 'Summarise the report in French' }]);
  h.click('.runs-open-link'); await settle();
  assert.deepEqual(h.opened, [['session_work_a', { turnId: 'turn_work_a' }]]);
  assert.equal(h.state.ui.activeView, 'chat');
  h.controller.dispose();
});

test('OFF blocks Resume while Stop, Withdraw and limits stay usable; model text stays escaped', async () => {
  const h = harness({}, { sessions: [{ id: 'session_work_n', title: '<img src=x onerror=alert(1)>' }] });
  h.setSnapshot(snapshot([item('work_n', { status: 'paused', group: 'needs_you', queue_position: null }),
    item('work_w'), item('work_r', { status: 'running', group: 'running', queue_position: null })], { enabled: false }));
  h.show('runs');
  h.controller.bind(); await settle();
  assert.equal(h.runsHost.querySelector('[data-action="runs-resume"]').disabled, true);
  assert.equal(h.runsHost.querySelector('[data-action="runs-withdraw"]').disabled, false);
  assert.equal(h.runsHost.querySelector('[data-action="runs-stop"]').disabled, false);
  assert.equal(h.runsHost.querySelector('img'), null);
  assert.equal(h.runsHost.querySelector('[data-work-id="work_n"] .runs-row-title').textContent, '<img src=x onerror=alert(1)>');
  h.show('limits'); h.controller.wake(); await settle();
  assert.equal(h.limitsHost.querySelector('[data-draft="limit_local_runnable_turns"]').disabled, false);
  h.controller.dispose();
});

test('pause requested on a running turn reads as requested, never as paused, and is not asked twice', async () => {
  const h = harness();
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null, control_kind: 'pause' })]));
  h.controller.bind(); await settle();
  const meta = h.runsHost.querySelector('.runs-row-meta').textContent;
  assert.match(meta, /pause requested/);
  assert.doesNotMatch(meta, /· paused/);
  assert.equal(h.runsHost.querySelector('[data-action="runs-pause"]').disabled, true);
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null, control_kind: 'cancel' })]));
  await h.controller.refresh();
  assert.match(h.runsHost.querySelector('.runs-row-meta').textContent, /stop requested, cleaning up/);
  assert.equal(h.runsHost.querySelector('[data-action="runs-stop"]').disabled, true);
  h.controller.dispose();
});

test('the project filter lists the projects in view and narrows the rows', async () => {
  const h = harness({}, { sessions: [] });
  h.setSnapshot(snapshot([item('work_a'), item('work_b', { project_id: 'project_site' })]));
  const withProjects = controllers.createController({ windowRef: h.windowRef, state: h.state, runsHost: h.runsHost, now: () => NOW,
    getProjects: () => [{ id: 'project_site', name: 'jenny-site' }] });
  withProjects.bind(); await settle();
  assert.equal(h.runsHost.querySelector('[data-action="runs-filter"]').textContent, 'All projects ▾');
  h.click('[data-action="runs-filter"]');
  const options = [...h.runsHost.querySelectorAll('[role="menuitemradio"]')].map(node => [node.textContent, node.getAttribute('aria-checked')]);
  assert.deepEqual(options, [['All projects', 'true'], ['General', 'false'], ['jenny-site', 'false']]);
  assert.equal(h.document.activeElement?.textContent, 'All projects', 'the menu opens on the checked item');
  h.document.activeElement.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(h.document.activeElement?.textContent, 'General');
  h.document.activeElement.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(h.runsHost.querySelector('[role="menu"]'), null);
  assert.equal(h.document.activeElement?.dataset.action, 'runs-filter');
  h.click('[data-action="runs-filter"]');
  h.click('[data-action="runs-filter-pick"][data-project-id="project_site"]');
  assert.deepEqual([...h.runsHost.querySelectorAll('.runs-row')].map(node => node.dataset.workId), ['work_b']);
  assert.match(h.runsHost.querySelector('.runs-row-meta').textContent, /^jenny-site · /);
  withProjects.dispose(); h.controller.dispose();
});

test('an empty page is one muted line', async () => {
  const h = harness();
  h.setSnapshot(snapshot([]));
  h.controller.bind(); await settle();
  const empty = h.runsHost.querySelector('[data-runs-empty]');
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, 'Nothing is running. Work you start in a chat shows up here.');
  assert.equal(h.runsHost.querySelectorAll('.runs-group:not([hidden])').length, 0);
  h.controller.dispose();
});

test('Diagnostics › Runs and the Runtime limits binder share one lazily loaded controller and drop a late load after release', async () => {
  const globals = { rendererRunsView: runsView, rendererRuntimeLimitsView: limitsView, rendererOrchestrationController: controllers };
  const h = harness(); const pending = deferred(); const loads = [];
  h.controller.dispose();
  h.windowRef.scriptLoaderUtils = { ensureScript: async ({ src }) => { loads.push(src); await pending.promise; Object.assign(h.windowRef, globals); return true; } };
  createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef, getLazySectionDom: () => ({}), callbacks: {} });
  h.windowRef.rendererRuntimeConsole.showRuns(h.runsHost);
  assert.equal(loads.length, 1);
  h.windowRef.rendererRuntimeConsole.dispose(); pending.resolve(); await settle();
  assert.equal(h.snapshotReads(), 0, 'released before load: no fetch');

  const h2 = harness(); const order = [];
  h2.controller.dispose();
  h2.windowRef.scriptLoaderUtils = { ensureScript: async ({ src }) => { order.push(src);
    const name = src.endsWith('runs-view.js') ? 'rendererRunsView' : src.endsWith('limits-view.js') ? 'rendererRuntimeLimitsView' : 'rendererOrchestrationController';
    h2.windowRef[name] = globals[name]; return true; } };
  const binder = createSettingsSectionBinders({ state: h2.state, windowRef: h2.windowRef,
    getLazySectionDom: () => ({ advancedTuningFields: h2.limitsHost }), callbacks: {} });
  const cleanups = [];
  const ctx = { registerSectionListener() {}, markSectionBound() {}, addCleanup(fn) { cleanups.push(fn); }, finalizeSectionBindings() { return true; } };
  h2.windowRef.rendererRuntimeConsole.showRuns(h2.runsHost); binder.bindSection('runtimeLimits', ctx); await settle();
  assert.deepEqual(order, ['renderer/shell/renderer-runs-view.js', 'renderer/shell/renderer-runtime-limits-view.js',
    'renderer/shell/renderer-orchestration-controller.js']);
  assert.equal(h2.snapshotReads(), 1, 'one poller serves both views');
  assert.match(h2.runsHost.textContent, /Quarterly report/);
  h2.show('limits'); h2.timers.at(-1)(); await settle();
  assert.match(h2.limitsHost.textContent, /Runtime limits/);
  assert.equal(h2.snapshotReads(), 2);
  for (const fn of cleanups) fn();
  h2.windowRef.rendererRuntimeConsole.dispose();
});

test('Diagnostics › Runs polls only while Diagnostics shows the Runs tab, and a paint of the tab wakes it', async () => {
  const h = harness(); h.controller.dispose();
  Object.assign(h.windowRef, { rendererRunsView: runsView, rendererRuntimeLimitsView: limitsView, rendererOrchestrationController: controllers });
  createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef, getLazySectionDom: () => ({}), callbacks: {} });
  const seam = h.windowRef.rendererRuntimeConsole;
  seam.showRuns(h.runsHost); await settle();
  assert.match(h.runsHost.textContent, /Quarterly report/, 'the first paint attaches the board');
  const reads = h.snapshotReads();
  assert.equal(reads, 1);
  // Another Diagnostics tab: the next tick reads nothing and the poll stops.
  h.state.ui.logs.activeTab = 'activity'; h.timers.at(-1)(); await settle();
  assert.equal(h.snapshotReads(), reads, 'Activity tab: no read');
  // Settings (even the old Runs section id) is not where Runs shows any more.
  h.state.ui.activeView = 'settings'; h.state.ui.activeSettingsSection = 'runs'; h.state.ui.logs.activeTab = 'runs';
  seam.showRuns(h.runsHost); await settle();
  assert.equal(h.snapshotReads(), reads, 'Settings view: no read');
  // Back on Diagnostics › Runs: the paint wakes the stopped poll at once.
  h.show('runs');
  seam.showRuns(h.runsHost); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'Runs tab shown again: a read now');
  seam.showRuns(h.runsHost); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'a repaint while polling does not read again');
  // A newer binder set (settings rebind) releases the older board.
  createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef, getLazySectionDom: () => ({}), callbacks: {} });
  assert.notEqual(h.windowRef.rendererRuntimeConsole, seam);
  h.timers.at(-1)(); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'the released controller no longer polls');
  h.windowRef.rendererRuntimeConsole.dispose();
});

test('a failed lazy load leaves a retry that loads on click', async () => {
  const h = harness(); h.controller.dispose();
  let fail = true;
  h.windowRef.scriptLoaderUtils = { ensureScript: async ({ src }) => {
    if (fail) return false;
    if (src.endsWith('runs-view.js')) h.windowRef.rendererRunsView = runsView;
    else if (src.endsWith('limits-view.js')) h.windowRef.rendererRuntimeLimitsView = limitsView;
    else h.windowRef.rendererOrchestrationController = controllers;
    return true; } };
  h.windowRef.inventoryActionButton = require('../renderer/inventory/action-button');
  createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef, getLazySectionDom: () => ({}), callbacks: {} });
  h.windowRef.rendererRuntimeConsole.showRuns(h.runsHost);
  await settle();
  const retry = h.runsHost.querySelector('[data-action="runtime-load-retry"]');
  assert.ok(retry);
  fail = false; retry.click(); await settle();
  assert.match(h.runsHost.textContent, /Quarterly report/);
  h.windowRef.rendererRuntimeConsole.dispose();
});

test('runs and limits render translated strings in pseudo, RTL and CJK locales', () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  for (const tag of ['qps-ploc', 'ar', 'ja', 'zh-CN', 'zh-TW']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', `${tag}.json`), 'utf8'));
    const strings = catalog.strings || catalog;
    const context = vm.createContext({ inventoryActionButton: require('../renderer/inventory/action-button'), Intl,
      inventoryTextField: require('../renderer/inventory/text-field'), inventoryNumberInput: require('../renderer/inventory/number-input'),
      inventorySettingsField: require('../renderer/inventory/settings-field'), jennyI18n: { tag: () => tag === 'qps-ploc' ? 'en' : tag,
        t: (key, fallback, params) => String(strings[key] || fallback).replace(/\{(\w+)\}/g, (match, name) => params?.[name] ?? match) } });
    for (const file of ['renderer-runs-view.js', 'renderer-runtime-limits-view.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/shell', file), 'utf8'), context);
    }
    const dom = new JSDOM(`<html dir="${tag === 'ar' ? 'rtl' : 'ltr'}"><body><div id="runs"></div><div id="limits"></div></body></html>`);
    const runs = context.rendererRunsView.createRunsView(dom.window.document.getElementById('runs'));
    const model = { snapshot: snapshot(), loaded: true, draft: {}, sessions: [{ id: 'session_work_a', title: '会話 العربية' }], projects: [],
      now: NOW, finishedSince: controllers.localMidnight(NOW), canControl: () => true, limitErrors: {} };
    runs.update(model);
    const host = dom.window.document.getElementById('runs');
    assert.equal(host.querySelector('h3').textContent, strings['runtime.runs.title'] || 'Runs');
    assert.equal(host.textContent.includes('{'), false, `${tag}: no raw placeholders`);
    assert.equal(host.querySelector('.runs-row-title').textContent, '会話 العربية');
    const limitsHost = dom.window.document.getElementById('limits');
    context.rendererRuntimeLimitsView.createLimitsView(limitsHost).update(model);
    assert.equal(limitsHost.querySelectorAll('input[type="number"]').length, 11);
    assert.equal(limitsHost.textContent.includes('{'), false, `${tag}: no raw placeholders in limits`);
    dom.window.close();
  }
});

test('the instructions box follows a newer prompt until the person types, and the save checks the revision they saw', async () => {
  const updates = [];
  let prompt = 'Summarise the report'; let revision = 1;
  const h = harness({ updatePending: async payload => { updates.push(payload); return { ok: false }; },
    getWork: async payload => detail(item(payload.work_id, { revision }), { prompt }) });
  h.controller.bind(); await settle();
  h.click('.runs-row-main'); await settle();
  const box = () => h.runsHost.querySelector('[data-draft="edit"]');
  assert.equal(box().value, 'Summarise the report');
  prompt = 'Summarise the report as bullets'; revision = 2;
  h.setSnapshot(snapshot([item('work_a', { revision: 2 })]));
  await h.controller.refresh();
  assert.equal(box().value, 'Summarise the report as bullets', 'no stale text under a newer revision');
  box().value = 'Summarise the report as bullets, in French';
  box().dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
  prompt = 'Someone else changed it'; revision = 3;
  h.setSnapshot(snapshot([item('work_a', { revision: 3 })]));
  await h.controller.refresh();
  assert.equal(box().value, 'Summarise the report as bullets, in French', 'the draft survives the poll');
  h.click('[data-action="runs-edit"]'); await settle();
  assert.equal(updates[0].expected_revision, 2, 'checked against the revision the person was editing, so revision 3 conflicts');
  h.controller.dispose();
});

test('paused and needs-attention work can be stopped while the runtime is off', async () => {
  const cancels = [];
  const h = harness({ cancel: async payload => { cancels.push(payload); return { ok: true, status: 'requested' }; } });
  h.setSnapshot(snapshot([item('work_a', { status: 'paused', group: 'needs_you', queue_position: null, recovery_kind: 'restart_paused', revision: 5 })],
    { enabled: false }));
  h.controller.bind(); await settle();
  assert.equal(h.runsHost.querySelector('[data-action="runs-resume"]').disabled, true);
  assert.equal(h.runsHost.querySelector('[data-action="runs-stop"]').disabled, false);
  h.click('[data-action="runs-stop"]'); h.click('[data-action="runs-stop-confirm"]'); await settle();
  assert.deepEqual(cancels, [{ work_id: 'work_a', expected_revision: 5 }]);
  h.controller.dispose();
});

test('a poll that removes the focused action keeps focus on the same row', async () => {
  const h = harness();
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null })]));
  h.controller.bind(); await settle();
  h.runsHost.querySelector('[data-action="runs-pause"]').focus();
  h.setSnapshot(snapshot([item('work_a', { status: 'paused', group: 'needs_you', queue_position: null, revision: 2 })]));
  await h.controller.refresh();
  assert.equal(h.runsHost.querySelector('[data-action="runs-pause"]'), null, 'Pause is gone');
  assert.equal(h.document.activeElement?.dataset.focusKey, 'work_a:select', 'focus lands on the row, not the page body');
  h.controller.dispose();
});

test('a failed detail read clears once reads succeed again', async () => {
  let fail = true;
  const h = harness({ getWork: async payload => (fail ? { ok: false } : detail(item(payload.work_id))) });
  h.controller.bind(); await settle();
  h.click('.runs-row-main'); await settle();
  const message = h.runsHost.querySelector('[data-runs-message]');
  assert.match(message.textContent, /unavailable/);
  fail = false; await h.controller.refresh();
  assert.equal(message.textContent, '');
  assert.equal(message.hidden, true);
  h.controller.dispose();
});

test('one tool call reads singular', () => {
  assert.equal(runsView.stateDetail({ group: 'running', status: 'running', progress: { steps: 2, tool_calls: 1 } }), 'step 2 · 1 tool call');
  assert.equal(runsView.stateDetail({ group: 'running', status: 'running', progress: { steps: 2, tool_calls: 3 } }), 'step 2 · 3 tool calls');
});

test('F6: back on the view with no size change, the stopped poll resumes and repaints at once', async () => {
  const h = harness();
  h.controller.bind(); await settle();
  const count = () => h.runsHost.querySelector('[data-runs-count]').textContent;
  assert.equal(count(), '0 running · 1 waiting');
  h.state.ui.activeView = 'chat';
  h.timers.at(-1)(); await settle();
  assert.equal(h.controller.isPolling(), false, 'Chat shown: the poll stops');
  h.setSnapshot(snapshot([item('work_r', { status: 'running', group: 'running', queue_position: null }), item('work_a')]));
  const reads = h.snapshotReads();
  // The Diagnostics view again; it hides with content-visibility, so no resize fires.
  h.show('runs');
  h.controller.resume(); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'shown: a read now, not a tick later');
  assert.equal(count(), '1 running · 1 waiting');
  assert.equal(h.controller.isPolling(), true);
  h.setSnapshot(snapshot([]));
  h.controller.resume(); await settle();
  assert.equal(h.snapshotReads(), reads + 2, 'shown while a tick is pending: still a read now');
  assert.equal(count(), '0 running · 0 waiting');
  h.controller.dispose();
});

test('F6: the section binders pass "section shown" to the shared controller', async () => {
  const h = harness(); h.controller.dispose();
  Object.assign(h.windowRef, { rendererRunsView: runsView, rendererRuntimeLimitsView: limitsView, rendererOrchestrationController: controllers });
  h.show('limits');
  const binder = createSettingsSectionBinders({ state: h.state, windowRef: h.windowRef,
    getLazySectionDom: () => ({ advancedTuningFields: h.limitsHost }), callbacks: {} });
  const cleanups = [];
  binder.bindSection('runtimeLimits', { registerSectionListener() {}, markSectionBound() {}, addCleanup(fn) { cleanups.push(fn); }, finalizeSectionBindings() { return true; } });
  await settle();
  h.state.ui.activeView = 'chat'; h.timers.at(-1)(); await settle();
  const reads = h.snapshotReads();
  h.show('limits');
  binder.sectionShown('runtimeLimits'); await settle();
  assert.equal(h.snapshotReads(), reads + 1);
  binder.sectionShown('models'); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'other sections do not touch the poller');
  binder.sectionShown('runs'); await settle();
  assert.equal(h.snapshotReads(), reads + 1, 'Runs is no Settings section any more');
  for (const fn of cleanups) fn();
});

test('F7: when Withdraw or a confirmed Stop removes the row, focus moves to the next row, else the previous, else the filter', async () => {
  const running = (id, extra = {}) => item(id, { status: 'running', group: 'running', queue_position: null, ...extra });
  const h = harness({ cancel: async () => ({ ok: true, status: 'cancelled' }) });
  h.setSnapshot(snapshot([item('work_a', { created_at: '2026-09-27T14:00:00.000Z' }), item('work_b', { created_at: '2026-09-27T14:01:00.000Z' })]));
  h.controller.bind(); await settle();
  h.runsHost.querySelector('[data-work-id="work_a"][data-action="runs-withdraw"]').focus();
  h.setSnapshot(snapshot([item('work_a', { status: 'cancelled', group: 'finished', queue_position: null }), item('work_b')]));
  h.click('[data-work-id="work_a"][data-action="runs-withdraw"]'); await settle();
  assert.equal(h.runsHost.querySelector('.runs-group[data-group="finished"] .runs-list').hidden, true, 'withdrawn into the collapsed group');
  assert.equal(h.document.activeElement?.dataset.focusKey, 'work_b:select', 'the next row takes focus');

  h.setSnapshot(snapshot([running('work_r1', { created_at: '2026-09-27T14:00:00.000Z' }), running('work_r2', { created_at: '2026-09-27T14:01:00.000Z' })]));
  await h.controller.refresh();
  h.click('[data-work-id="work_r2"][data-action="runs-stop"]');
  h.setSnapshot(snapshot([running('work_r1')]));
  h.click('[data-action="runs-stop-confirm"]'); await settle();
  assert.equal(h.document.activeElement?.dataset.focusKey, 'work_r1:select', 'the last row gone: the previous row');

  h.click('[data-work-id="work_r1"][data-action="runs-stop"]');
  h.setSnapshot(snapshot([]));
  h.click('[data-action="runs-stop-confirm"]'); await settle();
  assert.equal(h.document.activeElement?.dataset.focusKey, 'filter', 'no rows left: the project filter');
  h.controller.dispose();
});

test('N6: "Stop requested" clears once its run is done; Finished today lists the newest first', async () => {
  const h = harness({ cancel: async () => ({ ok: true, status: 'requested' }) });
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null })]));
  h.controller.bind(); await settle();
  h.click('[data-action="runs-stop"]'); h.click('[data-action="runs-stop-confirm"]'); await settle();
  const message = h.runsHost.querySelector('[data-runs-message]');
  assert.match(message.textContent, /Stop requested/);
  h.setSnapshot(snapshot([item('work_a', { status: 'running', group: 'running', queue_position: null, control_kind: 'cancel', revision: 2 })]));
  await h.controller.refresh();
  assert.match(message.textContent, /Stop requested/, 'still cleaning up: the line stays');
  const finished = (id, at) => item(id, { status: 'completed', group: 'finished', queue_position: null, created_at: '2026-09-27T08:00:00.000Z', updated_at: at });
  h.setSnapshot(snapshot([finished('work_early', '2026-09-27T09:00:00.000Z'), item('work_a', { status: 'cancelled', group: 'finished',
    queue_position: null, updated_at: '2026-09-27T14:59:00.000Z' }), finished('work_mid', '2026-09-27T12:00:00.000Z')]));
  await h.controller.refresh();
  assert.equal(message.textContent, '');
  assert.equal(message.hidden, true);
  assert.deepEqual([...h.runsHost.querySelectorAll('.runs-group[data-group="finished"] .runs-row')].map(node => node.dataset.workId),
    ['work_a', 'work_mid', 'work_early']);
  h.controller.dispose();
});
