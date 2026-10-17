'use strict';

// Diagnostics Overview, Needs attention: the section is hidden when empty, holds one entry per merged
// explanation with a severity icon (never a badge), and keeps fold state and focus across a repaint.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOverviewHarness, makeState, entry } = require('./helpers/diagnostics-overview-harness');

const ACTIONS = Object.freeze({ 'show-diagnostics-performance': true, 'choose-workspace-folder': true });
const SLOW = (overrides) => entry({ event: 'ipc.handler_slow', component: 'electron.main', data: { channel: 'models:list', durationMs: 5200 }, ...overrides });
const WATCH = (overrides) => entry({
  event: 'ide.watch_start_failed', component: 'renderer.lifecycle', layer: 'renderer', message: 'No workspace root is configured; choose a workspace folder first.', ...overrides,
});
const MEMORY_ERROR = entry({
  entry_id: 'mem-1', level: 'ERROR', layer: 'sidecar', component: 'sidecar.memory.index', event: 'memory.index_write_failed',
  message: 'index write failed: database is locked', data: { error_code: 'CMP-MEM-0042', remediation: 'Retry after the lock clears.' },
});

function paint(t, logs, extra) {
  const harness = createOverviewHarness(t, { actions: ACTIONS });
  const state = makeState({ logs, ...extra });
  harness.render(state, logs);
  return { harness, state };
}

test('Needs attention is hidden while nothing needs attention and says nothing about it', (t) => {
  const { harness } = paint(t, []);
  const section = harness.doc.getElementById('diagnosticsAttention');
  assert.equal(section.hidden, true);
  assert.equal(harness.doc.getElementById('diagnosticsIssueList').children.length, 0);
  assert.doesNotMatch(section.textContent, /no issues|no actionable|nothing/i);
});

test('one entry per merged explanation, newest first, with a severity icon instead of a badge', (t) => {
  const logs = [
    WATCH({ entry_id: 'w1', sequence: 1 }), WATCH({ entry_id: 'w2', sequence: 2, event: 'ide.tree_list_failed' }),
    SLOW({ entry_id: 's1', sequence: 3, ts: new Date(Date.now() - 2 * 60000).toISOString() }), SLOW({ entry_id: 's2', sequence: 4, ts: new Date(Date.now() - 2 * 60000).toISOString() }), MEMORY_ERROR,
  ];
  const { harness } = paint(t, logs);
  const section = harness.doc.getElementById('diagnosticsAttention');
  assert.equal(section.hidden, false);
  const items = Array.from(harness.doc.querySelectorAll('#diagnosticsIssueList > li'));
  assert.deepEqual(items.map((node) => node.dataset.issueGroup), ['fallback:memory.index_write_failed', 'slowRequest', 'noWorkspaceFolder'], 'ERROR first, then the newer WARN group');
  assert.equal(harness.doc.querySelector('.diagnostics-issue-badge'), null);
  // The order line says what the order is: a mixed list puts errors first.
  assert.equal(section.querySelector('.diagnostics-section-meta').textContent, 'Errors first, then newest');
  const warningsOnly = paint(t, [SLOW({ entry_id: 's9' })]).harness;
  assert.equal(warningsOnly.doc.querySelector('#diagnosticsAttention .diagnostics-section-meta').textContent, 'Newest first');
  for (const item of items) {
    const icon = item.querySelector('svg.inv-state-icon');
    assert.ok(icon, `${item.dataset.issueGroup} carries its severity as an icon`);
    assert.equal(icon.classList.contains('inv-state-icon--error'), item.dataset.severity === 'ERROR');
    assert.equal(icon.classList.contains('inv-state-icon--warn'), item.dataset.severity === 'WARN');
  }
  const slow = harness.doc.querySelector('[data-issue-group="slowRequest"]');
  assert.match(slow.querySelector('.diagnostics-issue-when').textContent, /\d{1,2}:\d{2}.* · 2 times$/);
  assert.equal(slow.querySelector('.diagnostics-issue-title').textContent, 'A background request was slow');
});

test('the mapped action shows when the shell serves it; otherwise Show in Activity scopes by the group key', (t) => {
  const logs = [SLOW({ entry_id: 's1' }), MEMORY_ERROR];
  const { harness } = paint(t, logs);
  const slowButton = harness.doc.querySelector('[data-issue-group="slowRequest"] .diagnostics-issue-actions > button');
  assert.equal(slowButton.dataset.action, 'show-diagnostics-performance');
  const memoryButton = harness.doc.querySelector('[data-issue-group="fallback:memory.index_write_failed"] .diagnostics-issue-actions > button');
  assert.equal(memoryButton.dataset.action, 'inspect-diagnostic-issue');
  assert.equal(memoryButton.textContent, 'Show in Activity');
  const key = decodeURIComponent(memoryButton.dataset.issue);
  assert.deepEqual(key.split('\u0000').slice(0, 4), ['sidecar.memory.index', 'memory.index_write_failed', 'CMP-MEM-0042', 'ERROR']);
});

