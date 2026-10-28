'use strict';

// Owner report 2026-10-27 (primary chat): the New session preparation turn was cancelled by its
// 60 s deadline before the model's first token, the turn's own Retry then replayed the label
// "Preparing a new chat" as an ordinary prompt (complete_session_handoff is unavailable there),
// and after a chat switch the "Jenny took 2 notes" row sat below the retried turn's live
// reasoning. The deadline staging lives in chat-proposal-session-service.test.js and
// session-handoff-preparation.test.js; this file pins the Retry gate and the note order.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { appendOffTurnMessages } = require('../services/backend/session-off-turn-messages');
const { resolveReanchoredHistory } = require('../services/backend/session-turn-events');
const { persistUserTurn } = require('../services/backend/chat-stream-session-lifecycle');
const { createManagedChatStreamRuntime } = require('../services/backend/chat-stream-managed-runtime');
const { assertRegenerateAnchorAdmissible } = require('../services/backend/chat-turn-admission');
const { APPLICATION_TURN_HANDOFF_PREPARATION } = require('../services/backend/session-handoff-context');
const { BackendService } = require('../services/backend/backend-service');
const { reconcileAcceptedRegenerate } = require('../renderer/chat/renderer-send-flow-helpers');
const { buildMessageActionModel, resolveRegenerateRequest } = require('../renderer/chat/chat-bubble-action-utils');
const { renderTimelineErrorCard } = require('../renderer/chat/renderer-error-recovery-utils');
const { resolveHandoffPreparationErrorNotice } = require('../renderer/chat/renderer-turn-row-model-utils');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

const SESSION_ID = 'session-primary-1027';
const NOTE_ID = 'memory_note_reflect_session_primary_1027_0';

function storeFixture(t) {
  const scratch = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'retry-note-order-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  store.createSessionWithId(SESSION_ID, { title: 'Primary' });
  return store;
}

function noteReceipt() {
  const at = new Date().toISOString();
  return {
    id: NOTE_ID, role: 'assistant', kind: 'memory_note', content: '', status: 'complete', timestamp: at, finalizedAt: at,
    memory_notes: [0, 1].map((index) => ({
      result_kind: 'memory', action: 'remember', status: 'saved', operation_id: `reflect:${SESSION_ID}:0123456789abcdef:${index}`,
      scope: 'project', kind: index ? 'preference' : 'fact', undoable: true, text_preview: `Note ${index}`, origin: 'reflection',
    })),
  };
}

// A failed turn, then (while the chat is idle) a reflection receipt, which is how the receipt
// ended up after the turn the Retry re-opens.
function seedFailedTurnThenNote(store) {
  store.appendMessage(SESSION_ID, { id: 'user_stream_a', role: 'user', content: 'Review the debt register.', turn_id: 'turn_a' });
  store.appendMessage(SESSION_ID, {
    id: 'assistant_stream_a', role: 'assistant', content: '', status: 'runtime_error', turn_id: 'turn_a',
    parent_stream_id: 'stream_a', stream_error: 'Model stopped responding.', error_code: 'CMP-AI-0005', retryable: true,
  });
  const appended = appendOffTurnMessages(store, SESSION_ID, [noteReceipt()]);
  assert.deepEqual(appended, { ok: true, appended: 1 });
}

const ids = (messages) => messages.map((message) => message.id);

test('a Retry lifts a reflection receipt above the reused prompt, in both stores\' shared re-anchor', (t) => {
  const store = storeFixture(t);
  seedFailedTurnThenNote(store);
  assert.deepEqual(ids(store.getSessionMessages(SESSION_ID)), ['user_stream_a', 'assistant_stream_a', NOTE_ID]);

  const retried = store.truncateAfterMessage(SESSION_ID, 'user_stream_a', {
    replaceMessageContent: 'Review the debt register.', replaceMessageTurnId: 'turn_b', preserveSupersededTurn: true,
  });
  assert.ok(retried);
  store.appendMessage(SESSION_ID, { id: 'assistant_stream_b', role: 'assistant', content: 'Three items are stale.',
    status: 'complete', turn_id: 'turn_b', parent_stream_id: 'stream_b' });
  assert.deepEqual(ids(store.getSessionMessages(SESSION_ID)),
    [NOTE_ID, 'user_stream_a', 'assistant_stream_a', 'assistant_stream_b'],
    'the receipt sits above the prompt, never between the prompt and its new answer');
});

