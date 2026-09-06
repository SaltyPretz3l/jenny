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
  resolveMessageCopyText,
  summarizeDurableFailurePreview,
} = require('../renderer/chat/renderer-send-flow-helpers');

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
