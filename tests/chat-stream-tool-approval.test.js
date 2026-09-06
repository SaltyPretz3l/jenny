const test = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForToolApproval,
} = require('../services/backend/chat-stream-tool-handling');
const {
  CanonicalTurnEventCollector,
} = require('../services/backend/canonical-turn-event-collector');
const {
  normalizeMessageFields,
} = require('../services/backend/message-normalization');

function findPendingApproval(pendingToolApprovals, { callId = '', streamId = '' } = {}) {
  for (const pending of pendingToolApprovals.values()) {
    if (
      (!callId || String(pending?.callId || '') === String(callId))
      && (!streamId || String(pending?.streamId || '') === String(streamId))
    ) {
      return pending;
    }
  }
  return null;
}

/* ---- D2: approval timeout ---- */

// The module aliases `const _setTimeout = setTimeout` at load, so mock timers
// only reach it if they are enabled BEFORE the require. Busting the cache here
// keeps the seam in the test rather than adding an injectable timer to
// production for the sake of one assertion.
function loadToolHandlingWithMockedTimers() {
  const modulePath = require.resolve('../services/backend/chat-stream-tool-handling');
  delete require.cache[modulePath];
  const loaded = require(modulePath);
  delete require.cache[modulePath];
  return loaded;
}

test('waitForToolApproval resolves false when the production timeout timer fires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { waitForToolApproval: waitWithMockedTimer } = loadToolHandlingWithMockedTimers();

  const updateCalls = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage(sessionId, messageId, update) {
        updateCalls.push({ sessionId, messageId, update });
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const params = {
    tool_name: 'TestTool',
    tool_call_id: 'call-timeout-1',
    tool_input: { key: 'value' },
  };

  const resultPromise = waitWithMockedTimer(mockService, 'stream-1', 'session-1', 'req-1', params, controller);
  // Track settlement separately: awaiting a promise that production never
  // settles would HANG the file until the runner's per-file watchdog kills it,
  // which is a much harder failure to attribute than a failed assertion.
  const PENDING = Symbol('pending');
  let settledWith = PENDING;
  resultPromise.then((value) => { settledWith = value; });

  assert.ok(findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-timeout-1',
    streamId: 'stream-1',
  }), 'the approval must be registered before the timer runs');

  // Nothing settles the promise but production's own timer: the previous version
  // called pending.resolve(false, 'timeout') by hand, so deleting the timer
  // entirely left this test green.
  t.mock.timers.tick(10 * 60 * 1000);
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }

  assert.notEqual(settledWith, PENDING, 'the production approval timer must settle the promise');
  const result = await resultPromise;
  assert.equal(result, false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].update.tool_call.status, 'timeout');
  assert.equal(mockService.pendingToolApprovals.size, 0, 'the pending entry must be cleaned up');
});

test('waitForToolApproval resolves false when aborted', async () => {
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage() {},
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const params = {
    tool_name: 'TestTool',
    tool_call_id: 'call-abort-1',
    tool_input: {},
  };

  const resultPromise = waitForToolApproval(mockService, 'stream-1', 'session-1', 'req-1', params, controller);
  controller.abort();

  const result = await resultPromise;
  assert.equal(result, false);
  assert.equal(mockService.pendingToolApprovals.has('call-abort-1'), false);
});

test('waitForToolApproval persists approved status immediately when accepted', async () => {
  const updateCalls = [];
  const emitted = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage(sessionId, messageId, patch) {
        updateCalls.push({ sessionId, messageId, patch });
      },
    },
    emit(_event, payload) {
      emitted.push(payload);
    },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const params = {
    tool_name: 'Write',
    tool_call_id: 'call-approved-1',
    tool_input: { path: 'notes.md' },
  };
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-approved-1',
    'session-approved-1',
    'req-approved-1',
    params,
    controller
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-approved-1',
    streamId: 'stream-approved-1',
  });
  assert.ok(pending);
  pending.resolve(true, 'approved');

  const approved = await resultPromise;
  assert.equal(approved, true);
  assert.equal(mockService.pendingToolApprovals.has('call-approved-1'), false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].patch.tool_call.status, 'approved');
  assert.equal(updateCalls[0].patch.tool_call.approval_state, 'approved');
  assert.equal(Object.hasOwn(updateCalls[0].patch.tool_call, 'reason'), false);
  assert.equal(
    emitted.some((payload) => payload && payload.type === 'tool_use' && payload.callId === 'call-approved-1' && payload.status === 'approved'),
    true
  );
});

