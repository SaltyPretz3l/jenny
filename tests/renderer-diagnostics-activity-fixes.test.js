'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const viewState = require('../renderer/shell/renderer-diagnostics-view-state');
const issueUtils = require('../renderer/shared/diagnostics-issue-utils');

// Diagnostics Activity fixes (row 57, A1 review): selection on append, group scope, search fields,
// Follow state, Escape scope, aria-disabled busy controls and the Open Models branch.

function entry(id, extra = {}) {
  return { entry_id: `entry-${id}`, run_id: 'run', sequence: id, ts: new Date(1700000000000 + id * 1000).toISOString(),
    level: 'INFO', layer: 'electron', component: 'chat', event: 'chat.note', message: `event ${id}`, ...extra };
}

function installDom(t, markup) {
  const dom = new JSDOM(markup, { pretendToBeVisual: true });
  const previous = { window: global.window, document: global.document };
  global.window = dom.window;
  global.document = dom.window.document;
  const beforeRestore = [];
  t.after(() => {
    while (beforeRestore.length) beforeRestore.pop()();
    Object.assign(global, previous);
    dom.window.close();
  });
  return Object.assign(dom, { beforeRestore });
}

const ACTIVITY_MARKUP = '<section id="diagnosticsActivity"><span id="logResultsLabel"></span>'
  + '<button id="logAutoScrollToggle" aria-pressed="true" class="active"></button>'
  + '<div id="diagnosticsActivityScope" hidden></div>'
  + '<div id="diagnosticsActivityLayout"><div id="logList"></div><aside id="logDetailPanel" hidden></aside></div></section>'
  + '<div id="diagnosticsStatusAnnouncer"></div>';

function activityHarness(t) {
  installDom(t, ACTIVITY_MARKUP);
  const activity = require('../renderer/shell/renderer-diagnostics-activity');
  const state = { ui: { logs: {} }, diagnosticsSnapshot: { active_run: { run_id: 'run' } }, logs: [] };
  const view = viewState.ensureDiagnosticsViewState(state);
  const cache = { signature: '', filterAnnouncementSignature: '', ids: [], selectedEntryId: '' };
  return { activity, state, view, cache, render: (entries) => activity.renderActivity(state, entries, null, cache) };
}

async function appWithEntries(t, entries) {
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => ({
    active_run: { run_id: 'run' }, entries, sources: {}, integrity: { complete: true, partial_reasons: [] },
  }) } } } });
  t.after(async () => app.dispose());
  app.window.document.getElementById('logsTopRailTab').click();
  await waitForUi(app.window, 50);
  app.window.__rendererState.logs = entries.slice();
  return app;
}

async function inspectGroup(app, group) {
  const { window } = app;
  const doc = window.document;
  const control = doc.createElement('button');
  control.dataset.action = 'inspect-diagnostic-issue';
  control.dataset.issue = encodeURIComponent(group.key);
  doc.getElementById('logsView').appendChild(control);
  control.click();
  await waitForUi(window, 60);
}

test('A1-1: a selection made in the same frame as an append marks the row selected and the only tab stop', (t) => {
  const { view, render } = activityHarness(t);
  const first = [entry(1), entry(2), entry(3)];
  render(first);
  assert.equal(globalThis.document.querySelector('[data-entry-id="entry-1"]').tabIndex, 0);

  view.selectedEntryId = 'entry-2';
  render(first.concat(entry(4)));
  const rows = Array.from(globalThis.document.querySelectorAll('#logList [data-entry-id]'));
  assert.equal(rows.length, 4);
  assert.equal(globalThis.document.querySelector('[data-entry-id="entry-2"]').getAttribute('aria-selected'), 'true');
  assert.deepEqual(rows.filter((row) => row.tabIndex === 0).map((row) => row.dataset.entryId), ['entry-2']);
});

