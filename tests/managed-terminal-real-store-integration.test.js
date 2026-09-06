'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  createManagedService,
} = require('./helpers/managed-sidecar-runtime-helpers');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => cleanupTrackedResources());

test('real managed store preserves an unsaved reply and retries the exact terminal mutation', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-terminal-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const events = [];
  service.on('chat-stream', (event) => events.push(event));
  await service.start();

  const sessionId = 'session_real_managed_terminal';
  service.sessionStore.createSessionWithId(sessionId, { title: 'Real terminal' });
  const durablePort = service.sessionStore.conversationStore;
  let terminalCommitCalls = 0;
  const faultPort = Object.freeze({
    ...durablePort,
    commitTerminal(...args) {
      terminalCommitCalls += 1;
      if (terminalCommitCalls === 1) {
        return {
          ok: false,
          applied: false,
          durable: false,
          reason: 'injected_terminal_refusal',
          commitEpoch: 0,
          dirtyEpoch: 0,
          durableEpoch: 0,
          value: null,
        };
      }
      return durablePort.commitTerminal(...args);
    },
  });
  service.sessionStore.conversationStore = faultPort;
  service.sessionConversationStore = faultPort;
  service.conversationStore = faultPort;

  const started = await startManagedSidecarChatStream(
    service,
    buildManagedChatRequest({ sessionId, prompt: 'Hello from a real store' })
  );
  const controller = service.activeStreams.get(started.streamId);
  await controller._pendingPromise;

  const completion = events.find((event) => event.type === 'complete');
  assert.equal(completion?.durability?.state, 'unsaved');
  assert.equal(service.sessionStore.getActiveTurn(sessionId)?.stream_id, started.streamId);
  const artifact = service.terminalRepairStore.listPending(sessionId)[0];
  assert.equal(artifact.message.content, 'Hello from the sidecar');

  const retried = await service.retryUnsavedReply({
    sessionId,
    messageId: artifact.message.id,
    artifactId: artifact.artifact_id,
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.durable, true);
  assert.equal(terminalCommitCalls, 2);
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
  assert.equal(service.terminalRepairStore.listPending(sessionId).length, 0);
  assert.equal(events.filter((event) => event.type === 'complete').length, 1);
  assert.equal(
    service.sessionStore.getSessionMessages(sessionId)
      .filter((message) => message.id === artifact.message.id).length,
    1
  );
});
