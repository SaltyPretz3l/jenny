'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-client-timing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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
