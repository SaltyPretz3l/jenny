'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
const {
  storePendingClientTiming, takePendingClientTiming, CLIENT_TIMING_PENDING_TTL_MS,
} = require('../services/backend/turn-diagnostic-client-timing');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-client-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('pending timing expires once through its timer, independent of wall-clock jumps', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const logs = [];
  const emit = (...args) => logs.push(args);
  storePendingClientTiming(emit, 'timer-root', 'kept', { full_renders: 1 });
  now += CLIENT_TIMING_PENDING_TTL_MS + 1;
  storePendingClientTiming(emit, 'timer-root', 'other', { full_renders: 2 });
  assert.deepEqual(takePendingClientTiming(emit, 'timer-root', 'kept'), { full_renders: 1 });
  assert.equal(logs.length, 0);
  t.mock.timers.tick(CLIENT_TIMING_PENDING_TTL_MS);
  assert.equal(takePendingClientTiming(emit, 'timer-root', 'other'), null);
  assert.deepEqual(logs.map(([, event, details]) => [event, details.streamId]),
    [['chat.turn_diagnostic_client_timing_expired', 'other']]);
});

test('replacing pending timing cancels its old expiry and merges the reports', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logs = [];
  const emit = (...args) => logs.push(args);
  storePendingClientTiming(emit, 'timer-root', 'replace', { full_renders: 1 });
  t.mock.timers.tick(CLIENT_TIMING_PENDING_TTL_MS - 1);
  storePendingClientTiming(emit, 'timer-root', 'replace', { noop_renders: 2 });
  t.mock.timers.tick(1);
  assert.deepEqual(takePendingClientTiming(emit, 'timer-root', 'replace'), { full_renders: 1, noop_renders: 2 });
  t.mock.timers.tick(CLIENT_TIMING_PENDING_TTL_MS);
  assert.equal(logs.length, 0);
});

test('client_timing keeps the row-list morph counters and their bounded reason histogram', async (t) => {
  // timeline-perf 2026-09-30: the keyed row-list morph counts as a "patch
  // applied", so without these the dump could not show a per-delta rebuild.
  const { mergeClientTimingIntoTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-1',
    streamId: 'stream_row_list_1',
    terminalStatus: 'completed',
    clientTiming: { send_started_at_ms: 1000 },
  });
  assert.ok(filePath);
  const oversized = {};
  for (let i = 0; i < 40; i += 1) oversized[`reason_${i}`] = 1;
  await mergeClientTimingIntoTurnDiagnostic({
    service,
    streamId: 'stream_row_list_1',
    clientTiming: {
      row_list_morphs: 61,
      row_list_rows_reused: 0,
      row_list_rows_rebuilt: 7259,
      row_list_morph_reasons: { ...oversized, 'live:segment_row_state_mismatch>block_key_mismatch': 61, zero: 0 },
    },
    attempts: 1,
    delayMs: 1,
  });
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(payload.client_timing.row_list_morphs, 61);
  assert.equal(payload.client_timing.row_list_rows_reused, 0);
  assert.equal(payload.client_timing.row_list_rows_rebuilt, 7259);
  assert.deepEqual(payload.client_timing.row_list_morph_reasons, {
    other: 40,
    'live:segment_row_state_mismatch>block_key_mismatch': 61,
  });
  assert.equal('zero' in payload.client_timing.row_list_morph_reasons, false);
});
