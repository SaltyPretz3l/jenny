const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../../services/backend/backend-service');
const { createFakeSafeStorage } = require('../helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  markManagedSidecarReady,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function waitForTerminalEvent(service) {
  return new Promise((resolve) => {
    const listener = (event) => {
      if (event?.type !== 'complete' && event?.type !== 'error') {
        return;
      }
      service.off('chat-stream', listener);
      resolve(event);
    };
    service.on('chat-stream', listener);
  });
}

async function createManagedBackend({
  featureFlags = {},
  title = 'Managed tool execution',
  toolExecutor = null,
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-tool-execution-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
    featureFlags,
    toolExecutor,
  });
  markManagedSidecarReady(service);
  service._resolveModel = async () => 'mock-v1';
  const created = await service.createSession({
    title,
    preferences: {
      context_preferences: { include_memory: false },
    },
  });
  return { service, sessionId: created.data.id };
}

function installChatSend(service, chatSend) {
  service.sidecarClient = {
    connected: true,
    async request(method) {
      throw new Error(`Unexpected sidecar request: ${method}`);
    },
    chatSend,
  };
}

function chatEvents(service) {
  const events = [];
  service.on('chat-stream', (event) => events.push(event));
  return events;
}

test('managed BackendService persists a single tool round trip with exact ids and final text', async () => {
  const { service, sessionId } = await createManagedBackend();
  const events = chatEvents(service);
  installChatSend(service, async (_params, { onNotification }) => {
    onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_single',
        tool_name: 'read_file',
        tool_input: { path: 'src/app.js' },
      },
    });
    onNotification({
      method: 'tool.result',
      params: {
        tool_call_id: 'call_single',
        tool_name: 'read_file',
        tool_input: { path: 'src/app.js' },
        output: '1  const x = 1;',
        success: true,
      },
    });
    onNotification({ method: 'chat.token', params: { delta: 'File contents: hello world.' } });
    onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({ sessionId, prompt: 'Read app.js' });
  const terminal = await terminalPromise;
  const persisted = await service.getSessionMessages(sessionId);
  const toolMessages = persisted.data.filter((message) => (
    message.kind === 'tool_use' || message.kind === 'tool_result'
  ));

  assert.equal(terminal.type, 'complete');
  assert.equal(terminal.content, 'File contents: hello world.');
  assert.deepEqual(toolMessages.map((message) => ({
    id: message.id,
    role: message.role,
    kind: message.kind,
    callId: message.tool_call?.call_id || message.tool_result?.call_id,
    toolName: message.tool_call?.tool_name || message.tool_result?.tool_name,
    status: message.tool_call?.status || (message.tool_result?.is_error ? 'error' : 'completed'),
    parentStreamId: message.tool_call?.parent_stream_id || message.tool_result?.parent_stream_id,
  })), [
    {
      id: `tool_use_${stream.streamId}_call_single`,
      role: 'assistant',
      kind: 'tool_use',
      callId: 'call_single',
      toolName: 'read_file',
      status: 'completed',
      parentStreamId: stream.streamId,
    },
    {
      id: `tool_result_${stream.streamId}_call_single`,
      role: 'tool',
      kind: 'tool_result',
      callId: 'call_single',
      toolName: 'read_file',
      status: 'completed',
      parentStreamId: stream.streamId,
    },
  ]);
  assert.deepEqual(
    persisted.turn_events
      .filter((event) => event.kind === 'tool_use' || event.kind === 'tool_result')
      .map((event) => [event.kind, event.tool_call_id, event.status]),
    [
      ['tool_use', 'call_single', 'running'],
      ['tool_result', 'call_single', 'completed'],
    ]
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_use' || event.type === 'tool_result')
      .map((event) => [event.type, event.callId, event.toolName]),
    [
      ['tool_use', 'call_single', 'read_file'],
      ['tool_result', 'call_single', 'read_file'],
    ]
  );
  const assistant = persisted.data.find((message) => message.id === `assistant_${stream.streamId}`);
  assert.equal(assistant?.content, 'File contents: hello world.');
});

