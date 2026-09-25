'use strict';

// 2026-09-22: a paused turn whose settlement could not be confirmed took the
// attention path, which returned before the failed-turn machinery. No turn
// diagnostic was written and the renderer's client timing expired waiting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reportManagedContinuationAttention } = require('../services/backend/managed-sidecar-terminal-cleanup');

function findDiagnostics(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(path.join(root, 'diagnostics'));
  return found;
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

function makeService(userDataPath) {
  const logs = [];
  const emitted = [];
  return {
    logs,
    emitted,
    options: { userDataPath },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    emit(channel, payload) { emitted.push({ channel, payload }); },
  };
}

const runtime = {
  getEventBase: () => ({ sessionId: 'sess_attention', streamId: 'stream_attention', requestId: 'stream_attention' }),
  getDiagnosticToolEvents: () => [{ tool: 'read_file', status: 'failed' }],
};

test('the attention path writes a turn diagnostic when given the turn context', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-attention-diagnostic-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = makeService(userDataPath);

  reportManagedContinuationAttention(service, runtime,
    Object.assign(new Error('pause refused'), { reason: 'runtime_continuation_producer_cleanup_unconfirmed' }),
    { traceId: 'stream_attention', timingMarkers: {}, turnDiagnosticState: { promptContributions: null },
      model: 'test-model', clientTiming: null });

  assert.equal(service.logs[0].event, 'session_runtime.attention_required');
  assert.equal(service.emitted[0].payload.type, 'error');
  assert.equal(await waitFor(() => findDiagnostics(userDataPath).length === 1), true);
  const written = JSON.parse(fs.readFileSync(findDiagnostics(userDataPath)[0], 'utf8'));
  assert.equal(written.stream_id, 'stream_attention');
  assert.equal(written.terminal_status, 'unknown');
  assert.equal(written.terminal_error.message, 'runtime_continuation_producer_cleanup_unconfirmed');
});

test('a diagnostic failure never changes the attention outcome', () => {
  const service = makeService('');
  const throwingRuntime = { ...runtime, getDiagnosticToolEvents() { throw new Error('boom'); } };
  reportManagedContinuationAttention(service, throwingRuntime, new Error('pause refused'),
    { traceId: 't', timingMarkers: {}, turnDiagnosticState: {}, model: '', clientTiming: null });
  assert.equal(service.emitted.length, 1);
});
