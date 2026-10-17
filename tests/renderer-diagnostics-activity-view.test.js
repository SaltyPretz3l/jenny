'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createLogsEventBindings } = require('../renderer/shell/renderer-diagnostics-event-bindings');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { QUIET_MONACO_WINDOW_GLOBALS, OBSERVED_SOURCES } = require('./helpers/diagnostics-view-fixtures');

// Diagnostics Activity in the loaded app: rows, issue scope and the inspector.

test('issue inspection scopes Activity and selecting a row disengages Follow latest', async (t) => {
  const issue = { entry_id: 'issue', run_id: 'run', sequence: 1, ts: '2026-10-14T09:00:00.500Z', level: 'ERROR', layer: 'sidecar', component: 'runtime.engine', event: 'engine.failed', message: 'failed', trace_id: 'trace-1', request_id: 'request-1', data: { error_code: 'CMP-AI-1' } };
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: [issue], sources: {}, integrity: { complete: true, partial_reasons: [] } }) } } } });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  assert.equal(doc.querySelectorAll('#diagnosticsIssueList .log-level-badge').length, 0);
  assert.deepEqual(
    Array.from(doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue-correlations code')).map((node) => node.textContent),
    ['trace-1', 'request-1'],
  );
  doc.querySelector('[data-action="inspect-diagnostic-issue"]').click(); await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.logs.activeTab, 'activity');
  assert.ok(doc.getElementById('diagnosticsClearScope'));
  assert.equal(doc.getElementById('diagnosticsActivityScope').hidden, false);
  assert.match(doc.getElementById('diagnosticsActivityScope').textContent, /Showing records for .*1 record.*Show all records/);
  assert.equal(doc.getElementById('diagnosticsActivity').dataset.scoped, 'true');
  assert.equal(doc.getElementById('diagnosticsActivityLayout').dataset.detail, 'closed');
  const row = doc.querySelector('[data-entry-id="issue"]');
  row.click(); await waitForUi(window, 20);
  assert.equal(window.__rendererState.ui.logs.autoScroll, false);
  assert.equal(doc.getElementById('logDetailPanel').hidden, false);
  assert.equal(doc.querySelector('[data-entry-id="issue"]'), row, 'selection must not rebuild the activity list');
  assert.ok(doc.querySelector('#logDetailPanel .inv-codeblock-wrap'));
  assert.equal(doc.getElementById('diagnosticsActivityLayout').dataset.detail, 'open');
  assert.match(doc.getElementById('diagnosticsCloseDetail').textContent, /Back to records/);
  // The visible text names the button at each width, so no aria-label overrides "Back to records".
  assert.equal(doc.getElementById('diagnosticsCloseDetail').hasAttribute('aria-label'), false);
  assert.equal(doc.querySelector('#diagnosticsCloseDetail .diagnostics-detail-close-wide .sr-only').textContent, 'Close details');
  assert.equal(doc.getElementById('diagnosticsCloseDetail').getAttribute('title'), 'Close details');
  assert.equal(doc.querySelectorAll('#logDetailPanel h4, #logDetailPanel .diagnostics-detail-section').length, 0, 'no Identity or Summary sections');
  assert.equal(doc.querySelector('#logDetailPanel h3').textContent, 'failed');
  assert.match(doc.querySelector('#logDetailPanel .diagnostics-detail-meta').textContent, /^Error · \d\d:\d\d:\d\d\.\d{3} · Local engine$/);
  assert.ok(doc.querySelector('#logDetailPanel .diagnostics-detail-icon .inv-state-icon--error'));
  assert.deepEqual(
    Array.from(doc.querySelectorAll('#logDetailPanel dl.diagnostics-facts dt')).map((term) => term.textContent),
    ['Event', 'Component', 'Trace', 'Request', 'Launch'],
  );
  assert.equal(doc.querySelector('#logDetailPanel dl.diagnostics-facts dd:last-child').textContent, 'This launch · record 1');
  assert.match(doc.querySelector('#logDetailPanel .inv-codeblock-wrap').textContent, /Recorded data/);
  doc.getElementById('diagnosticsCloseDetail').click(); await waitForUi(window, 40);
  assert.equal(doc.getElementById('logDetailPanel').hidden, true);
  assert.equal(doc.activeElement?.dataset.entryId, 'issue');
  row.click(); await waitForUi(window, 20);
  doc.getElementById('logsView').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(doc.getElementById('logDetailPanel').hidden, true);
  doc.getElementById('diagnosticsClearScope').click(); await waitForUi(window, 40);
  assert.equal(window.__rendererState.ui.logs.issueScope, null);
  assert.equal(doc.activeElement, doc.getElementById('logSearchInput'));
});

