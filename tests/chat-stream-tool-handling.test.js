const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const {
  normalizeExternalPayloadsFromNotification,
  normalizeGeneratedArtifactsFromNotification,
  handleToolNotification,
  settleUnfinishedToolsForStream,
  settlePendingApprovalsForStream,
} = require('../services/backend/chat-stream-tool-handling');
const {
  resolveToolResultStatus,
} = require('../services/backend/chat-stream-terminal-utils');
const {
  attachWorkspaceIdentityToCanonicalEvent,
  workspaceIdentityForDiffMetadata,
} = require('../services/backend/chat-stream-tool-payload-utils');
const { workspaceRootId } = require('../services/workspace-root-identity');

/* ---- D1: path traversal validation ---- */

test('normalizeGeneratedArtifactsFromNotification filters entries with traversal in absolute_path', () => {
  const result = normalizeGeneratedArtifactsFromNotification([
    {
      artifact_id: 'a1',
      title: 'Safe File',
      file_name: 'safe.txt',
      display_path: 'src/safe.txt',
      absolute_path: '/home/user/src/safe.txt',
    },
    {
      artifact_id: 'a2',
      title: 'Traversal File',
      file_name: 'etc-passwd',
      display_path: 'src/etc-passwd',
      absolute_path: '../../etc/passwd',
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].artifact_id, 'a1');
});

test('normalizeGeneratedArtifactsFromNotification filters entries with null bytes', () => {
  const result = normalizeGeneratedArtifactsFromNotification([
    {
      artifact_id: 'a3',
      title: 'Null Byte File',
      file_name: 'foo.txt',
      display_path: 'foo\0bar',
      absolute_path: '/home/user/foo.txt',
    },
  ]);
  assert.equal(result.length, 0);
});

test('normalizeGeneratedArtifactsFromNotification allows normal paths', () => {
  const result = normalizeGeneratedArtifactsFromNotification([
    {
      artifact_id: 'a4',
      title: 'Normal',
      file_name: 'index.js',
      display_path: 'src/index.js',
      absolute_path: '/project/src/index.js',
    },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].file_name, 'index.js');
});

test('normalizeGeneratedArtifactsFromNotification returns empty for non-array', () => {
  assert.deepEqual(normalizeGeneratedArtifactsFromNotification(null), []);
  assert.deepEqual(normalizeGeneratedArtifactsFromNotification('hello'), []);
  assert.deepEqual(normalizeGeneratedArtifactsFromNotification(42), []);
});

test('normalizeExternalPayloadsFromNotification accepts paths inside managed payload root', () => {
  const userDataPath = path.join(os.tmpdir(), 'jenny-sidecar-tool-handling');
  const safePath = path.join(userDataPath, 'background-memory', 'ipc-payloads', 'payload-1.json');
  const normalized = normalizeExternalPayloadsFromNotification(
    {
      output: {
        path: safePath,
        bytes: 1200,
      },
    },
    { options: { userDataPath } }
  );

  assert.deepEqual(normalized, {
    output: {
      path: 'payload-1.json',
      bytes: 1200,
      encoding: 'utf-8',
      format: 'json',
    },
  });
});

test('normalizeExternalPayloadsFromNotification rejects paths outside managed payload root', () => {
  const userDataPath = path.join(os.tmpdir(), 'jenny-sidecar-tool-handling');
  const outsidePath = path.join(os.tmpdir(), 'other-root', 'payload-1.json');
  const normalized = normalizeExternalPayloadsFromNotification(
    {
      output: {
        path: outsidePath,
        bytes: 1200,
      },
    },
    { options: { userDataPath } }
  );

  assert.deepEqual(normalized, {});
});

test('diff metadata receives a trusted workspace identity without accepting a supplied identity', () => {
  const root = path.join(os.tmpdir(), 'jenny-diff-origin');
  const service = {
    configService: {
      getState: () => ({ toolsWorkspaceRoot: root }),
    },
  };
  assert.deepEqual(
    workspaceIdentityForDiffMetadata(service, {
      workspace_id: 'root_aaaaaaaaaaaaaaaaaaaaaaaa',
      diff: { path: 'src/app.js' },
    }),
    { workspace_id: workspaceRootId(root) }
  );
  const originalRoot = path.join(os.tmpdir(), 'jenny-original-diff-origin');
  assert.deepEqual(
    workspaceIdentityForDiffMetadata(service, { diff: {} }, originalRoot),
    { workspace_id: workspaceRootId(originalRoot) },
    'request-scoped origin wins if config changes before the result arrives'
  );
  assert.deepEqual(workspaceIdentityForDiffMetadata(service, { changed: true }), {});
  assert.deepEqual(workspaceIdentityForDiffMetadata({}, { diff: { path: 'src/app.js' } }), {});
});

test('canonical diff events are cloned and stamped with the trusted workspace identity', () => {
  const root = path.join(os.tmpdir(), 'jenny-canonical-diff-origin');
  const original = {
    type: 'tool_execution_completed',
    payload: { metadata: { diff: { path: 'src/app.js' } } },
  };
  const stamped = attachWorkspaceIdentityToCanonicalEvent(original, {
    configService: { getToolsWorkspaceRoot: () => root },
  });

  assert.equal(stamped.payload.metadata.workspace_id, workspaceRootId(root));
  assert.equal(Object.hasOwn(original.payload.metadata, 'workspace_id'), false);
});

test('settlePendingApprovalsForStream repairs stale pending tool_use rows without matching results', () => {
  const sessionMessages = [{
    id: 'tool_use_call-a',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-a',
      tool_name: 'write_file',
      input: { path: 'a.txt' },
      summary: 'write_file a.txt',
      status: 'pending_approval',
      approval_state: 'pending',
      parent_stream_id: 'stream-1',
    },
  }, {
    id: 'tool_use_call-b',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-b',
      tool_name: 'write_file',
      input: { path: 'b.txt' },
      summary: 'write_file b.txt',
      status: 'pending_approval',
      approval_state: 'pending',
      parent_stream_id: 'stream-1',
    },
  }, {
    id: 'tool_result_call-b',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-b',
      tool_name: 'write_file',
      output_text: 'ok',
      is_error: false,
      parent_stream_id: 'stream-1',
    },
  }];

  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return sessionMessages;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = sessionMessages.findIndex((message) => message.id === messageId);
        if (index === -1) return;
        sessionMessages[index] = { ...sessionMessages[index], ...patch };
      },
    },
    pendingToolApprovals: new Map([
      ['call-a', {
        streamId: 'stream-1',
        resolve() {},
      }],
    ]),
    emit() {},
    currentModel: 'test-model',
  };

  const repaired = settlePendingApprovalsForStream(mockService, 'session-1', 'stream-1', 'cancelled');
  assert.equal(repaired, 1);
  assert.equal(mockService.pendingToolApprovals.size, 0);
  assert.equal(sessionMessages[0].tool_call.status, 'cancelled');
  assert.equal(sessionMessages[0].tool_call.approval_state, 'cancelled');
  assert.equal(sessionMessages[1].tool_call.status, 'pending_approval');
});

