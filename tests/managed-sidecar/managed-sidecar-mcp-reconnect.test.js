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
  createManagedService,
  waitForChatStreamEvent,
} = require('../helpers/managed-sidecar-runtime-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar surfaces mcp_retry_count metadata when an MCP transport reconnects mid-call', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-mcp-reconnect-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();

  const created = await service.createSession({
    title: 'MCP Reconnect Session',
    preferences: { preferred_model: 'mock-v1' },
  });

  const toolResultPromise = waitForChatStreamEvent(
    service,
    (event) => event.type === 'tool_result' && event.toolName === 'mcp__docs__lookup'
  );
  const completed = waitForChatStreamEvent(service, (event) => event.type === 'complete');

  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Please run an mcp reconnect lookup',
    preferredModel: 'mock-v1',
  });

  const toolResult = await toolResultPromise;
  await completed;

  assert.equal(toolResult.streamId, stream.streamId);
  assert.equal(toolResult.isError, false);
  assert.equal(toolResult.metadata.mcp_retry_count, 1);
  assert.equal(toolResult.metadata.mcp_reconnected_server, 'docs');

  const messages = await service.getSessionMessages(stream.sessionId);
  const toolResultMessage = messages.data.find(
    (message) => message.kind === 'tool_result' && message.tool_result?.tool_name === 'mcp__docs__lookup'
  );
  assert.ok(toolResultMessage, 'expected a persisted tool_result message for the MCP call');
  assert.equal(toolResultMessage.tool_result.metadata.mcp_retry_count, 1);
  assert.equal(toolResultMessage.tool_result.metadata.mcp_reconnected_server, 'docs');
  assert.equal(toolResultMessage.tool_result.is_error, false);

  await service.stop();
});