test('local renderer correlations are redacted and bounded in Overview and detail', async (t) => {
  const app = await loadRendererApp({
    // Without this the ambient monaco_fallback issue is row 0, so both the
    // overviewValues[0] assertion below and the inspect click read the wrong row.
    windowGlobals: QUIET_MONACO_WINDOW_GLOBALS,
    shell: { diagnostics: { logs: { getSnapshot: async () => ({
      active_run: { run_id: 'run' },
      entries: [],
      sources: OBSERVED_SOURCES,
      integrity: { complete: true, partial_reasons: [] },
    }) } } },
  });
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  await shell.__emitLogAppend({
    origin_entry_id: 'local-correlation',
    run_id: 'run',
    ts: '2026-08-16T00:00:03Z',
    level: 'WARN',
    layer: 'renderer',
    component: 'renderer.lifecycle',
    event: 'renderer.local_warning',
    message: 'Local warning',
    trace_id: 'Bearer local-secret-token',
    request_id: 'r'.repeat(500),
  });
  await waitForUi(window, 80);

  const overviewValues = Array.from(
    doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue-correlations code'),
  ).map((node) => node.textContent);
  assert.match(overviewValues[0], /Bearer \[redacted\]/);
  assert.equal(overviewValues.some((value) => value.includes('local-secret-token')), false);
  assert.equal(overviewValues.every((value) => value.length <= 160), true);

  // Scope the click to THIS issue's row rather than trusting list order.
  const localIssue = Array.from(doc.querySelectorAll('#diagnosticsIssueList .diagnostics-issue'))
    .find((node) => node.textContent.includes('renderer.local_warning'));
  assert.ok(localIssue, 'the emitted local warning is grouped into an issue row');
  localIssue.querySelector('[data-action="inspect-diagnostic-issue"]').click();
  await waitForUi(window, 40);
  doc.querySelector('[data-entry-id="local-correlation"]').click();
  await waitForUi(window, 20);
  const detailValues = Array.from(
    doc.querySelectorAll('#logDetailPanel .diagnostics-facts code'),
  ).map((node) => node.textContent);
  assert.equal(detailValues.some((value) => value.includes('local-secret-token')), false);
  assert.equal(detailValues.every((value) => value.length <= 160), true);
});

test('first live event replaces the empty state and anchors keyboard navigation', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('logsTopRailTab').click();
  await waitForUi(window, 40);
  doc.getElementById('diagnosticsActivityTab').click();
  await waitForUi(window, 30);
  const search = doc.getElementById('logSearchInput');
  search.value = 'first-live-only';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 30);
  assert.equal(doc.querySelector('#logList .inv-empty-note').textContent, 'No records match. Clear the search or filters.');

  await shell.__emitLogAppend({ entry_id: 'first-live', run_id: 'harness-current', sequence: 1, level: 'INFO', layer: 'electron', event: 'first-live-only' });
  await waitForUi(window, 80);
  assert.ok(window.__rendererState.logs.some((entry) => entry.event === 'first-live-only'));
  const row = doc.querySelector('[data-entry-id="first-live"]');
  assert.ok(row);
  assert.equal(row.tabIndex, 0);
  assert.equal(doc.querySelector('#logList .inv-empty-note'), null);
});

