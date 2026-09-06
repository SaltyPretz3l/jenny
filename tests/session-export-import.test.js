const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_IMPORT_ERROR_CODES,
  exportSession,
  importSession,
} = require('../services/backend/session-export-import');
const {
  MAX_IMAGE_SIZE_BYTES,
} = require('../services/attachment-asset-store');

function assertSessionImportError(fn, { code, reason }) {
  assert.throws(fn, (error) => {
    assert.equal(error.name, 'SessionImportError');
    assert.equal(error.code, code);
    assert.equal(error.reason, reason);
    assert.equal(typeof error.message, 'string');
    assert.ok(error.message.length > 0);
    return true;
  });
}

function createMockSessionStore(sessions = {}) {
  const store = {
    _sessions: { ...sessions },
    getSession(sessionId) {
      return store._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...store._sessions } };
    },
    _write(payload) {
      store._sessions = { ...(payload.sessions || {}) };
    },
    _toSummary(session) {
      return {
        id: session.id,
        title: session.title,
        message_count: (session.messages || []).length,
        branch_origin: session.branch_origin || null,
      };
    },
  };
  return store;
}

function createMockShadowStore(sessions = {}) {
  const store = {
    _sessions: { ...sessions },
    getSession(sessionId) {
      return store._sessions[sessionId] || null;
    },
    _read() {
      return { schema_version: 3, sessions: { ...store._sessions } };
    },
    _write(payload) {
      store._sessions = { ...(payload.sessions || {}) };
    },
  };
  return store;
}

describe('exportSession', () => {
  it('returns null for nonexistent session', () => {
    const store = createMockSessionStore();
    assert.equal(exportSession(store, 'nonexistent'), null);
  });

  it('exports session as JSON with format header', () => {
    const store = createMockSessionStore({
      sess_1: {
        id: 'sess_1',
        title: 'Test Chat',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        preferred_model: 'claude-opus-4-6',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: { history_scope: 'session', include_personality: true, include_memory: true, include_git_context: true },
        lockdown: true,
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello', attachments: [] },
          { id: 'msg_2', role: 'assistant', content: 'Hi there!', attachments: [] },
        ],
      },
    });
    const json = exportSession(store, 'sess_1');
    assert.ok(json);
    const parsed = JSON.parse(json);
    assert.equal(parsed.format, 'jenny-session-export');
    assert.equal(parsed.session.lockdown, true, 'lockdown travels with the export');
    assert.equal(parsed.format_version, 1);
    assert.equal(parsed.session.title, 'Test Chat');
    assert.equal(parsed.session.messages.length, 2);
  });

  it('exports branch metadata for transparency', () => {
    const store = createMockSessionStore({
      sess_branch: {
        id: 'sess_branch',
        title: 'Branch Chat',
        created_at: '2026-05-12T12:00:00.000Z',
        updated_at: '2026-05-12T12:05:00.000Z',
        branch_origin: {
          source_session_id: 'sess_parent',
          source_message_id: 'msg_parent',
          source_title: 'Parent Chat',
          created_at: '2026-05-12T12:00:00.000Z',
        },
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello', attachments: [] },
        ],
      },
    });

    const parsed = JSON.parse(exportSession(store, 'sess_branch'));
    assert.deepEqual(parsed.session.branch_origin, {
      source_session_id: 'sess_parent',
      source_message_id: 'msg_parent',
      source_title: 'Parent Chat',
      created_at: '2026-05-12T12:00:00.000Z',
    });
  });

  it('exports normalized message reactions', () => {
    const store = createMockSessionStore({
      sess_reactions: {
        id: 'sess_reactions',
        title: 'Reaction Chat',
        created_at: '2026-05-12T17:00:00.000Z',
        updated_at: '2026-05-12T17:01:00.000Z',
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            content: 'Worth saving',
            attachments: [],
            message_reactions: {
              saved: {
                selected: true,
                updated_at: '2026-05-12T17:01:00.000Z',
              },
            },
          },
        ],
      },
    });

    const parsed = JSON.parse(exportSession(store, 'sess_reactions'));
    assert.deepEqual(parsed.session.messages[0].message_reactions, {
      saved: {
        selected: true,
        updated_at: '2026-05-12T17:01:00.000Z',
      },
    });
  });

  it('does not embed or leak unsafe attachment asset paths', () => {
    const store = createMockSessionStore({
      sess_leak: {
        id: 'sess_leak',
        title: 'Leak Check',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        messages: [
          {
            id: 'msg_unsafe',
            role: 'user',
            content: 'look at this',
            attachments: [
              {
                id: 'image_unsafe',
                kind: 'image',
                displayName: 'secret.png',
                mimeType: 'image/png',
                assetPath: __filename,
              },
            ],
          },
        ],
      },
    });
    const attachmentStore = {
      resolveSafePath() {
        return '';
      },
    };

    const parsed = JSON.parse(exportSession(store, 'sess_leak', attachmentStore));
    const exportedAttachment = parsed.session.messages[0].attachments[0];

    assert.equal(Object.prototype.hasOwnProperty.call(exportedAttachment, '_exportedData'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(exportedAttachment, 'assetPath'), false);
  });
});

