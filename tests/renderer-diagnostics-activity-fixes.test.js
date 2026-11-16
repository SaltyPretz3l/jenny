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
  + '<div id="diagnosticsActivityLayout"><div id="logList"></div><div id="logEmpty" hidden></div><aside id="logDetailPanel" hidden></aside></div></section>'
  + '<div id="diagnosticsStatusAnnouncer"></div>';

function activityHarness(t) {
  const dom = installDom(t, ACTIVITY_MARKUP);
  const activity = require('../renderer/shell/renderer-diagnostics-activity');
  const state = { ui: { logs: {} }, diagnosticsRefreshedAt: 1, diagnosticsSnapshot: { active_run: { run_id: 'run' } }, logs: [] };
  const view = viewState.ensureDiagnosticsViewState(state);
  const cache = { signature: '', filterAnnouncementSignature: '', ids: [], selectedEntryId: '' };
  dom.beforeRestore.push(() => clearTimeout(cache.announceTimer));
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
  assert.match(doc.getElementById('logEmpty').textContent, /No records for this issue in this launch/);
  const clear = doc.getElementById('diagnosticsClearScope');
  assert.ok(clear, 'Show all records stays available');
  clear.click();
  await waitForUi(window, 50);
  assert.equal(window.__rendererState.ui.logs.issueScope, null);
  assert.ok(doc.querySelector('[data-entry-id="entry-1"]'));
});

