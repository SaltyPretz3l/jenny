'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DiagnosticLogService, MAX_ENTRY_BYTES } = require('../services/diagnostic-log-service');

test('canonical service assigns stable run fields, deduplicates renderer origins, and never echoes renderer ingestion', async () => {
  const broadcasts = []; const writes = [];
  const service = new DiagnosticLogService({ runId: 'run-current', now: () => new Date('2026-08-16T00:00:00Z'), writer: { write: (entry) => writes.push(entry) }, onEntry: (entry) => broadcasts.push(entry), historyReader: async () => ({ entries: [], malformed_count: 0, truncated: false, errors: [] }) });
  const first = service.append({ layer: 'renderer', event: 'renderer.ready', origin_entry_id: 'boot:1' }, { broadcast: false });
  const duplicate = service.append({ layer: 'renderer', event: 'renderer.ready', origin_entry_id: 'boot:1' }, { broadcast: false });
  service.append({ layer: 'electron', event: 'backend.ready' });
  service.append({ layer: 'sidecar', event: 'sidecar.ready' });
  assert.equal(duplicate, null);
  assert.equal(first.run_id, 'run-current');
  assert.deepEqual(service.list().map((entry) => entry.sequence), [1, 2, 3]);
  assert.equal(writes.length, 3);
  assert.equal(broadcasts.length, 2);
  const snapshot = await service.getSnapshot();
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot.sources).map(([key, value]) => [key, value.count])), { electron: 1, renderer: 1, sidecar: 1 });
});

test('selects the newest different prior run and labels pre-contract history legacy', async () => {
  const exact = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: [{ run_id: 'older', sequence: 1, event: 'a' }, { run_id: 'prior', sequence: 1, event: 'b' }, { run_id: 'prior', sequence: 2, event: 'c' }], malformed_count: 0, truncated: false, errors: [] }) });
  const snapshot = await exact.getSnapshot();
  assert.equal(snapshot.prior_run.run_id, 'prior');
  assert.deepEqual(snapshot.entries.map((entry) => entry.event), ['b', 'c']);
  const legacy = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: [{ event: 'legacy' }], malformed_count: 0, truncated: false, errors: [] }) });
  const legacySnapshot = await legacy.getSnapshot();
  assert.equal(legacySnapshot.prior_run.run_id, 'legacy-prior');
  assert.equal(legacySnapshot.prior_run.legacy, true);

  const trailingLegacy = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: [{ run_id: 'prior', event: 'exact' }, { event: 'legacy-newer' }], malformed_count: 0, truncated: false, errors: [] }) });
  const trailingSnapshot = await trailingLegacy.getSnapshot();
  assert.equal(trailingSnapshot.prior_run.run_id, 'legacy-prior');
  assert.deepEqual(trailingSnapshot.entries.map((entry) => entry.event), ['legacy-newer']);
});

test('oversized entries are bounded and drops are disclosed as partial evidence', async () => {
  const service = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: [], malformed_count: 1, truncated: true, errors: [] }) });
  const entry = service.append({ layer: 'electron', event: 'large', message: 'm'.repeat(MAX_ENTRY_BYTES * 2), data: { payload: 'x'.repeat(MAX_ENTRY_BYTES * 2) } });
  assert.equal(entry.data._truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(entry), 'utf8') <= MAX_ENTRY_BYTES);
  service.recordDrop('renderer', 2);
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.integrity.complete, false);
  assert.ok(snapshot.integrity.partial_reasons.includes('entries_dropped'));
  assert.ok(snapshot.integrity.partial_reasons.includes('history_malformed'));
});

test('UTF-8 entry and identity bounds cannot be bypassed by multibyte text', async () => {
  const service = new DiagnosticLogService({ runId: 'run-'.concat('🧪'.repeat(500)) });
  const entry = service.append({
    layer: 'renderer', event: 'unicode.large', origin_entry_id: 'origin-'.concat('🔐'.repeat(5000)),
    message: '🙂'.repeat(MAX_ENTRY_BYTES), data: { ['key-'.concat('界'.repeat(5000))]: 'value' },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(entry), 'utf8') <= MAX_ENTRY_BYTES);
  assert.ok(Buffer.byteLength(entry.run_id, 'utf8') <= 160);
  assert.ok(Buffer.byteLength(entry.origin_entry_id, 'utf8') <= 160);
  service.recordDrop('renderer', Infinity);
  service.recordDrop('renderer', -1);
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.integrity.dropped_by_source.renderer, 0);
});