test('settlePendingApprovalsForStream scopes completed calls to the current stream', () => {
  const sessionMessages = [{
    id: 'tool_result_reused-old',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-reused',
      tool_name: 'write_file',
      output_text: 'old result',
      is_error: false,
      parent_stream_id: 'stream-old',
    },
  }, {
    id: 'tool_use_reused-current',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-reused',
      tool_name: 'write_file',
      input: { path: 'current.txt' },
      summary: 'write_file current.txt',
      status: 'pending_approval',
      approval_state: 'pending',
      parent_stream_id: 'stream-current',
    },
  }];

  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return sessionMessages;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = sessionMessages.findIndex((message) => message.id === messageId);
        if (index === -1) return;
        sessionMessages[index] = { ...sessionMessages[index], ...patch };
      },
    },
    pendingToolApprovals: new Map(),
    emit() {},
    currentModel: 'test-model',
  };

  const repaired = settlePendingApprovalsForStream(
    mockService,
    'session-reused',
    'stream-current',
    'cancelled'
  );

  assert.equal(repaired, 1);
  assert.equal(sessionMessages[1].tool_call.status, 'cancelled');
  assert.equal(sessionMessages[1].tool_call.approval_state, 'cancelled');
});

test('settlePendingApprovalsForStream can repair stale pending tool_use rows as timeout', () => {
  const sessionMessages = [{
    id: 'tool_use_call-timeout',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-timeout',
      tool_name: 'write_file',
      input: { path: 'timeout.txt' },
      summary: 'write_file timeout.txt',
      status: 'pending_approval',
      approval_state: 'pending',
      parent_stream_id: 'stream-timeout',
    },
  }];

  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return sessionMessages;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = sessionMessages.findIndex((message) => message.id === messageId);
        if (index === -1) return;
        sessionMessages[index] = { ...sessionMessages[index], ...patch };
      },
    },
    pendingToolApprovals: new Map(),
    emit() {},
    currentModel: 'test-model',
  };

  const repaired = settlePendingApprovalsForStream(
    mockService,
    'session-timeout',
    'stream-timeout',
    'timeout'
  );

  assert.equal(repaired, 1);
  assert.equal(sessionMessages[0].tool_call.status, 'timeout');
  assert.equal(sessionMessages[0].tool_call.approval_state, 'timeout');
});

