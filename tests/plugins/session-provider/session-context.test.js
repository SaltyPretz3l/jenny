'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_PAGE_BYTES,
  buildTranscriptPage,
  normalizeCursor,
} = require('../../../services/plugins/session-provider/session-context');

const VIEW = Object.freeze({
  viewInstanceId: 'view-1', generationId: 'generation-1', senderId: 42,
  artifactDigest: 'a'.repeat(64),
});

function session(messages) {
  return { id: 'plugin-session', session_incarnation: 'incarnation-1', messages };
}

test('transcript pages are newest-first bounded and use an opaque older cursor', () => {
  const messages = Array.from({ length: 75 }, (_, index) => ({
    id: `message-${index}`, role: index % 2 ? 'assistant' : 'user',
    content: `message ${index}`, status: 'complete', attachments: [],
  }));
  const page = buildTranscriptPage({ session: session(messages), viewContext: VIEW,
    ticketBroker: { issueForAttachment: () => ({ ok: false }) } });

  assert.equal(page.ok, true);
  assert.equal(page.messages.length, MAX_CONTEXT_MESSAGES);
  assert.equal(page.messages[0].id, 'message-25');
  assert.equal(page.messages.at(-1).id, 'message-74');
  assert.equal(page.next_cursor, '25');
  assert.ok(page.page_bytes <= MAX_CONTEXT_PAGE_BYTES);

  const older = buildTranscriptPage({ session: session(messages), cursor: page.next_cursor,
    viewContext: VIEW, ticketBroker: { issueForAttachment: () => ({ ok: false }) } });
  assert.equal(older.messages[0].id, 'message-0');
  assert.equal(older.messages.at(-1).id, 'message-24');
  assert.equal(older.next_cursor, null);
});

test('attachment presentation issues a bound ticket and never exposes local paths', () => {
  const calls = [];
  const page = buildTranscriptPage({
    session: session([{ id: 'assistant-1', role: 'assistant', content: 'Generated.',
      plugin_operation: { operation_id: 'operation-1', status: 'succeeded' },
      attachments: [{ id: 'attachment-1', kind: 'image', displayName: 'result.png',
        mimeType: 'image/png', sizeBytes: 1234, width: 32, height: 24,
        assetPath: 'C:\\private\\result.png', provenance: { operation_id: 'operation-1' } }],
    }]),
    viewContext: VIEW,
    ticketBroker: { issueForAttachment(request) {
      calls.push(request);
      return { ok: true, url: `jenny-plugin-view://${VIEW.artifactDigest}/__attachment/${'b'.repeat(64)}`,
        expires_at: '2026-08-12T12:05:00.000Z' };
    } },
  });

  assert.equal(page.ok, true);
  const attachment = page.messages[0].attachments[0];
  assert.match(attachment.url, /__attachment\/[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(attachment).includes('private'), false);
  assert.deepEqual(calls[0], {
    viewInstanceId: 'view-1', generationId: 'generation-1',
    sessionId: 'plugin-session', sessionIncarnation: 'incarnation-1',
    operationId: 'operation-1', attachmentId: 'attachment-1',
    webContentsId: 42, artifactDigest: 'a'.repeat(64),
  });
});

test('oversized content is clipped and malformed cursors fail closed', () => {
  const page = buildTranscriptPage({
    session: session([{ id: 'large', role: 'assistant', content: 'x'.repeat(80 * 1024),
      attachments: [] }]),
    viewContext: VIEW, ticketBroker: { issueForAttachment: () => ({ ok: false }) },
  });
  assert.equal(page.ok, true);
  assert.equal(page.messages[0].content.length, 12_000);
  assert.ok(page.page_bytes <= MAX_CONTEXT_PAGE_BYTES);
  assert.equal(normalizeCursor('1.5', 10), null);
  assert.equal(buildTranscriptPage({ session: session([]), cursor: '-1', viewContext: VIEW,
    ticketBroker: {} }).reason, 'plugin_session_cursor_invalid');
});
