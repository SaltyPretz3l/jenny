/**
 * Session export and import for Jenny.
 *
 * Export produces a self-contained JSON payload with session metadata,
 * messages, and base64-encoded managed media attachments. Import creates a
 * new session from such a payload, re-persisting assets locally.
 */

const fs = require('fs');
const path = require('path');
const { redactExportSecretsInValue } = require('./transcript-export-redaction');
const { requestMemoryRpc } = require('./backend-memory');
const { isPlainObject } = require('../value-utils');
const {
  normalizeSession,
  normalizeMessage,
  createSessionId,
  TURN_EVENT_LOG_VERSION,
} = require('./electron-session-store');
const {
  normalizeBranchOrigin,
} = require('./session-store-migrations');
const { GENERAL_PROJECT_ID, normalizeProjectId } = require('../projects/project-schema');
const { PRIMARY_SESSION_ROLE, normalizeSessionRole } = require('./primary-session');
const {
  PERSIST_ERROR_CODES,
} = require('./error-codes');
const {
  persistSessionWithShadow,
} = require('./session-store-mirror');
const {
  MAX_AUDIO_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
} = require('../attachment-asset-store');
const {
  stripUnknownImportedMessageKeys,
  findOversizedImportedMessageString,
} = require('./session-import-message-bounds');

// 2: transcripts may carry role:'context' addressed-message rows. A format-1 reader would coerce them
// to assistant text, so it must refuse the file (the import below accepts 1 and 2).
const EXPORT_FORMAT_VERSION = 2;
const BASE64_ATTACHMENT_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const SESSION_IMPORT_ERROR_CODES = Object.freeze({
  PARSE_ERROR: PERSIST_ERROR_CODES.IMPORT_PARSE_ERROR,
  FORMAT_MISMATCH: PERSIST_ERROR_CODES.IMPORT_FORMAT_MISMATCH,
  ATTACHMENT_FAILED: PERSIST_ERROR_CODES.IMPORT_ATTACHMENT_FAILED,
});

class SessionImportError extends Error {
  constructor({ code, reason, message, cause } = {}) {
    super(String(message || 'Session import failed.'));
    this.name = 'SessionImportError';
    this.code = String(code || PERSIST_ERROR_CODES.IMPORT_FORMAT_MISMATCH);
    this.reason = String(reason || 'format_mismatch');
    if (cause) {
      this.cause = cause;
    }
  }
}

function createImportError(reason, message, cause) {
  const code = reason === 'parse_error'
    ? SESSION_IMPORT_ERROR_CODES.PARSE_ERROR
    : reason === 'attachment_failed'
      ? SESSION_IMPORT_ERROR_CODES.ATTACHMENT_FAILED
      : SESSION_IMPORT_ERROR_CODES.FORMAT_MISMATCH;
  return new SessionImportError({
    code,
    reason,
    message,
    cause,
  });
}

function normalizeExportFormatVersion(value) {
  if (value == null) {
    return 1;
  }
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : 0;
}

function stripAttachmentLocalFields(attachment = {}) {
  const {
    assetPath: _assetPath,
    _exportedData: _exportedData,
    _exportedMime: _exportedMime,
    ...clean
  } = attachment && typeof attachment === 'object' && !Array.isArray(attachment)
    ? attachment
    : {};
  return clean;
}

function resolveExportAssetPath(attachmentStore, assetPath) {
  if (!attachmentStore || !assetPath) {
    return '';
  }
  if (typeof attachmentStore.resolveSafePath === 'function') {
    return attachmentStore.resolveSafePath(assetPath);
  }
  if (typeof attachmentStore.isManagedAssetPath === 'function' && attachmentStore.isManagedAssetPath(assetPath)) {
    return path.resolve(String(assetPath || ''));
  }
  return '';
}

function cleanupImportedAssets(attachmentStore, assetPaths) {
  const paths = Array.isArray(assetPaths)
    ? assetPaths.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  if (!paths.length || !attachmentStore || typeof attachmentStore.deleteAssets !== 'function') {
    return;
  }
  try {
    attachmentStore.deleteAssets(paths);
  } catch (error) {
    void error;
  }
}

