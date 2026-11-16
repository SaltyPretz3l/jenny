const assert = require('node:assert/strict');
const test = require('node:test');

const {
  adoptPersistedUserMessageId,
  buildDurableFailureMessage,
  buildOptimisticAttachmentMetadata,
  buildSendFailureMetadata,
  cloneJsonLike,
  cloneQueuedAttachments,
  clipSessionTitle,
  findPendingUserQuestionRef,
  replyToPendingUserQuestions,
  resolveMessageCopyText,
  summarizeDurableFailurePreview,
  syncQuestionReplyPlaceholder,
} = require('../renderer/chat/renderer-send-flow-helpers');
const { createControllerHarness } = require('./helpers/send-controller-harness');

function makeMessageStore(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getSessionMessages: (sessionId) => map.get(sessionId) || [],
    setSessionMessages: (sessionId, messages) => { map.set(sessionId, messages); },
    read: (sessionId) => map.get(sessionId),
  };
}

test('send-flow helpers normalize titles and copy text from visible message segments', () => {
  assert.equal(clipSessionTitle('  New   thread  '), 'New thread');
  assert.equal(clipSessionTitle(''), 'New Chat');
  const longTitle = clipSessionTitle('x'.repeat(120));
  assert.equal(longTitle.length, 80);
  assert.equal(longTitle.endsWith('...'), true);

  assert.equal(resolveMessageCopyText({
    visible_segments: [{ text: 'hello' }, { text: '' }, { text: ' world' }],
    content: 'fallback',
  }), 'hello world');
  assert.equal(resolveMessageCopyText({ visible_segments: [], content: 'fallback' }), 'fallback');
});

test('copy text drops source markers only when the source_citations flag is on', () => {
  const message = { role: 'assistant', visible_segments: [{ text: 'Fact [web:1] and more【web:2】 and [web:1,3].' }], content: 'ignored' };
  assert.equal(resolveMessageCopyText(message, { source_citations: true }), 'Fact and more and.');
  assert.equal(resolveMessageCopyText({ role: 'assistant', content: 'Plain [web:2] text' }, { source_citations: true }), 'Plain text');
  assert.equal(resolveMessageCopyText({ role: 'user', content: 'My note [web:2]' }, { source_citations: true }), 'My note [web:2]', 'a user message keeps what was typed');
  assert.equal(resolveMessageCopyText(message, { source_citations: false }), 'Fact [web:1] and more【web:2】 and [web:1,3].');
  assert.equal(resolveMessageCopyText(message), 'Fact [web:1] and more【web:2】 and [web:1,3].');
  assert.equal(resolveMessageCopyText({ role: 'assistant', content: 'Keep\n\n[web:1] para' }, { source_citations: true }), 'Keep\n\n para');
});

test('send-flow clone helpers scrub unsafe keys and tolerate cycles', () => {
  const source = {
    safe: { value: 1 },
    constructor: { polluted: true },
  };
  source.self = source;

  const cloned = cloneJsonLike(source);
  assert.deepEqual(cloned.safe, { value: 1 });
  assert.equal(Object.hasOwn(cloned, 'constructor'), false);
  assert.equal(cloned.self, null);

  const attachments = [{ id: 'att-1', nested: { ok: true } }];
  const clonedAttachments = cloneQueuedAttachments(attachments);
  assert.deepEqual(clonedAttachments, attachments);
  assert.notEqual(clonedAttachments, attachments);
  assert.notEqual(clonedAttachments[0], attachments[0]);
});

