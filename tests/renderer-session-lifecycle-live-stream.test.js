const test = require('node:test');
const assert = require('node:assert/strict');

const { createSessionLifecycleController } = require('../renderer/shell/renderer-session-lifecycle-utils');

test('switching back to a streaming chat keeps its live thinking over the refetched copy', async () => {
  const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
  const liveReasoning = { source: 'provider', entries: [{ id: 'r1', text: 'Weighing the options' }] };
  const state = { currentSessionId: 'other', sessionMessageAccessOrder: new Map(),
    pendingToolApprovals: new Map(), messagesBySession: new Map([['chat', [
      { id: 'u1', role: 'user', content: 'Hi' },
      { id: 'a_settled', role: 'assistant', content: 'Earlier', status: 'complete', streamId: 's1' },
      { id: 'a_live', role: 'assistant', content: 'Draft', status: 'streaming', streamId: 's1', reasoning: liveReasoning },
      { id: 'a_gone', role: 'assistant', content: 'Not on disk yet', status: 'streaming', streamId: 's1', reasoning: liveReasoning },
      { id: 'a_old', role: 'assistant', content: 'Old stream', status: 'streaming', streamId: 's0' },
    ]]]) };
  const multiStream = createMultiStreamController({ getState: () => state });
  multiStream.registerStream('chat', 's1');
  const controller = createSessionLifecycleController({ state,
    getMultiStreamController: () => multiStream,
    sessionCacheController: { async evictColdSessionCaches() {} },
    thinkingController: { resumeAutoScroll() {} },
    jennyShell: {
      sessions: { async getMessages() { return { data: [
        { id: 'u1', role: 'user', content: 'Hi' },
        { id: 'a_settled', role: 'assistant', content: 'Earlier, settled', status: 'complete', streamId: 's1' },
        { id: 'a_live', role: 'assistant', content: '', status: 'streaming', streamId: 's1', reasoning: { source: 'none', entries: [] } },
      ], turn_events: [] }; } },
      chat: { async getActiveTurnState() { return null; } },
    },
    callbacks: {
      getSessionMessages: (id) => state.messagesBySession.get(id) || [],
      setSessionMessages: (id, messages) => state.messagesBySession.set(id, messages),
    },
  });
  await controller.openSession('chat', { silent: true });
  const byId = new Map(state.messagesBySession.get('chat').map((message) => [message.id, message]));
  assert.deepEqual([...byId.keys()], ['u1', 'a_settled', 'a_live', 'a_gone']);
  assert.equal(byId.get('a_settled').content, 'Earlier, settled');
  assert.deepEqual(byId.get('a_live').reasoning, liveReasoning);
  assert.equal(byId.get('a_live').content, 'Draft');
  assert.deepEqual(byId.get('a_gone').reasoning, liveReasoning);
});
