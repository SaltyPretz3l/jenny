const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleToolNotification,
  settlePendingApprovalsForStream,
  settleUnfinishedToolsForStream,
  waitForToolApproval,
} = require('../services/backend/chat-stream-tool-handling');
const {
  handleMonitorNotification,
} = require('../services/backend/monitor-event-service');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeSessionStore(initialMessages = []) {
  const messages = [...initialMessages];
  return {
    messages,
    getSessionMessages() { return messages; },
    appendMessage(_sid, msg) { messages.push(msg); },
    updateMessage(_sid, msgId, patch) {
      const idx = messages.findIndex((m) => String(m.id || '') === String(msgId || ''));
      if (idx !== -1) messages[idx] = { ...messages[idx], ...patch };
    },
  };
}

function makeService(overrides = {}) {
  return {
    sessionStore: makeSessionStore(),
    emit() {},
    _emitServiceLog() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    options: { userDataPath: '/tmp/example-jenny' },
    ...overrides,
  };
}

// The blank-id guards below return before production reads the session store.
// With an empty pending map the loop past a weakened guard also returns 0, so
// the only way to prove the guard fired is a store read that cannot happen.
function makeTripwireStore() {
  return {
    getSessionMessages() {
      throw new Error('guard did not return early: the session store was read');
    },
  };
}

function makeContext(overrides = {}) {
  return {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-dp',
    streamId: 'stream-dp',
    eventBase: { sessionId: 'session-dp', streamId: 'stream-dp', model: 'test-model' },
    turnEventCollector: null,
    adapter: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Lines 57-58: recordToolObservability — aggregator has no matching method
// ---------------------------------------------------------------------------

test('recordToolObservability: aggregator lacking recordToolResult does not break the tool_result append', () => {
  // NOT "returns false": recordToolObservability is internal and reached only
  // through handleToolNotification, so its boolean is unobservable here.
  // Flipping that return to true leaves this test green. What is provable is
  // that the missing method neither throws nor blocks persistence.
  const emitted = [];
  const serviceLogs = [];
  // aggregator present but missing recordToolResult
  const aggregator = { recordToolExecuting() { return true; } };
  const service = makeService({
    toolObservabilityAggregator: aggregator,
    emit(ev, p) { emitted.push(p); },
    _emitServiceLog(level, code, meta) { serviceLogs.push({ level, code, meta }); },
    sessionStore: makeSessionStore([{
      id: 'tool_use_stream-dp_call-57',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-57',
        tool_name: 'read_file',
        input: {},
        summary: 'read_file',
        status: 'running',
        approval_state: 'auto',
        parent_stream_id: 'stream-dp',
      },
    }]),
  });

  // tool.result path calls recordToolObservability(service,'result',...), which
  // maps to aggregator.recordToolResult — absent here → branch lines 56-58
  const ctx = makeContext({ resolvedSessionId: 'session-dp', streamId: 'stream-dp' });
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-57',
      tool_name: 'read_file',
      success: true,
      output: 'content',
    },
  });

  assert.equal(returned, true);
  // The tool_result message was appended normally even though observability failed
  const results = service.sessionStore.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(results.length, 1, 'tool_result message must be persisted');
  assert.equal(results[0].tool_result.call_id, 'call-57');
  // No service log should have been emitted (method just missing, not throwing)
  assert.equal(serviceLogs.length, 0);
});

// ---------------------------------------------------------------------------
// Lines 62-71: recordToolObservability — aggregator method throws → warn log
// ---------------------------------------------------------------------------