test('an edit keeps a reflection receipt above the prompt instead of deleting it', () => {
  const messages = [
    { id: 'user_a', role: 'user', content: 'Old' },
    { id: 'assistant_a', role: 'assistant', content: 'Reply' },
    { id: NOTE_ID, role: 'assistant', kind: 'memory_note' },
  ];
  const edited = { ...messages[0], content: 'New' };
  const out = resolveReanchoredHistory({ messages, targetIndex: 0, targetId: 'user_a', survivingTarget: edited, turnEvents: [] });
  assert.deepEqual(ids(out.messages), [NOTE_ID, 'user_a']);
  assert.equal(out.messages[1].content, 'New');
});

test('the renderer\'s optimistic regenerate moves the receipt the same way as the store', () => {
  const messages = [
    { id: 'user_stream_a', role: 'user', content: 'Review the debt register.' },
    { id: 'assistant_stream_a', role: 'assistant', status: 'error', content: '' },
    { id: NOTE_ID, role: 'assistant', kind: 'memory_note', content: '' },
  ];
  const reconcile = (failureRetry) => {
    let next = null;
    reconcileAcceptedRegenerate({
      sessionId: SESSION_ID, sourceMessageId: 'user_stream_a', targetMessageId: 'assistant_stream_a',
      startResult: { identity: { userMessageId: 'user_stream_a' } }, ...(failureRetry ? { failureRetry: true } : {}),
    }, {
      getSessionMessages: () => messages, setSessionMessages: (_id, list) => { next = list; },
      patchSessionSummary() {}, clearProjectionContextCacheForSession() {}, renderAll() {}, appendClientLog() {},
    });
    return ids(next);
  };
  assert.deepEqual(reconcile(true), [NOTE_ID, 'user_stream_a', 'assistant_stream_a']);
  assert.deepEqual(reconcile(false), [NOTE_ID, 'user_stream_a']);
});

// The live view after the chat switch: the turn tree draws a turn as one block at its prompt and
// a receipt as its own row in message order, so where the store keeps the receipt is where it
// renders. Rendering the pre-fix order first shows the reported shape.
async function renderedOrder(t, messages) {
  const at = new Date().toISOString();
  const app = await loadRendererApp({ shell: {
    sessions: [{ id: SESSION_ID, title: 'Primary', session_type: 'chat', conversation_mode: 'chat', preferred_model: 'm',
      reasoning_effort: 'default', plan_mode: false, pinned: false, archived_at: null, linked_session_ids: [],
      context_preferences: { history_scope: 'session' }, interactive_round_count: 0, interactive_sequence_state: 'idle',
      pending_question_batch: null, message_count: messages.length, updated_at: at }],
    workspaceState: { activeSessionId: SESSION_ID, openSessionIds: [SESSION_ID] },
    sessionMessagePayloads: { [SESSION_ID]: { data: messages } },
  } });
  t.after(() => app.dispose());
  await waitForUi(app.window, 150);
  const text = app.window.document.getElementById('chatTimeline').textContent;
  const at3 = (needle) => {
    const index = text.indexOf(needle);
    assert.ok(index >= 0, `${needle} renders`);
    return index;
  };
  return { note: at3('Jenny took 2 notes'), prompt: at3('Review the debt register.'), answer: at3('Three items are stale.') };
}

const timestamped = (messages) => messages.map((message, index) => ({
  ...message, timestamp: new Date(Date.now() - (60 - index) * 1000).toISOString(),
  ...(message.role === 'assistant' ? { finalizedAt: new Date().toISOString() } : {}),
}));
const PROMPT = { id: 'user_stream_a', role: 'user', content: 'Review the debt register.', status: 'complete' };
const FAILED = { id: 'assistant_stream_a', role: 'assistant', content: '', status: 'cancelled', streamId: 'stream_a',
  stream_error: 'Stream cancelled.', error_code: 'CMP-SIDECAR-0002', recovery_class: 'cancelled' };
const ANSWER = { id: 'assistant_stream_b', role: 'assistant', content: 'Three items are stale.', status: 'complete', streamId: 'stream_b' };

test('the reported order draws the receipt below the retried turn; the re-anchored order draws it above', async (t) => {
  const reported = await renderedOrder(t, timestamped([PROMPT, FAILED, noteReceipt(), ANSWER]));
  assert.ok(reported.note > reported.answer, 'pre-fix: the receipt renders after the retried answer');

  const fixed = await renderedOrder(t, timestamped([noteReceipt(), PROMPT, FAILED, ANSWER]));
  assert.ok(fixed.note < fixed.prompt && fixed.prompt < fixed.answer, 'receipt, then the prompt, then its answer');
});

// ---------- the preparation turn cannot be retried as an ordinary prompt ----------

