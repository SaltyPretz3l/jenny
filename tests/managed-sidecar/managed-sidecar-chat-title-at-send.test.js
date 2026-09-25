const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('a fresh "New Chat" is titled from the prompt at send, before the turn streams', async () => {
  // Owner gate 2026-09-20: the session only got its title at the end of the turn.
  const service = createManagedChatServiceStub();
  const sessionId = 'session_title_at_send';
  service.sessionStore.createSessionWithId(sessionId, { title: 'New Chat', message_count: 0 });
  const renames = [];
  service.renameSession = async (id, title) => {
    renames.push([id, title]);
    // Mirror the real service: the store's title moves, so the terminal
    // apply's still-default guard sees the rename.
    service.sessionStore.createSessionWithId(id, { title, message_count: 0 });
    return null;
  };
  let releaseDone = null;
  const doneGate = new Promise((resolve) => { releaseDone = resolve; });
  service.sidecarManager = { process: { pid: 1 }, getStatus: () => ({ phase: 'ready' }) };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      await doneGate;
      options.onNotification({ method: 'chat.token', params: { delta: 'Named.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Name this chat from my first words',
  }));

  assert.equal(renames.length, 1, 'renamed once, at send');
  assert.equal(renames[0][0], sessionId);
  assert.match(renames[0][1], /Name this chat/);

  releaseDone();
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  assert.equal(renames.length, 1, 'the terminal apply does not rename a second time');
});