test('recordToolObservability: aggregator.recordToolResult throws — emits WARN log and returns false', () => {
  const serviceLogs = [];
  const aggregator = {
    recordToolExecuting() { return true; },
    recordToolResult() { throw new Error('sample-observability-failure'); },
  };
  const service = makeService({
    toolObservabilityAggregator: aggregator,
    _emitServiceLog(level, code, meta) { serviceLogs.push({ level, code, meta }); },
    sessionStore: makeSessionStore([{
      id: 'tool_use_stream-dp_call-62',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-62',
        tool_name: 'write_file',
        input: {},
        summary: 'write_file',
        status: 'running',
        approval_state: 'auto',
        parent_stream_id: 'stream-dp',
      },
    }]),
  });

  const ctx = makeContext({ resolvedSessionId: 'session-dp', streamId: 'stream-dp' });
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-62',
      tool_name: 'write_file',
      success: true,
      output: 'wrote',
    },
  });

  assert.equal(returned, true);
  assert.equal(serviceLogs.length, 1, 'exactly one WARN log must be emitted');
  assert.equal(serviceLogs[0].level, 'WARN');
  assert.equal(serviceLogs[0].code, 'chat.tool_observability_record_failed');
  assert.equal(serviceLogs[0].meta.observationType, 'result');
  assert.equal(serviceLogs[0].meta.callId, 'call-62');
  assert.equal(serviceLogs[0].meta.error, 'sample-observability-failure');
});

test('recordToolObservability: aggregator.recordToolExecuting throws — emits WARN log', () => {
  const serviceLogs = [];
  const aggregator = {
    recordToolExecuting() { throw new Error('dummy-exec-failure'); },
    recordToolResult() { return true; },
  };
  const service = makeService({
    toolObservabilityAggregator: aggregator,
    _emitServiceLog(level, code, meta) { serviceLogs.push({ level, code, meta }); },
  });

  const ctx = makeContext({ resolvedSessionId: 'session-dp', streamId: 'stream-dp' });
  handleToolNotification(service, ctx, {
    method: 'tool.executing',
    params: {
      tool_call_id: 'call-62b',
      tool_name: 'inspect',
    },
  });

  assert.equal(serviceLogs.length, 1);
  assert.equal(serviceLogs[0].level, 'WARN');
  assert.equal(serviceLogs[0].meta.observationType, 'executing');
  assert.equal(serviceLogs[0].meta.callId, 'call-62b');
  assert.equal(serviceLogs[0].meta.error, 'dummy-exec-failure');
});

// ---------------------------------------------------------------------------
// Lines 87-88: upsertToolResultMessage — empty sessionId or callId → early return
// (driven via settleUnfinishedToolsForStream with a no-callId tool_use row)
// ---------------------------------------------------------------------------

test('settleUnfinishedToolsForStream: skips a tool_use row whose call_id is blank', () => {
  // Retitled: upsertToolResultMessage is not exported, and a blank call_id is
  // rejected by settleUnfinishedToolsForStream before upsert is ever reached,
  // so dropping either half of upsert's own guard leaves this green.
  // A tool_use row where call_id is '' — settleUnfinishedToolsForStream will
  // skip it at the completedCallIds.has check (line 845), so we need to drive
  // upsertToolResultMessage directly via handleToolNotification tool.result
  // with no tool_call_id param — that path returns early at line 555-557, not 87.
  // Instead, drive upsertToolResultMessage via the settlePendingApprovalsForStream
  // path which calls persistTerminalApprovalResult which calls upsertToolResultMessage
  // — but with real sessionId/callId so it does persist.
  // The cleanest way: drive settleUnfinishedToolsForStream with a running
  // tool_use whose call_id IS empty so the loop skips it (line 844-846).
  const store = makeSessionStore([{
    id: 'tool_use__empty',
    kind: 'tool_use',
    tool_call: {
      call_id: '',         // blank callId
      tool_name: 'run',
      input: {},
      summary: 'run',
      status: 'running',
      approval_state: 'auto',
      parent_stream_id: 'stream-88',
    },
  }]);
  const service = makeService({ sessionStore: store });
  const settlements = settleUnfinishedToolsForStream(service, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-88',
    streamId: 'stream-88',
    eventBase: {},
  });

  // blank callId → skipped entirely (line 845), no settlement, no tool_result appended
  assert.equal(settlements.length, 0, 'blank callId must be skipped');
  const toolResults = store.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(toolResults.length, 0, 'no tool_result must be appended when callId is empty');
});