test('canonical ingestion enforces redaction when an untrusted entry requests raw mode', () => {
  const service = new DiagnosticLogService({ runId: 'current' });
  const entry = service.append({
    layer: 'renderer', event: 'renderer.hostile', redaction_mode: 'unredacted',
    message: 'Authorization: Bearer abcdefghijklmnop',
    data: { api_key: 'sk-secretsecret', file: 'C:\\Users\\owner\\private.txt' },
  });
  assert.equal(entry.redaction_mode, 'redacted');
  assert.doesNotMatch(JSON.stringify(entry), /abcdefghijklmnop|sk-secretsecret|Users\\\\owner/);
});

test('canonical ingestion promotes child-process output lines to diagnostic messages', () => {
  const service = new DiagnosticLogService({ runId: 'current' });
  const entry = service.append({
    layer: 'electron', event: 'ollama.output', details: { stream: 'stderr', line: 'llama_model_loader: loaded meta data' },
  });
  assert.equal(entry.message, 'llama_model_loader: loaded meta data');
});

test('prior-run retention evicts old informational rows before severe evidence', async () => {
  const history = [
    { run_id: 'prior', sequence: 1, level: 'ERROR', event: 'failure.one' },
    { run_id: 'prior', sequence: 2, level: 'WARN', event: 'failure.two' },
    ...Array.from({ length: 258 }, (_, index) => ({ run_id: 'prior', sequence: index + 3, level: 'INFO', event: `info.${index}` })),
  ];
  const service = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: history, malformed_count: 0, truncated: false, errors: [] }) });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.entries.length, 250);
  assert.ok(snapshot.entries.some((entry) => entry.event === 'failure.one'));
  assert.ok(snapshot.entries.some((entry) => entry.event === 'failure.two'));
  assert.equal(snapshot.prior_run.integrity.complete, false);
  assert.ok(snapshot.prior_run.integrity.partial_reasons.includes('prior_retention_truncated'));
  assert.equal(snapshot.prior_run.integrity.dropped_by_source.electron, 10);
});

test('two-run snapshots enforce the 750 current plus 250 prior entry budget', async () => {
  const prior = Array.from({ length: 300 }, (_, index) => ({ run_id: 'prior', sequence: index + 1, level: 'INFO', event: `prior.${index}` }));
  const service = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: prior, malformed_count: 0, truncated: false, errors: [] }) });
  for (let index = 0; index < 800; index += 1) service.append({ layer: 'electron', level: 'INFO', event: `current.${index}` }, { persist: false, broadcast: false });
  const snapshot = await service.getSnapshot();
  assert.equal(snapshot.entries.filter((entry) => entry.run_id === 'current').length, 750);
  assert.equal(snapshot.entries.filter((entry) => entry.run_id === 'prior').length, 250);
  assert.equal(snapshot.active_run.sources.electron.count, 750);
  assert.equal(snapshot.prior_run.sources.electron.count, 250);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 4 * 1024 * 1024);
});

test('snapshot byte-pressure is disclosed with per-source drop metadata', async () => {
  const message = 'x'.repeat(12000);
  const prior = Array.from({ length: 250 }, (_, index) => ({ run_id: 'prior', sequence: index + 1, layer: 'sidecar', level: 'INFO', event: `prior.${index}`, message }));
  const service = new DiagnosticLogService({ runId: 'current', filePath: 'test.log', historyReader: async () => ({ entries: prior, malformed_count: 0, truncated: false, errors: [] }) });
  for (let index = 0; index < 250; index += 1) service.append({ layer: 'electron', level: 'INFO', event: `current.${index}`, message }, { persist: false, broadcast: false });
  const snapshot = await service.getSnapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= 4 * 1024 * 1024);
  assert.ok(snapshot.integrity.partial_reasons.includes('snapshot_truncated'));
  assert.ok(snapshot.integrity.dropped_by_source.sidecar > 0);
  assert.equal(snapshot.prior_run.integrity.complete, false);
  assert.ok(snapshot.prior_run.integrity.partial_reasons.includes('snapshot_truncated'));
});