function normalizeAttachmentKind(attachment) {
  return String(attachment?.kind || '').trim().toLowerCase();
}

function isRestorableAttachmentKind(kind) {
  return kind === 'image' || kind === 'audio';
}

function maxImportAttachmentBytes(kind) {
  return kind === 'audio' ? MAX_AUDIO_SIZE_BYTES : MAX_IMAGE_SIZE_BYTES;
}

function maxBase64CharactersForBytes(maxBytes) {
  return Math.ceil(Math.max(Number(maxBytes) || 0, 0) / 3) * 4;
}

function createAttachmentRestoreError(attachmentKind, cause) {
  return createImportError(
    'attachment_failed',
    `Session import failed while restoring ${attachmentKind || 'media'} attachment.`,
    cause
  );
}

function decodeExportedAttachmentData(attachment, attachmentKind) {
  const encoded = typeof attachment?._exportedData === 'string'
    ? attachment._exportedData.trim()
    : '';
  if (!encoded) {
    throw createAttachmentRestoreError(attachmentKind);
  }
  const maxBytes = maxImportAttachmentBytes(attachmentKind);
  const maxEncodedLength = maxBase64CharactersForBytes(maxBytes);
  if (Buffer.byteLength(encoded, 'ascii') > maxEncodedLength) {
    throw createAttachmentRestoreError(attachmentKind);
  }
  if (!BASE64_ATTACHMENT_RE.test(encoded) || encoded.length % 4 === 1) {
    throw createAttachmentRestoreError(attachmentKind);
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length > maxBytes) {
    throw createAttachmentRestoreError(attachmentKind);
  }
  return buffer;
}

const boundedString = (value, limit) => typeof value === 'string' && value.length <= limit;

function portableMemoryNote(note) {
  if (!isPlainObject(note) || !boundedString(note.text, 2000) || !boundedString(note.kind, 40)
    || !boundedString(note.origin, 40)) return null;
  return { text: note.text, kind: note.kind, origin: note.origin,
    ...(boundedString(note.created_at, 40) ? { created_at: note.created_at } : {}) };
}

function portableRecap(recap) {
  if (!isPlainObject(recap) || !boundedString(recap.text, 2000)) return null;
  return { text: recap.text,
    ...(boundedString(recap.updated_at, 40) ? { updated_at: recap.updated_at } : {}) };
}

function logMemoryReason(service, event, reason) {
  // Use only bounded protocol reason tokens, never error messages or memory text.
  try {
    service?._emitServiceLog?.('WARN', event, { reason: /^[a-z_]{1,64}$/u.test(reason) ? reason : 'sidecar_request_failed' });
  } catch (_error) { /* Memory never blocks chat transfer. */ }
}

async function exportMemoryAppendix(service, sessionId, payload, serialize) {
  try {
    const result = await requestMemoryRpc(service, 'memory.export_session', { session_id: sessionId });
    const notes = (Array.isArray(result?.notes) ? result.notes : []).map(portableMemoryNote).filter(Boolean).slice(0, 200);
    const recap = portableRecap(result?.recap);
    if (notes.length || recap) payload.session.memory = { notes, recap };
  } catch (_error) {
    logMemoryReason(service, 'memory.export_session_failed', 'sidecar_request_failed');
  }
  return serialize();
}

async function importMemoryAppendix(service, session, memory, summary) {
  let result;
  try {
    const answer = await requestMemoryRpc(service, 'memory.import_session', {
      session_id: session.id, project_id: session.project_id || GENERAL_PROJECT_ID,
      notes: memory.notes.map(({ text, kind, origin }) => ({ text, kind, origin })),
      recap: memory.recap?.text ?? null,
    });
    if (!['imported', 'refused'].includes(answer?.status)) throw new Error('invalid_response');
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
    result = { status: answer.status, imported: count(answer.imported), skipped: count(answer.skipped) };
    if (answer.status === 'refused') logMemoryReason(service, 'memory.import_session_refused', String(answer.reason || 'import_refused'));
  } catch (_error) {
    logMemoryReason(service, 'memory.import_session_failed', 'sidecar_request_failed');
    result = { status: 'failed', imported: 0, skipped: 0 };
  }
  return { ...summary, memory: result };
}