test('settleUnfinishedToolsForStream repairs running tool_use rows with synthetic interrupted result', () => {
  const sessionMessages = [{
    id: 'tool_use_call-running',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-running',
      tool_name: 'inspect_harness',
      input: { sections: ['tools'] },
      summary: 'Inspect Harness',
      status: 'running',
      approval_state: 'auto',
      parent_stream_id: 'stream-running',
    },
  }];
  const emitted = [];
  const turnEvents = [];
  const toolObservabilityCalls = [];
  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return sessionMessages;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = sessionMessages.findIndex((message) => message.id === messageId);
        if (index === -1) return;
        sessionMessages[index] = { ...sessionMessages[index], ...patch };
      },
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
      },
    },
    emit(eventName, payload) {
      emitted.push({ eventName, payload });
    },
    toolObservabilityAggregator: {
      recordToolResult(payload) {
        toolObservabilityCalls.push(payload);
        return true;
      },
    },
    _emitServiceLog() {},
    currentModel: 'test-model',
  };

  const repaired = settleUnfinishedToolsForStream(mockService, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-running',
    streamId: 'stream-running',
    eventBase: {
      streamId: 'stream-running',
      sessionId: 'session-running',
      model: 'test-model',
    },
    turnEventCollector: {
      noteEvent(event) {
        turnEvents.push(event);
      },
    },
  });

  assert.equal(repaired.length, 1);
  assert.equal(sessionMessages[0].tool_call.status, 'interrupted');
  const syntheticResult = sessionMessages.find(
    (message) => String(message.kind || '') === 'tool_result'
  );
  assert.ok(syntheticResult);
  assert.equal(syntheticResult.tool_result.call_id, 'call-running');
  assert.equal(syntheticResult.tool_result.is_error, true);
  assert.equal(syntheticResult.tool_result.error_code, 'CMP-LOOP-0013');
  assert.equal(turnEvents[0].kind, 'tool_result');
  assert.equal(
    turnEvents[0].payload.promoted_observations[0].event_type,
    'tool.cancelled'
  );
  assert.equal(
    turnEvents[0].payload.promoted_observations[0].source,
    'electron_orphan_repair'
  );
  assert.equal(
    turnEvents[0].payload.promoted_observations[0].observation_id,
    'stream-running:electron_orphan_repair:call-running'
  );
  assert.equal(toolObservabilityCalls.length, 1);
  assert.equal(toolObservabilityCalls[0].callId, 'call-running');
  assert.equal(toolObservabilityCalls[0].toolName, 'inspect_harness');
  assert.equal(toolObservabilityCalls[0].success, false);
  assert.equal(toolObservabilityCalls[0].errorCode, 'CMP-LOOP-0013');
  assert.equal(toolObservabilityCalls[0].terminalState, 'interrupted');
  assert.equal(emitted.some((entry) => entry.payload?.type === 'tool_result'), true);
});