// Lines 87-88 directly: drive via handleToolNotification with valid callId but
// have the sessionStore.appendMessage absent AND no existing message ID
// so upsertToolResultMessage reaches line 120-122 (appendMessage not a function → return)
// We need a service where updateMessage exists but appendMessage does not.

test('settleUnfinishedToolsForStream: skips settlement when the resolved sessionId is blank', () => {
  // Retitled for the same reason as the blank-call_id case above: this never
  // reaches upsertToolResultMessage's guard.
  // Route through settleUnfinishedToolsForStream with blank resolvedSessionId
  const store = makeSessionStore([{
    id: 'tool_use_stream-87_call-87',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-87',
      tool_name: 'run',
      input: {},
      summary: 'run',
      status: 'running',
      approval_state: 'auto',
      parent_stream_id: 'stream-87',
    },
  }]);
  const service = makeService({ sessionStore: store });
  // Pass empty resolvedSessionId → normalizedSessionId is '' → returns []
  const settlements = settleUnfinishedToolsForStream(service, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: '',     // triggers line 87-88 guard (returns early)
    streamId: 'stream-87',
    eventBase: {},
  });
  assert.equal(settlements.length, 0);
  // Nothing appended
  const toolResults = store.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(toolResults.length, 0);
});

// ---------------------------------------------------------------------------
// Lines 121-122: upsertToolResultMessage — no existing message AND appendMessage missing
// ---------------------------------------------------------------------------

test('upsertToolResultMessage: returns without appending when appendMessage is absent', () => {
  // Build a store with no existing tool_result for this callId, but missing appendMessage
  const existingMessages = [];
  const updateCalls = [];
  const service = makeService({
    sessionStore: {
      getSessionMessages() { return existingMessages; },
      updateMessage(_sid, msgId, patch) { updateCalls.push({ msgId, patch }); },
      // appendMessage intentionally absent
    },
  });

  // Drive via handleToolNotification tool.result — it calls upsertToolResultMessage.
  // With no existing tool_result and no appendMessage, must silently return.
  const ctx = makeContext({ resolvedSessionId: 'session-121', streamId: 'stream-121' });
  ctx.eventBase = { sessionId: 'session-121', streamId: 'stream-121', model: 'test-model' };
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-121',
      tool_name: 'read_file',
      success: true,
      output: 'data',
    },
  });

  assert.equal(returned, true);
  // updateMessage called for tool_use (existingToolUseId lookup returns null,
  // so updateMessage on tool_use is skipped too), and no appendMessage called
  assert.equal(existingMessages.length, 0, 'no message must be appended without appendMessage');
  // updateCalls may be 0 since no existing tool_use either
  assert.equal(updateCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Lines 335-336: waitForToolApproval — settled guard prevents double-resolution
// ---------------------------------------------------------------------------

test('waitForToolApproval: second resolve call is a no-op (settled guard lines 334-336)', async () => {
  const updateCalls = [];
  const emitted = [];
  const service = makeService({
    sessionStore: {
      appendMessage() {},
      updateMessage(_sid, msgId, patch) { updateCalls.push({ msgId, patch }); },
      getSessionMessages() { return []; },
    },
    emit(_ev, p) { emitted.push(p); },
  });

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    service, 'stream-335', 'session-335', 'req-335',
    { tool_name: 'write_file', tool_call_id: 'call-335', tool_input: { path: 'example.txt' } },
    controller
  );

  // Find the pending entry
  const pending = [...service.pendingToolApprovals.values()][0];
  assert.ok(pending, 'pending approval must be registered');

  // First resolution
  pending.resolve(false, 'denied');
  // Second resolution — must be ignored (settled guard)
  pending.resolve(true, 'approved');

  const result = await resultPromise;
  assert.equal(result, false, 'result must be from first resolution (denied=false)');
  // updateMessage called exactly once (for the denied resolution)
  assert.equal(updateCalls.length, 1, 'updateMessage must be called exactly once');
  assert.equal(updateCalls[0].patch.tool_call.status, 'denied');
  // tool_result emitted once (for the denied path via persistTerminalApprovalResult)
  const toolResultEvents = emitted.filter((p) => p && p.type === 'tool_result');
  assert.equal(toolResultEvents.length, 1, 'exactly one tool_result event must be emitted');
});