test('A1-2: Inspect shows the records of a WARN group that has no component', async (t) => {
  const records = [entry(1, { level: 'WARN', layer: 'sidecar', component: undefined, event: 'engine.slow' }), entry(2)];
  const app = await appWithEntries(t, records);
  const [group] = issueUtils.groupIssues(records);
  await inspectGroup(app, group);
  const { window } = app;
  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  assert.equal(window.__rendererState.ui.logs.issueScope.key, group.key);
  assert.deepEqual(Array.from(window.document.querySelectorAll('#logList [data-entry-id]'), (row) => row.dataset.entryId), ['entry-1']);
});

test('A1-2: Inspect shows the records of a WARN group that has no event', async (t) => {
  const records = [entry(1, { level: 'WARN', event: '' }), entry(2)];
  const app = await appWithEntries(t, records);
  const [group] = issueUtils.groupIssues(records);
  await inspectGroup(app, group);
  assert.deepEqual(Array.from(app.window.document.querySelectorAll('#logList [data-entry-id]'), (row) => row.dataset.entryId), ['entry-1']);
});

test('A1-2: a scope whose group is gone says there are no records and Show all records clears it', async (t) => {
  const records = [entry(1, { level: 'WARN' })];
  const app = await appWithEntries(t, records);
  const { window } = app;
  const doc = window.document;
  await inspectGroup(app, { key: 'gone\u0000gone.event\u0000\u0000WARN\u0000\u0000false' });
  assert.equal(doc.querySelectorAll('#logList [data-entry-id]').length, 0);
  assert.match(doc.getElementById('logList').textContent, /No records for this issue in this launch/);
  const clear = doc.getElementById('diagnosticsClearScope');
  assert.ok(clear, 'Show all records stays available');
  clear.click();
  await waitForUi(window, 50);
  assert.equal(window.__rendererState.ui.logs.issueScope, null);
  assert.ok(doc.querySelector('[data-entry-id="entry-1"]'));
});

test('an empty launch says so once and a scoped empty list says why', (t) => {
  const { view, render } = activityHarness(t);
  const note = () => globalThis.document.querySelector('#logList .inv-empty-note').textContent;
  render([]);
  assert.equal(note(), 'No records yet. Records appear as Jenny works.');
  assert.equal(globalThis.document.getElementById('logResultsLabel').textContent, '0 records');
  view.query = 'nothing';
  render([entry(1)]);
  assert.equal(note(), 'No records match. Clear the search or filters.');
  assert.equal(globalThis.document.getElementById('logResultsLabel').textContent, '0 of 1 records');
  view.query = '';
  view.issueScope = { key: 'gone', title: '', count: 0 };
  render([entry(1)]);
  assert.equal(note(), 'No records for this issue in this launch.');
  assert.equal(globalThis.document.getElementById('diagnosticsActivity').dataset.scoped, 'true');
});

test('A1-13: search matches details.message and the error code', (t) => {
  const { view, render } = activityHarness(t);
  const records = [
    entry(1, { message: '', details: { message: 'needle in details' } }),
    entry(2, { data: { error_code: 'CMP-AI-0077' } }),
    entry(3, { data: { code: 'ENGINE_GONE' } }),
    entry(4),
  ];
  const ids = () => Array.from(globalThis.document.querySelectorAll('#logList [data-entry-id]'), (row) => row.dataset.entryId);
  view.query = 'NEEDLE IN';
  render(records);
  assert.deepEqual(ids(), ['entry-1']);
  view.query = 'cmp-ai-0077';
  render(records);
  assert.deepEqual(ids(), ['entry-2']);
  view.query = 'engine_gone';
  render(records);
  assert.deepEqual(ids(), ['entry-3']);
});

