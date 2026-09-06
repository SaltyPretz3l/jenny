'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildManagedSidecarChatSendOptions,
} = require('../services/backend/electron-tool-bridge');

test('ask_user alone suspends and resumes the stream idle watchdog around execution', async () => {
  const events = [];
  let releaseAskUser;
  const askUserWait = new Promise((resolve) => { releaseAskUser = resolve; });
  const service = {
    toolExecutor: {
      async executePreApproved({ toolName }) {
        events.push(`execute:${toolName}`);
        if (toolName === 'ask_user') return askUserWait;
        return { content: 'status', isError: false, metadata: {} };
      },
    },
  };
  const options = buildManagedSidecarChatSendOptions({
    service,
    controller: new AbortController(),
    streamId: 'stream-ask-user',
    resolvedSessionId: 'session-ask-user',
    requestId: 'request-ask-user',
    requestTraceId: 'trace-ask-user',
    runtime: { handleNotification() {} },
    toolContext: {},
    handleToolNotification() {},
    waitForToolApproval() {},
    turnEventCollector: {},
    normalizedPreferences: {},
    timeoutMs: 1_000,
    noteStreamActivity() { events.push('activity'); },
    pauseStreamIdleTimer() {
      events.push('suspend');
      return () => events.push('resume');
    },
  });

  const pending = options.onElectronToolRequest({ tool_name: 'ask_user' });
  assert.deepEqual(events, ['suspend', 'execute:ask_user']);
  releaseAskUser({ content: 'answered', isError: false, metadata: {} });
  await pending;
  assert.deepEqual(events, ['suspend', 'execute:ask_user', 'resume']);

  await options.onElectronToolRequest({ tool_name: 'jenny_status' });
  assert.deepEqual(events, ['suspend', 'execute:ask_user', 'resume', 'execute:jenny_status']);
});