test('an empty launch says so once and a scoped empty list says why', (t) => {
  const { view, render } = activityHarness(t);
  const note = () => globalThis.document.querySelector('#logEmpty .inv-empty-note').textContent;
  render([]);
  assert.equal(note(), 'No records yet. Records appear as Jenny works.');
  assert.equal(globalThis.document.getElementById('logResultsLabel').textContent, '0 records');
  view.query = 'nothing';
  render([entry(1)]);
  assert.equal(note(), 'No records match.');
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

const byId = (id) => globalThis.document.getElementById(id);
const rowIds = () => Array.from(globalThis.document.querySelectorAll('#logList [data-entry-id]'), (row) => row.dataset.entryId);

test('a launch with no records says why in one note: loading, failed, this launch, previous launch', (t) => {
  const { state, view, render } = activityHarness(t);
  const note = () => byId('logEmpty').querySelector('.inv-empty-note');
  const check = (text) => {
    render([]);
    assert.equal(note().textContent, text);
    assert.equal(byId('diagnosticsActivity').dataset.records, 'none');
    assert.equal(byId('diagnosticsActivity').dataset.list, 'empty');
    assert.equal(byId('logEmpty').hidden, false);
    assert.equal(byId('logList').hidden, true);
    assert.equal(byId('logEmpty').querySelector('button'), null, 'no action while the launch has no records');
    assert.equal(byId('logAutoScrollToggle').disabled, true);
  };
  const snapshot = state.diagnosticsSnapshot;
  delete state.diagnosticsSnapshot;
  delete state.diagnosticsRefreshedAt;
  check('Loading records…');
  assert.equal(note().getAttribute('role'), 'status');
  // The logs snapshot landed while a slower refresher (runtime inventory, say) is still running.
  state.diagnosticsSnapshot = snapshot;
  check('No records yet. Records appear as Jenny works.');
  state.diagnosticsRefreshedAt = 1;
  state.diagnosticsSnapshot.integrity = { partial_reasons: ['refresh_logs_failed'] };
  check('Records couldn’t load. Refresh on Overview to try again.');
  assert.equal(note().getAttribute('role'), null);
  state.diagnosticsSnapshot.integrity = { partial_reasons: [] };
  check('No records yet. Records appear as Jenny works.');
  view.selectedRunId = 'prior';
  check('The previous launch left no records. Choose This launch to see what Jenny is doing now.');

  view.selectedRunId = 'run';
  render([entry(1)]);
  assert.equal(byId('diagnosticsActivity').dataset.records, 'some');
  assert.equal(byId('diagnosticsActivity').dataset.list, 'rows');
  assert.equal(byId('logEmpty').hidden, true);
  assert.equal(byId('logEmpty').innerHTML, '');
  assert.equal(byId('logList').hidden, false);
  assert.equal(byId('logAutoScrollToggle').disabled, false);
  assert.deepEqual(rowIds(), ['entry-1']);
});

test('filters that match nothing keep the toolbar facts and offer Clear search and filters outside the listbox', (t) => {
  const { view, render } = activityHarness(t);
  view.query = 'zzz';
  render([entry(1)]);
  assert.equal(byId('diagnosticsActivity').dataset.records, 'some');
  assert.equal(byId('diagnosticsActivity').dataset.list, 'empty');
  assert.equal(byId('logResultsLabel').textContent, '0 of 1 records');
  assert.equal(byId('logList').hidden, true);
  assert.equal(byId('logList').querySelector('button'), null, 'a button may not live inside the listbox');
  assert.equal(byId('logEmpty').querySelector('.inv-empty-note').textContent, 'No records match.');
  const action = byId('logEmpty').querySelector('button[data-action="clear-diagnostics-filters"]');
  assert.equal(action.textContent, 'Clear search and filters');
  assert.ok(action.classList.contains('diagnostics-issue-link'));
});

test('Clear search and filters resets query, severity and source and focuses search', async (t) => {
  const app = await appWithEntries(t, [entry(1), entry(2, { level: 'WARN' })]);
  const { window } = app;
  const doc = window.document;
  doc.getElementById('diagnosticsActivityTab').click();
  await waitForUi(window, 40);
  const search = doc.getElementById('logSearchInput');
  const level = doc.getElementById('logLevelFilter');
  level.value = 'error';
  level.dispatchEvent(new window.Event('change', { bubbles: true }));
  search.value = 'zzz';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(doc.querySelectorAll('#logList [data-entry-id]').length, 0);
  doc.querySelector('#logEmpty [data-action="clear-diagnostics-filters"]').click();
  await waitForUi(window, 60);
  const logs = window.__rendererState.ui.logs;
  assert.deepEqual([logs.query, logs.levelFilter, logs.sourceFilter, logs.returnState], ['', 'all', 'all', null]);
  assert.deepEqual([search.value, level.value], ['', 'all']);
  assert.equal(doc.querySelectorAll('#logList [data-entry-id]').length, 2);
  assert.equal(doc.getElementById('logEmpty').hidden, true);
  assert.equal(doc.activeElement, search);
});

test('the scope line shows no count when the issue left the launch', (t) => {
  const { activity, view, render } = activityHarness(t);
  const records = [entry(1, { level: 'WARN' })];
  view.issueScope = { key: 'gone', title: 'Gone', count: 0 };
  render(records);
  const scope = byId('diagnosticsActivityScope');
  assert.match(scope.textContent, /Showing records for Gone.*Show all records/);
  assert.equal(scope.querySelector('.diagnostics-scope-count'), null);
  const [group] = issueUtils.groupIssues(records);
  view.issueScope = activity.issueScopeFor(group, group.key);
  render(records);
  assert.equal(scope.querySelector('.diagnostics-scope-count').textContent, '1 record');
});

test('a record with no layer is the App source: it stays under Source > App and is found by "electron"', (t) => {
  const { view, render } = activityHarness(t);
  const records = [entry(1, { layer: '' }), entry(2, { layer: 'sidecar' }), entry(3, { layer: undefined, source: undefined })];
  view.sourceFilter = 'electron';
  render(records);
  assert.deepEqual(rowIds(), ['entry-1', 'entry-3']);
  view.sourceFilter = 'all';
  view.query = 'electron';
  render(records);
  assert.deepEqual(rowIds(), ['entry-1', 'entry-3']);
});

// jsdom has no layout: rows are 20 px tall in document order, the list shows from its scrollTop.
function stubListLayout(dom, list) {
  let scrollTop = 0;
  Object.defineProperty(list, 'scrollTop', { configurable: true, get: () => scrollTop, set: (value) => { scrollTop = value; } });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => 5000 });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function rect() {
    const index = this.parentElement === list ? Array.prototype.indexOf.call(list.children, this) : 0;
    const top = this.parentElement === list ? index * 20 - scrollTop : 0;
    return { top, bottom: top + (this === list ? 400 : 20), height: this === list ? 400 : 20, left: 0, right: 0, width: 0 };
  };
}