describe('importSession', () => {
  it('throws a structured parse error for invalid JSON', () => {
    const store = createMockSessionStore();
    assertSessionImportError(() => importSession(store, 'not json'), {
      code: SESSION_IMPORT_ERROR_CODES.PARSE_ERROR,
      reason: 'parse_error',
    });
  });

  it('throws a structured format error for wrong format', () => {
    const store = createMockSessionStore();
    assertSessionImportError(() => importSession(store, JSON.stringify({ format: 'wrong' })), {
      code: SESSION_IMPORT_ERROR_CODES.FORMAT_MISMATCH,
      reason: 'format_mismatch',
    });
  });

  it('refuses exports from a newer format version before creating a session', () => {
    const store = createMockSessionStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 99,
      session: {
        title: 'Future Export',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello from later Jenny' },
        ],
      },
    });

    assertSessionImportError(() => importSession(store, payload), {
      code: SESSION_IMPORT_ERROR_CODES.FORMAT_MISMATCH,
      reason: 'unsupported_format_version',
    });
    assert.deepEqual(store._sessions, {});
  });

  it('imports session and creates new ID', () => {
    const store = createMockSessionStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Exported Chat',
        lockdown: true,
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello' },
        ],
      },
    });
    const result = importSession(store, payload);
    assert.ok(result);
    assert.ok(result.id);
    assert.equal(store.getSession(result.id).lockdown, true, 'an exported lockdown is imported');
    assert.ok(result.title.includes('imported'));
    assert.equal(result.message_count, 1);
  });

  it('mirrors imported sessions into the shadow store', () => {
    const store = createMockSessionStore();
    const shadowStore = createMockShadowStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Exported Chat',
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello' },
        ],
      },
    });

    const result = importSession(store, payload, null, { shadowStore });

    assert.ok(result);
    const shadowSession = shadowStore.getSession(result.id);
    assert.ok(shadowSession);
    assert.equal(shadowSession.id, result.id);
    assert.ok(shadowSession.title.includes('imported'));
    assert.equal(shadowSession.messages.length, 1);
  });

  it('imports exported branch sessions as fresh root sessions without dangling lineage', () => {
    const store = createMockSessionStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Branch Export',
        branch_origin: {
          source_session_id: 'missing_parent',
          source_message_id: 'msg_parent',
          source_title: 'Parent Chat',
          created_at: '2026-05-12T12:00:00.000Z',
        },
        messages: [
          { id: 'msg_1', role: 'user', content: 'Hello' },
        ],
      },
    });

    const result = importSession(store, payload);
    assert.equal(result.branch_origin, null);
    assert.equal(store.getSession(result.id).branch_origin, null);
  });

  it('imports message reactions through the canonical message normalizer', () => {
    const store = createMockSessionStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Reaction Export',
        messages: [
          {
            id: 'msg_1',
            role: 'assistant',
            content: 'Worth saving',
            messageReactions: {
              saved: {
                selected: true,
                updatedAt: '2026-05-12T12:01:00-05:00',
              },
              unknown: {
                selected: true,
                updated_at: '2026-05-12T17:02:00.000Z',
              },
            },
          },
        ],
      },
    });

    const result = importSession(store, payload);
    const imported = store.getSession(result.id);

    assert.deepEqual(imported.messages[0].message_reactions, {
      saved: {
        selected: true,
        updated_at: '2026-05-12T17:01:00.000Z',
      },
    });
  });

  it('strips imported attachment asset paths when exported bytes are absent', () => {
    const store = createMockSessionStore();
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Unsafe Attachment Import',
        messages: [
          {
            id: 'msg_unsafe_attachment',
            role: 'user',
            content: 'see attached',
            attachments: [
              {
                id: 'image_unsafe',
                kind: 'image',
                displayName: 'unsafe.png',
                mimeType: 'image/png',
                assetPath: 'C:/Users/Jenny/private/unsafe.png',
              },
            ],
          },
        ],
      },
    });

    const result = importSession(store, payload, {
      saveImageBufferSync() {
        throw new Error('save should not be called without exported bytes');
      },
    });

    const imported = store.getSession(result.id);
    assert.deepEqual(imported.messages[0].attachments, []);
  });

  it('rejects oversized exported attachment payloads before decoding', () => {
    const store = createMockSessionStore();
    const oversizedEncoded = 'A'.repeat(Math.ceil((MAX_IMAGE_SIZE_BYTES + 1) / 3) * 4 + 4);
    let saveCalled = false;
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Oversized Attachment Import',
        messages: [
          {
            id: 'msg_oversized_attachment',
            role: 'user',
            content: 'large attachment',
            attachments: [
              {
                id: 'image_oversized',
                kind: 'image',
                displayName: 'oversized.png',
                _exportedData: oversizedEncoded,
                _exportedMime: 'image/png',
              },
            ],
          },
        ],
      },
    });
    const attachmentStore = {
      saveImageBufferSync() {
        saveCalled = true;
        return { assetPath: 'C:/managed/oversized.png' };
      },
    };

    assertSessionImportError(() => importSession(store, payload, attachmentStore), {
      code: SESSION_IMPORT_ERROR_CODES.ATTACHMENT_FAILED,
      reason: 'attachment_failed',
    });
    assert.equal(saveCalled, false);
    assert.deepEqual(store._sessions, {});
  });

  it('exports and re-imports managed audio attachments', () => {
    const store = createMockSessionStore({
      sess_audio: {
        id: 'sess_audio',
        title: 'Voice Chat',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        preferred_model: 'gemma4:e4b',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: { history_scope: 'session', include_personality: true, include_memory: true, include_git_context: true },
        messages: [
          {
            id: 'msg_voice',
            role: 'user',
            content: 'hello from voice',
            attachments: [
              {
                id: 'audio_1',
                kind: 'audio',
                displayName: 'voice.webm',
                mimeType: 'audio/webm',
                sizeBytes: 4,
                durationMs: 3200,
                assetPath: __filename,
                sourceKind: 'microphone',
                transcriptText: 'hello from voice',
                transcriptStatus: 'complete',
                transcriptLanguage: 'en',
              },
            ],
          },
        ],
      },
    });

    const exported = exportSession(store, 'sess_audio', {
      resolveSafePath() {
        return __filename;
      },
    });
    assert.ok(exported);
    const parsed = JSON.parse(exported);
    assert.equal(parsed.session.messages[0].attachments[0].kind, 'audio');
    assert.match(parsed.session.messages[0].attachments[0]._exportedData, /^[A-Za-z0-9+/=]+$/);

    const attachmentStore = {
      saveAudioBufferSync(buffer, options = {}) {
        assert.ok(Buffer.isBuffer(buffer));
        return {
          assetPath: 'C:/managed/imported-audio.webm',
          durationMs: options.durationMs,
        };
      },
    };
    const result = importSession(store, exported, attachmentStore);

    assert.ok(result);
    const importedSession = store.getSession(result.id);
    assert.equal(importedSession.messages[0].attachments[0].kind, 'audio');
    assert.equal(importedSession.messages[0].attachments[0].assetPath, 'C:/managed/imported-audio.webm');
    assert.equal(importedSession.messages[0].attachments[0].transcriptText, 'hello from voice');
  });

  it('exports and re-imports assistant reply wav attachments', () => {
    const store = createMockSessionStore({
      sess_tts: {
        id: 'sess_tts',
        title: 'Reply Audio',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T01:00:00Z',
        preferred_model: 'gemma4:e4b',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        context_preferences: { history_scope: 'session', include_personality: true, include_memory: true, include_git_context: true },
        messages: [
          {
            id: 'msg_reply',
            role: 'assistant',
            content: 'Here is your narrated reply.',
            attachments: [
              {
                id: 'audio_tts_1',
                kind: 'audio',
                displayName: 'Assistant Reply.wav',
                mimeType: 'audio/wav',
                sizeBytes: 8,
                durationMs: 2100,
                assetPath: __filename,
                sourceKind: 'assistant_tts',
              },
            ],
          },
        ],
      },
    });

    const exported = exportSession(store, 'sess_tts', {
      resolveSafePath() {
        return __filename;
      },
    });
    assert.ok(exported);
    const attachmentStore = {
      saveAudioBufferSync(buffer, options = {}) {
        assert.ok(Buffer.isBuffer(buffer));
        assert.equal(options.sourceKind, 'assistant_tts');
        return {
          assetPath: 'C:/managed/imported-reply.wav',
          durationMs: options.durationMs,
          sourceKind: options.sourceKind,
        };
      },
    };

    const result = importSession(store, exported, attachmentStore);

    assert.ok(result);
    const importedSession = store.getSession(result.id);
    assert.equal(importedSession.messages[0].attachments[0].mimeType, 'audio/wav');
    assert.equal(importedSession.messages[0].attachments[0].sourceKind, 'assistant_tts');
    assert.equal(importedSession.messages[0].attachments[0].assetPath, 'C:/managed/imported-reply.wav');
  });

  it('throws a structured attachment error and cleans up restored assets on partial import failure', () => {
    const store = createMockSessionStore();
    const savedAssetPath = 'C:/managed/imported-first.png';
    const deletedAssetPaths = [];
    const payload = JSON.stringify({
      format: 'jenny-session-export',
      format_version: 1,
      session: {
        title: 'Partial Import',
        messages: [
          {
            id: 'msg_partial',
            role: 'user',
            content: 'two images',
            attachments: [
              {
                id: 'image_first',
                kind: 'image',
                displayName: 'first.png',
                _exportedData: Buffer.from('first-image').toString('base64'),
                _exportedMime: 'image/png',
              },
              {
                id: 'image_second',
                kind: 'image',
                displayName: 'second.png',
                _exportedData: Buffer.from('second-image').toString('base64'),
                _exportedMime: 'image/png',
              },
            ],
          },
        ],
      },
    });
    let saveCount = 0;
    const attachmentStore = {
      saveImageBufferSync() {
        saveCount += 1;
        if (saveCount === 1) {
          return { assetPath: savedAssetPath };
        }
        throw new Error('image write failed');
      },
      deleteAssets(assetPaths) {
        deletedAssetPaths.push(...assetPaths);
        return { deletedCount: assetPaths.length, deletedPaths: assetPaths };
      },
    };

    assertSessionImportError(() => importSession(store, payload, attachmentStore), {
      code: SESSION_IMPORT_ERROR_CODES.ATTACHMENT_FAILED,
      reason: 'attachment_failed',
    });
    assert.deepEqual(deletedAssetPaths, [savedAssetPath]);
    assert.deepEqual(store._sessions, {});
  });
});