/**
 * Export a session to a portable JSON string.
 *
 * @param {Object} sessionStore  - ElectronSessionStore instance
 * @param {string} sessionId
 * @param {Object} [options.service] - BackendService providing the sidecar and reason-only logging
 * @param {boolean} [options.includeMemory] - Include portable chat memory (async when available)
 * @returns {string|null|Promise<string>} JSON string or null if session not found
 */
function exportSession(sessionStore, sessionId, attachmentStore = null, options = {}) {
  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return null;
  }
  const messagesWithAssets = session.messages.map((message) => {
    if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
      return message;
    }
    const enrichedAttachments = message.attachments.map((attachment) => {
      if (
        !['image', 'audio'].includes(String(attachment.kind || '').trim())
        || !attachment.assetPath
      ) {
        return attachment;
      }
      const safeAssetPath = resolveExportAssetPath(attachmentStore, attachment.assetPath);
      if (!safeAssetPath) {
        if (options.requireManagedMedia === true) {
          throw new Error('Managed session media is unavailable for archive export.');
        }
        return stripAttachmentLocalFields(attachment);
      }
      try {
        const bytes = fs.readFileSync(safeAssetPath);
        return {
          ...stripAttachmentLocalFields(attachment),
          _exportedData: bytes.toString('base64'),
          _exportedMime: attachment.mimeType || (attachment.kind === 'audio' ? 'audio/webm' : 'image/png'),
        };
      } catch {
        if (options.requireManagedMedia === true) {
          throw new Error('Managed session media is unreadable for archive export.');
        }
        return stripAttachmentLocalFields(attachment);
      }
    });
    return { ...message, attachments: enrichedAttachments };
  });

  const payload = {
    format: 'jenny-session-export',
    // Format 2 only when it matters: a transcript with addressed-message rows (role context),
    // which a format-1 reader would coerce to assistant text. Others stay importable by 1.4.x.
    format_version: messagesWithAssets.some((message) => message?.role === 'context') ? EXPORT_FORMAT_VERSION : 1,
    exported_at: new Date().toISOString(),
    session: {
      title: session.title,
      project_id: session.project_id,
      created_at: session.created_at,
      updated_at: session.updated_at,
      preferred_model: session.preferred_model,
      reasoning_effort: session.reasoning_effort,
      lockdown: session.lockdown === true,
      conversation_mode: session.conversation_mode,
      context_preferences: session.context_preferences,
      branch_origin: normalizeBranchOrigin(session.branch_origin),
      // Only a trusted archive restore reads it back (see importSession).
      ...(normalizeSessionRole(session.session_role) ? { session_role: PRIMARY_SESSION_ROLE } : {}),
      messages: messagesWithAssets,
      ...(options.includeTurnEvents === true ? {
        turn_events: session.turn_events,
        turn_event_log_version: Number(session.turn_event_log_version || 0),
      } : {}),
    },
  };

  const serialize = () => {
    payload.session = redactExportSecretsInValue(payload.session);
    return JSON.stringify(payload, null, 2);
  };
  if (options.includeMemory === true && options.service?.sidecarClient) {
    return exportMemoryAppendix(options.service, sessionId, payload, serialize);
  }
  return serialize();
}

// Canonical turn events come back only from Jenny's own archive, together with
// the log version the renderer needs to use them. A log written by a newer
// build is dropped and the chat is rebuilt from its messages.
function trustedTurnEventLog(source, options) {
  const version = Number(source.turn_event_log_version || 0);
  if (options.trustedArchive !== true || !Array.isArray(source.turn_events)
    || !Number.isInteger(version) || version < 0 || version > TURN_EVENT_LOG_VERSION) {
    return { turn_events: [], turn_event_log_version: 0 };
  }
  return { turn_events: source.turn_events, turn_event_log_version: version };
}