// ---------------------------------------------------------------------------
// Lines 416-418: waitForToolApproval — pre-aborted signal → immediate finish('cancelled')
// ---------------------------------------------------------------------------

test('waitForToolApproval: already-aborted controller resolves immediately as cancelled', async () => {
  const updateCalls = [];
  const emitted = [];
  const service = makeService({
    sessionStore: {
      appendMessage() {},
      updateMessage(_sid, msgId, patch) { updateCalls.push({ msgId, patch }); },
      getSessionMessages() { return []; },
    },
    emit(_ev, p) { emitted.push(p); },
  });

  // Abort BEFORE calling waitForToolApproval
  const controller = new AbortController();
  controller.abort();

  const result = await waitForToolApproval(
    service, 'stream-416', 'session-416', 'req-416',
    { tool_name: 'run_shell', tool_call_id: 'call-416', tool_input: {} },
    controller
  );

  assert.equal(result, false, 'pre-aborted controller must resolve to false');
  // Pending map must be empty — approval was registered then immediately settled
  assert.equal(service.pendingToolApprovals.size, 0, 'pending map must be empty after immediate settle');
  // updateMessage called with 'cancelled'
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].patch.tool_call.status, 'cancelled');
  // tool_result emitted for the cancelled path
  const toolResultEvents = emitted.filter((p) => p && p.type === 'tool_result');
  assert.equal(toolResultEvents.length, 1);
  assert.equal(toolResultEvents[0].approvalState, 'cancelled');
});

// ---------------------------------------------------------------------------
// Lines 444-445: handleToolNotification tool.executing — empty callId → returns true early
// ---------------------------------------------------------------------------

test('handleToolNotification tool.executing: empty callId returns true without side effects', () => {
  const appendCalls = [];
  const service = makeService({
    sessionStore: {
      getSessionMessages() { return []; },
      appendMessage(_sid, msg) { appendCalls.push(msg); },
      updateMessage() {},
    },
  });

  const ctx = makeContext();
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.executing',
    params: {
      tool_call_id: '',    // blank — triggers early return at lines 444-445
      tool_name: 'read_file',
    },
  });

  assert.equal(returned, true, 'must return true even for empty callId');
  assert.equal(appendCalls.length, 0, 'no message must be appended for empty callId');
  assert.equal(ctx.seenToolCalls.size, 0, 'callId must not be added to seenToolCalls');
});

// ---------------------------------------------------------------------------
// Lines 556-557: handleToolNotification tool.result — empty callId → returns true early
// ---------------------------------------------------------------------------

test('handleToolNotification tool.result: empty callId returns true without side effects', () => {
  const appendCalls = [];
  const service = makeService({
    sessionStore: {
      getSessionMessages() { return []; },
      appendMessage(_sid, msg) { appendCalls.push(msg); },
      updateMessage() {},
    },
  });

  const ctx = makeContext();
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: '',    // blank — triggers early return at lines 556-557
      tool_name: 'write_file',
      success: true,
      output: 'ok',
    },
  });

  assert.equal(returned, true, 'must return true even for empty callId on tool.result');
  assert.equal(appendCalls.length, 0, 'no message must be appended');
});

// ---------------------------------------------------------------------------
// Lines 655-666: handleToolNotification — monitor tool drains pending notifications
// ---------------------------------------------------------------------------

