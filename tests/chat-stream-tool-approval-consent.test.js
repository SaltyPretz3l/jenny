'use strict';

// A decision executes a tool only when it is that tool's own consent (tool
// review, 2026-10-19): plan tokens never run another tool, a second waiter for a
// live approval id is denied without touching the first, and a pending state
// updates an existing tool_use row instead of appending a twin.

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForToolApproval } = require('../services/backend/chat-stream-tool-handling');
const { buildToolUseMessageId } = require('../services/backend/tool-message-id');

function makeService(messages = []) {
  const appended = [];
  const updated = [];
  const logs = [];
  return {
    appended,
    updated,
    logs,
    sessionStore: {
      getSessionMessages() { return messages; },
      appendMessage(sessionId, message) { appended.push({ sessionId, message }); },
      updateMessage(sessionId, messageId, patch) { updated.push({ sessionId, messageId, patch }); },
    },
    emit() {},
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
}

function onlyPending(service) {
  const entries = [...service.pendingToolApprovals.values()];
  assert.equal(entries.length, 1);
  return entries[0];
}

function start(service, callId, overrides = {}) {
  return waitForToolApproval(
    service, 'stream-consent', 'session-consent', 'req-consent',
    { tool_name: 'Write', tool_call_id: callId, tool_input: { path: 'notes.md' }, ...overrides },
    new AbortController()
  );
}

for (const token of ['accepted', 'rejected']) {
  test(`a plan decision token (${token}) never executes an ordinary tool`, async () => {
    const service = makeService();
    const promise = start(service, `call-${token}`);
    onlyPending(service).resolve(true, token);
    assert.equal(await promise, false);
    const row = service.updated.at(-1).patch.tool_call;
    assert.equal(row.approval_state, 'denied');
    assert.equal(row.status, 'denied');
    assert.equal(service.pendingToolApprovals.size, 0);
  });
}

test('approved_auto is the ordinary tool consent of an Auto plan run', async () => {
  const service = makeService();
  const promise = start(service, 'call-auto');
  onlyPending(service).resolve(true, 'approved_auto');
  assert.equal(await promise, true);
  assert.equal(service.updated.at(-1).patch.tool_call.approval_state, 'approved_auto');
});

test('a duplicate request for a live approval id is denied and keeps the first waiter', async () => {
  const service = makeService();
  const first = start(service, 'call-dup');
  const firstPending = onlyPending(service);
  const second = await start(service, 'call-dup');
  assert.equal(second, false);
  assert.equal(service.pendingToolApprovals.get(firstPending.approvalId), firstPending);
  assert.equal(service.logs.filter((entry) => entry.event === 'chat.tool_approval_duplicate_denied').length, 1);
  assert.equal(service.appended.length, 1, 'the duplicate wrote no second pending row');

  firstPending.resolve(true, 'approved');
  assert.equal(await first, true);
  assert.equal(service.pendingToolApprovals.size, 0);
});

test('a settled waiter deletes only its own map entry', async () => {
  const service = makeService();
  const promise = start(service, 'call-own');
  const pending = onlyPending(service);
  const foreign = { approvalId: pending.approvalId, resolve() {} };
  service.pendingToolApprovals.set(pending.approvalId, foreign);
  pending.resolve(false, 'denied');
  assert.equal(await promise, false);
  assert.equal(service.pendingToolApprovals.get(pending.approvalId), foreign);
});

test('the pending state updates an existing tool_use row instead of appending a twin', async () => {
  const existingId = buildToolUseMessageId('stream-consent', 'call-row');
  const service = makeService([{
    id: existingId,
    kind: 'tool_use',
    tool_call: { call_id: 'call-row', tool_name: 'Write', status: 'pending', approval_state: 'auto', parent_stream_id: 'stream-consent' },
  }]);
  const promise = start(service, 'call-row');
  assert.equal(service.appended.length, 0);
  assert.equal(service.updated.length, 1);
  assert.equal(service.updated[0].messageId, existingId);
  assert.equal(service.updated[0].patch.tool_call.status, 'pending_approval');
  assert.equal(service.updated[0].patch.tool_call.approval_state, 'pending');
  assert.equal(onlyPending(service).messageId, existingId);

  onlyPending(service).resolve(true, 'approved');
  assert.equal(await promise, true);
  assert.equal(service.updated.at(-1).messageId, existingId);
  assert.equal(service.updated.at(-1).patch.tool_call.approval_state, 'approved');
});