test('rows show a level icon for errors and warnings, dbg for debug and nothing for info', async (t) => {
  const records = [
    { entry_id: 'e', run_id: 'run', sequence: 1, ts: '2026-10-14T09:00:01.250Z', level: 'ERROR', layer: 'sidecar', component: 'runtime', event: 'engine.failed', message: 'Engine failed' },
    { entry_id: 'w', run_id: 'run', sequence: 2, ts: '2026-10-14T09:00:02.250Z', level: 'WARN', layer: 'renderer', component: 'ui', event: 'ui.slow', message: 'Slow paint' },
    { entry_id: 'd', run_id: 'run', sequence: 3, ts: '2026-10-14T09:00:03.250Z', level: 'DEBUG', layer: 'electron', component: 'main', event: 'main.tick', message: '' },
    { entry_id: 'i', run_id: 'run', sequence: 4, ts: '2026-10-14T09:00:04.250Z', level: 'INFO', layer: 'electron', component: 'main', event: 'main.ready', message: 'Ready' },
  ];
  const app = await loadRendererApp({ shell: { diagnostics: { logs: { getSnapshot: async () => ({ active_run: { run_id: 'run' }, entries: records, sources: {}, integrity: { complete: true, partial_reasons: [] } }) } } } });
  t.after(async () => app.dispose());
  const { window } = app; const doc = window.document;
  doc.getElementById('logsTopRailTab').click(); await waitForUi(window, 40);
  doc.getElementById('diagnosticsActivityTab').click(); await waitForUi(window, 40);
  const cell = (id) => doc.querySelector(`[data-entry-id="${id}"] .log-entry-level`);
  assert.ok(cell('e').querySelector('.inv-state-icon--error'));
  assert.ok(cell('w').querySelector('.inv-state-icon--warn'));
  assert.equal(cell('d').textContent, 'dbg');
  assert.equal(cell('i').textContent, '');
  assert.equal(doc.querySelector('[data-entry-id="e"]').getAttribute('title'), 'Error');
  assert.match(doc.querySelector('[data-entry-id="e"]').getAttribute('aria-label'), /Level ERROR, Source Local engine, Event engine\.failed/);
  assert.equal(doc.querySelector('[data-entry-id="e"] .log-entry-source').textContent, 'Local engine');
  assert.equal(doc.querySelector('[data-entry-id="e"] .log-entry-event bdi').textContent, 'engine.failed');
  assert.match(doc.getElementById('logResultsLabel').textContent, /^\d+ records$/);
  const level = doc.getElementById('logLevelFilter');
  level.value = 'error';
  level.dispatchEvent(new window.Event('change', { bubbles: true }));
  await waitForUi(window, 40);
  assert.match(doc.getElementById('logResultsLabel').textContent, /^\d+ of \d+ records$/);
  level.value = 'debug';
  level.dispatchEvent(new window.Event('change', { bubbles: true }));
  const search = doc.getElementById('logSearchInput');
  search.value = 'no-such-record';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  await waitForUi(window, 40);
  assert.equal(doc.querySelector('#logList .inv-empty-note').textContent, 'No records match. Clear the search or filters.');
});

test('crossing into narrow Activity moves row focus to Back to activity', async (t) => {
  const dom = new JSDOM('<div id="logsView"><div id="logList"><button data-entry-id="entry" tabindex="0">Event</button></div><button id="diagnosticsCloseDetail">Back to activity</button></div>', { pretendToBeVisual: true });
  const previousWindow = global.window;
  const previousDocument = global.document;
  global.window = dom.window;
  global.document = dom.window.document;
  t.after(() => {
    global.window = previousWindow;
    global.document = previousDocument;
    dom.window.close();
  });
  let changeListener = null;
  const query = {
    matches: false,
    addEventListener(type, listener) { if (type === 'change') changeListener = listener; },
    removeEventListener(type, listener) { if (type === 'change' && changeListener === listener) changeListener = null; },
  };
  dom.window.matchMedia = () => query;
  const logList = dom.window.document.getElementById('logList');
  const state = { ui: { logs: { selectedEntryId: 'entry', autoScroll: false } } };
  const bindings = createLogsEventBindings({ state, dom: { logList }, callbacks: { renderLogs() {} } });
  bindings.bind();
  t.after(() => bindings.dispose());

  logList.querySelector('[data-entry-id="entry"]').focus();
  query.matches = true;
  changeListener({ matches: true });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 30));
  assert.equal(dom.window.document.activeElement.id, 'diagnosticsCloseDetail');
});
