'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageEditController } = require('../renderer/chat/renderer-chat-message-edit-utils');

function createState(draft) {
  return {
    ui: {
      editingDraftBySession: new Map(),
      editingMessageId: 'm1',
      editingDraftText: draft,
      editingOriginalText: 'hello',
      editingSessionId: 's1',
      editCommitting: false,
      editingAffectedCount: 1,
    },
    messagesBySession: new Map(),
  };
}

test('commitEdit preserves intentional leading and trailing whitespace changes', async () => {
  for (const draft of [' hello', 'hello ', ' hello ']) {
    const state = createState(draft);
    const sends = [];
    const controller = createMessageEditController({
      state,
      document: { querySelector() { return null; }, querySelectorAll() { return []; }, defaultView: null },
      getCurrentSessionMessages: () => [{ id: 'm1', role: 'user', content: 'hello' }],
      getCurrentSessionId: () => 's1',
      startPromptSend: async (prompt) => {
        sends.push(prompt);
        return { streamId: 'stream-1', identity: { userMessageId: 'm1' } };
      },
    });

    await controller.commitEdit();
    assert.deepEqual(sends, [draft]);
  }
});
