// Gate F9 (2026-10-05): after Jenny is killed mid-reply, the stale active turn
// was reconciled as "Sidecar connection issue" with Retry, while the runtime
// store had already paused the same turn's work for Resume. Retry started a
// second copy of the turn. When the turn's runtime work is restart-paused, the
// row now says Jenny closed and offers only Resume of that same work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');
const { createManagedService } = require('../helpers/managed-sidecar-runtime-helpers');
const { SIDECAR_ERROR_CODES } = require('../../services/backend/error-codes');
const { reconcileManagedSidecarActiveTurns } = require('../../services/backend/managed-sidecar-reconciliation');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createKilledTurn(label) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-reconcile-restart-${label}-`));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const { id: sessionId } = service.sessionStore.createSession({ title: 'Killed mid-reply' });
  service.sessionStore.appendMessage(sessionId, {
    id: 'user_stream-killed', role: 'user', content: 'Write a long essay', timestamp: new Date().toISOString(),
  });
  service.sessionStore.setActiveTurn(sessionId, {
    request_id: 'turn-killed', turn_id: 'turn-killed', stream_id: 'stream-killed',
    user_message_id: 'user_stream-killed', started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(), status: 'streaming',
  });
  return { service, sessionId };
}

function runtimeWith(records) {
  return {
    store: {
      listSummaries: () => ({ items: records.map((record) => ({ work_id: record.work_id, session_id: record.session_id,
        turn_id: record.turn_id, status: record.status })), next_cursor: null }),
      get: (workId) => records.find((record) => record.work_id === workId) || null,
    },
  };
}

function restartPausedWork(sessionId, overrides = {}) {
  return {
    work_id: 'work-killed', session_id: sessionId, turn_id: 'turn-killed', status: 'paused',
    attempt: { attempt_id: 'a1', stream_id: 'stream-killed', incarnation: 'old', authority_revision: 'r1' },
    recovery: { kind: 'restart_paused', previous_status: 'running', reason: 'restart', at: new Date().toISOString() },
    ...overrides,
  };
}

function failureRow(service, sessionId) {
  return service.sessionStore.getSessionMessages(sessionId).find((message) => message.id === 'assistant_stream-killed');
}

const ATTEMPT = { attempt_id: 'a1', stream_id: 'stream-killed', incarnation: 'old', authority_revision: 'r1' };

test('a turn whose runtime work the restart paused reads "Jenny closed" with Resume only', async () => {
  const { service, sessionId } = createKilledTurn('paused');
  // Resumable: the checkpoint belongs to the paused attempt (scheduler.resume's rule).
  service.sessionRuntime = runtimeWith([restartPausedWork(sessionId, { checkpoint_ref: { source_attempt: { ...ATTEMPT } } })]);
  await reconcileManagedSidecarActiveTurns(service);
  const row = failureRow(service, sessionId);
  assert.ok(row, 'the interrupted turn still gets its terminal row');
  assert.equal(row.terminal_subcode, 'app_restart');
  assert.equal(row.recovery_class, 'app_restart');
  assert.equal(row.stream_error, 'Jenny closed before this reply finished.');
  assert.notEqual(row.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT, 'no sidecar blame for an app close');
  assert.deepEqual(row.recovery_actions.map((action) => action.id), ['resume_paused_reply']);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

// Astra review: the scheduler refuses to resume paused work without a checkpoint
// for its attempt, so such a reply offers Run again, never a Resume that fails.
test('restart-paused work with no checkpoint for its attempt offers Run again, not Resume', async () => {
  for (const [label, checkpoint] of [['none', undefined], ['older-attempt', { source_attempt: { ...ATTEMPT, attempt_id: 'a0' } }]]) {
    const { service, sessionId } = createKilledTurn(`rerun-${label}`);
    service.sessionRuntime = runtimeWith([restartPausedWork(sessionId, checkpoint ? { checkpoint_ref: checkpoint } : {})]);
    await reconcileManagedSidecarActiveTurns(service);
    const row = failureRow(service, sessionId);
    assert.equal(row.terminal_subcode, 'app_restart_unresumable', label);
    assert.equal(row.recovery_class, 'app_restart_rerun', label);
    assert.equal(row.stream_error, 'Jenny closed before this reply finished.', label);
    assert.deepEqual(row.recovery_actions.map((action) => action.id), ['rerun_interrupted_reply'], label);
  }
});

test('without restart-paused work for that stream the sidecar crash row is unchanged', async () => {
  for (const [label, records] of [
    ['none', []],
    ['other-stream', [restartPausedWork('x', { attempt: { attempt_id: 'a2', stream_id: 'stream-other', incarnation: 'old', authority_revision: 'r1' } })]],
    ['not-restart', [restartPausedWork('x', { recovery: null })]],
  ]) {
    const { service, sessionId } = createKilledTurn(label);
    service.sessionRuntime = runtimeWith(records.map((record) => ({ ...record, session_id: sessionId })));
    await reconcileManagedSidecarActiveTurns(service);
    const row = failureRow(service, sessionId);
    assert.equal(row.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT, label);
    assert.equal(row.terminal_subcode, 'sidecar_crash', label);
    assert.ok(row.recovery_actions.some((action) => action.id === 'retry_turn'), label);
  }
});