test('managed BackendService preserves generated artifacts in persistence and stream output', async () => {
  const { service, sessionId } = await createManagedBackend();
  const events = chatEvents(service);
  const artifact = {
    artifact_id: 'artifact_managed_plan',
    artifact_kind: 'document',
    title: 'Scratch Plan',
    file_name: 'plan.md',
    display_path: '.jenny/artifacts/session-1/plan.md',
    absolute_path: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
    language: 'markdown',
    editable: true,
    status: 'available',
  };
  installChatSend(service, async (_params, { onNotification }) => {
    onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_artifact',
        tool_name: 'create_artifact',
        tool_input: { title: 'Scratch Plan' },
      },
    });
    onNotification({
      method: 'tool.result',
      params: {
        tool_call_id: 'call_artifact',
        tool_name: 'create_artifact',
        output: 'artifact created',
        success: true,
        generated_artifacts: [artifact],
      },
    });
    onNotification({ method: 'chat.token', params: { delta: 'Created the plan.' } });
    onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({ sessionId, prompt: 'Create a scratch plan' });
  await terminalPromise;
  const persisted = await service.getSessionMessages(sessionId);
  const resultMessage = persisted.data.find((message) => message.kind === 'tool_result');
  const streamResult = events.find((event) => event.type === 'tool_result');
  const turnResult = persisted.turn_events.find((event) => event.kind === 'tool_result');
  const expectedArtifact = {
    artifact_id: 'artifact_managed_plan',
    artifact_kind: 'document',
    title: 'Scratch Plan',
    file_name: 'plan.md',
    display_path: '.jenny/artifacts/session-1/plan.md',
    absolute_path: '[redacted:path]',
    language: 'markdown',
    mime_type: '',
    width: 0,
    height: 0,
    editable: true,
    status: 'available',
  };

  assert.deepEqual(resultMessage.tool_result.generated_artifacts, [expectedArtifact]);
  assert.deepEqual(streamResult.generatedArtifacts, [expectedArtifact]);
  assert.deepEqual(turnResult.payload.generated_artifacts, [{
    ...expectedArtifact,
    tool_call_id: 'call_artifact',
  }]);
  assert.equal(resultMessage.tool_result.call_id, 'call_artifact');
  assert.equal(resultMessage.tool_result.parent_stream_id, stream.streamId);
});

test('managed BackendService persists the user message before approval pauses the turn', async () => {
  const { service, sessionId } = await createManagedBackend();
  const approvalReached = deferred();
  installChatSend(service, async (_params, options) => {
    const approvalPromise = options.onApprovalRequest({
      tool_call_id: 'call_approval',
      tool_name: 'write_file',
      tool_input: { path: 'notes.txt', content: 'approved content' },
    });
    approvalReached.resolve();
    const approved = await approvalPromise;
    assert.equal(approved, true);
    options.onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_approval',
        tool_name: 'write_file',
        tool_input: { path: 'notes.txt', content: 'approved content' },
      },
    });
    options.onNotification({
      method: 'tool.result',
      params: {
        tool_call_id: 'call_approval',
        tool_name: 'write_file',
        output: 'wrote notes.txt',
        success: true,
      },
    });
    options.onNotification({ method: 'chat.token', params: { delta: 'Saved.' } });
    options.onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({
    sessionId,
    prompt: 'Write the approved note',
  });
  await approvalReached.promise;
  const duringApproval = await service.getSessionMessages(sessionId);

  assert.deepEqual(duringApproval.data.map((message) => ({
    id: message.id,
    role: message.role,
    kind: message.kind || '',
    content: message.content,
    callId: message.tool_call?.call_id || '',
    status: message.tool_call?.status || '',
  })), [
    {
      id: `user_${stream.streamId}`,
      role: 'user',
      kind: '',
      content: 'Write the approved note',
      callId: '',
      status: '',
    },
    {
      id: `tool_use_${stream.streamId}_call_approval`,
      role: 'assistant',
      kind: 'tool_use',
      content: 'Write notes.txt',
      callId: 'call_approval',
      status: 'pending_approval',
    },
  ]);
  const pending = [...service.pendingToolApprovals.values()].find(
    (entry) => entry.callId === 'call_approval' && entry.streamId === stream.streamId
  );
  assert.ok(pending);
  pending.resolve(true, 'approved');
  await terminalPromise;

  const settled = await service.getSessionMessages(sessionId);
  assert.deepEqual(
    settled.turn_events
      .filter((event) => event.kind === 'approval_requested' || event.kind === 'approval_resolved')
      .map((event) => [event.kind, event.tool_call_id, event.status]),
    [
      ['approval_requested', 'call_approval', 'approval_pending'],
      ['approval_resolved', 'call_approval', 'completed'],
    ]
  );
});

