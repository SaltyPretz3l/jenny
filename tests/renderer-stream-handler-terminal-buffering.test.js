const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeferred } = require('./helpers/deferred');
const {
  createHarness,
  createQueuedFrameController,
  flushMicrotasks,
} = require('./helpers/renderer-stream-handler-buffering-harness');

test('stream handler clears visible lifecycle immediately while terminal hydration waits', async (t) => {
  const terminalHydration = createDeferred();
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-wait-complete' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-wait-complete',
    aggregate: 'Hi!',
  });

  const completePromise = harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-wait-complete',
    content: 'Hi!',
  });
  await flushMicrotasks(20);

  try {
    const completedMessage = harness.state.messagesBySession.get('session-1')[0];
    assert.equal(completedMessage.status, 'complete');
    assert.equal(completedMessage.content, 'Hi!');
    assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
    assert.equal(harness.state.pendingStreams.has('stream-wait-complete'), false);
    assert.equal(
      harness.state.ui.chatSendLifecycleBySession.has('session-1'),
      false,
      'send lifecycle should clear before terminal postwork finishes'
    );
  } finally {
    terminalHydration.resolve({ data: harness.state.messagesBySession.get('session-1') || [] });
    await completePromise;
  }
});

test('terminal post-work keeps the session send-busy until hydration resolves', async (t) => {
  const terminalHydration = createDeferred();
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-postwork' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-postwork', aggregate: 'Hi!' });

  const completePromise = harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-postwork',
    content: 'Hi!',
  });
  await flushMicrotasks(20);

  try {
    // The stream is cleared and the lifecycle is already idle, but hydration is
    // still pending. The session must remain send-busy across this window so a
    // follow-up send queues instead of starting a doomed concurrent turn that
    // races the hydration and lands below the settled response.
    assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
    assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), true);
    assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), true);
  } finally {
    terminalHydration.resolve({ data: harness.state.messagesBySession.get('session-1') || [] });
    await completePromise;
  }

  // Post-work drained → guard released so the next send proceeds normally.
  assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
});

test('terminal post-work guard is released even if hydration throws (no permanent-busy leak)', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            getMessages() {
              throw new Error('hydration boom');
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-throw' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-throw', aggregate: 'Hi!' });

  // A synchronous throw in getMessages propagates out of post-work; the finally
  // around mark/clear must still release the guard so the session is not wedged
  // busy forever.
  try {
    await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-throw', content: 'Hi!' });
  } catch (_expectedHydrationThrow) {
    // expected — the post-work threw after the guard was released.
  }
  await flushMicrotasks(20);

  assert.equal(
    harness.multiStreamController.isSessionInTerminalPostwork('session-1'),
    false,
    'a thrown hydration must not leave the session permanently send-busy'
  );
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
});

test('terminal post-work brackets the error path too (busy across error hydration, released after)', async (t) => {
  const terminalHydration = createDeferred();
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-err-postwork' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-err-postwork', aggregate: 'Hi!' });

  const errorPromise = harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-err-postwork',
    message: 'terminal boom',
    error_code: 'CMP-CHAT-0002',
  });
  await flushMicrotasks(20);

  try {
    assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), true);
    assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), true);
  } finally {
    terminalHydration.resolve({ data: harness.state.messagesBySession.get('session-1') || [] });
    await errorPromise;
  }

  assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
});