test('waitForToolApproval captures approval lifecycle as canonical events', async () => {
  const reason = 'This command can delete or overwrite files (rm). Approve to continue.';
  const appended = [];
  const emitted = [];
  const collector = new CanonicalTurnEventCollector({
    turnId: 'stream-canonical-approval',
    sessionId: 'session-canonical-approval',
  });
  const mockService = {
    sessionStore: {
      appendMessage(_sessionId, message) { appended.push(message); },
      updateMessage() {},
    },
    emit(_event, payload) { emitted.push(payload); },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-canonical-approval',
    'session-canonical-approval',
    'req-canonical-approval',
    {
      tool_name: 'Write',
      tool_call_id: 'call-canonical-approval',
      tool_input: { path: 'notes.md' },
      reason,
      policy_scope: 'Workspace files',
      policy_consequence: 'May change data in this scope.',
    },
    controller,
    collector
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-canonical-approval',
    streamId: 'stream-canonical-approval',
  });
  assert.ok(pending);
  assert.equal(appended[0].tool_call.reason, reason);
  assert.equal(emitted.find((payload) => payload.type === 'tool_approval_needed').reason, reason);
  pending.resolve(false, 'denied');

  assert.equal(await resultPromise, false);
  const approvalEvents = collector.capturedEvents.filter(
    (event) => String(event.kind || '').startsWith('approval_')
  );
  assert.equal(approvalEvents.length, 2);
  assert.deepEqual(
    approvalEvents.map((event) => event.payload.canonical_event_type),
    ['tool_approval_requested', 'tool_approval_resolved']
  );
  assert.deepEqual(
    approvalEvents.map((event) => event.event_id),
    [
      'stream-canonical-approval:approval:requested:call-canonical-approval',
      'stream-canonical-approval:approval:resolved:call-canonical-approval',
    ]
  );
  assert.equal(
    approvalEvents[0].primary_message_id,
    'tool_use_stream-canonical-approval_call-canonical-approval'
  );
  assert.equal(approvalEvents[1].payload.approval_state, 'denied');
  assert.equal(approvalEvents[1].payload.approved, false);
  assert.equal(approvalEvents[0].payload.policy_scope, 'Workspace files');
  assert.equal(approvalEvents[0].payload.policy_consequence, 'May change data in this scope.');
  assert.equal(approvalEvents[0].payload.reason, reason);
  assert.equal(
    collector.capturedEvents.find((event) => event.kind === 'tool_use').payload.reason,
    reason
  );
});