test('at the retention limit a new record removes and appends rows in place and keeps the reader where they were', (t) => {
  const dom = installDom(t, ACTIVITY_MARKUP);
  const activity = require('../renderer/shell/renderer-diagnostics-activity');
  const state = { ui: { logs: {} }, diagnosticsRefreshedAt: 1, diagnosticsSnapshot: { active_run: { run_id: 'run' } }, logs: [] };
  const view = viewState.ensureDiagnosticsViewState(state);
  const cache = { signature: '', filterAnnouncementSignature: '', ids: [], selectedEntryId: '' };
  dom.beforeRestore.push(() => clearTimeout(cache.announceTimer));
  let rebuilds = 0;
  const virtualizer = { rebuild() { rebuilds += 1; } };
  const list = byId('logList');
  stubListLayout(dom, list);
  const paint = (records) => activity.renderActivity(state, records, virtualizer, cache);
  const records = Array.from({ length: 750 }, (_, index) => entry(index + 1));
  view.autoScroll = false;
  paint(records);
  const before = new Map(Array.from(list.querySelectorAll('[data-entry-id]'), (row) => [row.dataset.entryId, row]));
  list.scrollTop = 200;
  const dropped = new Set(['entry-3', 'entry-5', 'entry-6']);
  const next = records.filter((record) => !dropped.has(record.entry_id)).concat(entry(751));
  const rebuildsBefore = rebuilds;
  paint(next);

  assert.equal(list.querySelectorAll('[data-entry-id]').length, 748);
  for (const [id, row] of before) {
    assert.equal(list.querySelector(`[data-entry-id="${id}"]`), dropped.has(id) ? null : row, `${id} keeps its node`);
  }
  assert.equal(list.lastElementChild.dataset.entryId, 'entry-751');
  assert.equal(list.scrollTop, 140, 'the first visible row stays at the top: three rows above it left');
  assert.equal(rebuilds, rebuildsBefore + 1);

  view.autoScroll = true;
  paint(next.slice(1).concat(entry(752)));
  assert.equal(list.scrollTop, list.scrollHeight, 'following: the list ends at the newest record');
});

test('in-place trim anchors on a surviving row when the first visible row is itself dropped', (t) => {
  const dom = installDom(t, ACTIVITY_MARKUP);
  const activity = require('../renderer/shell/renderer-diagnostics-activity');
  const state = { ui: { logs: {} }, diagnosticsRefreshedAt: 1, diagnosticsSnapshot: { active_run: { run_id: 'run' } }, logs: [] };
  const view = viewState.ensureDiagnosticsViewState(state);
  const cache = { signature: '', filterAnnouncementSignature: '', ids: [], selectedEntryId: '' };
  dom.beforeRestore.push(() => clearTimeout(cache.announceTimer));
  const list = byId('logList');
  stubListLayout(dom, list);
  const records = Array.from({ length: 40 }, (_, index) => entry(index + 1));
  view.autoScroll = false;
  activity.renderActivity(state, records, null, cache);
  list.scrollTop = 200; // entry-11 sits at the top, entry-12 20 px below it
  const dropped = new Set(['entry-2', 'entry-11']);
  activity.renderActivity(state, records.filter((record) => !dropped.has(record.entry_id)).concat(entry(41)), null, cache);
  const entry12 = list.querySelector('[data-entry-id="entry-12"]');
  assert.equal(entry12.getBoundingClientRect().top, 20, 'entry-12 stays where the reader saw it');
  assert.equal(list.scrollTop, 160);
});

test('in-place trim hands focus to the next surviving row when the focused row is dropped', (t) => {
  const { view, render } = activityHarness(t);
  const records = [1, 2, 3, 4, 5].map((id) => entry(id));
  view.autoScroll = false;
  render(records);
  byId('logList').querySelector('[data-entry-id="entry-2"]').focus();
  assert.equal(globalThis.document.activeElement.dataset.entryId, 'entry-2');
  render(records.filter((record) => record.entry_id !== 'entry-2').concat(entry(6)));
  assert.equal(globalThis.document.activeElement.dataset.entryId, 'entry-3');
  assert.deepEqual(Array.from(globalThis.document.querySelectorAll('#logList [tabindex="0"]'), (row) => row.dataset.entryId), ['entry-3']);
});