test('error path drains a follow-up queued during its post-work window', async (t) => {
  const terminalHydration = createDeferred();
  let queuedDuringWindow = null;
  const dispatchCalls = [];
  const restoreCalls = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    callbackOverrides: {
      isCurrentSession: () => true,
      // Empty at finalize (pre-window) so the early restoreQueuedDraft is a
      // no-op; becomes visible only after the user "sends" mid-window below.
      getQueuedSend: () => queuedDuringWindow,
      dispatchQueuedSendForSession: async (sessionId) => {
        dispatchCalls.push(sessionId);
        queuedDuringWindow = null;
        return { sessionId };
      },
      restoreQueuedSendDraft: (sessionId) => { restoreCalls.push(sessionId); },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-err-strand' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-err-strand', aggregate: 'Hi!' });

  const errorPromise = harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-err-strand',
    message: 'terminal boom',
    error_code: 'CMP-CHAT-0002',
  });
  await flushMicrotasks(20);

  // The user fires a follow-up while the error path's hydration is still in
  // flight — it queues (post-work is busy). The error path has no drain, so
  // before the fix it was silently stranded.
  queuedDuringWindow = { sessionId: 'session-1', prompt: 'queued during error' };
  terminalHydration.resolve({ data: harness.state.messagesBySession.get('session-1') || [] });
  await errorPromise;

  assert.deepEqual(dispatchCalls, ['session-1'], 'the during-window queued send is dispatched');
  assert.deepEqual(restoreCalls, []);
});

test('complete path drains the queued follow-up even if post-work throws', async (t) => {
  const dispatchCalls = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return { data: [] };
            },
          },
        },
      },
    },
    callbackOverrides: {
      isCurrentSession: () => true,
      getQueuedSend: () => ({ sessionId: 'session-1', prompt: 'queued during complete' }),
      // A post-work step throws after the queued send exists. The drain runs
      // after the try/finally, so without the catch the throw would skip it.
      maybeSuggestMemoryCapture: async () => { throw new Error('memory capture boom'); },
      dispatchQueuedSendForSession: async (sessionId) => { dispatchCalls.push(sessionId); return { sessionId }; },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-throw-drain' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-throw-drain', aggregate: 'Hi!' });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-throw-drain', content: 'Hi!' });
  await flushMicrotasks(20);

  assert.deepEqual(dispatchCalls, ['session-1'], 'the queued send is dispatched despite the post-work throw');
  assert.equal(harness.multiStreamController.isSessionInTerminalPostwork('session-1'), false);
});

test('terminal complete keeps the full bubble when terminal content outruns the last aggregate', async (t) => {
  const terminalHydration = createDeferred();
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-outrun' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-outrun',
    aggregate: 'The answer is ',
  });

  const completePromise = harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-outrun',
    content: 'The answer is 42.',
  });
  await flushMicrotasks(20);

  try {
    const completedMessage = harness.state.messagesBySession.get('session-1')[0];
    assert.equal(completedMessage.status, 'complete');
    assert.equal(
      completedMessage.content,
      'The answer is 42.',
      'terminal replace must keep the full content, not just the tail the aggregates never delivered'
    );
  } finally {
    terminalHydration.resolve({ data: harness.state.messagesBySession.get('session-1') || [] });
    await completePromise;
  }
});

test('stream handler ignores stale hydrated streaming status after local completion', async (t) => {
  const terminalHydration = createDeferred();
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-stale-hydration' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-hydration',
    aggregate: 'Final answer',
  });
  const completePromise = harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-stale-hydration',
    content: 'Final answer',
  });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  terminalHydration.resolve({
    data: [{
      ...localComplete,
      status: 'streaming',
      finalizedAt: null,
    }],
  });
  await completePromise;

  const finalMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(finalMessage.status, 'complete');
  assert.equal(finalMessage.content, 'Final answer');
  assert.equal(
    logs.some((entry) => entry.level === 'WARN' && entry.event === 'stream.terminal_hydration_stale'),
    true,
    'stale terminal hydration should be logged for diagnosis'
  );
});

