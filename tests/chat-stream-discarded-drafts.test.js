'use strict';

// Discarded-drafts receipt: a metadata-only { count, latest_reason } persisted
// on the final assistant message of a successfully completed turn after the
// sidecar's tool loop discarded streamed reply text (chat.stream_reset).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  noteDiscardedDraft,
  buildTerminalMessageExtras,
  normalizeDiscardedDrafts,
} = require('../services/backend/chat-stream-discarded-drafts');
const {
  handleNotification,
} = require('../services/backend/chat-stream-managed-runtime-notifications');
const {
  createManagedChatStreamRuntime,
} = require('../services/backend/chat-stream-managed-runtime');
const {
  settleManagedAssistantCompletion,
} = require('../services/backend/chat-stream-managed-terminal-settlement');
const {
  buildAssistantCompletionTerminalMutation,
} = require('../services/backend/chat-stream-session-lifecycle');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const {
  makeCtx,
  makeHandleToolNotification,
} = require('./helpers/managed-runtime-notification-harness');

test('noteDiscardedDraft counts uncapped, latest reason wins, empty reason is unknown', () => {
  let drafts = null;
  for (let i = 0; i < 9; i += 1) drafts = noteDiscardedDraft(drafts, `r${i}`);
  assert.deepEqual(drafts, { count: 9, latest_reason: 'r8' });
  const before = noteDiscardedDraft(null, 'a');
  const after = noteDiscardedDraft(before, '  ');
  assert.deepEqual(before, { count: 1, latest_reason: 'a' }, 'returns a new object');
  assert.deepEqual(after, { count: 2, latest_reason: 'unknown' });
  assert.equal(noteDiscardedDraft(null, 'x'.repeat(200)).latest_reason.length, 64);
});

test('normalizeDiscardedDrafts accepts valid shapes and rejects the rest', () => {
  assert.deepEqual(normalizeDiscardedDrafts({ count: 2, latest_reason: ' provider_retry ' }), {
    count: 2, latest_reason: 'provider_retry',
  });
  assert.deepEqual(normalizeDiscardedDrafts({ count: 1, latest_reason: '' }), {
    count: 1, latest_reason: 'unknown',
  });
  for (const bad of [null, undefined, 3, 'x', [], { count: 0, latest_reason: 'a' },
    { count: 1.5, latest_reason: 'a' }, { count: '2', latest_reason: 'a' }, { count: 2 },
    { count: 2, latest_reason: 7 }]) {
    assert.equal(normalizeDiscardedDrafts(bad), null);
  }
  assert.equal(normalizeDiscardedDrafts({ count: 1, latest_reason: 'y'.repeat(65) }).latest_reason.length, 64);
});

test('buildTerminalMessageExtras omits absent fields', () => {
  assert.deepEqual(buildTerminalMessageExtras({}), {});
  assert.deepEqual(buildTerminalMessageExtras({ resumableStop: null, discardedDrafts: { count: 0 } }), {});
  assert.deepEqual(
    buildTerminalMessageExtras({ resumableStop: 'max_iterations', discardedDrafts: { count: 2, latest_reason: 'a' } }),
    { resumable_stop: 'max_iterations', discarded_drafts: { count: 2, latest_reason: 'a' } },
  );
});

function resetCtx({ assistantText = '', currentSegmentText = '', persisted = [], reasoning = [] } = {}) {
  const ctx = makeCtx();
  ctx.assistantText = assistantText;
  ctx.currentSegmentText = currentSegmentText;
  ctx.reasoningEntries = reasoning;
  ctx.persistedTextSegmentIds = persisted;
  ctx.refusedTextSegments = [];
  ctx.textSegmentIndex = persisted.length;
  ctx.discardedDrafts = null;
  return ctx;
}

function reset(ctx, reason) {
  handleNotification(
    ctx,
    { method: 'chat.stream_reset', params: { reason } },
    { toolContext: {}, handleToolNotification: makeHandleToolNotification(ctx) },
  );
}

test('reset counting: empty and tool_continuation resets are not counted', () => {
  const empty = resetCtx();
  reset(empty, 'provider_retry');
  assert.equal(empty.discardedDrafts, null);

  const cont = resetCtx({ assistantText: 'Looking.', currentSegmentText: 'Looking.' });
  reset(cont, 'tool_continuation');
  assert.equal(cont.discardedDrafts, null);
});

