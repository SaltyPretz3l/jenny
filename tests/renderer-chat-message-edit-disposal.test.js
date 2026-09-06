'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMessageEditController } = require('../renderer/chat/renderer-chat-message-edit-utils');

test('a commit settling after disposal cannot clear a newer controller edit', async () => {
  let resolveStart;
  const pendingStart = new Promise((resolve) => { resolveStart = resolve; });
  const state = {
    ui: {
      editingDraftBySession: new Map(),
      editingMessageId: 'm1',
      editingDraftText: 'edited',
      editingOriginalText: 'old',
      editingSessionId: 's1',
      editCommitting: false,
      editingAffectedCount: 1,
    },
    messagesBySession: new Map(),
  };
  let renderCount = 0;
  const controller = createMessageEditController({
    state,
    document: { querySelector() { return null; }, querySelectorAll() { return []; }, defaultView: null },
    getCurrentSessionMessages: () => [{ id: 'm1', role: 'user', content: 'old' }],
    startPromptSend: () => pendingStart,
    renderAll: () => { renderCount += 1; },
  });

  const commit = controller.commitEdit();
  await Promise.resolve();
  controller.dispose();
  Object.assign(state.ui, {
    editingMessageId: 'm2',
    editingDraftText: 'new draft',
    editingOriginalText: 'new',
    editingSessionId: 's2',
    editCommitting: false,
    editingAffectedCount: 1,
  });
  renderCount = 0;
  resolveStart({ streamId: 'stream-1', identity: { userMessageId: 'm1' } });
  await commit;

  assert.equal(state.ui.editingMessageId, 'm2');
  assert.equal(state.ui.editingDraftText, 'new draft');
  assert.equal(state.ui.editingSessionId, 's2');
  assert.equal(renderCount, 0);
});