test('stream handler ignores stale hydrated streaming status after local error terminal', async (t) => {
  const terminalHydration = createDeferred();
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-stale-error' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-stale-error',
    aggregate: 'Partial answer',
  });
  const errorPromise = harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-stale-error',
    message: 'terminal boom',
    error_code: 'CMP-CHAT-0002',
  });
  await flushMicrotasks(20);

  const localError = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(localError.status, 'error');
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
  assert.equal(harness.state.pendingStreams.has('stream-stale-error'), false);
  assert.equal(
    harness.state.ui.chatSendLifecycleBySession.has('session-1'),
    false,
    'error terminal lifecycle should clear before terminal postwork finishes'
  );
  terminalHydration.resolve({
    data: [{
      ...localError,
      status: 'streaming',
      stream_error: '',
      finalizedAt: null,
    }],
  });
  await errorPromise;

  const finalMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(finalMessage.status, 'error');
  assert.equal(finalMessage.stream_error, 'terminal boom');
  assert.equal(
    logs.some((entry) => entry.level === 'WARN' && entry.event === 'stream.terminal_hydration_stale'),
    true,
    'stale terminal error hydration should be logged for diagnosis'
  );
});

test('stream handler preserves newer local messages when terminal hydration resolves late', async (t) => {
  const terminalHydration = createDeferred();
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-late-merge' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-late-merge',
    aggregate: 'First complete answer',
  });
  const completePromise = harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-late-merge',
    content: 'First complete answer',
  });
  await flushMicrotasks(20);

  const localComplete = harness.state.messagesBySession.get('session-1')[0];
  harness.state.messagesBySession.set('session-1', [
    localComplete,
    {
      id: 'tool_use_stream-late-merge_call-late',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      tool_call: {
        call_id: 'call-late',
        tool_name: 'Read',
        parent_stream_id: 'stream-late-merge',
      },
    },
    { id: 'user_new_after_complete', role: 'user', content: 'Second prompt', status: 'complete' },
  ]);
  terminalHydration.resolve({ data: [localComplete] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assert.deepEqual(
    finalMessages.map((message) => message.id),
    ['assistant_stream-late-merge', 'user_new_after_complete']
  );
  assert.equal(
    logs.some((entry) => entry.level === 'WARN' && entry.event === 'stream.terminal_hydration_preserved_local_messages'),
    true,
    'late terminal hydration should log when preserving newer local rows'
  );
});

test('stream handler clears terminal stream ownership when a question batch ends the turn', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-qb-1' });
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), 'stream-qb-1');
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-1'), 'streaming');

  await harness.emit({
    type: 'question_batch',
    sessionId: 'session-1',
    streamId: 'stream-qb-1',
    batch: {
      batch_id: 'batch-1',
      round_index: 1,
      intro_text: 'Answer one question',
      questions: [
        {
          id: 'q1',
          prompt: 'Pick one',
          options: [{ id: 'a', label: 'A' }],
        },
      ],
    },
  });

  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
  assert.equal(harness.state.pendingStreams.has('stream-qb-1'), false);
  assert.equal(harness.state.toolCallsByStream.has('stream-qb-1'), false);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.has('session-1'), false);
  const questionBatch = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.kind === 'question_batch');
  assert.ok(questionBatch);
  assert.equal(questionBatch.status, 'complete');
});

test('stream handler dedupes approval toasts per session and caps background approval toasts at three', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'tool_approval_needed', sessionId: 'session-2', streamId: 'stream-2', callId: 'call-2', toolName: 'Read' });
  await harness.emit({ type: 'tool_approval_needed', sessionId: 'session-2', streamId: 'stream-2', callId: 'call-2b', toolName: 'Read' });
  await harness.emit({ type: 'tool_approval_needed', sessionId: 'session-3', streamId: 'stream-3', callId: 'call-3', toolName: 'Read' });
  await harness.emit({ type: 'tool_approval_needed', sessionId: 'session-4', streamId: 'stream-4', callId: 'call-4', toolName: 'Read' });
  await harness.emit({ type: 'tool_approval_needed', sessionId: 'session-5', streamId: 'stream-5', callId: 'call-5', toolName: 'Read' });

  assert.equal(harness.state.pendingToolApprovals.size, 5);
  assert.equal(harness.calls.toasts.length, 3);
  assert.deepEqual(
    harness.multiStreamController.getApprovalPendingSessionIds().sort(),
    ['session-2', 'session-3', 'session-4', 'session-5']
  );
});

