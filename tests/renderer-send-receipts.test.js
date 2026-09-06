'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendReceiptStore } = require('../renderer/chat/renderer-send-receipts');
const { createControllerHarness } = require('./helpers/send-controller-harness');

test('startPromptSend projects and forwards the session run mode', async (t) => {
  const harness = createControllerHarness([], {
    runtimePreferences: { runMode: 'auto' },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('One bounded send');

  assert.ok(result);
  assert.equal(harness.calls.startStream[0].approvalMode, 'auto_run');
});

function createStoreEnv() {
  const state = {
    currentSessionId: 'session-a',
    attachments: { queued: [{ id: 'asset-a', assetPath: 'C:/managed/a.png' }] },
    composerSessionState: new Map(),
  };
  const chatInput = { value: 'origin prompt', selectionStart: 13, selectionEnd: 13 };
  const released = [];
  const logs = [];
  const store = createSendReceiptStore({
    state,
    chatInput,
    releaseAssets(paths) { released.push(...paths); },
    log(level, event, details) { logs.push({ level, event, details }); },
  });
  return { state, chatInput, released, logs, store };
}

function beginOriginReceipt(env) {
  return env.store.begin({
    sessionId: 'session-a',
    prompt: 'origin prompt',
    visiblePrompt: 'origin prompt',
    attachments: env.state.attachments.queued,
    runtimePreferences: { preferredModel: 'model-a', contextPreferences: { historyScope: 'session' } },
    toolPreferences: { web: true },
  }, { consumeDraft: true, restoreOnFailure: true });
}

test('receipt snapshots are immutable and synchronously claim only the origin draft', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);

  assert.ok(Object.isFrozen(receipt));
  assert.ok(Object.isFrozen(receipt.payload));
  assert.ok(Object.isFrozen(receipt.payload.attachments));
  assert.equal(receipt.originSessionId, 'session-a');
  assert.equal(receipt.payload.prompt, 'origin prompt');
  assert.deepEqual(receipt.payload.runtimePreferences, {
    preferredModel: 'model-a',
    contextPreferences: { historyScope: 'session' },
  });
  assert.equal(env.chatInput.value, '');
  assert.deepEqual(env.state.attachments.queued, []);
  assert.throws(() => { receipt.payload.runtimePreferences.preferredModel = 'mutated'; }, TypeError);
});

test('failure after a session switch restores the origin record without touching the visible session', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);
  env.state.currentSessionId = 'session-b';
  env.chatInput.value = 'draft in B';
  env.state.attachments.queued = [{ id: 'asset-b', assetPath: 'C:/managed/b.png' }];

  const result = env.store.settleFailed(receipt, { retryable: true });

  assert.equal(result.restoredToComposer, true);
  assert.equal(env.chatInput.value, 'draft in B');
  assert.deepEqual(env.state.attachments.queued.map((entry) => entry.id), ['asset-b']);
  const origin = env.state.composerSessionState.get('session-a');
  assert.equal(origin.text, 'origin prompt');
  assert.deepEqual(origin.attachments.map((entry) => entry.id), ['asset-a']);
  assert.equal(result.failedPayload.attachmentOwner, 'failed_payload');
});

test('newer origin work is never overwritten and becomes a recoverable failed payload', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);
  const origin = env.state.composerSessionState.get('session-a');
  origin.text = 'newer origin draft';
  origin.attachments = [{ id: 'asset-new', assetPath: 'C:/managed/new.png' }];
  origin.draftRevision += 1;
  origin.sendReceiptId = '';
  env.chatInput.value = origin.text;
  env.state.attachments.queued = origin.attachments;

  const result = env.store.settleFailed(receipt, { retryable: true });

  assert.equal(result.restoredToComposer, false);
  assert.equal(env.chatInput.value, 'newer origin draft');
  assert.deepEqual(env.state.attachments.queued.map((entry) => entry.id), ['asset-new']);
  assert.equal(result.failedPayload.attachmentOwner, 'failed_payload');
  assert.equal(env.store.getRetryAvailability(result.failedPayload.id).available, true);
});

test('first-turn failure does not overwrite newer work in the blank composer', () => {
  const env = createStoreEnv();
  env.state.currentSessionId = '';
  const receipt = beginOriginReceipt(env);
  env.chatInput.value = 'new first-turn draft';
  env.state.attachments.queued = [{ id: 'asset-new', assetPath: 'C:/managed/new.png' }];

  const result = env.store.settleFailed(receipt, { retryable: true });

  assert.equal(result.restoredToComposer, false);
  assert.equal(env.chatInput.value, 'new first-turn draft');
  assert.deepEqual(env.state.attachments.queued.map((entry) => entry.id), ['asset-new']);
  assert.equal(result.failedPayload.attachmentOwner, 'failed_payload');
});