test('reset counting: model_winddown with an empty live slice is not counted, with text it is', () => {
  const wind = resetCtx({ assistantText: 'Persisted.', persisted: ['seg0'] });
  reset(wind, 'model_winddown');
  assert.equal(wind.discardedDrafts, null);

  const live = resetCtx({ assistantText: 'Persisted. draft', currentSegmentText: ' draft', persisted: ['seg0'] });
  reset(live, 'model_winddown');
  assert.deepEqual(live.discardedDrafts, { count: 1, latest_reason: 'model_winddown' });

  // Turn-wide reasoning (already saved with seg0) is not this slice's: no count.
  const savedReasoning = resetCtx({ persisted: ['seg0'], reasoning: [{ text: 'thinking' }] });
  reset(savedReasoning, 'model_winddown');
  assert.equal(savedReasoning.discardedDrafts, null);

  const reasoningOnly = resetCtx({ persisted: ['seg0'], reasoning: [{ text: 'thinking' }] });
  reasoningOnly.transcriptCollector.slice = { phases: [{ phase_kind: 'reasoning', entries: [{ text: 'live' }] }] };
  reset(reasoningOnly, 'model_winddown');
  assert.equal(reasoningOnly.discardedDrafts?.count, 1);
});

test('reset counting: discarding resets count and keep the latest reason across resets', () => {
  const ctx = resetCtx({ assistantText: 'Streamed.', currentSegmentText: 'Streamed.' });
  reset(ctx, 'provider_retry');
  assert.deepEqual(ctx.discardedDrafts, { count: 1, latest_reason: 'provider_retry' });
  ctx.assistantText = 'Again.';
  ctx.currentSegmentText = 'Again.';
  reset(ctx, 'nudge_retry');
  assert.deepEqual(ctx.discardedDrafts, { count: 2, latest_reason: 'nudge_retry' });
});

test('reset counting: a discard of only persisted segments counts', () => {
  const ctx = resetCtx({ persisted: ['seg0'] });
  reset(ctx, 'post_tool_restart');
  assert.equal(ctx.discardedDrafts?.count, 1);
});

