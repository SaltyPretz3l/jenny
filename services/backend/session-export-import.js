/**
 * Session export and import for Jenny.
 *
 * Export produces a self-contained JSON payload with session metadata,
 * messages, and base64-encoded managed media attachments. Import creates a
 * new session from such a payload, re-persisting assets locally.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeSession,
  normalizeMessage,
  createSessionId,
} = require('./electron-session-store');
const {
  normalizeBranchOrigin,
} = require('./session-store-migrations');
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

const EXPORT_FORMAT_VERSION = 1;
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

/**
 * Export a session to a portable JSON string.
 *
 * @param {Object} sessionStore  - ElectronSessionStore instance
 * @param {string} sessionId
 * @returns {string|null} JSON string or null if session not found
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
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: new Date().toISOString(),
    session: {
      title: session.title,
      created_at: session.created_at,
      updated_at: session.updated_at,
      preferred_model: session.preferred_model,
      reasoning_effort: session.reasoning_effort,
      lockdown: session.lockdown === true,
      conversation_mode: session.conversation_mode,
      context_preferences: session.context_preferences,
      branch_origin: normalizeBranchOrigin(session.branch_origin),
      messages: messagesWithAssets,
    },
  };

  return JSON.stringify(payload, null, 2);
}

/**
 * Import a session from an exported JSON string.
 *
 * @param {Object}   sessionStore       - ElectronSessionStore instance
 * @param {string}   jsonPayload        - JSON string from exportSession
 * @param {Object}   [attachmentStore]  - AttachmentAssetStore for re-persisting managed media
 * @param {Object}   [options]
 * @param {Object}   [options.shadowStore] - SessionShadowStore mirror for legacy listings
 * @returns {Object} Session summary
 * @throws {SessionImportError} on invalid input or attachment restore failure
 */
function importSession(sessionStore, jsonPayload, attachmentStore, options = {}) {
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

  const source = parsed.session;
  const requestedSessionId = String(options.restoredSessionId || '').trim();
  const preserveIdentity = options.trustedArchive === true && requestedSessionId.length > 0;
  if (preserveIdentity && !/^sess_[A-Za-z0-9_-]{1,154}$/.test(requestedSessionId)) {
    throw createImportError('format_mismatch', 'Session restore metadata contains an invalid identity.');
  }
  if (preserveIdentity && sessionStore.getSession(requestedSessionId)) {
    throw createImportError('format_mismatch', 'Session restore identity conflicts with existing data.');
  }
  const newSessionId = preserveIdentity ? requestedSessionId : createSessionId();
  const savedAssetPaths = [];

  try {
    const restoredMessages = (Array.isArray(source.messages) ? source.messages : []).map(
      (message) => {
        if (!Array.isArray(message.attachments) || message.attachments.length === 0) {
          return normalizeMessage(message);
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
          return { ...clean, assetPath: savedMeta.assetPath };
        });
        return normalizeMessage({ ...message, attachments: restoredAttachments });
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
      preferred_model: source.preferred_model || '',
      reasoning_effort: source.reasoning_effort || 'default',
      lockdown: source.lockdown === true,
      conversation_mode: source.conversation_mode || 'chat',
      context_preferences: source.context_preferences || {},
      branch_origin: preserveIdentity ? normalizeBranchOrigin(source.branch_origin) : null,
      created_at: preserveIdentity ? source.created_at : new Date().toISOString(),
      updated_at: preserveIdentity ? source.updated_at : new Date().toISOString(),
      messages: restoredMessages,
    });

    return persistSessionWithShadow(sessionStore, session, {
      shadowStore: options.shadowStore,
    });
  } catch (error) {
    cleanupImportedAssets(attachmentStore, savedAssetPaths);
    throw error;
  }
}

module.exports = {
  SESSION_IMPORT_ERROR_CODES,
  SessionImportError,
  exportSession,
  importSession,
  EXPORT_FORMAT_VERSION,
};