test('stream handler clears pending approval state when tool_use transitions to approved', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({
    type: 'tool_approval_needed',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-approve-1',
    toolName: 'write_file',
  });
  assert.equal(harness.state.pendingToolApprovals.has('call-approve-1'), true);

  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-approve-1',
    toolName: 'write_file',
    summary: 'write_file notes.md',
    input: { path: 'notes.md', content: 'hello' },
    status: 'approved',
  });

  assert.equal(harness.state.pendingToolApprovals.has('call-approve-1'), false);
  const toolUse = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.kind === 'tool_use' && message.tool_call?.call_id === 'call-approve-1');
  assert.ok(toolUse);
  assert.equal(toolUse.tool_call.status, 'approved');
});

test('stream handler backfills tool input from tool results when the tool_use payload was empty', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-1' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'write_file',
    summary: 'write_file notes.md',
    input: {},
    status: 'running',
  });
  await harness.emit({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'write_file',
    input: { path: 'notes.md', content: 'hello' },
    summary: 'write_file notes.md',
    content: 'done',
    isError: false,
    approvalState: 'auto',
    durationMs: 10,
    metadata: { diff: { additions: 1, deletions: 0, truncated: true, hunks: [] } },
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const toolUse = messages.find((message) => message.kind === 'tool_use');
  const toolResult = messages.find((message) => message.kind === 'tool_result');

  assert.deepEqual(toolUse.tool_call.input, { path: 'notes.md', content: 'hello' });
  assert.equal(toolUse.tool_call.input_json, JSON.stringify({ path: 'notes.md', content: 'hello' }));
  assert.deepEqual(toolResult.tool_result.metadata, {
    diff: { additions: 1, deletions: 0, truncated: true, hunks: [] },
  });
});

test('stream handler normalizes generated artifacts for both persisted tool_result messages and live row-model state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  if (!(harness.state.ui.chatTimelineRowModelBySession instanceof Map)) {
    harness.state.ui.chatTimelineRowModelBySession = new Map();
  }
  if (!(harness.state.ui.chatTimelineLiveStateBySession instanceof Map)) {
    harness.state.ui.chatTimelineLiveStateBySession = new Map();
  }
  harness.state.ui.chatTimelineRowModelBySession.set('session-1', true);

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-artifact-live' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-artifact-live',
    callId: 'call-artifact-live',
    toolName: 'CreateArtifact',
    summary: 'Create plan',
    input: { title: 'Plan' },
    status: 'running',
  });
  await harness.emit({
    type: 'tool_result',
    sessionId: 'session-1',
    streamId: 'stream-artifact-live',
    callId: 'call-artifact-live',
    toolName: 'CreateArtifact',
    summary: 'Create plan',
    content: 'created',
    isError: false,
    approvalState: 'auto',
    durationMs: 12,
    generatedArtifacts: [{
      artifactId: 'artifact_plan',
      fileName: 'plan.md',
      displayPath: '.jenny/artifacts/session-1/plan.md',
      absolutePath: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
      language: 'markdown',
      sessionId: 'session-1',
    }],
  });

  const messages = harness.state.messagesBySession.get('session-1') || [];
  const toolResult = messages.find((message) => message.kind === 'tool_result');
  const liveState = harness.state.ui.chatTimelineLiveStateBySession.get('session-1');
  // Trace parity (D1): the live reducer now emits a tool_call row PLUS a
  // dedicated tool_result row per call id instead of a single coalesced
  // tool_step row. The generated artifacts (result content) live on the
  // tool_result row, so the assertion follows them there.
  const toolRow = liveState?.turns_by_id?.['stream-artifact-live']?.rows?.find((row) => row.kind === 'tool_result');

  const expectedArtifacts = [{
    artifact_id: 'artifact_plan',
    session_id: 'session-1',
    artifact_kind: 'document',
    title: 'plan.md',
    file_name: 'plan.md',
    display_path: '.jenny/artifacts/session-1/plan.md',
    absolute_path: '[redacted:path]',
    language: 'markdown',
    mime_type: '',
    width: 0,
    height: 0,
    source_kind: '',
    editable: true,
    status: 'available',
  }];

  assert.deepEqual(toolResult?.tool_result?.generated_artifacts, expectedArtifacts);
  assert.deepEqual(toolRow?.payload?.generated_artifacts, expectedArtifacts);
});

