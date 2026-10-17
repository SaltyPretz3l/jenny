'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticReport, selectRunEvidence, MAX_EVENTS } = require('../renderer/shared/diagnostics-report-utils');

test('report labels partial evidence and bounds the selected-run event tail', () => {
  const entries = Array.from({ length: MAX_EVENTS + 10 }, (_, sequence) => ({ run_id: 'current', sequence, level: 'INFO', event: `event.${sequence}` }));
  entries.push({ run_id: 'prior', sequence: 1, level: 'ERROR', event: 'prior.error' });
  const report = JSON.parse(buildDiagnosticReport({ active_run: { run_id: 'current', sources: {}, integrity: { complete: false, partial_reasons: ['sidecar_unavailable'], capture_policy: {} } }, entries }, {}, {}));
  assert.equal(report.evidence.complete, false); assert.deepEqual(report.evidence.partial_reasons, ['sidecar_unavailable']); assert.equal(report.event_tail.length, MAX_EVENTS); assert.ok(report.event_tail.every((entry) => entry.run_id === 'current'));
  assert.equal(report.report_truncated, true);
  assert.equal(report.event_tail_total, MAX_EVENTS + 10);
  assert.equal(report.event_tail_omitted, 10);
  assert.equal(report.issue_groups_total, 0);
});

