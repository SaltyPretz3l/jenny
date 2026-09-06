// WIDE-019 (Electron half): typed tool-result attachment ingest into the
// existing AttachmentAssetStore, refs-only persistence, and bounded ID-based
// reads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { AttachmentAssetStore } = require('../services/attachment-asset-store');
const {
  MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES,
  ingestToolResultAttachments,
  normalizeWireToolResultAttachment,
  readToolResultAttachment,
  toPersistedToolResultAttachmentRefs,
} = require('../services/backend/tool-result-attachments');
const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');

function makeTempStoreService(t) {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-tool-result-att-'));
  t.after(() => {
    try {
      fs.rmSync(rootDir, { recursive: true, force: true });
    } catch (_error) {
      // best effort cleanup
    }
  });
  return {
    attachmentAssetStore: new AttachmentAssetStore({ rootDir, nativeImage: null }),
  };
}

function wireAttachment(overrides = {}) {
  const data = Buffer.from('fake-jpeg-bytes-0123456789');
  return {
    id: 'att_source_1',
    kind: 'image',
    mime_type: 'image/jpeg',
    data_base64: data.toString('base64'),
    byte_length: data.length,
    width: 32,
    height: 24,
    source_tool: 'read_file',
    ...overrides,
  };
}

test('normalizeWireToolResultAttachment maps snake_case wire keys to camelCase', () => {
  const normalized = normalizeWireToolResultAttachment(wireAttachment({ page_number: 2 }));
  assert.equal(normalized.id, 'att_source_1');
  assert.equal(normalized.mimeType, 'image/jpeg');
  assert.equal(normalized.byteLength, 26);
  assert.equal(normalized.pageNumber, 2);
  assert.equal(normalized.width, 32);
});

test('normalizeWireToolResultAttachment refuses bad kinds, mimes, and oversize declarations', () => {
  assert.equal(normalizeWireToolResultAttachment(wireAttachment({ kind: 'script' })), null);
  assert.equal(
    normalizeWireToolResultAttachment(wireAttachment({ mime_type: 'text/html' })),
    null
  );
  assert.equal(
    normalizeWireToolResultAttachment(
      wireAttachment({ byte_length: MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES + 1 })
    ),
    null
  );
  assert.equal(normalizeWireToolResultAttachment('not-an-object'), null);
});

test('ingest stores bytes in the asset store and bounded ID read round-trips them', (t) => {
  const service = makeTempStoreService(t);
  const wire = wireAttachment();

  const refs = ingestToolResultAttachments(service, [wire], {
    streamId: 'stream-1',
    callId: 'call-1',
    toolName: 'read_file',
  });

  assert.equal(refs.length, 1);
  assert.ok(refs[0].id.startsWith('image_'));
  assert.equal(refs[0].sourceId, 'att_source_1');
  assert.ok(service.attachmentAssetStore.isManagedAssetPath(refs[0].assetPath));
  // Stored bytes match the decoded wire payload exactly.
  assert.deepEqual(
    fs.readFileSync(refs[0].assetPath),
    Buffer.from(wire.data_base64, 'base64')
  );

  const read = readToolResultAttachment(service, refs[0].id);
  assert.equal(read.ok, true);
  assert.equal(read.mimeType, 'image/jpeg');
  assert.equal(read.byteLength, wire.byte_length);
  assert.equal(read.dataBase64, wire.data_base64);
});

test('bounded read refuses unknown ids and oversize assets', (t) => {
  const service = makeTempStoreService(t);
  const refs = ingestToolResultAttachments(service, [wireAttachment()], {});
  assert.equal(refs.length, 1);

  assert.equal(readToolResultAttachment(service, 'image_not_real').ok, false);

  // Swap the stored asset for an oversized file: the bounded read refuses.
  fs.writeFileSync(
    refs[0].assetPath,
    Buffer.alloc(MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES + 1)
  );
  const read = readToolResultAttachment(service, refs[0].id);
  assert.equal(read.ok, false);
  assert.match(read.reason, /bounded-read/);
});

test('ingest drops sliced base64 and enforces the aggregate cap whole-attachment', (t) => {
  const service = makeTempStoreService(t);
  const sliced = wireAttachment({ id: 'att_sliced' });
  sliced.data_base64 = sliced.data_base64.slice(0, sliced.data_base64.length - 3);

  const big = Buffer.alloc(1_500_000, 7);
  const first = wireAttachment({
    id: 'att_big_1',
    data_base64: big.toString('base64'),
    byte_length: big.length,
  });
  const second = wireAttachment({
    id: 'att_big_2',
    data_base64: big.toString('base64'),
    byte_length: big.length,
  });

  const refs = ingestToolResultAttachments(service, [sliced, first, second], {});

  // Sliced encoding refused outright; the second big attachment would push
  // the aggregate past 2 MiB so it is dropped WHOLE.
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourceId, 'att_big_1');
  assert.equal(fs.readFileSync(refs[0].assetPath).length, big.length);
});

