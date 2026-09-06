// CTL-007 acceptance contract: startup active-turn reconciliation must be
// IDEMPOTENT against already-terminal evidence. settleOrphanedManagedTurn
// currently appends `assistant_<streamId>` sidecar_crash failure rows
// unconditionally — if the turn's assistant row already persisted (the crash
// happened AFTER durable settle but BEFORE active_turn cleared, or a previous
// reconcile already ran), the blind append duplicates the message id and/or
// fabricates a failure for a turn the user watched succeed. The fix must check
// for existing terminal evidence for the stream (a persisted assistant row
// with a terminal status counts on its own — turn-event presence is NOT
// required) and, when found, clear the stale active_turn WITHOUT appending
// anything, logging an `already_terminal` reason. The genuine-crash path
// (no assistant row at all) keeps today's behavior — that pin is below.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  collectServiceLogs,
} = require('../helpers/backend-service-helpers');
const {
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');
const {
  SIDECAR_ERROR_CODES,
} = require('../../services/backend/error-codes');
const {
  reconcileManagedSidecarActiveTurns,
} = require('../../services/backend/managed-sidecar-reconciliation');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createOrphanedService(label) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), `jenny-reconcile-idem-${label}-`));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const logs = collectServiceLogs(service);
  const created = service.sessionStore.createSession({ title: 'Reconcile Idempotency' });
  service.sessionStore.appendMessage(created.id, {
    id: 'user_stream-idem',
    role: 'user',
    content: 'Please continue',
    timestamp: new Date().toISOString(),
  });
  return { service, logs, sessionId: created.id };
}