test('failure after optimistic-session rekey targets the authoritative session', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);
  const record = env.state.composerSessionState.get('session-a');
  env.state.composerSessionState.delete('session-a');
  env.state.composerSessionState.set('session-real', { ...record, sessionId: 'session-real' });
  env.state.currentSessionId = 'session-real';

  const result = env.store.settleFailed(receipt, { sessionId: 'session-real', retryable: true });

  assert.equal(result.restoredToComposer, true);
  assert.equal(result.failedPayload.sessionId, 'session-real');
});

test('acceptance transfers attachment assets to canonical history and leaves another session alone', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);
  env.state.currentSessionId = 'session-b';
  env.chatInput.value = 'draft in B';
  env.state.attachments.queued = [{ id: 'asset-b', assetPath: 'C:/managed/b.png' }];

  assert.deepEqual(env.store.settleAccepted(receipt, { sessionId: 'session-a' }), { ignored: false });
  assert.deepEqual(env.store.settleAccepted(receipt, { sessionId: 'session-a' }), { ignored: true });
  assert.deepEqual(env.released, [], 'canonical session history still references the accepted asset');
  assert.equal(env.chatInput.value, 'draft in B');
  assert.deepEqual(env.state.attachments.queued.map((entry) => entry.id), ['asset-b']);
});

test('failed payload retains restored assets until exact retry ownership is dismissed', () => {
  const env = createStoreEnv();
  const firstReceipt = beginOriginReceipt(env);
  const failure = env.store.settleFailed(firstReceipt, { retryable: true });

  const replacementReceipt = beginOriginReceipt(env);
  env.store.settleAccepted(replacementReceipt, { sessionId: 'session-a' });
  assert.deepEqual(env.released, [], 'a later composer send cannot delete an asset retained for exact Retry');

  assert.equal(env.store.dismissFailedPayload(failure.failedPayload.id), true);
  assert.deepEqual(env.released, ['C:/managed/a.png']);
});

test('canonical attachment handoff survives post-accept renderer failure and disposal', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);

  assert.equal(env.store.transferAttachmentsToCanonicalHistory(receipt), true);
  const settlement = env.store.settleFailed(receipt, { retryable: true });

  assert.equal(settlement.canonicalAccepted, true);
  assert.equal(settlement.restoredToComposer, false);
  assert.equal(settlement.failedPayload, null);
  assert.equal(env.state.failedSendPayloadsById.size, 0);
  assert.deepEqual(env.state.attachments.queued, [], 'canonical handoff does not restore a duplicate draft attachment');
  env.store.dispose();
  assert.deepEqual(env.released, [], 'renderer cleanup cannot delete a canonically persisted attachment');
});

test('disposing during mention collection prevents a late chat bridge start', async (t) => {
  let resolveMentions;
  const mentionContents = new Promise((resolve) => { resolveMentions = resolve; });
  const harness = createControllerHarness([], { chatInputValue: 'hello' });
  t.after(() => harness.restore());
  global.window.rendererIdeMentionAutocomplete = {
    collectMentionContents: () => mentionContents,
  };

  const pendingSend = harness.controller.startPromptSend('hello');
  await Promise.resolve();
  harness.controller.dispose();
  resolveMentions([]);
  const result = await pendingSend;

  assert.equal(result, null);
  assert.equal(harness.calls.startStream.length, 0);
  assert.deepEqual(harness.calls.errors, []);
});

test('Retry replays the stored payload and ignores the current composer', async (t) => {
  let attempt = 0;
  const harness = createControllerHarness([], {
    chatInputValue: 'immutable original',
    startStream: async (payload) => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('transport unavailable');
        error.code = 'CMP-CHAT-0002';
        throw error;
      }
      return { sessionId: payload.sessionId, streamId: 'stream-retry' };
    },
  });
  t.after(() => harness.restore());
  const originalAttachment = { id: 'original-asset', kind: 'image', assetPath: 'C:/managed/original.png' };
  harness.state.attachments.queued = [originalAttachment];

  await harness.controller.startPromptSend('immutable original', { restoreInputOnError: true });
  const failedMessage = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.send_failure?.payload_id);
  assert.ok(failedMessage?.send_failure?.payload_id);

  harness.chatInput.value = 'new unrelated draft';
  harness.state.attachments.queued = [{ id: 'new-asset', kind: 'image', assetPath: 'C:/managed/new.png' }];
  const result = await harness.controller.retryFailedPayload(failedMessage.send_failure.payload_id);

  assert.equal(result.streamId, 'stream-retry');
  assert.equal(harness.calls.startStream.length, 2);
  assert.equal(harness.calls.startStream[1].prompt, 'immutable original');
  assert.deepEqual(harness.calls.startStream[1].attachments, [originalAttachment]);
  assert.equal(harness.chatInput.value, 'new unrelated draft');
  assert.deepEqual(harness.state.attachments.queued.map((entry) => entry.id), ['new-asset']);
  assert.equal(
    JSON.stringify(harness.calls.logs).includes('immutable original'),
    false,
    'receipt diagnostics must not contain prompt text',
  );
  assert.equal(
    harness.controller.getFailedPayloadRetryAvailability(failedMessage.send_failure.payload_id).available,
    false,
    'accepted retry consumes the failed-payload receipt',
  );
  assert.equal(
    failedMessage.send_failure.dismissed,
    undefined,
    'the immutable pre-retry snapshot is not mutated in place',
  );
  const settledFailure = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.id === failedMessage.id);
  assert.equal(settledFailure.send_failure.dismissed, true, 'accepted retry clears the original failure notice');
});