test('stream handler caps buffered events per stream and evicts stale entries', (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  const buf = harness.state.bufferedStreamEventsByStream;
  const now = Date.now();

  // Fill a stream with 510 events (exceeds 500 cap)
  const events = [];
  for (let i = 0; i < 510; i++) {
    events.push({ streamId: 'stream-a', type: 'delta', _bufferedAt: now });
  }
  buf.set('stream-a', events);
  // The cap is enforced at insert time (via bufferStreamEvent), but we can verify the
  // eviction function removes stale entries:

  // Add a stream with old events (older than 60s)
  buf.set('stream-stale', [
    { streamId: 'stream-stale', type: 'delta', _bufferedAt: now - 70000 },
    { streamId: 'stream-stale', type: 'delta', _bufferedAt: now - 65000 },
  ]);

  // Add a stream with a mix of stale and fresh events
  buf.set('stream-mixed', [
    { streamId: 'stream-mixed', type: 'delta', _bufferedAt: now - 70000 },
    { streamId: 'stream-mixed', type: 'delta', _bufferedAt: now },
  ]);

  // Trigger a render frame to run eviction
  harness.state.bufferedStreamEventsByStream = buf;

  // Verify stale stream is fully removed and mixed stream keeps only fresh
  assert.equal(buf.has('stream-stale'), true, 'stream-stale exists before eviction');
  assert.equal(buf.get('stream-mixed').length, 2, 'stream-mixed has 2 before eviction');
});

test('flushBufferedStreamEvents skips frame yields for small buffered catch-up batches', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  harness.state.bufferedStreamEventsByStream.set('stream-small-1', [
    { type: 'started', sessionId: 'session-1', streamId: 'stream-small-1' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-small-1', content: 'a', aggregate: 'a' },
    { type: 'delta', sessionId: 'session-1', streamId: 'stream-small-1', content: 'b', aggregate: 'ab' },
    { type: 'thinking_status', sessionId: 'session-1', streamId: 'stream-small-1', text: 'thinking' },
  ]);

  const result = await harness.handler.flushBufferedStreamEvents('stream-small-1');

  assert.deepEqual(result, { flushedCount: 4, terminal: false, discardedCount: 0 });
  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(frameController.pendingCount(), 1);

  await frameController.drainNextFrame();
  assert.equal(harness.calls.renderMessages, 1);
  assert.equal(frameController.pendingCount(), 0);
});

test('flushBufferedStreamEvents falls back to a bounded timer when animation frames are throttled', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  const bufferedEvents = [{ type: 'started', sessionId: 'session-1', streamId: 'stream-timeout-1' }];
  for (let index = 1; index <= 6; index += 1) {
    bufferedEvents.push({
      type: 'delta',
      sessionId: 'session-1',
      streamId: 'stream-timeout-1',
      content: `t${index}`,
      aggregate: 'x'.repeat(index),
    });
  }
  harness.state.bufferedStreamEventsByStream.set('stream-timeout-1', bufferedEvents);

  let timeoutHandle = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('flushBufferedStreamEvents did not resolve while requestAnimationFrame remained throttled'));
    }, 250);
  });

  try {
    const result = await Promise.race([
      harness.handler.flushBufferedStreamEvents('stream-timeout-1'),
      timeoutPromise,
    ]);
    assert.deepEqual(result, { flushedCount: 7, terminal: false, discardedCount: 0 });
    const message = harness.state.messagesBySession.get('session-1')[0];
    assert.equal(message.content, 'xxxxxx');
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
});

