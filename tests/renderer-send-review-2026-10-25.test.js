'use strict';

// Regression pins from the 2026-10-25 send-path review (renderer-send-utils.js
// and renderer-chat-shell-controller.js). Each test names the defect it pins.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMessageSequence, createControllerHarness } = require('./helpers/send-controller-harness');
const { createChatShellController } = require('../renderer/chat/renderer-chat-shell-controller');

const SESSION = 'session-1';

function busyHarness(t, options = {}) {
  const harness = createControllerHarness(buildMessageSequence(), options);
  t.after(() => harness.restore());
  harness.multiStreamController.registerStream(SESSION, 'stream-live');
  return harness;
}

function mentionSpy() {
  const calls = { paths: 0, contents: 0 };
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionPaths() { calls.paths += 1; return ['C:/draft/mentioned.js']; },
    collectMentionContents() { calls.contents += 1; return [{ path: 'C:/draft/mentioned.js', content: 'draft-only' }]; },
  };
  return calls;
}

test('an edit sent while the session is busy is rejected, not queued, and leaves the composer alone', async (t) => {
  const harness = busyHarness(t, { chatInputValue: 'my unsent draft' });

  const result = await harness.controller.startPromptSend('edited text', {
    visiblePrompt: 'edited text',
    editedMessageId: 'user_1',
    sessionIdOverride: SESSION,
    preserveComposerDraft: true,
  });

  assert.deepEqual(result, { rejected: true, reason: 'session_busy', sessionId: SESSION });
  assert.equal(harness.chatInput.value, 'my unsent draft');
  assert.equal(harness.controller.getQueuedSend(SESSION), null, 'an edit never becomes a queued message');
  assert.equal(harness.calls.editAndRegenerate.length, 0);
});

test('a non-composer prompt queued while busy takes none of the draft @-mentions and keeps the draft', async (t) => {
  const harness = busyHarness(t, { chatInputValue: 'see @mentioned.js' });
  const mentions = mentionSpy();

  const result = await harness.controller.startPromptSend('regenerate this', { sessionIdOverride: SESSION, preserveComposerDraft: true });

  assert.equal(result?.queued, true);
  assert.deepEqual(mentions, { paths: 0, contents: 0 });
  assert.equal(harness.chatInput.value, 'see @mentioned.js');
});

test('a non-composer prompt sent directly does not read the draft @-mentions', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), { chatInputValue: 'see @mentioned.js' });
  t.after(() => harness.restore());
  const mentions = mentionSpy();

  await harness.controller.startPromptSend('follow-up prompt', { sessionIdOverride: SESSION, preserveComposerDraft: true });

  assert.equal(harness.calls.startStream.length, 1);
  assert.equal(mentions.contents, 0);
  assert.equal(harness.chatInput.value, 'see @mentioned.js');
});

test('a drained outbox entry blocked by compaction reports null so the dispatcher keeps it queued', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), { compactionCoordinator: { isPending: () => true } });
  t.after(() => harness.restore());

  const drained = await harness.controller.startPromptSend('queued prompt', { sessionIdOverride: SESSION, outboxDispatch: true });
  const typed = await harness.controller.startPromptSend('typed prompt', { sessionIdOverride: SESSION });

  assert.equal(drained, null);
  assert.deepEqual(typed, { rejected: true, reason: 'session_compacting', sessionId: SESSION });
});

test('a failed edit records no failed-send Retry payload', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), { editAndRegenerateError: new Error('sidecar unavailable') });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('edited text', {
    visiblePrompt: 'edited text',
    editedMessageId: 'user_1',
    sessionIdOverride: SESSION,
    preserveComposerDraft: true,
  });

  assert.equal(result, null);
  assert.equal(harness.state.failedSendPayloadsById?.size || 0, 0);
});

test('a throw while staging the optimistic turn settles the send instead of stranding preflight and the draft', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), {
    chatInputValue: 'hello there',
    callbacks: { optimisticAppend: () => { throw new Error('render cache unavailable'); } },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('hello there', { sessionIdOverride: SESSION });

  assert.equal(result, null);
  assert.equal(harness.multiStreamController.isSessionSendBusy(SESSION), false, 'preflight cleared');
  assert.equal(harness.state.sendPreflight, null);
  assert.equal(harness.chatInput.value, 'hello there', 'the consumed draft is restored');
  assert.equal(harness.calls.startStream.length, 0);
});

test('a rejected cancelStream releases the Stop hold so the queued send still drains', async (t) => {
  const harness = busyHarness(t);
  harness.controller.stashQueuedSendForSession(SESSION, { prompt: 'queued prompt', status: 'ready' });
  global.window.jennyShell.chat.cancelStream = async () => { throw new Error('ipc down'); };

  await assert.rejects(harness.controller.handleStopActiveStream(), /ipc down/);
  harness.multiStreamController.clearStream('stream-live');
  await harness.controller.dispatchQueuedSendForSession(SESSION);

  assert.equal(harness.calls.startStream.length, 1, 'the failed Stop did not hold the drain');
});

test('disposing a split pane keeps the shared outbox and failed-send payloads alive', async (t) => {
  let attempts = 0;
  const harness = createControllerHarness([], {
    sessionContextFor: () => ({ paneId: 1, getSessionId: () => SESSION, setSessionId() {}, isCurrent: (id) => id === SESSION }),
    startStream: async () => { attempts += 1; throw new Error('retry me'); },
  });
  t.after(() => harness.restore());
  await harness.controller.startPromptSend('lost turn', { sessionIdOverride: SESSION });
  assert.equal(attempts, 1);
  assert.equal(harness.state.failedSendPayloadsById.size, 1);

  harness.controller.dispose();

  assert.equal(harness.state.failedSendPayloadsById.size, 1, "pane 0's Retry payloads survive");
  const entry = harness.state.sendOutboxController.enqueue(SESSION, { prompt: 'still queueable', status: 'ready' });
  assert.ok(entry, 'the shared outbox still accepts entries');
});

test('the shell edit gate counts a send still in preflight as busy', (t) => {
  const saved = globalThis.rendererChatMessageEditUtils;
  t.after(() => { globalThis.rendererChatMessageEditUtils = saved; });
  let editDeps = null;
  globalThis.rendererChatMessageEditUtils = { createMessageEditController(d) { editDeps = d; return {}; } };
  createChatShellController({
    state: { currentSessionId: SESSION, ui: {} },
    windowRef: { jennyShell: { chat: {} } },
    slashDependencies: { getInteractiveComposerStatusNotice() { return null; } },
    dom: { chatInput: { value: '', disabled: false } },
    constants: { TOAST_SOURCE: {}, ACTIVITY_SCOPE: {} },
    controllers: { multiStreamController: { isSessionSendBusy: (id) => id === SESSION } },
    callbacks: {
      renderAll() {},
      appendClientLog() {},
      getCurrentSessionMessages() { return []; },
      isSessionStreaming: () => false,
      hasPendingToolApprovalForSession: () => false,
    },
    factories: {
      sendUtils: { createSendController() { return {}; } },
      composerFlowUtils: { createComposerV2FlowController() { return {}; } },
      chatEventUtils: { createChatEventBindings() { return { bind() {}, dispose() {} }; } },
    },
  });

  assert.equal(editDeps.resolveFollowUpActionBlock().blocked, true);
});