for (const terminalState of ['denied', 'cancelled']) {
  test(`waitForToolApproval persists terminal tool_result when approval is ${terminalState}`, async () => {
    const messages = [];
    const emitted = [];
    const turnEvents = [];
    const mockService = {
      sessionStore: {
        getSessionMessages() {
          return messages;
        },
        appendMessage(_sessionId, message) {
          messages.push(normalizeMessageFields(message, 'test-model'));
        },
        updateMessage(_sessionId, messageId, patch) {
          const index = messages.findIndex((message) => String(message.id || '') === messageId);
          if (index !== -1) {
            messages[index] = { ...messages[index], ...patch };
          }
        },
      },
      emit(_event, payload) {
        emitted.push(payload);
      },
      pendingToolApprovals: new Map(),
      currentModel: 'test-model',
    };
    const collector = new CanonicalTurnEventCollector({
      turnId: `stream-${terminalState}`,
      sessionId: `session-${terminalState}`,
    });
    const controller = new AbortController();
    const resultPromise = waitForToolApproval(
      mockService,
      `stream-${terminalState}`,
      `session-${terminalState}`,
      `req-${terminalState}`,
      {
        tool_name: 'write_file',
        tool_call_id: `call-${terminalState}`,
        tool_input: { path: `${terminalState}.txt` },
      },
      controller,
      {
        noteEvent(event) {
          turnEvents.push(event);
          return collector.noteEvent(event);
        },
      }
    );

    const pending = findPendingApproval(mockService.pendingToolApprovals, {
      callId: `call-${terminalState}`,
      streamId: `stream-${terminalState}`,
    });
    assert.ok(pending);
    pending.resolve(false, terminalState);

    assert.equal(await resultPromise, false);
    const toolResult = messages.find((message) => String(message.kind || '') === 'tool_result');
    assert.ok(toolResult);
    assert.equal(toolResult.tool_result.call_id, `call-${terminalState}`);
    assert.equal(toolResult.tool_result.is_error, true);
    assert.equal(toolResult.tool_result.approval_state, terminalState);
    assert.equal(toolResult.tool_result.error_code, 'CMP-TOOL-0001');
    assert.equal(
      emitted.some((payload) =>
        payload?.type === 'tool_result'
        && payload.callId === `call-${terminalState}`
        && payload.approvalState === terminalState
      ),
      true
    );
    const persistedTurnResult = turnEvents.find((event) => String(event.kind || '') === 'tool_result');
    assert.ok(persistedTurnResult);
    assert.equal(persistedTurnResult.status, terminalState);
    assert.equal(persistedTurnResult.payload.approval_state, terminalState);
  });
}

test('waitForToolApproval preserves policy_decision_id across tool_use and approval canonical events', async () => {
  const appendCalls = [];
  const updateCalls = [];
  const collector = new CanonicalTurnEventCollector({
    turnId: 'stream-policy-id',
    sessionId: 'session-policy-id',
  });
  const mockService = {
    sessionStore: {
      appendMessage(_sessionId, message) {
        appendCalls.push(message);
      },
      updateMessage(_sessionId, _messageId, patch) {
        updateCalls.push(patch);
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-policy-id',
    'session-policy-id',
    'req-policy-id',
    {
      tool_name: 'Write',
      tool_call_id: 'call-policy-id',
      tool_input: { path: 'notes.md' },
      policy_decision_id: 'policy-decision-123',
    },
    controller,
    collector
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-policy-id',
    streamId: 'stream-policy-id',
  });
  assert.ok(pending);
  pending.resolve(false, 'denied');
  await resultPromise;

  assert.equal(appendCalls[0].tool_call.policy_decision_id, 'policy-decision-123');
  assert.equal(updateCalls[0].tool_call.policy_decision_id, 'policy-decision-123');

  const toolUseEvent = collector.capturedEvents.find((event) => event.kind === 'tool_use');
  assert.ok(toolUseEvent);
  assert.equal(toolUseEvent.payload.policy_decision_id, 'policy-decision-123');

  const approvalEvents = collector.capturedEvents.filter(
    (event) => String(event.kind || '').startsWith('approval_')
  );
  assert.equal(approvalEvents.length, 2);
  assert.equal(approvalEvents[0].payload.policy_decision_id, 'policy-decision-123');
  assert.equal(approvalEvents[1].payload.policy_decision_id, 'policy-decision-123');
});

test('waitForToolApproval persists preempted status immediately when interrupted upstream', async () => {
  const updateCalls = [];
  const emitted = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage(sessionId, messageId, patch) {
        updateCalls.push({ sessionId, messageId, patch });
      },
    },
    emit(_event, payload) {
      emitted.push(payload);
    },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const params = {
    tool_name: 'Write',
    tool_call_id: 'call-preempted-1',
    tool_input: { path: 'notes.md' },
  };
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-preempted-1',
    'session-preempted-1',
    'req-preempted-1',
    params,
    controller
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-preempted-1',
    streamId: 'stream-preempted-1',
  });
  assert.ok(pending);
  pending.resolve(false, 'preempted');

  const approved = await resultPromise;
  assert.equal(approved, false);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].patch.tool_call.status, 'preempted');
  assert.equal(updateCalls[0].patch.tool_call.approval_state, 'preempted');
  assert.equal(
    emitted.some((payload) => payload && payload.type === 'tool_use' && payload.callId === 'call-preempted-1' && payload.status === 'preempted'),
    true
  );
});

