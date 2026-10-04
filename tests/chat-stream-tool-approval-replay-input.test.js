const test = require('node:test');
const assert = require('node:assert/strict');

const {
  waitForToolApproval,
} = require('../services/backend/chat-stream-tool-handling');
const {
  convertToolUseToProviderMessage,
} = require('../services/backend/chat-stream-reasoning');

// Approval-gated tool_use rows persist the call's real arguments (HB-012), so
// a declined call is replayed to the model with the path it actually used,
// never a [redacted:path] placeholder it would copy back as a literal.

function createService() {
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
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
  };
}

function requestApproval(service, callId) {
  return waitForToolApproval(
    service,
    `stream-${callId}`,
    `session-${callId}`,
    `req-${callId}`,
    {
      tool_name: 'write_file',
      tool_call_id: callId,
      tool_input: { path: 'C:\\ws\\src\\a.js', api_key: 'sk-approvalsecret123456' },
    },
    new AbortController(),
    null,
    { binding_id: `binding-${callId}` }
  );
}

function denyPending(service, callId) {
  const pending = [...service.pendingToolApprovals.values()]
    .find((entry) => String(entry?.callId || '') === callId);
  assert.ok(pending);
  pending.resolve(false, 'denied');
}

test('waitForToolApproval persists the real path for pending and denied rows and replays it', async () => {
  const service = createService();
  const resultPromise = requestApproval(service, 'call-model-input');

  const pendingRow = service.messages.find((message) => message.kind === 'tool_use');
  assert.ok(pendingRow);
  assert.deepEqual(JSON.parse(pendingRow.tool_call.input_json), { path: 'C:\\ws\\src\\a.js', api_key: '[redacted]' });
  assert.equal(pendingRow.tool_call.model_input_json, undefined);
  assert.equal(
    convertToolUseToProviderMessage(pendingRow).tool_calls[0].function.arguments,
    pendingRow.tool_call.input_json
  );

  denyPending(service, 'call-model-input');
  assert.equal(await resultPromise, false);
  const deniedRow = service.messages.find((message) => message.kind === 'tool_use');
  assert.deepEqual(JSON.parse(deniedRow.tool_call.input_json), { path: 'C:\\ws\\src\\a.js', api_key: '[redacted]' });
  assert.equal(deniedRow.tool_call.model_input_json, undefined);
  assert.equal(JSON.stringify(deniedRow).includes('[redacted:path]'), false);
});
