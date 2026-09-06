'use strict';

// Split from turn-diagnostic-dump.test.js (which sits at the 600-line test
// ratchet): the reasoning-channel render counters shipped by
// renderer-stream-client-metrics.js must survive the client_timing allowlist.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-dump-reasoning-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('client_timing preserves bounded reasoning body render telemetry', async (t) => {
  const userDataPath = makeTempDir(t);
  const service = { options: { userDataPath }, _emitServiceLog() {} };
  const fallbackReasons = {};
  for (let index = 0; index < 40; index += 1) {
    fallbackReasons[`reason_${index}`] = index + 1;
  }

  const dumped = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-reasoning-body',
    streamId: 'stream_reasoning_body_1',
    terminalStatus: 'completed',
    clientTiming: {
      reasoning_body_renders: 12,
      reasoning_body_full_renders: 3,
      reasoning_body_fallback_reasons: fallbackReasons,
      reasoning_body_render_ms_max: 4.57,
      reasoning_peak_entry_chars: 4096,
    },
  });
  assert.ok(dumped);
  const payload = JSON.parse(fs.readFileSync(dumped, 'utf8'));
  assert.equal(payload.client_timing.reasoning_body_renders, 12);
  assert.equal(payload.client_timing.reasoning_body_full_renders, 3);
  assert.equal(payload.client_timing.reasoning_body_render_ms_max, 4.57);
  assert.equal(payload.client_timing.reasoning_peak_entry_chars, 4096);
  assert.equal(Object.keys(payload.client_timing.reasoning_body_fallback_reasons).length, 32);
});