test('send-flow helpers build optimistic attachment metadata by kind', () => {
  assert.deepEqual(buildOptimisticAttachmentMetadata([
    {
      id: 'image-1',
      kind: 'image',
      displayName: 'Image',
      mimeType: 'image/png',
      sizeBytes: 12,
      width: 100,
      height: 80,
      assetPath: 'asset://image',
      sourceKind: 'upload',
    },
    {
      id: 'audio-1',
      kind: 'audio',
      displayName: 'Audio',
      mimeType: 'audio/wav',
      sizeBytes: 34,
      durationMs: 250,
      assetPath: 'asset://audio',
      sourceKind: 'upload',
      transcriptText: 'hello',
      transcriptStatus: 'complete',
      transcriptLanguage: 'en',
    },
    {
      id: 'text-1',
      kind: 'text',
      displayName: 'Notes',
      promptName: 'notes',
      extension: '.txt',
      sizeBytes: 56,
      budgetTruncated: true,
    },
  ]), [
    {
      id: 'image-1',
      kind: 'image',
      displayName: 'Image',
      mimeType: 'image/png',
      sizeBytes: 12,
      width: 100,
      height: 80,
      assetPath: 'asset://image',
      sourceKind: 'upload',
    },
    {
      id: 'audio-1',
      kind: 'audio',
      displayName: 'Audio',
      mimeType: 'audio/wav',
      sizeBytes: 34,
      durationMs: 250,
      assetPath: 'asset://audio',
      sourceKind: 'upload',
      transcriptText: 'hello',
      transcriptStatus: 'complete',
      transcriptLanguage: 'en',
    },
    {
      id: 'text-1',
      kind: 'text',
      displayName: 'Notes',
      promptName: 'notes',
      extension: '.txt',
      sizeBytes: 56,
      truncated: true,
    },
  ]);
});

test('send-flow helpers build durable failure metadata and previews', () => {
  const error = {
    message: 'transport down',
    code: 'CMP-CHAT-0042',
    retryable: false,
    category: 'transport',
  };
  const metadata = buildSendFailureMetadata(error, { restoredToComposer: true });
  assert.equal(metadata.state, 'failed');
  assert.equal(metadata.error_code, 'CMP-CHAT-0042');
  assert.equal(metadata.retryable, false);
  assert.equal(metadata.restored_to_composer, true);
  assert.equal(typeof metadata.failed_at, 'string');

  const durable = buildDurableFailureMessage(error, 'session-1', (role, content, extra) => ({
    role,
    content,
    ...extra,
  }));
  assert.equal(durable.role, 'assistant');
  assert.equal(durable.status, 'error');
  assert.equal(durable.stream_error, 'transport down');
  assert.equal(durable.error_code, 'CMP-CHAT-0042');
  assert.equal(durable.session_id, 'session-1');

  assert.equal(summarizeDurableFailurePreview(' prompt text ', durable), 'prompt text');
  assert.equal(summarizeDurableFailurePreview('', durable), 'transport down');
});

test('adoptPersistedUserMessageId renames the optimistic bubble in place to the persisted id', () => {
  const store = makeMessageStore({
    'session-1': [
      { id: 'user_local_111', role: 'user', content: 'Hello', client_message_id: 'user_local_111' },
      { id: 'assistant_stream-x', role: 'assistant', content: 'Hi' },
    ],
  });

  const changed = adoptPersistedUserMessageId(store, 'session-1', 'user_local_111', 'user_stream-x');
  assert.equal(changed, true);

  const messages = store.read('session-1');
  assert.equal(messages.length, 2, 'no row is appended or removed when renaming');
  assert.equal(messages[0].id, 'user_stream-x', 'optimistic id is rewritten in its canonical position');
  assert.equal(messages[0].client_message_id, 'user_stream-x', 'client_message_id is rewritten too');
  assert.equal(messages[0].content, 'Hello', 'content is preserved');
  assert.equal(messages[1].id, 'assistant_stream-x', 'other rows are untouched');
});

test('adoptPersistedUserMessageId drops the optimistic copy when the persisted twin already exists (race guard)', () => {
  const store = makeMessageStore({
    'session-1': [
      { id: 'user_stream-x', role: 'user', content: 'Hello' },
      { id: 'user_local_111', role: 'user', content: 'Hello' },
    ],
  });

  const changed = adoptPersistedUserMessageId(store, 'session-1', 'user_local_111', 'user_stream-x');
  assert.equal(changed, true);

  const ids = store.read('session-1').map((message) => message.id);
  assert.deepEqual(ids, ['user_stream-x'], 'the optimistic duplicate is removed, never producing two rows with one id');
});