function runtimeHarness(suffix) {
  const emitted = [];
  const persisted = [];
  const patches = [];
  const service = {
    featureFlags: {},
    emit(eventName, payload) { emitted.push({ eventName, payload }); },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) { persisted.push(message); return message; },
      updateMessage(sessionId, id, patch) { patches.push({ sessionId, id, patch }); return { id }; },
      setSessionPreferences() {},
      getActiveTurn() { return null; },
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
      getSessionMessages() { return persisted.slice(); },
      replaceMessages() {},
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: `session_${suffix}`,
    streamId: `stream_${suffix}`,
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user_${suffix}`,
  });
  const deps = { toolContext: {}, handleToolNotification() {} };
  const send = (method, params) => runtime.handleNotification({ method, params }, deps);
  const complete = () => emitted.find((e) => e.eventName === 'chat-stream' && e.payload?.type === 'complete');
  return { runtime, send, emitted, persisted, patches, complete };
}

test('successful completion after a discarding reset persists discarded_drafts (base append path)', async () => {
  const h = runtimeHarness('base');
  h.send('chat.token', { delta: 'Bad draft.' });
  h.send('chat.stream_reset', { reason: 'provider_retry' });
  h.send('chat.token', { delta: 'Good answer.' });
  h.send('chat.done', { stop_reason: 'end_turn' });
  await h.runtime.settleTerminalResult({ status: 'completed' });

  assert.equal(h.persisted.length, 1);
  assert.equal(h.persisted[0].content, 'Good answer.');
  assert.deepEqual(h.persisted[0].discarded_drafts, { count: 1, latest_reason: 'provider_retry' });
  assert.equal(JSON.stringify(h.persisted[0].discarded_drafts).includes('Bad draft'), false);
  assert.deepEqual(h.complete().payload.discardedDrafts, { count: 1, latest_reason: 'provider_retry' });
});

test('a turn with no discarding reset carries no discarded_drafts', async () => {
  const h = runtimeHarness('none');
  h.send('chat.token', { delta: 'Fine.' });
  h.send('chat.done', { stop_reason: 'end_turn' });
  await h.runtime.settleTerminalResult({ status: 'completed' });
  assert.equal(Object.hasOwn(h.persisted[0], 'discarded_drafts'), false);
  assert.equal(Object.hasOwn(h.complete().payload, 'discardedDrafts'), false);
});

test('segmented finalize carries discarded_drafts on the final slice', async () => {
  const h = runtimeHarness('seg');
  h.send('chat.token', { delta: 'Looking.' });
  h.send('tool.executing', { tool_call_id: 'call_1', tool_name: 'read_file' });
  h.send('chat.token', { delta: 'junk' });
  h.send('chat.stream_reset', { reason: 'model_winddown' });
  h.send('chat.token', { delta: 'Final.' });
  h.send('chat.done', { stop_reason: 'end_turn' });
  await h.runtime.settleTerminalResult({ status: 'completed' });

  const final = h.persisted.find((m) => m.content === 'Final.');
  assert.ok(final);
  assert.deepEqual(final.discarded_drafts, { count: 1, latest_reason: 'model_winddown' });
  assert.equal(Object.hasOwn(h.persisted.find((m) => m.content === 'Looking.'), 'discarded_drafts'), false);
});

test('no final slice: the receipt patches the last persisted segment', async () => {
  const h = runtimeHarness('noslice');
  h.send('chat.token', { delta: 'Bad.' });
  h.send('chat.stream_reset', { reason: 'provider_retry' });
  h.send('chat.token', { delta: 'Looking.' });
  h.send('tool.executing', { tool_call_id: 'call_1', tool_name: 'read_file' });
  h.send('chat.done', { stop_reason: 'end_turn' });
  await h.runtime.settleTerminalResult({ status: 'completed' });

  assert.equal(h.persisted.length, 1, 'only the boundary segment exists');
  assert.equal(h.patches.length, 1);
  assert.equal(h.patches[0].id, h.persisted[0].id);
  assert.deepEqual(h.patches[0].patch, { discarded_drafts: { count: 1, latest_reason: 'provider_retry' } });
});

test('coordinator path: terminal mutation and complete payload carry discarded_drafts', async () => {
  const captured = [];
  const identity = { sessionId: 's', sessionIncarnation: 'i', generation: 1, turnId: 't', streamId: 'st', userMessageId: 'u' };
  const slice = { phases: [], visibleSegments: [], toolSteps: [] };
  const ctx = {
    service: { terminalCoordinator: { async settle(request) { captured.push(request); return { ok: true, visibleTerminal: true, durableTerminal: true }; } } },
    turnLease: { identity, store: { getSessionMessages: () => [], commitTerminal() {} } },
    streamId: 'st', resolvedSessionId: 's', assistantBaseMessageId: 'assistant_st',
    assistantText: 'Answer.', currentSegmentText: 'Answer.', textSegmentIndex: 0,
    hasPersistedSegments: false, persistedTextSegmentIds: [], refusedTextSegments: [],
    reasoningEntries: [], model: 'local', normalizedPreferences: {}, normalizedInteractiveResponse: null,
    exchangeTitle: '', eventBase: { streamId: 'st' }, turnUsage: null, unfinishedToolRepairs: [],
    turnEventCollector: { retargetCapturedEvents() { return 0; } },
    transcriptCollector: { slice, completeCurrentPhase() {}, resetSlice() {} },
    visibleCompletionEmitted: false, terminalPersistRefused: false, visibleAssistantMessageId: '',
    onVisibleCompletion() {}, streamSawBatch: false, terminalCoordinatorHandled: false,
    discardedDrafts: { count: 3, latest_reason: 'nudge_retry' },
  };
  await settleManagedAssistantCompletion(ctx);
  assert.deepEqual(captured[0].messages[0].discarded_drafts, { count: 3, latest_reason: 'nudge_retry' });
  assert.deepEqual(captured[0].terminal.rendererPayload.discardedDrafts, { count: 3, latest_reason: 'nudge_retry' });

  // Empty trailing slice after saved segments: no final message, so the
  // receipt is patched onto the last saved segment once the settle lands.
  const patches = [];
  const segmented = {
    ...ctx, assistantText: 'Looking.', currentSegmentText: '', hasPersistedSegments: true,
    persistedTextSegmentIds: ['seg0', 'seg1'], terminalCoordinatorHandled: false,
    service: { ...ctx.service, sessionStore: { updateMessage: (s, id, patch) => patches.push({ id, patch }) } },
  };
  await settleManagedAssistantCompletion(segmented);
  assert.equal(captured[1].messages.length, 0);
  assert.deepEqual(patches, [{ id: 'seg1', patch: { discarded_drafts: { count: 3, latest_reason: 'nudge_retry' } } }]);

  // Refused segments only: the receipt rides on the last refused segment.
  const refused = {
    ...segmented, persistedTextSegmentIds: [], hasPersistedSegments: false,
    refusedTextSegments: [{ id: 'r0', role: 'assistant', content: 'A' }, { id: 'r1', role: 'assistant', content: 'B' }],
  };
  await settleManagedAssistantCompletion(refused);
  assert.deepEqual(captured[2].messages.map((m) => m.discarded_drafts?.count), [undefined, 3]);
  assert.equal(patches.length, 1);
  // Astra: a failed (non-durable) settle must not patch saved metadata.
  const failing = {
    ...segmented, terminalCoordinatorHandled: false,
    service: { ...segmented.service, terminalCoordinator: { async settle(request) { captured.push(request); return { ok: false, visibleTerminal: false, durableTerminal: false }; } } },
  };
  await settleManagedAssistantCompletion(failing);
  assert.equal(patches.length, 1, 'no patch after a non-durable settle');

  // Astra: a reasoning-only trailing message or segment never carries the
  // receipt (it renders under a text row); the last text-bearing one does.
  const reasoningTail = {
    ...segmented, currentSegmentText: '', terminalCoordinatorHandled: false,
    transcriptCollector: { ...ctx.transcriptCollector, slice: { ...slice, phases: [{ phase_kind: 'reasoning', entries: [{ text: 'hm' }] }] } },
    service: {
      ...segmented.service,
      sessionStore: {
        getSessionMessages: () => [{ id: 'seg0', content: 'Answer' }, { id: 'seg1', content: '' }],
        updateMessage: (s, id, patch) => patches.push({ id, patch }),
      },
    },
  };
  await settleManagedAssistantCompletion(reasoningTail);
  const finalMessage = captured[captured.length - 1].messages.at(-1);
  assert.equal(finalMessage.discarded_drafts, undefined, 'reasoning-only final message carries no receipt');
  assert.equal(patches.at(-1).id, 'seg0', 'patched onto the last text-bearing segment');

  const blankRefusedTail = {
    ...refused, terminalCoordinatorHandled: false,
    refusedTextSegments: [{ id: 'r0', role: 'assistant', content: 'A' }, { id: 'r1', role: 'assistant', content: '' }],
  };
  await settleManagedAssistantCompletion(blankRefusedTail);
  assert.deepEqual(captured.at(-1).messages.map((m) => m.discarded_drafts?.count), [3, undefined]);
});

test('terminal mutation builder emits discarded_drafts only for a valid receipt', () => {
  const base = { messageId: 'assistant_x', content: 'Hi', reasoningEntries: [] };
  const withDrafts = buildAssistantCompletionTerminalMutation({ ...base, discardedDrafts: { count: 2, latest_reason: 'a' } });
  assert.deepEqual(withDrafts.messages[0].discarded_drafts, { count: 2, latest_reason: 'a' });
  const without = buildAssistantCompletionTerminalMutation(base);
  assert.equal(Object.hasOwn(without.messages[0], 'discarded_drafts'), false);
});

test('message normalization keeps a valid discarded_drafts and drops an invalid one', () => {
  const valid = normalizeMessageFields({ id: 'a', role: 'assistant', content: 'x', discarded_drafts: { count: 2, latest_reason: ' r ' } });
  assert.deepEqual(valid.discarded_drafts, { count: 2, latest_reason: 'r' });
  const invalid = normalizeMessageFields({ id: 'a', role: 'assistant', content: 'x', discarded_drafts: { count: 0, text: 'leak' } });
  assert.equal(Object.hasOwn(invalid, 'discarded_drafts'), false);
});