test('a malformed acceptance cancels its identifiable stream and preserves a retry payload', async (t) => {
  const harness = createControllerHarness([], {
    chatInputValue: 'malformed acceptance prompt',
    startStream: async () => ({ streamId: 'stream-malformed', sessionId: '' }),
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('malformed acceptance prompt', { restoreInputOnError: true });

  assert.equal(result, null);
  assert.deepEqual(harness.calls.cancelStream, ['stream-malformed']);
  const failedMessage = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.send_failure?.payload_id);
  assert.ok(failedMessage, 'the malformed acceptance must remain recoverable');
  assert.equal(harness.chatInput.value, 'malformed acceptance prompt');
});

test('failed outbox attempts stay in the outbox without accumulating transcript failures', async (t) => {
  const harness = createControllerHarness([], {
    startStream: async () => { throw new Error('temporary transport failure'); },
  });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('queued payload', {
    sessionIdOverride: 'session-1',
    preserveComposerDraft: true,
    restoreDraftOnStartStreamReject: false,
    recordFailedPayload: false,
    outboxDispatch: true,
  });

  assert.equal(result, null);
  assert.deepEqual(harness.state.messagesBySession.get('session-1'), []);
  assert.deepEqual(harness.calls.errors, [], 'background retry failures must not spam composer errors');
  assert.equal(harness.state.ui.chatSendLifecycleBySession.has('session-1'), false);
});

test('failed payload retention is bounded and evicts the oldest receipt', () => {
  const env = createStoreEnv();
  const payloadIds = [];
  for (let index = 0; index < 65; index += 1) {
    const receipt = env.store.begin({
      sessionId: 'session-a', prompt: `prompt ${index}`, visiblePrompt: `prompt ${index}`, attachments: [],
    }, { consumeDraft: false, restoreOnFailure: false });
    payloadIds.push(env.store.settleFailed(receipt, { retryable: true }).failedPayload.id);
  }

  assert.equal(env.store.getRetryAvailability(payloadIds[0]).available, false);
  assert.equal(env.store.getRetryAvailability(payloadIds.at(-1)).available, true);
  assert.equal(env.logs.filter((entry) => entry.event === 'chat.failed_payload_evicted').length, 1);
  assert.equal(JSON.stringify(env.logs).includes('prompt 0'), false);
});

test('outbox-owned failures settle without creating a second failed-payload owner', () => {
  const { store, state, released } = createStoreEnv();
  const receipt = store.begin({ sessionId: 's1', prompt: 'queued', attachments: [{ assetPath: 'asset-a' }] }, {
    consumeDraft: false,
    recordFailedPayload: false,
  });
  const settlement = store.settleFailed(receipt, { sessionId: 's1' });
  assert.equal(settlement.failedPayload, null);
  assert.equal(state.failedSendPayloadsById.size, 0);
  assert.deepEqual(released, ['asset-a'], 'an orphaned outbox receipt releases its managed asset');
});

test('a failed outbox receipt leaves assets with its still-visible queue entry', () => {
  const { store, state, released } = createStoreEnv();
  const attachment = { assetPath: 'asset-a' };
  const receipt = store.begin({ sessionId: 's1', prompt: 'queued', attachments: [attachment] }, {
    consumeDraft: false,
    recordFailedPayload: false,
  });
  state.sendOutboxBySession = new Map([['s1', [{
    id: 'outbox-1', attachmentOwner: 'send_receipt', attachments: [attachment],
  }]]]);

  store.settleFailed(receipt, { sessionId: 's1' });
  assert.deepEqual(released, []);
});

test('dispose makes late settlement inert and releases owned assets once', () => {
  const env = createStoreEnv();
  const receipt = beginOriginReceipt(env);

  env.store.dispose();
  env.store.dispose();

  assert.deepEqual(env.released, ['C:/managed/a.png']);
  assert.deepEqual(env.store.settleFailed(receipt, { retryable: true }), {
    ignored: true,
    restoredToComposer: false,
    failedPayload: null,
  });
  assert.equal(env.store.getRetryAvailability('missing').available, false);
});