test('settleUnfinishedToolsForStream scopes completed calls to the current stream', () => {
  const sessionMessages = [{
    id: 'tool_result_reused-old',
    kind: 'tool_result',
    tool_result: {
      call_id: 'call-reused',
      tool_name: 'inspect_harness',
      output_text: 'old result',
      parent_stream_id: 'stream-old',
    },
  }, {
    id: 'tool_use_reused-current',
    kind: 'tool_use',
    tool_call: {
      call_id: 'call-reused',
      tool_name: 'inspect_harness',
      input: { sections: ['tools'] },
      summary: 'Inspect Harness',
      status: 'running',
      approval_state: 'auto',
      parent_stream_id: 'stream-current',
    },
  }];
  const mockService = {
    sessionStore: {
      getSessionMessages() {
        return sessionMessages;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = sessionMessages.findIndex((message) => message.id === messageId);
        if (index === -1) return;
        sessionMessages[index] = { ...sessionMessages[index], ...patch };
      },
      appendMessage(_sessionId, message) {
        sessionMessages.push(message);
      },
    },
    emit() {},
    _emitServiceLog() {},
    currentModel: 'test-model',
  };

  const repaired = settleUnfinishedToolsForStream(mockService, {
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-reused',
    streamId: 'stream-current',
    eventBase: {
      streamId: 'stream-current',
      sessionId: 'session-reused',
      model: 'test-model',
    },
  });

  assert.equal(repaired.length, 1);
  assert.equal(sessionMessages[1].tool_call.status, 'interrupted');
});

test('handleToolNotification upserts repeated tool.result events by call_id', () => {
  const messagesBySession = new Map([['session-1', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };

  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-1',
    streamId: 'stream-1',
    eventBase: { sessionId: 'session-1', streamId: 'stream-1', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-upsert-1',
      tool_name: 'read_file',
      success: true,
      output: 'first output',
      tool_input: { path: 'README.md' },
    },
  });
  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-upsert-1',
      tool_name: 'read_file',
      success: true,
      output: 'second output',
      tool_input: { path: 'README.md' },
    },
  });

  const messages = sessionStore.getSessionMessages('session-1');
  const toolResults = messages.filter((message) => String(message.kind || '') === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].tool_result.call_id, 'call-upsert-1');
  assert.equal(toolResults[0].tool_result.output_text, 'second output');
});

test('handleToolNotification resolves a historical unscoped persisted tool_result id', () => {
  const updates = [];
  const appends = [];
  const service = {
    sessionStore: {
      getSessionMessages: () => [{
        id: 'tool_result_call_legacy',
        kind: 'tool_result',
        tool_result: { call_id: 'call_legacy', parent_stream_id: 'stream_legacy' },
      }],
      updateMessage: (sessionId, messageId) => updates.push({ sessionId, messageId }),
      appendMessage: (...args) => appends.push(args),
    },
    emit() {},
  };

  const handled = handleToolNotification(service, {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock:model',
    resolvedSessionId: 'sess_legacy',
    streamId: 'stream_legacy',
    eventBase: { sessionId: 'sess_legacy', streamId: 'stream_legacy' },
  }, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call_legacy',
      tool_name: 'Read',
      tool_input: {},
      output: 'legacy output',
      success: true,
      metadata: {},
    },
  });

  assert.equal(handled, true);
  assert.deepEqual(updates, [{ sessionId: 'sess_legacy', messageId: 'tool_result_call_legacy' }]);
  assert.deepEqual(appends, []);
});