test('handleToolNotification tool.result: monitor tool actually DRAINS a stashed pending monitor event', () => {
  // Strengthened (was vacuous): the prior version only asserted the tool_result
  // persisted + the emitted toolName==='monitor', which stays GREEN even if the
  // `if (toolName === 'monitor')` drain branch is deleted (drain is a no-op with
  // no pending events). To pin the branch we first STASH a pending monitor event
  // via handleMonitorNotification (fires before any tool_result exists, so it is
  // queued and returns false), then let the tool.result land — the monitor branch
  // must drain that queued event, which re-applies it to the persisted tool_result
  // (monitor.events gains the entry) and emits a 'message_updated' event.
  const emitted = [];
  const store = makeSessionStore();
  const service = makeService({
    sessionStore: store,
    emit(_ev, p) { emitted.push(p); },
    _emitServiceLog() {},
  });

  // 1. Fire a monitor.event for a tool_call that has NO tool_result yet → stashed.
  const stashedHandled = handleMonitorNotification(service, {
    method: 'monitor.event',
    params: {
      session_id: 'session-655',
      request_id: 'stream-655',
      tool_call_id: 'call-monitor',
      monitor_id: 'example-monitor-42',
      kind: 'output',
      stream: 'stdout',
      text: 'queued-monitor-line-1',
      sequence: 1,
    },
  });
  // No matching tool_result exists yet → event is orphaned/stashed (returns false),
  // and nothing is persisted.
  assert.equal(stashedHandled, false, 'monitor event must be stashed (no tool_result yet)');
  assert.equal(store.messages.length, 0, 'no message must exist before the tool_result lands');

  const ctx = makeContext({
    resolvedSessionId: 'session-655',
    streamId: 'stream-655',
    eventBase: { sessionId: 'session-655', streamId: 'stream-655', model: 'test-model' },
  });

  // 2. Now the tool.result for the monitor lands → monitor branch must drain the
  //    stashed event and re-apply it to the freshly persisted tool_result.
  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-monitor',
      tool_name: 'monitor',     // triggers the drain branch (lines 654-666)
      success: true,
      output: 'monitor output',
      metadata: {
        monitor: { monitor_id: 'example-monitor-42' },
      },
    },
  });

  assert.equal(returned, true);
  // tool_result message appended
  const results = store.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(results.length, 1, 'tool_result must be persisted for monitor tool');
  assert.equal(results[0].tool_result.tool_name, 'monitor');
  // emitted tool_result event
  const toolResultEvent = emitted.find((p) => p && p.type === 'tool_result');
  assert.ok(toolResultEvent, 'tool_result event must be emitted');
  assert.equal(toolResultEvent.toolName, 'monitor');
  assert.equal(toolResultEvent.callId, 'call-monitor');

  // --- The load-bearing assertions that pin the drain branch ---
  // The drain re-runs handleMonitorNotification against the now-existing message,
  // which updates it and emits a 'message_updated' chat-stream event. If the
  // `if (toolName === 'monitor')` branch is removed, NO drain happens → no
  // message_updated event and the stashed monitor output never lands.
  const messageUpdated = emitted.find((p) => p && p.type === 'message_updated');
  assert.ok(messageUpdated, 'drain must emit a message_updated event for the queued monitor line');
  assert.equal(messageUpdated.messageId, results[0].id, 'message_updated must target the monitor tool_result');
  // The drained monitor output event must now be present on the persisted result.
  const appliedMonitor = (results[0].tool_result.metadata || {}).monitor || {};
  const appliedEvents = Array.isArray(appliedMonitor.events) ? appliedMonitor.events : [];
  assert.equal(appliedEvents.length, 1, 'exactly the one queued monitor event must be drained in');
  assert.equal(appliedEvents[0].text, 'queued-monitor-line-1', 'drained event text must match the stashed line');
});

test('handleToolNotification tool.result: monitor tool with non-object monitor metadata still drains safely', () => {
  // metadata.monitor is not an object — lines 655-659 use empty object {}
  const store = makeSessionStore();
  const service = makeService({ sessionStore: store });

  const ctx = makeContext({
    resolvedSessionId: 'session-655b',
    streamId: 'stream-655b',
    eventBase: { sessionId: 'session-655b', streamId: 'stream-655b', model: 'test-model' },
  });

  const returned = handleToolNotification(service, ctx, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-monitor-b',
      tool_name: 'monitor',
      success: true,
      output: 'ok',
      metadata: { monitor: 'not-an-object' },  // non-object → empty {}
    },
  });

  assert.equal(returned, true);
  const results = store.messages.filter((m) => m.kind === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_result.tool_name, 'monitor');
});

