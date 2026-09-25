const test = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForToolApproval,
} = require('../services/backend/chat-stream-tool-handling');
const {
  convertToolUseToProviderMessage,
} = require('../services/backend/chat-stream-reasoning');

// Approval-gated tool_use rows carry model_input_json so a declined call is
// replayed to the model with workspace-relative paths, not [redacted:path].

function createService(toExecutionContext) {
  const messages = [];
  return {
    messages,
    sessionStore: {
      getSessionMessages() {
        return messages;
      },
      appendMessage(_sessionId, message) {
        messages.push(message);
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index !== -1) messages[index] = { ...messages[index], ...patch };
      },
    },
    sessionExecutionAuthority: { toExecutionContext },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
}

function requestApproval(service, callId, executionAuthority) {
  return waitForToolApproval(
    service,
    `stream-${callId}`,
    `session-${callId}`,
    `req-${callId}`,
    {
      tool_name: 'write_file',
      tool_call_id: callId,
      tool_input: { path: 'C:\\ws\\src\\a.js' },
    },
    new AbortController(),
    null,
    executionAuthority
  );
}

function denyPending(service, callId) {
  const pending = [...service.pendingToolApprovals.values()]
    .find((entry) => String(entry?.callId || '') === callId);
  assert.ok(pending);
  pending.resolve(false, 'denied');
}

test('waitForToolApproval persists model replay input for pending and denied workspace paths', async () => {
  const executionAuthority = { binding_id: 'binding-model-input' };
  const authorityCalls = [];
  const service = createService((authority) => {
    authorityCalls.push(authority);
    return { root_path: 'C:\\ws' };
  });
  const resultPromise = requestApproval(service, 'call-model-input', executionAuthority);

  const pendingRow = service.messages.find((message) => message.kind === 'tool_use');
  assert.ok(pendingRow);
  assert.deepEqual(JSON.parse(pendingRow.tool_call.model_input_json), { path: '.\\src\\a.js' });
  assert.equal(pendingRow.tool_call.model_input_json.includes('[redacted:path]'), false);
  assert.deepEqual(JSON.parse(pendingRow.tool_call.input_json), { path: '[redacted:path]\\a.js' });
  assert.equal(
    convertToolUseToProviderMessage(pendingRow).tool_calls[0].function.arguments,
    pendingRow.tool_call.model_input_json
  );

  denyPending(service, 'call-model-input');
  assert.equal(await resultPromise, false);
  const deniedRow = service.messages.find((message) => message.kind === 'tool_use');
  assert.deepEqual(JSON.parse(deniedRow.tool_call.model_input_json), { path: '.\\src\\a.js' });
  assert.deepEqual(JSON.parse(deniedRow.tool_call.input_json), { path: '[redacted:path]\\a.js' });
  assert.deepEqual(authorityCalls, [executionAuthority]);
});

test('waitForToolApproval keeps approval behavior when execution context lookup throws', async () => {
  let authorityCallCount = 0;
  const service = createService(() => {
    authorityCallCount += 1;
    throw new Error('binding closed');
  });
  const resultPromise = requestApproval(service, 'call-closed-binding', { binding_id: 'binding-closed' });

  denyPending(service, 'call-closed-binding');
  assert.equal(await resultPromise, false);
  const deniedRow = service.messages.find((message) => message.kind === 'tool_use');
  assert.equal(deniedRow.tool_call.model_input_json, undefined);
  assert.deepEqual(JSON.parse(deniedRow.tool_call.input_json), { path: '[redacted:path]\\a.js' });
  assert.equal(authorityCallCount, 1);
});