test('A1-7: explanations read the group data, not a re-match against the entries', (t) => {
  // Two records share the event and the second; the group keeps the latest member's data (5.2 s).
  const stamp = new Date(Date.now() - 60000).toISOString();
  const logs = [
    SLOW({ entry_id: 'a', sequence: 1, ts: stamp, data: { durationMs: 1 } }),
    SLOW({ entry_id: 'b', sequence: 2, ts: stamp, data: { channel: 'models:list', durationMs: 5200 } }),
  ];
  const { harness } = paint(t, logs);
  const cause = harness.doc.querySelector('[data-issue-group="slowRequest"] .diagnostics-issue-cause').textContent;
  assert.match(cause, /took 5\.2 s/);
  assert.doesNotMatch(cause, /took 1 ms/);
});

test('Details holds the evidence; open folds and focus survive a repaint for new content', (t) => {
  const { harness, state } = paint(t, [SLOW({ entry_id: 's1' }), MEMORY_ERROR]);
  const slow = () => harness.doc.querySelector('[data-issue-group="slowRequest"]');
  const fold = slow().querySelector('details.diagnostics-issue-tech');
  assert.equal(fold.querySelector('summary').textContent, 'Details');
  assert.equal(fold.open, false);
  const body = fold.querySelector('dl').textContent;
  assert.match(body, /Event.*ipc\.handler_slow/s);
  assert.match(body, /Area.*App.*electron\.main/s);
  assert.match(body, /Request.*models:list/s);
  fold.open = true;
  fold.querySelector('summary').focus();
  state.logs = [...state.logs, WATCH({ entry_id: 'w1', sequence: 9 })];
  harness.render(state, state.logs);
  assert.equal(slow().querySelector('details').open, true, 'the fold stays open');
  assert.equal(harness.doc.activeElement?.tagName, 'SUMMARY', 'focus returns to the summary');
  assert.ok(slow().contains(harness.doc.activeElement));
  assert.ok(harness.doc.querySelector('[data-issue-group="noWorkspaceFolder"]'), 'the new entry painted');
});

test('the recorded message, advice, code and correlation ids appear in Details, redacted and bounded', (t) => {
  const secret = 'sk-' + 'a'.repeat(200);
  const memory = { ...MEMORY_ERROR, data: { ...MEMORY_ERROR.data, request_id: secret } };
  const { harness } = paint(t, [memory]);
  const body = harness.doc.querySelector('[data-issue-group="fallback:memory.index_write_failed"] details dl').textContent;
  assert.match(body, /Code.*CMP-MEM-0042/s);
  assert.match(body, /Message.*database is locked/s);
  assert.match(body, /Advice.*Retry after the lock clears\./s);
  const chip = harness.doc.querySelector('.diagnostics-issue-correlations code');
  assert.ok(chip.textContent.length <= 160);
  assert.doesNotMatch(chip.textContent, new RegExp(secret));
});

test('no raw ISO timestamp reaches the Overview text, even when a record time cannot be read', (t) => {
  const broken = '2026-10-14T99:99:99.000Z';
  const logs = [SLOW({ entry_id: 'bad', ts: broken }), MEMORY_ERROR];
  const { harness } = paint(t, logs, {});
  const text = harness.doc.getElementById('diagnosticsOverview').textContent;
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  assert.doesNotMatch(text, /T\d{2}:\d{2}:\d{2}/);
  assert.doesNotMatch(text, /99:99/);
  assert.match(harness.doc.querySelector('[data-issue-group="slowRequest"] .diagnostics-issue-when').textContent, /^—/);
});

test('a previous launch stamps each entry with its date', (t) => {
  const harness = createOverviewHarness(t, { actions: ACTIONS });
  const old = new Date(Date.now() - 3 * 86400000).toISOString();
  const state = makeState({
    ui: { logs: { selectedRunId: 'run-0' } },
    diagnosticsSnapshot: { active_run: { run_id: 'run-1' }, prior_run: { run_id: 'run-0', started_at: old, sources: {}, integrity: { complete: true } } },
  });
  harness.render(state, [MEMORY_ERROR, SLOW({ entry_id: 'old', ts: old })]);
  const when = harness.doc.querySelector('[data-issue-group="slowRequest"] .diagnostics-issue-when').textContent;
  assert.match(when, /[A-Za-z]{3}.*\d/, 'a previous launch names the day, not only the clock');
  assert.match(harness.doc.querySelector('#diagnosticsAttention .diagnostics-section-meta').textContent, /previous launch/);
});