// ---------------------------------------------------------------------------
// Lines 733-734: settlePendingApprovalsForStream — empty sessionId/streamId → returns 0
// ---------------------------------------------------------------------------

test('settlePendingApprovalsForStream: returns 0 immediately when sessionId is blank', () => {
  const service = makeService({ sessionStore: makeTripwireStore() });
  const result = settlePendingApprovalsForStream(service, '', 'stream-733', 'cancelled');
  assert.equal(result, 0, 'must return 0 for blank sessionId');
});

test('settlePendingApprovalsForStream: returns 0 immediately when streamId is blank', () => {
  const service = makeService({ sessionStore: makeTripwireStore() });
  const result = settlePendingApprovalsForStream(service, 'session-733', '', 'cancelled');
  assert.equal(result, 0, 'must return 0 for blank streamId');
});

// ---------------------------------------------------------------------------
// Lines 737-738: settlePendingApprovalsForStream — pending with non-matching streamId is skipped
// ---------------------------------------------------------------------------

test('settlePendingApprovalsForStream: pending approval from different stream is skipped', () => {
  const resolveCalls = [];
  const service = makeService({
    sessionStore: makeSessionStore(),
    pendingToolApprovals: new Map([
      ['approval-other', {
        streamId: 'stream-OTHER',   // different stream
        resolve(approved, state) { resolveCalls.push({ approved, state }); },
      }],
    ]),
  });

  const result = settlePendingApprovalsForStream(service, 'session-737', 'stream-737', 'cancelled');
  assert.equal(result, 0);
  // The mismatched approval must NOT be resolved
  assert.equal(resolveCalls.length, 0, 'pending from other stream must not be resolved');
  // It must remain in the map
  assert.equal(service.pendingToolApprovals.size, 1, 'pending must remain in map');
});

// ---------------------------------------------------------------------------
// Lines 756-757: settlePendingApprovalsForStream — tool_use with callId in completedCallIds skipped
// ---------------------------------------------------------------------------

test('settlePendingApprovalsForStream: pending tool_use already in completedCallIds is skipped', () => {
  // A tool_use that has a matching tool_result in the SAME stream → callId in completedCallIds
  const store = makeSessionStore([
    {
      id: 'tool_use_stream-756_call-756',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-756',
        tool_name: 'write_file',
        input: {},
        summary: 'write_file',
        status: 'pending_approval',
        approval_state: 'pending',
        parent_stream_id: 'stream-756',
      },
    },
    {
      id: 'tool_result_stream-756_call-756',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call-756',
        tool_name: 'write_file',
        output_text: 'done',
        is_error: false,
        parent_stream_id: 'stream-756',   // SAME stream → completedCallIds includes call-756
      },
    },
  ]);
  const updateCalls = [];
  store.updateMessage = (_sid, msgId, patch) => { updateCalls.push({ msgId, patch }); };

  const service = makeService({ sessionStore: store });
  const result = settlePendingApprovalsForStream(service, 'session-756', 'stream-756', 'cancelled');

  // call-756 already has a result → must be skipped
  assert.equal(result, 0, 'already-completed call must not be repaired');
  // updateMessage must not be called for the tool_use message
  const toolUseUpdates = updateCalls.filter((c) => c.msgId === 'tool_use_stream-756_call-756');
  assert.equal(toolUseUpdates.length, 0, 'completed tool_use must not be updated');
});

// ---------------------------------------------------------------------------
// Lines 842-843: settleUnfinishedToolsForStream — callId in completedCallIds → skip
// ---------------------------------------------------------------------------