test('handleToolNotification redacts sensitive-looking input values before persistence', () => {
  const messagesBySession = new Map([['session-redact-input', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-redact-input',
    streamId: 'stream-redact-input',
    eventBase: { sessionId: 'session-redact-input', streamId: 'stream-redact-input', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.executing',
    params: {
      tool_call_id: 'call-redact-input',
      tool_name: 'read_file',
      tool_input: {
        path: 'C:/Users/demo/private/notes.txt',
        note: 'temporary value sk-managedsecret1234567890 should not persist',
        token: 'super-secret-token',
      },
    },
  });

  const messages = sessionStore.getSessionMessages('session-redact-input');
  assert.equal(messages.length, 1);
  const serialized = JSON.stringify(messages[0]);
  assert.equal(serialized.includes('C:/Users/demo/private/notes.txt'), false);
  assert.equal(serialized.includes('sk-managedsecret1234567890'), false);
  assert.equal(serialized.includes('super-secret-token'), false);
  assert.equal(messages[0].tool_call.input.token, '[redacted]');
  assert.match(messages[0].tool_call.input.note, /\[redacted\]/);
});

test('handleToolNotification restores trusted local artifact paths with session scope only from bridge state', () => {
  const messagesBySession = new Map([['session-artifact', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
    _electronToolGeneratedArtifactsByCall: new Map([[
      'stream-artifact|call-artifact',
      [{
        artifact_id: 'artifact-image-1',
        display_path: '.jenny/artifacts/session-artifact/capture.png',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-artifact/capture.png',
      }],
    ]]),
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-artifact',
    streamId: 'stream-artifact',
    eventBase: { sessionId: 'session-artifact', streamId: 'stream-artifact', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      request_id: 'stream-artifact',
      tool_call_id: 'call-artifact',
      tool_name: 'worktree_list',
      success: true,
      output: 'captured',
      generated_artifacts: [{
        artifact_id: 'artifact-image-1',
        artifact_kind: 'image',
        title: 'Capture',
        file_name: 'capture.png',
        display_path: '.jenny/artifacts/session-artifact/capture.png',
        mime_type: 'image/png',
      }],
    },
  });

  const [toolResult] = sessionStore.getSessionMessages('session-artifact')
    .filter((message) => String(message.kind || '') === 'tool_result');
  assert.equal(toolResult.tool_result.generated_artifacts[0].absolute_path, '[redacted:path]');
  assert.equal(
    toolResult.tool_result.generated_artifacts[0].absolute_path.includes('C:/workspace'),
    false
  );
  assert.equal(toolResult.tool_result.generated_artifacts[0].local_trusted, true);
  assert.equal(toolResult.tool_result.generated_artifacts[0].session_id, 'session-artifact');
  assert.equal(service._electronToolGeneratedArtifactsByCall.size, 0);
});

test('handleToolNotification preserves explicit untrusted local artifact markers', () => {
  const messagesBySession = new Map([['session-untrusted-artifact', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-untrusted-artifact',
    streamId: 'stream-untrusted-artifact',
    eventBase: {
      sessionId: 'session-untrusted-artifact',
      streamId: 'stream-untrusted-artifact',
      model: 'mock-model',
    },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      request_id: 'stream-untrusted-artifact',
      tool_call_id: 'call-untrusted-artifact',
      tool_name: 'mermaid_generate',
      success: true,
      output: 'inspected',
      generated_artifacts: [{
        artifact_id: 'artifact-image-untrusted',
        artifact_kind: 'image',
        title: 'Untrusted Image',
        file_name: 'preview.png',
        display_path: '.jenny/artifacts/session-untrusted-artifact/preview.png',
        absolute_path: 'C:/workspace/.jenny/artifacts/session-untrusted-artifact/preview.png',
        mime_type: 'image/png',
        local_trusted: false,
      }],
    },
  });

  const [toolResult] = sessionStore.getSessionMessages('session-untrusted-artifact')
    .filter((message) => String(message.kind || '') === 'tool_result');
  assert.equal(toolResult.tool_result.generated_artifacts[0].absolute_path, '[redacted:path]');
  assert.equal(toolResult.tool_result.generated_artifacts[0].local_trusted, false);
});

test('handleToolNotification sanitizes structured metadata for stream and persisted tool results', () => {
  const messagesBySession = new Map([['session-metadata', []]]);
  const emitted = [];
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit(eventName, payload) {
      emitted.push({ eventName, payload });
    },
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const turnEvents = [];
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-metadata',
    streamId: 'stream-metadata',
    eventBase: { sessionId: 'session-metadata', streamId: 'stream-metadata', model: 'mock-model' },
    turnEventCollector: {
      noteEvent(event) {
        turnEvents.push(event);
      },
    },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-metadata',
      tool_name: 'write_file',
      success: true,
      output: 'wrote file',
      tool_input: { path: 'src/app.js' },
      metadata: {
        result_kind: 'file_mutation',
        diff: {
          additions: 1,
          deletions: 0,
          hunks: [{
            oldStart: 1,
            oldLines: 0,
            newStart: 1,
            newLines: 1,
            lines: ['+unsafe\nline'],
          }],
        },
        diffs: [
          {
            path: '../secret.txt',
            additions: 1,
            deletions: 0,
            hunks: [{
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ['+secret'],
            }],
          },
          {
            path: 'src/app.js',
            additions: 1,
            deletions: 0,
            hunks: [{
              oldStart: 1,
              oldLines: 0,
              newStart: 1,
              newLines: 1,
              lines: ['+safe'],
            }],
          },
        ],
        patch: {
          operation_count: 1,
          changed_file_count: 1,
          changed_paths: ['../secret.txt', 'src/app.js'],
          success: true,
        },
        files: [
          { path: '../secret.txt', operation: 'update', changed: true },
          { path: 'src/app.js', operation: 'update', changed: true },
        ],
      },
    },
  });

  const persisted = sessionStore.getSessionMessages('session-metadata')
    .find((message) => String(message.kind || '') === 'tool_result');
  assert.ok(persisted);
  assert.equal(persisted.tool_result.metadata.result_kind, 'file_mutation');
  assert.equal(persisted.tool_result.metadata.diff.truncated, true);
  assert.equal(persisted.tool_result.metadata.diff.truncation_reason, 'line_limit');
  assert.deepEqual(persisted.tool_result.metadata.diff.hunks, []);
  assert.equal(persisted.tool_result.metadata.diffs.length, 1);
  assert.equal(persisted.tool_result.metadata.diffs[0].path, 'src/app.js');
  assert.deepEqual(persisted.tool_result.metadata.patch.changed_paths, ['src/app.js']);
  assert.equal(persisted.tool_result.metadata.files.length, 1);
  assert.equal(persisted.tool_result.metadata.files[0].path, 'src/app.js');

  const streamResult = emitted.find((entry) => entry.payload?.type === 'tool_result')?.payload;
  assert.ok(streamResult);
  assert.deepEqual(streamResult.metadata.diff.hunks, []);
  assert.equal(streamResult.metadata.diffs.length, 1);
  assert.deepEqual(streamResult.metadata.patch.changed_paths, ['src/app.js']);

  const turnResult = turnEvents.find((event) => event.kind === 'tool_result');
  assert.ok(turnResult);
  assert.deepEqual(turnResult.payload.metadata.diff.hunks, []);
  assert.equal(turnResult.payload.metadata.diffs.length, 1);
});