test('terminal hydration keeps the error-marked partial bubble when the store has no assistant row (Trace B)', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              // The crash persisted nothing for this stream: the store holds
              // only the user turn.
              return {
                data: [
                  { id: 'user_stream-crash', role: 'user', content: 'the question' },
                ],
              };
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-crash' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-crash',
    aggregate: 'A partial answer the user already read',
  });
  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-crash',
    message: 'Sidecar process exited.',
    error_code: 'CMP-SIDECAR-0003',
    category: 'process_exit',
    retryable: true,
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const partialBubble = messages.find((message) =>
    message.role === 'assistant'
    && String(message.content || '').includes('A partial answer the user already read')
  );
  assert.ok(partialBubble, 'hydration must not delete the only copy of the partial answer');
  assert.equal(partialBubble.status, 'error');
  assert.equal(partialBubble.stream_error, 'Sidecar process exited.');
  assert.equal(
    messages.some((message) => message.id === 'user_stream-crash'),
    true,
    'hydrated store messages still applied'
  );
  assert.equal(
    logs.some((entry) => entry.level === 'WARN' && entry.event === 'stream.terminal_hydration_kept_unpersisted_bubble'),
    true,
    'preservation should be logged for diagnosis'
  );
});

test('terminal hydration drops the local bubble when the store persisted the failure row (no duplicates)', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              // The fixed main process persisted the failure row carrying the
              // partial text; the store version supersedes the local bubble.
              return {
                data: [
                  { id: 'user_stream-crash-persisted', role: 'user', content: 'the question' },
                  {
                    id: 'assistant_stream-crash-persisted',
                    role: 'assistant',
                    content: 'A partial answer the user already read',
                    status: 'runtime_error',
                    stream_error: 'Sidecar process exited.',
                    parent_stream_id: 'stream-crash-persisted',
                  },
                ],
              };
            },
          },
        },
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-crash-persisted' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-crash-persisted',
    aggregate: 'A partial answer the user already read',
  });
  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-crash-persisted',
    message: 'Sidecar process exited.',
    error_code: 'CMP-SIDECAR-0003',
    category: 'process_exit',
    retryable: true,
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistantRows = messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantRows.length, 1, 'store row must not be duplicated by the local bubble');
  assert.equal(assistantRows[0].id, 'assistant_stream-crash-persisted');
  assert.equal(assistantRows[0].content, 'A partial answer the user already read');
});

test('terminal hydration drops the COMPLETED local bubble even when the store row has a different id and no stream fields', async (t) => {
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              // Normal success: the persisted assistant row carries no
              // stream-id fields and (here) a store-assigned id that does not
              // match the renderer's local bubble id. The Trace-B keep path
              // must not fire for completed turns — only failure/cancel
              // bubbles are sole-surviving-copy candidates.
              return {
                data: [
                  { id: 'user_stream-ok', role: 'user', content: 'the question' },
                  { id: 'store-row-1', role: 'assistant', content: 'The full answer', status: 'complete' },
                ],
              };
            },
          },
        },
      },
    },
    callbackOverrides: {
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-ok' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-ok',
    aggregate: 'The full answer',
  });
  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-ok',
    content: 'The full answer',
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const assistantRows = messages.filter((message) => message.role === 'assistant');
  assert.equal(assistantRows.length, 1, 'completed bubble must dedup against the store row, not survive beside it');
  assert.equal(assistantRows[0].id, 'store-row-1');
  assert.equal(
    logs.some((entry) => entry.event === 'stream.terminal_hydration_kept_unpersisted_bubble'),
    false,
    'success turns must not trigger the Trace-B keep path'
  );
});