/**
 * Import a session from an exported JSON string.
 *
 * @param {Object}   sessionStore       - ElectronSessionStore instance
 * @param {string}   jsonPayload        - JSON string from exportSession
 * @param {Object}   [attachmentStore]  - AttachmentAssetStore for re-persisting managed media
 * @param {Object}   [options]
 * @param {Object}   [options.shadowStore] - SessionShadowStore mirror for legacy listings
 * @param {string}   [options.restoredIncarnation] - trusted archive restore only: the chat's incarnation
 * @param {Object}   [options.service] - BackendService for a new chat's memory appendix
 * @returns {Object|Promise<Object>} Session summary; awaited when importing memory
 * @throws {SessionImportError} on invalid input or attachment restore failure
 */
function validateSessionImportPayload(jsonPayload) {
  let parsed;
  try {
    parsed = JSON.parse(jsonPayload);
  } catch (error) {
    throw createImportError(
      'parse_error',
      'Session import failed because the selected file is not valid JSON.',
      error
    );
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || parsed.format !== 'jenny-session-export'
    || !parsed.session
  ) {
    throw createImportError(
      'format_mismatch',
      'Session import failed because the selected file is not a Jenny session export.'
    );
  }
  const formatVersion = normalizeExportFormatVersion(parsed.format_version);
  if (formatVersion <= 0) {
    throw createImportError(
      'format_mismatch',
      'Session import failed because the selected file has an invalid export format version.'
    );
  }
  if (formatVersion > EXPORT_FORMAT_VERSION) {
    throw createImportError(
      'unsupported_format_version',
      'Session import failed because the selected file was exported by a newer Jenny version.'
    );
  }

  if (typeof parsed.session !== 'object' || Array.isArray(parsed.session)
    || (parsed.session.messages !== undefined && !Array.isArray(parsed.session.messages))) {
    throw createImportError('format_mismatch', 'Session payload is malformed.');
  }
  if (parsed.session.turn_events !== undefined && (!Array.isArray(parsed.session.turn_events)
    || parsed.session.turn_events.some((event) => !event || typeof event !== 'object' || Array.isArray(event)))) {
    throw createImportError('format_mismatch', 'Session turn events are malformed.');
  }
  if (Object.hasOwn(parsed.session, 'memory')) {
    const memory = parsed.session.memory;
    if (!isPlainObject(memory) || !Array.isArray(memory.notes) || memory.notes.length > 200
      || memory.notes.some(note => !portableMemoryNote(note))
      || (memory.recap != null && !portableRecap(memory.recap))) {
      delete parsed.session.memory;
      parsed.memory_drop_reason = 'invalid_memory_appendix';
    } else {
      parsed.session.memory = { notes: memory.notes.map(portableMemoryNote), recap: portableRecap(memory.recap) };
    }
  }
  const messageIds = new Set();
  for (const [index, message] of (parsed.session.messages || []).entries()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || (message.attachments !== undefined && !Array.isArray(message.attachments))) {
      throw createImportError('format_mismatch', 'Session message is malformed.');
    }
    // Unknown keys are stripped at import, so only admitted fields are bounded.
    const oversized = findOversizedImportedMessageString(stripUnknownImportedMessageKeys(message).message);
    if (oversized) {
      throw createImportError(
        'format_mismatch',
        `Session message field messages[${index}].${oversized.path} exceeds the ${oversized.limit}-character import limit.`
      );
    }
    const messageId = String(message.id || '');
    if (messageId && messageIds.has(messageId)) {
      throw createImportError('format_mismatch', 'Session message is malformed.');
    }
    if (messageId) messageIds.add(messageId);
    for (const attachment of message.attachments || []) {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
        throw createImportError('format_mismatch', 'Session attachment is malformed.');
      }
      const kind = normalizeAttachmentKind(attachment);
      if (isRestorableAttachmentKind(kind) && attachment._exportedData) decodeExportedAttachmentData(attachment, kind);
    }
  }
  return parsed;
}