test('persisted refs carry ids and scalars only - never bytes or base64', () => {
  const refs = toPersistedToolResultAttachmentRefs([
    {
      id: 'image_stored_1',
      sourceId: 'att_source_1',
      kind: 'pdf_page',
      mimeType: 'image/jpeg',
      byteLength: 42,
      width: 10,
      height: 20,
      pageNumber: 3,
      assetPath: 'C:/assets/images/a.jpg',
      dataBase64: 'should-not-appear',
    },
  ]);

  assert.equal(refs.length, 1);
  assert.equal(refs[0].id, 'image_stored_1');
  assert.equal(refs[0].page_number, 3);
  assert.equal(refs[0].asset_path, 'C:/assets/images/a.jpg');
  const serialized = JSON.stringify(refs);
  assert.ok(!serialized.includes('dataBase64'));
  assert.ok(!serialized.includes('data_base64'));
  assert.ok(!serialized.includes('should-not-appear'));
});

test('tool.result notification ingest persists refs-only into messages and turn events', (t) => {
  const storeService = makeTempStoreService(t);
  const messagesBySession = new Map([['session-att', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex(
        (message) => String(message.id || '') === String(messageId || '')
      );
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const emitted = [];
  const turnEvents = [];
  const service = {
    sessionStore,
    emit(type, payload) {
      emitted.push({ type, payload });
    },
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
    attachmentAssetStore: storeService.attachmentAssetStore,
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-att',
    streamId: 'stream-att',
    eventBase: { sessionId: 'session-att', streamId: 'stream-att', model: 'mock-model' },
    turnEventCollector: {
      noteEvent(event) {
        turnEvents.push(event);
      },
    },
  };
  const wire = wireAttachment();

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-att-1',
      tool_name: 'read_file',
      success: true,
      output: '{"kind":"image"}',
      tool_input: { path: 'photo.png' },
      trusted_attachments: [wire],
    },
  });

  const messages = sessionStore.getSessionMessages('session-att');
  const toolResult = messages.find((message) => message.kind === 'tool_result');
  const refs = toolResult.tool_result.trusted_attachment_refs;
  assert.equal(refs.length, 1);
  assert.ok(refs[0].id.startsWith('image_'));
  assert.equal(refs[0].source_id, wire.id);
  // Refs only — the persisted message never contains the wire base64.
  assert.ok(!JSON.stringify(messages).includes(wire.data_base64));

  const resultTurnEvent = turnEvents.find((event) => event.kind === 'tool_result');
  const eventRefs = resultTurnEvent.payload.trusted_attachment_refs;
  assert.equal(eventRefs.length, 1);
  assert.equal(eventRefs[0].id, refs[0].id);
  assert.ok(!JSON.stringify(turnEvents).includes(wire.data_base64));

  // Live chat-stream event exposes camelCase refs for the renderer.
  const streamEvent = emitted.find(
    (entry) => entry.type === 'chat-stream' && entry.payload.type === 'tool_result'
  );
  assert.equal(streamEvent.payload.trustedAttachments.length, 1);
  assert.equal(streamEvent.payload.trustedAttachments[0].mimeType, 'image/jpeg');

  // Ingested bytes round-trip through the bounded ID-based read.
  const read = readToolResultAttachment(service, refs[0].id);
  assert.equal(read.ok, true);
  assert.equal(read.dataBase64, wire.data_base64);
});

test('tool.result without an asset store still persists cleanly with no refs', () => {
  const messagesBySession = new Map([['session-no-store', []]]);
  const sessionStore = {
    getSessionMessages(sessionId) {
      return messagesBySession.get(sessionId) || [];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage() {},
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-no-store',
    streamId: 'stream-no-store',
    eventBase: { sessionId: 'session-no-store', streamId: 'stream-no-store', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-no-store',
      tool_name: 'read_file',
      success: true,
      output: 'plain output',
      tool_input: { path: 'a.txt' },
      trusted_attachments: [wireAttachment()],
    },
  });

  const messages = sessionStore.getSessionMessages('session-no-store');
  const toolResult = messages.find((message) => message.kind === 'tool_result');
  assert.equal(toolResult.tool_result.output_text, 'plain output');
  assert.equal(toolResult.tool_result.trusted_attachment_refs, undefined);
});