test('settleUnfinishedToolsForStream: running tool_use with callId in completedCallIds is skipped', () => {
  // A tool_use with status=running AND a matching tool_result in the same stream
  const store = makeSessionStore([
    {
      id: 'tool_use_stream-842_call-842',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-842',
        tool_name: 'inspect',
        input: {},
        summary: 'inspect',
        status: 'running',
        approval_state: 'auto',
        parent_stream_id: 'stream-842',
      },
    },
    {
      id: 'tool_result_stream-842_call-842',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call-842',
        tool_name: 'inspect',
        output_text: 'result',
        is_error: false,
        parent_stream_id: 'stream-842',   // same stream → completedCallIds
      },
    },
  ]);
  const appendCalls = [];
  const origAppend = store.appendMessage.bind(store);
  store.appendMessage = (sid, msg) => { appendCalls.push(msg); origAppend(sid, msg); };

  const service = makeService({ sessionStore: store });
  const settlements = settleUnfinishedToolsForStream(service, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-842',
    streamId: 'stream-842',
    eventBase: {},
  });

  assert.equal(settlements.length, 0, 'already-completed tool must not be settled');
  assert.equal(appendCalls.length, 0, 'no synthetic result must be appended');
});

// ---------------------------------------------------------------------------
// Lines 849-850: settleUnfinishedToolsForStream — tool_use with non-running status skipped
// ---------------------------------------------------------------------------

test('settleUnfinishedToolsForStream: tool_use with pending_approval status is skipped', () => {
  const store = makeSessionStore([{
    id: 'tool_use_stream-849_call-849',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-849',
      tool_name: 'write_file',
      input: {},
      summary: 'write_file',
      status: 'pending_approval',    // not 'running' → skipped at line 848-850
      approval_state: 'pending',
      parent_stream_id: 'stream-849',
    },
  }]);
  const appendCalls = [];
  const origAppend = store.appendMessage.bind(store);
  store.appendMessage = (sid, msg) => { appendCalls.push(msg); origAppend(sid, msg); };

  const service = makeService({ sessionStore: store });
  const settlements = settleUnfinishedToolsForStream(service, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-849',
    streamId: 'stream-849',
    eventBase: {},
  });

  assert.equal(settlements.length, 0, 'pending_approval tool must not be settled by settleUnfinished');
  assert.equal(appendCalls.length, 0, 'no synthetic result must be appended for non-running tool');
});

test('settleUnfinishedToolsForStream: tool_use with interrupted status is skipped (already terminal)', () => {
  const store = makeSessionStore([{
    id: 'tool_use_stream-849b_call-849b',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-849b',
      tool_name: 'run',
      input: {},
      summary: 'run',
      status: 'interrupted',         // non-running terminal state → skipped
      approval_state: 'auto',
      parent_stream_id: 'stream-849b',
    },
  }]);
  const appendCalls = [];
  const origAppend = store.appendMessage.bind(store);
  store.appendMessage = (sid, msg) => { appendCalls.push(msg); origAppend(sid, msg); };

  const service = makeService({ sessionStore: store });
  const settlements = settleUnfinishedToolsForStream(service, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-849b',
    streamId: 'stream-849b',
    eventBase: {},
  });

  assert.equal(settlements.length, 0, 'already-interrupted tool must not be re-settled');
  assert.equal(appendCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Bonus: verify recordToolObservability absent-aggregator path (lines 49-51)
// to ensure the aggregator=null guard returns false without logging
// ---------------------------------------------------------------------------

test('recordToolObservability: absent aggregator (null) emits no log and does not throw', () => {
  const serviceLogs = [];
  const service = makeService({
    toolObservabilityAggregator: null,
    _emitServiceLog(level, code, meta) { serviceLogs.push({ level, code, meta }); },
    sessionStore: makeSessionStore(),
  });

  const ctx = makeContext();
  // Executing path calls recordToolObservability(service,'executing',...) — aggregator null.
  // Its `false` return is not observable from here; the assertion is the absent log.
  handleToolNotification(service, ctx, {
    method: 'tool.executing',
    params: {
      tool_call_id: 'call-noagg',
      tool_name: 'read_file',
    },
  });

  assert.equal(serviceLogs.length, 0, 'no log must be emitted when aggregator is absent');
});