test('adoptPersistedUserMessageId is a no-op for equal ids, missing rows, or empty stores', () => {
  const equalStore = makeMessageStore({ 'session-1': [{ id: 'user_stream-x', role: 'user', content: 'Hi' }] });
  assert.equal(adoptPersistedUserMessageId(equalStore, 'session-1', 'user_stream-x', 'user_stream-x'), false);
  assert.deepEqual(equalStore.read('session-1').map((m) => m.id), ['user_stream-x']);

  const missingStore = makeMessageStore({ 'session-1': [{ id: 'assistant_stream-x', role: 'assistant', content: 'Hi' }] });
  assert.equal(adoptPersistedUserMessageId(missingStore, 'session-1', 'user_local_999', 'user_stream-x'), false);
  assert.deepEqual(missingStore.read('session-1').map((m) => m.id), ['assistant_stream-x']);

  const emptyStore = makeMessageStore({});
  assert.equal(adoptPersistedUserMessageId(emptyStore, 'session-1', 'user_local_111', 'user_stream-x'), false);
});

// Row 157: a message typed while an ask_user card waits answers the card.
function pendingQuestion(overrides = {}) {
  return {
    id: 'tool_use_call-q', role: 'tool', kind: 'tool_use',
    tool_call: {
      tool_name: 'ask_user', status: 'pending_user_input', question_ref: 'question_ref_1',
      parent_stream_id: 'stream-1', ...overrides,
    },
  };
}

test('findPendingUserQuestionRef finds the live turn\'s waiting card and nothing else', () => {
  const user = { id: 'u1', role: 'user', content: 'Set up a backup' };
  assert.equal(findPendingUserQuestionRef([user, pendingQuestion()], 'stream-1'), 'question_ref_1');
  assert.equal(findPendingUserQuestionRef([user, pendingQuestion()], ''), '', 'no live turn');
  assert.equal(findPendingUserQuestionRef([user, pendingQuestion()], 'stream-2'), '', 'another turn');
  assert.equal(findPendingUserQuestionRef([pendingQuestion(), user], 'stream-1'), '', 'older than the last user message');
  for (const overrides of [{ status: 'completed' }, { user_questions_stale: true }, { user_questions_withdrawn: true },
    { tool_name: 'exit_plan_mode' }, { question_ref: '' }]) {
    assert.equal(findPendingUserQuestionRef([user, pendingQuestion(overrides)], 'stream-1'), '', JSON.stringify(overrides));
  }
});

test('replyToPendingUserQuestions answers with the reply and reports whether the waiter took it', async () => {
  const sent = [];
  const chat = { async answerUserQuestions(ref, payload) { sent.push([ref, payload]); return true; } };
  const questionRef = 'question_ref_1';
  assert.equal(await replyToPendingUserQuestions({ questionRef, reply: '  Use the NAS  ', chat }), true);
  assert.deepEqual(sent, [['question_ref_1', { reply: 'Use the NAS' }]]);
  assert.equal(await replyToPendingUserQuestions({ questionRef, reply: 'x'.repeat(2001), chat }), false,
    'never longer than the tool keeps');
  assert.equal(await replyToPendingUserQuestions({ questionRef: '', reply: 'hi', chat }), false);
  assert.equal(await replyToPendingUserQuestions({ questionRef, reply: '   ', chat }), false);
  assert.equal(await replyToPendingUserQuestions({
    questionRef, reply: 'hi', chat: { async answerUserQuestions() { return false; } },
  }), false, 'a waiter already gone');
  assert.equal(await replyToPendingUserQuestions({
    questionRef, reply: 'hi', chat: { async answerUserQuestions() { throw new Error('ipc'); } },
  }), false);
  assert.equal(sent.length, 1);
});

test('syncQuestionReplyPlaceholder swaps the placeholder while questions wait and restores it after', () => {
  const input = { placeholder: 'Message Jenny...', dataset: {} };
  syncQuestionReplyPlaceholder(input, true);
  assert.equal(input.placeholder, 'Or answer in your own words…');
  syncQuestionReplyPlaceholder(input, true);
  syncQuestionReplyPlaceholder(input, false);
  assert.equal(input.placeholder, 'Message Jenny...');
  assert.deepEqual(input.dataset, {});
  syncQuestionReplyPlaceholder(input, false);
  assert.equal(input.placeholder, 'Message Jenny...');

  // A placeholder rewritten while swapped out (a locale or mode change) is the one restored.
  syncQuestionReplyPlaceholder(input, true);
  input.placeholder = 'Plan with Jenny...';
  syncQuestionReplyPlaceholder(input, true);
  assert.equal(input.placeholder, 'Or answer in your own words…');
  syncQuestionReplyPlaceholder(input, false);
  assert.equal(input.placeholder, 'Plan with Jenny...');
  syncQuestionReplyPlaceholder(input, true);
  input.placeholder = 'Ask about this file...';
  syncQuestionReplyPlaceholder(input, false);
  assert.equal(input.placeholder, 'Ask about this file...', 'a rewrite after the card leaves is kept');
  assert.deepEqual(input.dataset, {});
});