test('waitForToolApproval scopes pending approvals and message ids by stream when provider ids repeat', async () => {
  const appendedMessages = [];
  const mockService = {
    sessionStore: {
      appendMessage(_sessionId, message) {
        appendedMessages.push(message);
      },
      updateMessage() {},
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const firstPromise = waitForToolApproval(
    mockService,
    'stream-a',
    'session-1',
    'req-a',
    {
      tool_name: 'Write',
      tool_call_id: 'call-reused',
      tool_input: { path: 'a.md' },
    },
    controller
  );
  const secondPromise = waitForToolApproval(
    mockService,
    'stream-b',
    'session-1',
    'req-b',
    {
      tool_name: 'Write',
      tool_call_id: 'call-reused',
      tool_input: { path: 'b.md' },
    },
    controller
  );

  assert.equal(mockService.pendingToolApprovals.size, 2);
  const firstPending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-reused',
    streamId: 'stream-a',
  });
  const secondPending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-reused',
    streamId: 'stream-b',
  });
  assert.ok(firstPending);
  assert.ok(secondPending);
  assert.notEqual(firstPending.approvalId, secondPending.approvalId);
  assert.equal(firstPending.messageId, 'tool_use_stream-a_call-reused');
  assert.equal(secondPending.messageId, 'tool_use_stream-b_call-reused');
  assert.deepEqual(
    appendedMessages.map((message) => message.id),
    ['tool_use_stream-a_call-reused', 'tool_use_stream-b_call-reused']
  );

  firstPending.resolve(true, 'approved');
  secondPending.resolve(false, 'denied');
  assert.equal(await firstPromise, true);
  assert.equal(await secondPromise, false);
});

test('waitForToolApproval rejects approval requests without tool_call_id', async () => {
  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return [];
      },
      appendMessage() {},
      updateMessage() {},
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };

  const controller = new AbortController();
  const params = {
    tool_name: 'write_file',
    tool_input: { path: 'notes.md' },
  };

  await assert.rejects(
    () => waitForToolApproval(
      mockService,
      'stream-1',
      'session-1',
      'req-1',
      params,
      controller
    ),
    /missing tool_call_id/i
  );

  assert.equal(mockService.pendingToolApprovals.size, 0);
});

/* ---- SP-13: finish() must never leave the waiter poisoned ---- */
// Each of the four fallible settlement steps (updateMessage, emit, the turn
// event collector, and persistTerminalApprovalResult's own append) is made to
// throw in isolation. Pre-fix, finish() had no try/catch: a throw from any of
// these left `settled = true` but never reached `resolve(...)`, so the
// Promise returned by waitForToolApproval hung forever (the timeout/registry
// entry were already torn down, so nothing could ever retry it either).

test('waitForToolApproval still settles the promise when sessionStore.updateMessage throws during settlement', async () => {
  const logs = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage() {
        throw new Error('store write failed');
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-poison-update',
    'session-poison-update',
    'req-poison-update',
    {
      tool_name: 'Write',
      tool_call_id: 'call-poison-update',
      tool_input: { path: 'notes.md' },
    },
    controller
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-poison-update',
    streamId: 'stream-poison-update',
  });
  assert.ok(pending);
  pending.resolve(true, 'approved');

  const approved = await resultPromise;
  assert.equal(approved, true);
  assert.equal(mockService.pendingToolApprovals.has('call-poison-update'), false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'ERROR');
  assert.equal(logs[0].event, 'chat.tool_approval_settlement_failed');
  assert.equal(logs[0].details.callId, 'call-poison-update');
  assert.equal(logs[0].details.streamId, 'stream-poison-update');
  assert.equal(logs[0].details.sessionId, 'session-poison-update');
  assert.match(logs[0].details.message, /store write failed/);
});