function countAnnouncements(t) {
  const node = byId('diagnosticsStatusAnnouncer');
  const writes = [];
  Object.defineProperty(node, 'textContent', { configurable: true, get: () => '', set: (value) => { writes.push(value); } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return writes;
}

test('typing quickly announces the match count once, after the typing settles', (t) => {
  const { view, render } = activityHarness(t);
  const writes = countAnnouncements(t);
  for (const query of ['a', 'ab', 'abc']) {
    view.query = query;
    render([entry(1), entry(2)]);
    t.mock.timers.tick(100);
  }
  assert.deepEqual(writes, [], 'nothing is announced while the query keeps changing');
  t.mock.timers.tick(600);
  assert.deepEqual(writes, ['0 matching events.']);
});

test('dispose clears the pending announcement and nothing is written after it', (t) => {
  const { state, view } = activityHarness(t);
  const { createLogRenderer } = require('../renderer/shell/renderer-diagnostics-render-utils');
  globalThis.window.requestAnimationFrame = undefined;
  globalThis.window.cancelAnimationFrame = undefined;
  const writes = countAnnouncements(t);
  state.ui.activeView = 'logs';
  view.activeTab = 'activity';
  state.logs = [entry(1)];
  const renderer = createLogRenderer({ state, dom: { logList: byId('logList') } });
  renderer.renderLogs();
  t.mock.timers.tick(10);
  assert.ok(byId('logList').querySelector('[data-entry-id]'), 'the paint ran');
  assert.deepEqual(writes, [], 'the announcement waits for the typing to settle');
  renderer.dispose();
  t.mock.timers.tick(2000);
  assert.deepEqual(writes, []);
});

test('a launch with no records announces no match count over its note', (t) => {
  const { render } = activityHarness(t);
  const writes = countAnnouncements(t);
  render([]);
  t.mock.timers.tick(2000);
  assert.deepEqual(writes, []);
});

test('after an in-place trim the tab stop is a mounted row, not a virtualized placeholder', (t) => {
  const { state, view, cache, activity } = activityHarness(t);
  const mounted = [];
  const virtualizer = { rebuild() {}, ensureMountedForId(id) { mounted.push(id); return true; } };
  const records = [1, 2, 3, 4].map((id) => entry(id));
  view.autoScroll = false;
  activity.renderActivity(state, records, virtualizer, cache);
  mounted.length = 0;
  activity.renderActivity(state, records.slice(1).concat(entry(5)), virtualizer, cache);
  assert.equal(byId('logList').querySelector('[tabindex="0"]').dataset.entryId, 'entry-2');
  assert.ok(mounted.includes('entry-2'), 'the new first row is mounted before it becomes the tab stop');
});

test('when rows return while Clear search and filters has focus, the search field takes it', (t) => {
  const { view, render } = activityHarness(t);
  globalThis.document.body.insertAdjacentHTML('afterbegin', '<input id="logSearchInput">');
  view.levelFilter = 'error';
  render([entry(1)]);
  const clear = byId('logEmpty').querySelector('[data-action="clear-diagnostics-filters"]');
  clear.focus();
  assert.equal(globalThis.document.activeElement, clear);
  render([entry(1), entry(2, { level: 'ERROR' })]);
  assert.equal(globalThis.document.activeElement, byId('logSearchInput'));
});

test('only an icon cell carries the level tooltip, and the row itself has none', (t) => {
  const { render } = activityHarness(t);
  render([entry(1, { level: 'ERROR' }), entry(2, { level: 'WARN' }), entry(3), entry(4, { level: 'DEBUG' })]);
  const rows = Array.from(globalThis.document.querySelectorAll('#logList .log-entry'));
  assert.deepEqual(rows.map((row) => row.getAttribute('title')), [null, null, null, null]);
  const titles = rows.map((row) => row.querySelector('.log-entry-level').getAttribute('title'));
  assert.equal(titles[0], 'Error');
  assert.ok(titles[1], 'a warning names its level');
  assert.equal(titles[2], null, 'Info has no icon, so no tooltip');
  assert.equal(titles[3], null, 'Debug shows text, so no tooltip');
});

test('the inspector names the date as well as the time', (t) => {
  const { activity, state, view, render } = activityHarness(t);
  const records = [entry(1, { layer: 'sidecar' })];
  view.selectedEntryId = 'entry-1';
  render(records);
  activity.renderDetail(state, records);
  const format = require('../renderer/shell/renderer-diagnostics-format');
  assert.equal(
    globalThis.document.querySelector('#logDetailPanel .diagnostics-detail-meta').textContent,
    ['Info', format.formatDetailTime(records[0].ts), 'Local engine'].join(' · '),
  );
  assert.match(format.formatDetailTime(records[0].ts), /\d{4}/);
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