function questionHarness(t, options = {}) {
  const messages = [{ id: 'u1', role: 'user', content: 'Set up a backup' }, pendingQuestion()];
  const harness = createControllerHarness(messages, { chatInputValue: options.text ?? 'Use the NAS', isSessionStreaming: true });
  t.after(() => harness.restore());
  harness.state.activeStreamSessionId = 'session-1';
  harness.multiStreamController.registerStream('session-1', 'stream-1');
  const answered = [];
  const inputDuringAnswer = [];
  global.window.jennyShell.chat.answerUserQuestions = async (ref, payload) => {
    answered.push([ref, payload]);
    inputDuringAnswer.push(harness.chatInput.value);
    return options.waiterGone !== true;
  };
  return { ...harness, answered, inputDuringAnswer };
}

test('a typed composer send while a card waits answers it and clears the composer', async (t) => {
  const harness = questionHarness(t);
  const result = await harness.controller.startPromptSend('Use the NAS', { attachImageEditDraft: true });
  assert.equal(result, null);
  assert.deepEqual(harness.answered, [['question_ref_1', { reply: 'Use the NAS' }]]);
  assert.equal(harness.chatInput.value, '');
  assert.deepEqual(harness.inputDuringAnswer, [''], 'cleared before the round trip, so a second Enter sends nothing');
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.state.queuedSendBySession.size, 0, 'nothing was queued behind the card');
  assert.ok(harness.calls.logs.some((entry) => entry.event === 'chat.questions_answered_from_composer'));
});

test('a send the card does not take goes on as usual', async (t) => {
  const gone = questionHarness(t, { waiterGone: true });
  await gone.controller.startPromptSend('Use the NAS', { attachImageEditDraft: true });
  assert.equal(gone.answered.length, 1);
  assert.equal(gone.inputDuringAnswer[0], '');
  assert.equal(gone.calls.logs.some((entry) => entry.event === 'chat.questions_answered_from_composer'), false);

  const mention = questionHarness(t);
  global.window.rendererIdeMentionAutocomplete = { collectMentionPaths: () => ['src/app.js'] };
  t.after(() => { delete global.window?.rendererIdeMentionAutocomplete; });
  await mention.controller.startPromptSend('Look at @src/app.js', { attachImageEditDraft: true });
  assert.equal(mention.answered.length, 0, 'an @mention carries a file the reply cannot');
  delete global.window.rendererIdeMentionAutocomplete;

  const programmatic = questionHarness(t);
  await programmatic.controller.startPromptSend('Please continue', { preserveComposerDraft: true });
  assert.equal(programmatic.answered.length, 0, 'only a typed composer send answers the card');

  const withAttachment = questionHarness(t);
  withAttachment.state.attachments.queued = [{ id: 'a1', kind: 'file', displayName: 'notes.txt' }];
  await withAttachment.controller.startPromptSend('Here is the list', { attachImageEditDraft: true });
  assert.equal(withAttachment.answered.length, 0, 'a send with an attachment is a message, not an answer');
});

test('a reply longer than the card keeps stays in the composer with a notice', async (t) => {
  const long = 'x'.repeat(2001);
  const harness = questionHarness(t, { text: long });
  const result = await harness.controller.startPromptSend(long, { attachImageEditDraft: true });
  assert.equal(result?.reason, 'question_reply_too_long');
  assert.equal(harness.answered.length, 0);
  assert.equal(harness.chatInput.value, long, 'the draft is kept');
  assert.equal(harness.calls.startStream.length, 0);
  assert.equal(harness.state.queuedSendBySession.size, 0, 'not queued behind the card');
  assert.ok(harness.calls.composerNotices.some((entry) => entry.options.owner === 'questions:reply-length'
    && entry.message.includes('2000')));
});