test('waitForToolApproval still settles the promise when service.emit throws during settlement', async () => {
  const logs = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage() {},
    },
    // Only the settlement emit (finish() re-emits 'tool_use' with the
    // resolved status) should throw; the pre-Promise setup emits ('tool_use'
    // status:'pending_approval' and 'tool_approval_needed') must succeed or
    // the pending entry never gets registered and the test can't drive it.
    emit(_event, payload) {
      if (payload && payload.type === 'tool_use' && payload.status && payload.status !== 'pending_approval') {
        throw new Error('emit exploded');
      }
    },
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-poison-emit',
    'session-poison-emit',
    'req-poison-emit',
    {
      tool_name: 'Write',
      tool_call_id: 'call-poison-emit',
      tool_input: { path: 'notes.md' },
    },
    controller
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-poison-emit',
    streamId: 'stream-poison-emit',
  });
  assert.ok(pending);
  pending.resolve(false, 'denied');

  const approved = await resultPromise;
  assert.equal(approved, false);
  assert.equal(logs.some((entry) => entry.level === 'ERROR' && entry.event === 'chat.tool_approval_settlement_failed'), true);
});

test('waitForToolApproval still settles the promise when the turn event collector throws during settlement', async () => {
  const logs = [];
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage() {},
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };
  // Only the settlement's canonical 'tool_approval_resolved' note (inside
  // finish()) should throw; the pre-Promise setup notes ('tool_use' and
  // 'tool_approval_requested') must succeed or the pending entry never gets
  // registered and the test can't drive it.
  const poisonedCollector = {
    noteEvent(event) {
      if (event?.type === 'tool_approval_resolved') {
        throw new Error('collector exploded');
      }
    },
  };

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-poison-collector',
    'session-poison-collector',
    'req-poison-collector',
    {
      tool_name: 'Write',
      tool_call_id: 'call-poison-collector',
      tool_input: { path: 'notes.md' },
    },
    controller,
    poisonedCollector
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-poison-collector',
    streamId: 'stream-poison-collector',
  });
  assert.ok(pending);
  pending.resolve(true, 'approved');

  const approved = await resultPromise;
  assert.equal(approved, true);
  assert.equal(logs.some((entry) => entry.level === 'ERROR' && entry.event === 'chat.tool_approval_settlement_failed'), true);
});

test('waitForToolApproval still settles the promise when persistTerminalApprovalResult throws on denial', async () => {
  const logs = [];
  const mockService = {
    sessionStore: {
      getSessionMessages() {
        // Empty so persistTerminalApprovalResult's upsert falls through to
        // appendMessage (no existing tool_result row to update).
        return [];
      },
      updateMessage() {},
      // Only the terminal tool_result append (persistTerminalApprovalResult's
      // upsertToolResultMessage, reached on denial) should throw; the
      // pre-Promise setup append (the tool_use row) must succeed or the
      // pending entry never gets registered and the test can't drive it.
      appendMessage(_sessionId, message) {
        if (message?.kind === 'tool_result') {
          throw new Error('append exploded');
        }
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-poison-persist',
    'session-poison-persist',
    'req-poison-persist',
    {
      tool_name: 'Write',
      tool_call_id: 'call-poison-persist',
      tool_input: { path: 'notes.md' },
    },
    controller
  );

  const pending = findPendingApproval(mockService.pendingToolApprovals, {
    callId: 'call-poison-persist',
    streamId: 'stream-poison-persist',
  });
  assert.ok(pending);
  // Denial is required to reach persistTerminalApprovalResult.
  pending.resolve(false, 'denied');

  const approved = await resultPromise;
  assert.equal(approved, false);
  assert.equal(logs.some((entry) => entry.level === 'ERROR' && entry.event === 'chat.tool_approval_settlement_failed'), true);
});
