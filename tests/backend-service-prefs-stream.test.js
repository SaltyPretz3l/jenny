const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const {
  resolveTerminalRouting,
  resolveTerminalStatusFromErrorPayload,
} = require('../services/backend/chat-stream-terminal-utils');
const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
  trackPort,
} = require('./helpers/resource-cleanup');
const {
  waitForChatStreamEvent,
  collectServiceLogs,
} = require('./helpers/backend-service-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function createBackendService(options) {
  return new BackendService({
    safeStorage: createFakeSafeStorage(),
    isSafeStorageReady: () => true,
    ...options,
  });
}

test('shared terminal router preserves transcript-silent denial and question batch parity', () => {
  const denied = resolveTerminalRouting({ status: 'denied' });
  assert.equal(denied.status, 'denied');
  assert.equal(denied.denialSilent, true);
  assert.equal(denied.emitErrorEvent, false);
  assert.equal(denied.persistAssistantFailure, false);

  const questionBatch = resolveTerminalRouting({ status: 'question_batch' });
  assert.equal(questionBatch.status, 'question_batch');
  assert.equal(questionBatch.settleQuestionBatch, true);
  assert.equal(questionBatch.emitErrorEvent, false);
  assert.equal(questionBatch.persistAssistantFailure, false);
});

test('shared terminal router preserves timeout failure parity before and after visible completion', () => {
  const timeoutBeforeVisibleCompletion = resolveTerminalRouting({
    status: 'timeout',
    terminalSubcode: 'approval',
    visibleCompletionEmitted: false,
  });
  assert.equal(timeoutBeforeVisibleCompletion.status, 'timeout');
  assert.equal(timeoutBeforeVisibleCompletion.terminalSubcode, 'approval');
  assert.equal(timeoutBeforeVisibleCompletion.emitErrorEvent, true);
  assert.equal(timeoutBeforeVisibleCompletion.persistAssistantFailure, true);
  assert.equal(timeoutBeforeVisibleCompletion.logOnlyLateFailure, false);

  const timeoutAfterVisibleCompletion = resolveTerminalRouting({
    status: 'timeout',
    terminalSubcode: 'approval',
    visibleCompletionEmitted: true,
  });
  assert.equal(timeoutAfterVisibleCompletion.emitErrorEvent, false);
  assert.equal(timeoutAfterVisibleCompletion.persistAssistantFailure, false);
  assert.equal(timeoutAfterVisibleCompletion.logOnlyLateFailure, true);
});

test('shared terminal router resolves explicit and category-derived terminal statuses', () => {
  assert.equal(
    resolveTerminalStatusFromErrorPayload({ status: 'preempted', terminal_subcode: 'plan_drift' }),
    'preempted'
  );
  assert.equal(
    resolveTerminalStatusFromErrorPayload({ category: 'timeout' }),
    'timeout'
  );
  assert.equal(
    resolveTerminalStatusFromErrorPayload({ category: 'cancelled' }),
    'cancelled'
  );
});

// External backends own their model lifecycle: the constructor blanks
// `defaultModel` for them, and resolveManagedDefaultModel() returns '' rather
// than forcing DEFAULT_MANAGED_SHELL_MODEL onto an arbitrary OpenAI-compatible
// server. With no managed default, resolveModel() falls through to the backend's
// own catalog, so no managed model is ever loaded for an external backend.
// F-07: on an empty external completion, backend-chat-stream.js persists a
// failure row for `assistant_${streamId}` and THEN throws so the outer catch
// can do terminal routing; that catch used to persist ANOTHER failure row
// under the exact same id (visibleCompletionEmitted is hardcoded false, so
// terminal routing says "persist"), and SessionShadowStore.appendLocalMessage
// has no id dedup (unlike appendTurnEvents, which dedupes event_id) — so the
// turn ended up with two assistant_<streamId> rows instead of one.