test('managed ask policy surfaces approval for a read-only tool before execution', async () => {
  const { service, sessionId } = await createManagedBackend();
  const events = chatEvents(service);
  const approvalReached = deferred();
  installChatSend(service, async (_params, options) => {
    const approvalPromise = options.onApprovalRequest({
      tool_call_id: 'call_read_ask',
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
      policy_decision_id: 'decision_read_ask',
      policy_scope: 'Workspace files',
      policy_consequence: 'May read data in this scope.',
    });
    approvalReached.resolve();
    assert.equal(await approvalPromise, false);
    options.onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({
    sessionId,
    prompt: 'Read README.md after asking',
  });
  await approvalReached.promise;
  const duringApproval = await service.getSessionMessages(sessionId);

  assert.deepEqual(
    duringApproval.data
      .filter((message) => message.kind === 'tool_use')
      .map((message) => ({
        id: message.id,
        callId: message.tool_call.call_id,
        toolName: message.tool_call.tool_name,
        status: message.tool_call.status,
        approvalState: message.tool_call.approval_state,
      })),
    [{
      id: `tool_use_${stream.streamId}_call_read_ask`,
      callId: 'call_read_ask',
      toolName: 'read_file',
      status: 'pending_approval',
      approvalState: 'pending',
    }]
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_use' || event.type === 'tool_approval_needed')
      .map((event) => [event.type, event.callId, event.toolName, event.status || '', event.policy || '']),
    [
      ['tool_use', 'call_read_ask', 'read_file', 'pending_approval', ''],
      ['tool_approval_needed', 'call_read_ask', 'read_file', '', 'ask'],
    ]
  );
  assert.equal(
    events.some((event) => event.type === 'tool_use' && event.status === 'running'),
    false
  );

  const pending = [...service.pendingToolApprovals.values()].find(
    (entry) => entry.callId === 'call_read_ask' && entry.streamId === stream.streamId
  );
  assert.ok(pending);
  pending.resolve(false, 'denied');
  await terminalPromise;
});

test('managed BackendService persists sequential tool results in notification order', async () => {
  const { service, sessionId } = await createManagedBackend();
  installChatSend(service, async (_params, { onNotification }) => {
    for (const [callId, fileName] of [
      ['call_first', 'first.txt'],
      ['call_second', 'second.txt'],
    ]) {
      onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: callId,
          tool_name: 'read_file',
          tool_input: { path: fileName },
        },
      });
      onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: callId,
          tool_name: 'read_file',
          tool_input: { path: fileName },
          output: `contents of ${fileName}`,
          success: true,
        },
      });
    }
    onNotification({ method: 'chat.token', params: { delta: 'Read both files.' } });
    onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  await service.startChatStream({ sessionId, prompt: 'Read both files' });
  await terminalPromise;
  const persisted = await service.getSessionMessages(sessionId);

  assert.deepEqual(
    persisted.data
      .filter((message) => message.kind === 'tool_result')
      .map((message) => [
        message.tool_result.call_id,
        message.tool_result.output_text,
        message.tool_result.is_error,
      ]),
    [
      ['call_first', 'contents of first.txt', false],
      ['call_second', 'contents of second.txt', false],
    ]
  );
  assert.deepEqual(
    persisted.turn_events
      .filter((event) => event.kind === 'tool_result')
      .map((event) => [event.tool_call_id, event.payload.output_text]),
    [
      ['call_first', 'contents of first.txt'],
      ['call_second', 'contents of second.txt'],
    ]
  );
});