test('report redacts sensitive keys, values, data URLs, and local paths', () => {
  const report = buildDiagnosticReport({
    active_run: { run_id: 'current' },
    integrity: { complete: true },
    entries: [{
      run_id: 'current', level: 'ERROR', event: 'engine.failed', component: 'engine',
      message: 'Bearer secret-token-123 at C:\\Users\\owner\\private.txt',
      details: { api_key: 'sk-test-secret-value', image: `data:image/png;base64,${'A'.repeat(80)}` },
    }],
  }, {}, {});
  assert.doesNotMatch(report, /secret-token-123|sk-test-secret-value|Users\\owner|A{64}/);
  assert.match(report, /\[redacted/);
});

test('oversized reports remain valid JSON and disclose truncation', () => {
  const entries = Array.from({ length: 80 }, (_, index) => ({
    run_id: 'current', sequence: index + 1, event: `event.${index}`, message: 'x'.repeat(4000),
  }));
  const text = buildDiagnosticReport({ active_run: { run_id: 'current' }, entries, sources: {}, integrity: { complete: true } }, {}, {});
  const report = JSON.parse(text);
  assert.equal(report.report_truncated, true);
  assert.ok(text.length <= 64000);
  assert.equal(report.event_tail_total, entries.length);
  assert.equal(report.event_tail_omitted, entries.length - report.event_tail.length);
});

test('prior-run reports use prior source integrity instead of current-run evidence', () => {
  const report = JSON.parse(buildDiagnosticReport({
    active_run: { run_id: 'current', sources: { electron: { count: 9 } }, integrity: { complete: true, partial_reasons: [] } },
    prior_run: { run_id: 'prior', sources: { sidecar: { count: 2, capture_state: 'historical' } }, integrity: { complete: false, partial_reasons: ['history_truncated'], capture_policy: {} } },
    entries: [{ run_id: 'prior', layer: 'sidecar', event: 'prior.failure' }],
    sources: { electron: { count: 9 } }, integrity: { complete: true, partial_reasons: [] },
  }, {}, { runId: 'prior' }));
  assert.equal(report.evidence.complete, false);
  assert.deepEqual(report.evidence.partial_reasons, ['history_truncated']);
  assert.equal(report.evidence.sources.sidecar.count, 2);
  assert.equal(report.evidence.sources.electron, undefined);
});

test('missing run evidence stays empty instead of borrowing snapshot evidence', () => {
  const snapshot = {
    active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' },
    sources: { electron: { count: 99 } }, integrity: { complete: true },
  };
  for (const runId of ['current', 'prior']) {
    assert.deepEqual(selectRunEvidence(snapshot, runId), { sources: {}, integrity: {} });
  }
});

test('unknown run selections have no evidence or entries from any launch', () => {
  const report = JSON.parse(buildDiagnosticReport({
    active_run: { run_id: 'current', sources: { electron: { count: 9 } }, integrity: { complete: true } },
    prior_run: { run_id: 'prior', sources: {}, integrity: {} },
    entries: [{ run_id: 'missing', level: 'ERROR', event: 'missing.failure' }],
  }, { backend: { ready: true } }, { runId: 'missing' }));
  assert.deepEqual(report.evidence, { available: false, reason: 'run_not_in_snapshot' });
  assert.deepEqual(report.event_tail, []);
  assert.deepEqual(report.grouped_issues, []);
  assert.deepEqual(selectRunEvidence({}, 'missing'), report.evidence);
});

test('without an active run the current launch contains only entries without a run id', () => {
  const entries = [
    { level: 'WARN', event: 'current.failure' },
    { run_id: '', event: 'current.info' },
    { run_id: 'prior', level: 'ERROR', event: 'prior.failure' },
  ];
  const report = JSON.parse(buildDiagnosticReport({ prior_run: { run_id: 'prior' }, entries }, {}, { runId: '' }));
  assert.equal(report.selected_run_id, '');
  assert.equal(report.status_scope, 'current_launch');
  assert.deepEqual(report.event_tail, entries.slice(0, 2));
  assert.equal(report.grouped_issues.length, 1);
  assert.equal(report.report_truncated, false);
});

test('issue-group caps disclose totals even when the report fits the character budget', () => {
  const entries = Array.from({ length: 31 }, (_, index) => ({ run_id: 'current', level: 'WARN', event: `issue.${index}` }));
  const report = JSON.parse(buildDiagnosticReport({ active_run: { run_id: 'current' }, entries }, {}, {}));
  assert.equal(report.grouped_issues.length, 30);
  assert.equal(report.issue_groups_total, 31);
  assert.equal(report.event_tail_total, 31);
  assert.equal(report.event_tail_omitted, 0);
  assert.equal(report.report_truncated, true);
});

test('last-resort character truncation retains report totals', () => {
  const report = JSON.parse(buildDiagnosticReport({
    active_run: { run_id: 'current', sources: { sidecar: { detail: 'x'.repeat(70000) } }, integrity: { complete: true } },
    entries: [{ run_id: 'current', level: 'ERROR', event: 'failed' }],
  }, {}, {}));
  assert.equal(report.issue_groups_total, 1);
  assert.equal(report.event_tail_total, 1);
  assert.equal(report.event_tail_omitted, 1);
  assert.equal(report.report_truncated, true);
});

test('a noisy issue group does not crowd recent events out of the report', () => {
  const run = 'current';
  const entries = [];
  for (let sequence = 1; sequence <= 700; sequence += 1) {
    entries.push({ run_id: run, sequence, entry_id: `${run}:${sequence}`, ts: new Date(Date.UTC(2026, 9, 14, 0, 0, sequence)).toISOString(), level: 'WARN', layer: 'electron', component: 'ipc.handler', event: 'ipc.handler_slow', message: 'slow', data: { durationMs: 1200, channel: 'x', blob: 'b'.repeat(400) } });
  }
  for (let index = 0; index < 50; index += 1) {
    const sequence = 701 + index;
    entries.push({ run_id: run, sequence, entry_id: `${run}:${sequence}`, ts: new Date(Date.UTC(2026, 9, 14, 1, 0, index)).toISOString(), level: 'INFO', layer: 'electron', component: 'app.main', event: `info.${index}`, message: 'i'.repeat(300), data: {} });
  }
  const report = JSON.parse(buildDiagnosticReport({ active_run: { run_id: run, sources: {}, integrity: { complete: true } }, entries }, {}, {}));
  assert.equal(report.event_tail.length, MAX_EVENTS);
  assert.equal(report.grouped_issues[0].count, 700);
  assert.equal(Object.hasOwn(report.grouped_issues[0], 'entry_ids'), false);
  assert.equal(report.grouped_issues[0].data.durationMs, 1200);
  assert.equal(report.grouped_issues[0].data.blob.length, 200);
});

test('the report carries the memory reflection facet for the current launch only', () => {
  const facet = { available: true, enabled: true, state: 'idle', runs: 5, preempted: 2, saved: 10, failed: 0, refused: {} };
  const current = JSON.parse(buildDiagnosticReport({ active_run: { run_id: 'current' }, entries: [] }, { memory_reflection: facet }, {}));
  assert.deepEqual(current.runtime.memory_reflection, facet);
  const prior = JSON.parse(buildDiagnosticReport({ active_run: { run_id: 'current' }, entries: [] }, { memory_reflection: facet }, { runId: 'prior' }));
  assert.equal(prior.runtime.memory_reflection, undefined);
});
