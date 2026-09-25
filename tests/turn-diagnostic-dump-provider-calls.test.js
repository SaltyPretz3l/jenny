'use strict';

// Split from turn-diagnostic-dump.test.js (at the 600-line test ratchet).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { dumpTurnDiagnostic } = require('../services/backend/turn-diagnostic-dump');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-diagnostic-dump-calls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('dumpTurnDiagnostic keeps the per-call provider ledger of a three-call turn whose fatal call has no usage', async (t) => {
  // Owner turn 2026-09-20 20:21: answer call aborted by the thinking guard,
  // an internal reasoning summary, then a continuation that raised before its
  // usage trailer. The sidecar now ships one ledger entry per provider call;
  // the writer must carry it verbatim and must not synthesize usage for the
  // fatal call from the summary's.
  const userDataPath = makeTempDir(t);
  const providerDiagnostics = {
    time_to_provider_request_start_ms: 1000,
    time_to_first_chunk_ms: 11000,
    provider_call_count: 3,
    provider_call_ordinal: 3,
    provider_call_purpose: 'checkpoint_continuation',
    provider_call_outcome: 'failed',
    provider_call_start_ms: 252000,
    stream_counters: { malformed_tool_arguments_count: 1, tool_call_incomplete_count: 0 },
    provider_calls: [
      { ordinal: 1, purpose: 'turn', outcome: 'completed', start_ms: 1000, usage: null },
      {
        ordinal: 2,
        purpose: 'reasoning_summary',
        outcome: 'completed',
        start_ms: 241000,
        visible_output_chars: 431,
        usage: { prompt_eval_count: 9628, eval_count: 78 },
      },
      { ordinal: 3, purpose: 'checkpoint_continuation', outcome: 'failed', start_ms: 252000, usage: null },
    ],
  };
  const service = {
    options: { userDataPath },
    sidecarClient: {
      async harnessTurnDiagnostic() {
        return { provider_diagnostics: providerDiagnostics };
      },
    },
    _emitServiceLog() {},
  };

  const filePath = await dumpTurnDiagnostic({
    service,
    sessionId: 'session-3',
    streamId: 'stream_three_calls',
    requestId: 'stream_three_calls',
    terminalStatus: 'runtime_error',
    terminalError: { code: 'CMP-LOOP-0003', message: 'model generation failed', retryable: false },
  });
  assert.ok(filePath);

  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const provider = payload.provider_diagnostics;
  assert.equal(provider.provider_call_count, 3);
  assert.equal(provider.provider_call_purpose, 'checkpoint_continuation');
  assert.equal(provider.provider_call_outcome, 'failed');
  assert.equal('provider_eval_count' in provider, false);
  assert.equal('visible_output_chars' in provider, false);
  assert.deepEqual(
    provider.provider_calls.map((call) => [call.ordinal, call.purpose, call.outcome]),
    [[1, 'turn', 'completed'], [2, 'reasoning_summary', 'completed'], [3, 'checkpoint_continuation', 'failed']],
  );
  assert.equal(provider.provider_calls[1].usage.eval_count, 78);
  assert.equal(provider.provider_calls[2].usage, null);
  assert.equal(provider.time_to_provider_request_start_ms, 1000);
});
