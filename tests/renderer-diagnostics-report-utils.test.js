'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDiagnosticReport, MAX_EVENTS } = require('../renderer/shared/diagnostics-report-utils');

test('report labels partial evidence and bounds the selected-run event tail', () => {
  const entries = Array.from({ length: MAX_EVENTS + 10 }, (_, sequence) => ({ run_id: 'current', sequence, level: 'INFO', event: `event.${sequence}` }));
  entries.push({ run_id: 'prior', sequence: 1, level: 'ERROR', event: 'prior.error' });
  const report = JSON.parse(buildDiagnosticReport({ active_run: { run_id: 'current' }, entries, sources: {}, integrity: { complete: false, partial_reasons: ['sidecar_unavailable'], capture_policy: {} } }, {}, {}));
  assert.equal(report.evidence.complete, false); assert.deepEqual(report.evidence.partial_reasons, ['sidecar_unavailable']); assert.equal(report.event_tail.length, MAX_EVENTS); assert.ok(report.event_tail.every((entry) => entry.run_id === 'current'));
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

test('legacy snapshots explicitly label unavailable prior-run integrity', () => {
  const report = JSON.parse(buildDiagnosticReport({
    active_run: { run_id: 'current' }, prior_run: { run_id: 'prior' },
    entries: [{ run_id: 'prior', layer: 'sidecar', event: 'prior.failure' }],
    sources: {}, integrity: { complete: true, partial_reasons: [], capture_policy: {} },
  }, {}, { runId: 'prior' }));
  assert.equal(report.evidence.complete, false);
  assert.ok(report.evidence.partial_reasons.includes('prior_run_source_integrity_unavailable'));
  assert.equal(report.evidence.sources.sidecar.count, 1);
});