function setStaleActiveTurn(service, sessionId) {
  service.sessionStore.setActiveTurn(sessionId, {
    request_id: 'stream-idem',
    stream_id: 'stream-idem',
    user_message_id: 'user_stream-idem',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
}

function assistantRowsFor(service, sessionId) {
  return service.sessionStore.getSessionMessages(sessionId)
    .filter((message) => message.id === 'assistant_stream-idem');
}

function failureRows(service, sessionId) {
  return service.sessionStore.getSessionMessages(sessionId)
    .filter((message) => message.terminal_subcode === 'sidecar_crash'
      || message.error_code === SIDECAR_ERROR_CODES.PROCESS_EXIT);
}

test('a stale active_turn whose assistant row already settled COMPLETE is cleared without appending anything', async () => {
  const { service, logs, sessionId } = createOrphanedService('complete');
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_stream-idem',
    role: 'assistant',
    content: 'The finished answer the user already saw.',
    status: 'complete',
    streamId: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
  setStaleActiveTurn(service, sessionId);

  const result = await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const assistantRows = assistantRowsFor(service, sessionId);

  assert.equal(result.scanned, 1);
  assert.equal(reloaded.active_turn, null, 'the stale active_turn must still be cleared');
  assert.equal(assistantRows.length, 1, 'the settled assistant row must not be duplicated');
  assert.equal(
    assistantRows[0].status,
    'complete',
    'the settled assistant row must keep its COMPLETE status (not be overwritten as a crash)'
  );
  assert.deepEqual(
    failureRows(service, sessionId),
    [],
    'no sidecar_crash failure row may be fabricated for a turn with terminal evidence'
  );
  assert.ok(
    logs.some((entry) => /already_terminal/.test(String(entry.details?.reason || ''))
      || /already_terminal/.test(String(entry.event || ''))),
    'the evidence-based skip is diagnosed with an already_terminal reason'
  );
});

test('message-level terminal evidence alone suppresses the failure append (no turn events required)', async () => {
  const { service, sessionId } = createOrphanedService('no-events');
  // The crash window here: assistant settle persisted the message, but the
  // turn-event flush never happened. No turn events are seeded anywhere in
  // this harness — the persisted assistant row is the ONLY evidence, and it
  // must be enough.
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_stream-idem',
    role: 'assistant',
    content: 'Settled answer, events unflushed.',
    status: 'complete',
    streamId: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);

  assert.equal(reloaded.active_turn, null);
  assert.equal(assistantRowsFor(service, sessionId).length, 1);
  assert.deepEqual(failureRows(service, sessionId), []);
});

test('a failure row that already persisted is not appended a second time (restart-after-reconcile)', async () => {
  const { service, sessionId } = createOrphanedService('failure-dedupe');
  // A previous crash already settled this turn as a runtime_error (e.g. the
  // error path persisted the failure but the active_turn clear did not land
  // before the process died). A second restart must not stack another one.
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_stream-idem',
    role: 'assistant',
    content: 'Jenny lost contact with the managed sidecar before this turn could finish.',
    status: 'runtime_error',
    terminal_subcode: 'sidecar_crash',
    error_code: SIDECAR_ERROR_CODES.PROCESS_EXIT,
    streamId: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const assistantRows = assistantRowsFor(service, sessionId);

  assert.equal(reloaded.active_turn, null);
  assert.equal(assistantRows.length, 1, 'the persisted failure row must not be duplicated');
  assert.equal(assistantRows[0].status, 'runtime_error');
});

test('legacy duplicate assistant ids are normalized and gain no reconciliation copy', async () => {
  const { service, sessionId } = createOrphanedService('legacy-dup');
  // Legacy corruption shape: the blind-append defect already produced two
  // rows with the same id in an earlier release. The store now normalizes the
  // duplicate before reconciliation, which must add nothing further.
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_stream-idem',
    role: 'assistant',
    content: 'The finished answer.',
    status: 'complete',
    streamId: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
  service.sessionStore.appendMessage(sessionId, {
    id: 'assistant_stream-idem',
    role: 'assistant',
    content: 'Jenny lost contact with the managed sidecar before this turn could finish.',
    status: 'runtime_error',
    terminal_subcode: 'sidecar_crash',
    error_code: SIDECAR_ERROR_CODES.PROCESS_EXIT,
    streamId: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const assistantRows = assistantRowsFor(service, sessionId);

  assert.equal(reloaded.active_turn, null);
  assert.equal(
    assistantRows.length,
    1,
    'the store should collapse the legacy duplicate and reconciliation must not regrow it'
  );
});

// Green pin: the genuine-crash shape — a stale active_turn with NO assistant
// row at all — keeps today's repair exactly (this is the existing startup
// test's scenario; the idempotency fix must not over-suppress it).
test('a genuine orphan (no assistant row) still gains exactly one sidecar_crash failure row', async () => {
  const { service, sessionId } = createOrphanedService('genuine');
  setStaleActiveTurn(service, sessionId);

  const result = await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const assistantRows = assistantRowsFor(service, sessionId);

  assert.deepEqual(result, { scanned: 1, reconciled: 1 });
  assert.equal(reloaded.active_turn, null);
  assert.equal(assistantRows.length, 1, 'the genuine crash gains exactly one failure row');
  assert.equal(assistantRows[0].status, 'runtime_error');
  assert.equal(assistantRows[0].terminal_subcode, 'sidecar_crash');
  assert.equal(assistantRows[0].error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
});

test('a failed crash-row append preserves active_turn so a later reconciliation can succeed', async () => {
  const { service, sessionId } = createOrphanedService('append-retry');
  setStaleActiveTurn(service, sessionId);
  const appendMessage = service.sessionStore.appendMessage.bind(service.sessionStore);
  let failureAttempts = 0;
  service.sessionStore.appendMessage = (targetSessionId, message, options) => {
    if (message?.id === 'assistant_stream-idem' && failureAttempts++ === 0) {
      throw new Error('injected append failure');
    }
    return appendMessage(targetSessionId, message, options);
  };

  assert.deepEqual(await reconcileManagedSidecarActiveTurns(service), { scanned: 1, reconciled: 0 });
  assert.notEqual(service.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(failureRows(service, sessionId).length, 0);

  assert.deepEqual(await reconcileManagedSidecarActiveTurns(service), { scanned: 1, reconciled: 1 });
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(failureRows(service, sessionId).length, 1);
});

// ---------------------------------------------------------------------------
// Code-review pins (2026-07-10): segment rows persisted at tool boundaries
// carry top-level parent_stream_id and no status, so they LOOK like terminal
// evidence. A turn that crashed MID-TOOL-LOOP (dangling tool_use) or while
// streaming the final answer (trailing tool_result, no final segment) must
// still gain its crash row; only a turn whose LAST stream row is a terminal
// assistant segment (the completed-turn shape) suppresses the append.
// ---------------------------------------------------------------------------

function seedBoundarySegment(service, sessionId, segIndex, content) {
  service.sessionStore.appendMessage(sessionId, {
    id: `assistant_stream-idem_seg${segIndex}`,
    role: 'assistant',
    content,
    parent_stream_id: 'stream-idem',
    timestamp: new Date().toISOString(),
  });
}

function seedToolUse(service, sessionId, callId, status) {
  service.sessionStore.appendMessage(sessionId, {
    id: `tool_use_stream-idem_${callId}`,
    role: 'assistant',
    kind: 'tool_use',
    content: 'running shell',
    tool_call: { call_id: callId, tool_name: 'shell', status, streamId: 'stream-idem' },
    timestamp: new Date().toISOString(),
  });
}

function seedToolResult(service, sessionId, callId) {
  service.sessionStore.appendMessage(sessionId, {
    id: `tool_result_stream-idem_${callId}`,
    role: 'assistant',
    kind: 'tool_result',
    content: 'shell ok',
    tool_result: { call_id: callId, tool_name: 'shell', output_text: 'ok', parent_stream_id: 'stream-idem' },
    timestamp: new Date().toISOString(),
  });
}

test('a crash MID-TOOL-LOOP (boundary segment + dangling tool_use) still gains the crash row', async () => {
  const { service, sessionId } = createOrphanedService('seg-dangling-tool');
  seedBoundarySegment(service, sessionId, 0, 'Let me check that…');
  seedToolUse(service, sessionId, 'call_1', 'running');
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const failures = failureRows(service, sessionId);

  assert.equal(reloaded.active_turn, null, 'the stale active_turn is still cleared');
  assert.equal(
    failures.length,
    1,
    'a mid-stream commentary segment must NOT read as terminal evidence while a tool is dangling'
  );
});

test('a crash while streaming the FINAL answer (all tools settled, trailing tool_result) still gains the crash row', async () => {
  const { service, sessionId } = createOrphanedService('seg-trailing-tool');
  seedBoundarySegment(service, sessionId, 0, 'Let me check that…');
  seedToolUse(service, sessionId, 'call_1', 'completed');
  seedToolResult(service, sessionId, 'call_1');
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);
  const failures = failureRows(service, sessionId);

  assert.equal(reloaded.active_turn, null);
  assert.equal(
    failures.length,
    1,
    'segments alone are not settled evidence when the turn never persisted its final answer'
  );
});

// Green pin: the COMPLETED segmented turn (crash in the settle-to-clear
// window) keeps the CTL-007 suppression — its last stream row is the final
// text segment, after every tool settled.
test('a completed segmented turn (final segment last) is cleared without a fabricated crash row', async () => {
  const { service, logs, sessionId } = createOrphanedService('seg-completed');
  seedBoundarySegment(service, sessionId, 0, 'Let me check that…');
  seedToolUse(service, sessionId, 'call_1', 'completed');
  seedToolResult(service, sessionId, 'call_1');
  seedBoundarySegment(service, sessionId, 1, 'Here is the finished answer.');
  setStaleActiveTurn(service, sessionId);

  await reconcileManagedSidecarActiveTurns(service);
  const reloaded = service.sessionStore.getSession(sessionId);

  assert.equal(reloaded.active_turn, null);
  assert.deepEqual(
    failureRows(service, sessionId),
    [],
    'the completed segmented turn must not gain a phantom crash row'
  );
  assert.ok(
    logs.some((entry) => /already_terminal/.test(String(entry.details?.reason || ''))
      || /already_terminal/.test(String(entry.event || ''))),
    'the evidence-based skip is diagnosed'
  );
});