function importSession(sessionStore, jsonPayload, attachmentStore, options = {}) {
  const parsed = validateSessionImportPayload(jsonPayload);

  const source = parsed.session;
  const requestedSessionId = String(options.restoredSessionId || '').trim();
  const preserveIdentity = options.trustedArchive === true && requestedSessionId.length > 0;
  const trustedProjectRemap = normalizeProjectId(options.projectIdRemap);
  if (options.projectIdRemap !== undefined && !trustedProjectRemap) {
    throw createImportError('format_mismatch', 'Session import project remap is invalid.');
  }
  if (preserveIdentity && !/^sess_[A-Za-z0-9_-]{1,154}$/.test(requestedSessionId)) {
    throw createImportError('format_mismatch', 'Session restore metadata contains an invalid identity.');
  }
  if (preserveIdentity && sessionStore.getSession(requestedSessionId)) {
    throw createImportError('format_mismatch', 'Session restore identity conflicts with existing data.');
  }
  const newSessionId = preserveIdentity ? requestedSessionId : createSessionId();
  // Only the trusted archive keeps a chat's incarnation (its coordination records bind to it); ordinary
  // import mints a fresh identity on the first turn like any new chat.
  const restoredIncarnation = preserveIdentity && typeof options.restoredIncarnation === 'string'
    && options.restoredIncarnation.length <= 512 ? options.restoredIncarnation.trim() : '';
  const savedAssetPaths = [];
  const strippedMessageKeys = new Set();
  let droppedContextRows = 0;
  // Normalization can join or coerce admitted strings (visible segments into
  // content, an array content into one string), so the bounds hold on the
  // persisted shape too, not only on the incoming one.
  const boundedNormalized = (normalized, index, imported) => {
    // An addressed-message row that fails strict validation is dropped, never coerced to another role.
    if (!normalized && imported?.role === 'context') droppedContextRows += 1;
    const oversized = findOversizedImportedMessageString(normalized);
    if (oversized) {
      throw createImportError(
        'format_mismatch',
        `Session message field messages[${index}].${oversized.path} exceeds the ${oversized.limit}-character import limit after normalization.`
      );
    }
    return normalized;
  };

  try {
    const restoredMessages = (Array.isArray(source.messages) ? source.messages : []).map(
      (sourceMessage, index) => {
        // Applies before both normalizeMessage calls below: normalization
        // spreads unknown message keys through to the persisted record.
        const { message, strippedKeys } = stripUnknownImportedMessageKeys(sourceMessage);
        for (const key of strippedKeys) strippedMessageKeys.add(key);
        if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
          return boundedNormalized(normalizeMessage(message), index, message);
        }
        const restoredAttachments = message.attachments.map((attachment) => {
          const attachmentKind = normalizeAttachmentKind(attachment);
          if (
            !isRestorableAttachmentKind(attachmentKind)
            || !attachment?._exportedData
            || !attachmentStore
          ) {
            return stripAttachmentLocalFields(attachment);
          }
          const buffer = decodeExportedAttachmentData(attachment, attachmentKind);
          const saveMethod = attachmentKind === 'audio'
            ? attachmentStore.saveAudioBufferSync
            : attachmentStore.saveImageBufferSync;
          if (typeof saveMethod !== 'function') {
            throw createAttachmentRestoreError(attachmentKind);
          }
          let savedMeta;
          try {
            savedMeta = attachmentKind === 'audio'
              ? saveMethod.call(attachmentStore, buffer, {
                  mimeType: attachment._exportedMime || 'audio/webm',
                  sourceKind: attachment.sourceKind || 'import',
                  displayName: attachment.displayName || 'imported-audio',
                  durationMs: attachment.durationMs,
                  transcriptText: attachment.transcriptText,
                  transcriptStatus: attachment.transcriptStatus,
                  transcriptLanguage: attachment.transcriptLanguage,
                })
              : saveMethod.call(attachmentStore, buffer, {
                  mimeType: attachment._exportedMime || 'image/png',
                  sourceKind: attachment.sourceKind || 'import',
                  displayName: attachment.displayName || 'imported-image',
                });
          } catch (error) {
            throw createAttachmentRestoreError(attachmentKind, error);
          }
          if (!savedMeta || !savedMeta.assetPath) {
            throw createAttachmentRestoreError(attachmentKind);
          }
          savedAssetPaths.push(savedMeta.assetPath);
          const clean = stripAttachmentLocalFields(attachment);
          return {
            ...clean,
            assetPath: savedMeta.assetPath,
            ...(typeof savedMeta.mimeType === 'string' && savedMeta.mimeType.length > 0
              ? { mimeType: savedMeta.mimeType } : {}),
          };
        });
        return boundedNormalized(normalizeMessage({ ...message, attachments: restoredAttachments }), index, message);
      }
    )
      .filter(Boolean)
      // Imported files are untrusted: canonical history only ever holds
      // user/assistant/tool rows, and the sidecar extends system-role trust
      // to rows it believes it authored (the compaction-summary exception in
      // sanitize_semantic_message). Admitting an imported system row would
      // let a crafted export inject model-facing system instructions.
      .filter((message) => message.role !== 'system');

    const session = normalizeSession(newSessionId, {
      title: preserveIdentity
        ? String(source.title || 'Restored Chat').trim()
        : `${String(source.title || 'Imported Chat').trim()} (imported)`,
      project_id: trustedProjectRemap
        || (preserveIdentity ? normalizeProjectId(source.project_id) : '')
        || GENERAL_PROJECT_ID,
      preferred_model: source.preferred_model || '',
      reasoning_effort: source.reasoning_effort || 'default',
      lockdown: source.lockdown === true,
      conversation_mode: source.conversation_mode || 'chat',
      context_preferences: source.context_preferences || {},
      branch_origin: preserveIdentity ? normalizeBranchOrigin(source.branch_origin) : null,
      // Row 69: a restored primary Jenny chat stays the primary (its transcript spans every
      // project, so it must not come back as an ordinary General chat). Restore runs only into a
      // fresh profile; a duplicate is demoted, oldest kept, by ensurePrimarySession at startup.
      // A plain import is a copy and never a primary.
      ...(preserveIdentity && normalizeSessionRole(source.session_role)
        ? { session_role: PRIMARY_SESSION_ROLE, pinned: true } : {}),
      session_incarnation: restoredIncarnation,
      created_at: preserveIdentity ? source.created_at : new Date().toISOString(),
      updated_at: preserveIdentity ? source.updated_at : new Date().toISOString(),
      messages: restoredMessages,
      ...trustedTurnEventLog(source, options),
    });

    const summary = persistSessionWithShadow(sessionStore, session, {
      shadowStore: options.shadowStore,
    });
    const result = (strippedMessageKeys.size || droppedContextRows) && summary && typeof summary === 'object'
      ? {
        ...summary,
        ...(strippedMessageKeys.size ? { stripped_message_keys: [...strippedMessageKeys].sort() } : {}),
        ...(droppedContextRows ? { dropped_context_row_count: droppedContextRows } : {}),
      }
      : summary;
    if (options.trustedArchive !== true && !preserveIdentity) {
      if (parsed.memory_drop_reason) logMemoryReason(options.service, 'memory.import_appendix_dropped', parsed.memory_drop_reason);
      if (source.memory && options.service?.sidecarClient) {
        return importMemoryAppendix(options.service, session, source.memory, result);
      }
    }
    return result;
  } catch (error) {
    cleanupImportedAssets(attachmentStore, savedAssetPaths);
    throw error;
  }
}

module.exports = {
  validateSessionImportPayload,
  SESSION_IMPORT_ERROR_CODES,
  SessionImportError,
  exportSession,
  importSession,
  EXPORT_FORMAT_VERSION,
};