const prepAnchor = { id: 'user_stream_prep', role: 'user', content: 'Preparing a new chat',
  application_turn: APPLICATION_TURN_HANDOFF_PREPARATION };
const prepReply = { id: 'assistant_stream_prep', role: 'assistant', content: '', status: 'cancelled',
  stream_error: 'Stream cancelled.', error_code: 'CMP-SIDECAR-0002', recovery_class: 'cancelled',
  terminal_subcode: 'handoff_deadline', retryable: true };

test('the preparation turn\'s prompt is persisted with its application_turn marker', () => {
  const appended = [];
  persistUserTurn({ appendMessage: (message) => { appended.push(message); return { id: SESSION_ID }; } }, {
    messageId: 'user_stream_prep', content: 'Preparing a new chat', attachments: [], application_turn: APPLICATION_TURN_HANDOFF_PREPARATION,
  });
  persistUserTurn({ appendMessage: (message) => { appended.push(message); return { id: SESSION_ID }; } }, {
    messageId: 'user_plain', content: 'Hello', attachments: [],
  });
  assert.equal(appended[0].application_turn, 'handoff_preparation');
  assert.equal(Object.hasOwn(appended[1], 'application_turn'), false, 'an ordinary prompt carries no marker');
});

test('the managed runtime stamps the marker through the real store', (t) => {
  const store = storeFixture(t);
  // No turn lease: the runtime claims the active turn on the real store itself.
  const runtime = createManagedChatStreamRuntime({
    service: { sessionStore: store, _emitServiceLog() {} }, resolvedSessionId: SESSION_ID, streamId: 'stream_prep',
    normalizedPreferences: { conversation_mode: 'chat', interactive_round_count: 0 }, normalizedInteractiveResponse: null,
    normalizedAttachments: [], transcriptPrompt: 'Preparing a new chat', userMessageId: 'user_stream_prep',
    applicationTurn: APPLICATION_TURN_HANDOFF_PREPARATION,
  });
  assert.equal(runtime.persistUserMessage(), true);
  const persisted = store.getSessionMessages(SESSION_ID).find((message) => message.id === 'user_stream_prep');
  assert.equal(persisted.application_turn, 'handoff_preparation');
});

test('editAndRegenerate refuses a preparation turn\'s prompt and admits an ordinary one', async () => {
  const messages = [prepAnchor, prepReply, { id: 'user_plain', role: 'user', content: 'Hello' }];
  const service = { sessionStore: { getSession: () => ({ messages }) } };
  assert.throws(() => assertRegenerateAnchorAdmissible(service, SESSION_ID, 'user_stream_prep'),
    (error) => error.code === 'handoff_preparation_retry_refused' && error.retryable === false);
  assert.doesNotThrow(() => assertRegenerateAnchorAdmissible(service, SESSION_ID, 'user_plain'));

  const started = [];
  const receiver = { ...service, startChatStream: async (payload) => { started.push(payload); return {}; } };
  await assert.rejects(BackendService.prototype.editAndRegenerate.call(receiver,
    { sessionId: SESSION_ID, editedMessageId: 'user_stream_prep', failureRetry: true }),
  (error) => error.code === 'handoff_preparation_retry_refused');
  assert.equal(started.length, 0, 'no ordinary turn starts');
});

test('the renderer offers no Retry, Regenerate or Edit for a preparation turn', () => {
  const messages = [prepAnchor, prepReply];
  const request = resolveRegenerateRequest('assistant_stream_prep', messages, { allowErrorTarget: true });
  assert.equal(request.allowed, false);
  assert.equal(request.reason, 'Retry this from the New session card.');
  assert.equal(buildMessageActionModel(prepAnchor, {}).actions.edit.visible, false);
  assert.equal(buildMessageActionModel({ ...prepAnchor, application_turn: undefined }, {}).actions.edit.visible, true);

  assert.equal(resolveHandoffPreparationErrorNotice(prepReply, messages), true);
  assert.equal(resolveHandoffPreparationErrorNotice(prepReply, [{ ...prepAnchor, application_turn: undefined }, prepReply]), false);
  const card = renderTimelineErrorCard({ ...prepReply, recovery_title: 'New chat took too long to prepare', retryUnavailable: true });
  assert.match(card, /New chat took too long to prepare/);
  assert.doesNotMatch(card, /data-(?:error-)?action="(?:retry|retry_turn)"/);
  const ordinary = renderTimelineErrorCard({ ...prepReply, recovery_title: 'Turn cancelled' });
  assert.match(ordinary, /Regenerate response/, 'control: an ordinary cancelled card still offers Regenerate');
  assert.doesNotMatch(card, /Regenerate response/);
});