function bindingsHarness(t, { logs = {}, callbacks = {} } = {}) {
  const dom = installDom(t, '<div id="logsView"><button id="logAutoScrollToggle" class="active" aria-pressed="true"></button>'
    + '<button id="retry" data-action="diagnostics-retry-load" data-retry-model="m1"></button>'
    + '<button id="phasePercentilesResetButton">Reset</button>'
    + '<button id="openModels" data-action="diagnostics-open-models"></button>'
    + '<div id="logList"></div></div>');
  const state = { ui: { logs } };
  const bindings = createLogsEventBindings({
    state, dom: { logList: dom.window.document.getElementById('logList') },
    callbacks: { renderLogs() {}, ...callbacks },
  });
  bindings.bind();
  dom.beforeRestore.push(() => bindings.dispose());
  return { dom, state, doc: dom.window.document, view: viewState.ensureDiagnosticsViewState(state) };
}

test('A1-15: the scroll handler keeps Follow .active in sync with aria-pressed', (t) => {
  const { dom, doc, view } = bindingsHarness(t, { logs: { autoScroll: true } });
  const list = doc.getElementById('logList');
  Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 100, configurable: true });
  list.scrollTop = 0;
  list.dispatchEvent(new dom.window.Event('scroll'));
  const follow = doc.getElementById('logAutoScrollToggle');
  assert.equal(view.autoScroll, false);
  assert.equal(follow.getAttribute('aria-pressed'), 'false');
  assert.equal(follow.classList.contains('active'), false);
});

test('A1-15: Escape closes the inspector only while Activity is shown', (t) => {
  const { dom, doc, view } = bindingsHarness(t, { logs: { activeTab: 'overview', selectedEntryId: 'x' } });
  const root = doc.getElementById('logsView');
  const press = () => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    root.dispatchEvent(event);
    return event;
  };
  assert.equal(press().defaultPrevented, false);
  assert.equal(view.selectedEntryId, 'x');
  view.activeTab = 'activity';
  assert.equal(press().defaultPrevented, true);
  assert.equal(view.selectedEntryId, '');
});

for (const [name, selector, callbackName] of [
  ['Retry load', '#retry', 'retryModelLoad'],
  ['Reset timings', '#phasePercentilesResetButton', 'resetPhasePercentiles'],
]) {
  test(`A1-15: ${name} stays focusable while busy and ignores a second click`, async (t) => {
    let release;
    let calls = 0;
    const { doc } = bindingsHarness(t, { callbacks: {
      [callbackName]: () => { calls += 1; return new Promise((resolve) => { release = resolve; }); },
      refreshPhasePercentiles: async () => null,
    } });
    const button = doc.querySelector(selector);
    button.focus();
    button.click();
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    assert.equal(button.disabled, false, 'never the disabled property, so focus stays');
    assert.equal(doc.activeElement, button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.notEqual(button.getAttribute('aria-disabled'), 'true');
  });
}

test('Open Models: the diagnostics-open-models control calls the openModels callback', (t) => {
  let opened = 0;
  const { doc } = bindingsHarness(t, { callbacks: { openModels: () => { opened += 1; } } });
  doc.getElementById('openModels').click();
  assert.equal(opened, 1);
});

test('Open Models: the loaded app wires the control to the Models page', async (t) => {
  const app = await appWithEntries(t, []);
  const { window } = app;
  const control = window.document.createElement('button');
  control.dataset.action = 'diagnostics-open-models';
  window.document.getElementById('logsView').appendChild(control);
  control.click();
  await waitForUi(window, 60);
  assert.equal(window.__rendererState.ui.activeView, 'settings');
  assert.equal(window.__rendererState.ui.activeSettingsSection, 'models');
});

test('a trace link with no matching record opens Activity and focuses its first row', async (t) => {
  const app = await appWithEntries(t, [entry(1), entry(2)]);
  const { window } = app;
  assert.equal(window.__rendererState.ui.logs.activeTab, 'overview');
  window.dispatchEvent(new window.CustomEvent('diagnostics:focus-log-entry', { detail: { entryId: '' } }));
  await waitForUi(window, 80);
  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  assert.equal(window.document.activeElement?.dataset?.entryId, 'entry-1');
});