test('managed cancellation interrupts the current tool, blocks later activity, and cancels pending executor work', async () => {
  const cancelCalls = [];
  const toolExecutor = {
    cancelPendingForStream(streamId) {
      cancelCalls.push(streamId);
    },
  };
  const { service, sessionId } = await createManagedBackend({ toolExecutor });
  const events = chatEvents(service);
  const firstToolStarted = deferred();
  installChatSend(service, async (_params, options) => {
    options.onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_interrupted',
        tool_name: 'read_file',
        tool_input: { path: 'first.txt' },
      },
    });
    firstToolStarted.resolve();
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    });
    options.onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_must_not_run',
        tool_name: 'read_file',
        tool_input: { path: 'second.txt' },
      },
    });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({ sessionId, prompt: 'Read both, then cancel' });
  await firstToolStarted.promise;
  assert.equal(service.cancelChatStream(stream.streamId), true);
  const terminal = await terminalPromise;
  const persisted = await service.getSessionMessages(sessionId);

  assert.deepEqual(cancelCalls, [stream.streamId]);
  assert.deepEqual(
    persisted.data
      .filter((message) => message.kind === 'tool_use' || message.kind === 'tool_result')
      .map((message) => [
        message.kind,
        message.tool_call?.call_id || message.tool_result?.call_id,
        message.tool_call?.status || message.tool_result?.metadata?.terminal_state,
      ]),
    [
      ['tool_use', 'call_interrupted', 'interrupted'],
      ['tool_result', 'call_interrupted', 'interrupted'],
    ]
  );
  assert.equal(persisted.data.some((message) => JSON.stringify(message).includes('call_must_not_run')), false);
  assert.equal(events.some((event) => event.callId === 'call_must_not_run'), false);
  assert.deepEqual({
    type: terminal.type,
    status: terminal.status,
    terminalSubcode: terminal.terminal_subcode,
    cancelReason: terminal.cancel_reason,
  }, {
    type: 'error',
    status: 'cancelled',
    terminalSubcode: 'user_cancel',
    cancelReason: 'user_cancel',
  });
});

test('managed mixed text and tool calls retain the preamble before final answer text', async () => {
  const { service, sessionId } = await createManagedBackend({
    featureFlags: { response_loop_display_v2: true },
  });
  const events = chatEvents(service);
  installChatSend(service, async (_params, { onNotification }) => {
    onNotification({ method: 'chat.token', params: { delta: 'Some text ' } });
    onNotification({
      method: 'tool.executing',
      params: {
        tool_call_id: 'call_mixed',
        tool_name: 'read_file',
        tool_input: { path: 'mixed.txt' },
      },
    });
    onNotification({
      method: 'tool.result',
      params: {
        tool_call_id: 'call_mixed',
        tool_name: 'read_file',
        output: 'mixed contents',
        success: true,
      },
    });
    onNotification({
      method: 'chat.stream_reset',
      params: { reason: 'tool_continuation' },
    });
    onNotification({ method: 'chat.token', params: { delta: 'Final answer.' } });
    onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
    return { status: 'completed' };
  });

  const terminalPromise = waitForTerminalEvent(service);
  const stream = await service.startChatStream({ sessionId, prompt: 'Trigger mixed output' });
  const terminal = await terminalPromise;
  const persisted = await service.getSessionMessages(sessionId);
  const assistantText = persisted.data
    .filter((message) => message.role === 'assistant' && !message.kind)
    .map((message) => [message.id, message.content]);

  assert.equal(terminal.content, 'Final answer.');
  assert.deepEqual(
    events
      .filter((event) => event.type === 'delta' || event.type === 'stream_reset')
      .map((event) => event.type === 'delta'
        ? [event.type, event.content]
        : [
            event.type,
            event.reason,
            event.preserve_prior_segments,
            event.discard_scope,
          ]),
    [
      ['delta', 'Some text '],
      ['stream_reset', 'tool_continuation', true, 'none'],
      ['delta', 'Final answer.'],
    ]
  );
  assert.deepEqual(assistantText, [
    [`assistant_${stream.streamId}_seg0`, 'Some text '],
    [`assistant_${stream.streamId}_seg1`, 'Final answer.'],
  ]);
  assert.deepEqual(
    persisted.data
      .filter((message) => message.kind === 'tool_result')
      .map((message) => message.tool_result.call_id),
    ['call_mixed']
  );
});