test('handleToolNotification records data-only tool observability at notification boundary', () => {
  const messagesBySession = new Map([['session-obs', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const recorded = [];
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
    toolObservabilityAggregator: {
      recordToolExecuting(payload) {
        recorded.push({ kind: 'executing', payload });
        return true;
      },
      recordToolResult(payload) {
        recorded.push({ kind: 'result', payload });
        return true;
      },
    },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-obs',
    streamId: 'stream-obs',
    eventBase: { sessionId: 'session-obs', streamId: 'stream-obs', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.executing',
    params: {
      tool_call_id: 'call-observed',
      tool_name: 'read_file',
      tool_input: { path: 'secret.txt' },
    },
  });
  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-observed',
      tool_name: 'read_file',
      success: false,
      error_code: 'CMP-TOOL-0999',
      duration_ms: 123,
      output: 'super-secret-output',
      tool_input: { path: 'secret.txt' },
    },
  });

  assert.equal(recorded.length, 2);
  assert.equal(recorded[0].kind, 'executing');
  assert.equal(recorded[0].payload.streamId, 'stream-obs');
  assert.equal(recorded[0].payload.sessionId, 'session-obs');
  assert.equal(recorded[0].payload.callId, 'call-observed');
  assert.equal(recorded[0].payload.toolName, 'read_file');
  assert.equal(recorded[1].kind, 'result');
  assert.equal(recorded[1].payload.success, false);
  assert.equal(recorded[1].payload.errorCode, 'CMP-TOOL-0999');
  assert.equal(recorded[1].payload.durationMs, 123);

  const serialized = JSON.stringify(recorded);
  assert.equal(serialized.includes('super-secret-output'), false);
  assert.equal(serialized.includes('secret.txt'), false);
});

test('resolveToolResultStatus preserves additive timeout and preempted terminal statuses', () => {
  assert.equal(
    resolveToolResultStatus({ isError: true, approvalState: 'timeout' }),
    'timeout'
  );
  assert.equal(
    resolveToolResultStatus({ isError: true, approvalState: 'preempted' }),
    'preempted'
  );
  assert.equal(
    resolveToolResultStatus({ isError: true, approvalState: 'denied' }),
    'denied'
  );
  assert.equal(
    resolveToolResultStatus({ isError: true, approvalState: 'cancelled' }),
    'cancelled'
  );
});
