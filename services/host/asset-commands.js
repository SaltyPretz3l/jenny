'use strict';

const { HOST_ERROR_CODES } = require('../backend/error-codes');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const { readSessionMessagesForReferenceScan } = require('../backend/session-reference-scan');
const { collectAssetPaths } = require('../attachment-metadata');
const { createAttachmentContentStore } = require('./attachment-content-store');
const { createAttachmentId } = require('../attachment-asset-store');
const {
  MAX_FILE_CHARS,
  MAX_FILE_SIZE_BYTES,
  MAX_IMAGE_SIZE_BYTES,
  prepareAttachmentEntries,
  isSensitiveAttachmentPath,
} = require('../attachment-service');
const { readJson, writeJson } = require('./durable-json');

const SCHEMA_VERSION = 1;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 128;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STAGED_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_SELECTED_ATTACHMENTS = 8;
const MAX_SELECTED_SERIALIZED_BYTES = 8 * 1024 * 1024;
const MAX_DISPLAY_NAME_LENGTH = 240;
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const TEXT_MIME_TYPES = new Set(['text/plain']);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedId(value) {
  const normalized = String(value || '').trim();
  return ID_PATTERN.test(normalized) ? normalized : '';
}

function hasUnsafeDisplayCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0;
    if (character === '/' || character === '\\' || character === ':'
      || codePoint < 32 || codePoint === 127) return true;
  }
  return false;
}

function normalizeDisplayName(value, mimeType) {
  const fallback = mimeType === 'text/plain' ? 'attachment.txt' : 'image';
  const normalized = String(value || '').trim() || fallback;
  if (normalized.length > MAX_DISPLAY_NAME_LENGTH
    || normalized === '.' || normalized === '..'
    || hasUnsafeDisplayCharacter(normalized)) return '';
  if (isSensitiveAttachmentPath(normalized)) return '';
  return normalized || fallback;
}

function mimeType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function asBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  return null;
}

function hasImageSignature(buffer, type) {
  if (type === 'image/png') return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return buffer.length >= 3
    && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  return type === 'image/webp' && buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
}

function errorResult(kind, reason, extra = {}) {
  return {
    ok: false,
    error: {
      code: HOST_ERROR_CODES.INVALID,
      kind,
      reason,
      retryable: kind === 'unavailable' || kind === 'persistence',
      ...extra,
    },
  };
}

function publicAttachment(attachment) {
  return {
    id: String(attachment.id || ''),
    kind: String(attachment.kind || ''),
    display_name: String(attachment.displayName || ''),
    mime_type: String(attachment.mimeType || ''),
    size_bytes: Number.isSafeInteger(attachment.sizeBytes) ? attachment.sizeBytes : 0,
    truncated: attachment.truncated === true,
    ...(attachment.kind === 'image' ? { validation: 'pending_model_decode' } : {}),
    ...(Number.isSafeInteger(attachment.width) && attachment.width > 0 ? { width: attachment.width } : {}),
    ...(Number.isSafeInteger(attachment.height) && attachment.height > 0 ? { height: attachment.height } : {}),
  };
}

function normalizeStoredRecord(value) {
  if (!isRecord(value) || !boundedId(value.id) || !boundedId(value.device_id)
    || !['image', 'text'].includes(value.kind)
    || !Number.isSafeInteger(value.created_at) || !Number.isSafeInteger(value.expires_at)
    || value.created_at < 0 || value.created_at > Date.now() + 60_000
    || value.expires_at - value.created_at !== STAGED_TTL_MS || !Number.isSafeInteger(value.size_bytes)
    || value.size_bytes < 1 || value.size_bytes > MAX_IMAGE_SIZE_BYTES) return null;
  const attachment = isRecord(value.attachment) ? value.attachment : null;
  if (!attachment || String(attachment.id || '') !== value.id
    || String(attachment.kind || '') !== value.kind || attachment.sizeBytes !== value.size_bytes
    || value.size_bytes > (value.kind === 'image' ? MAX_STAGED_IMAGE_BYTES : MAX_FILE_SIZE_BYTES)) return null;
  if (!normalizeDisplayName(attachment.displayName, mimeType(attachment.mimeType))) return null;
  if (value.kind === 'image') {
    if (!IMAGE_MIME_TYPES.has(mimeType(attachment.mimeType))
      || !boundedId(attachment.id) || !String(attachment.assetPath || '').trim()) return null;
  } else if (typeof attachment.text !== 'string' || attachment.text.length > MAX_FILE_CHARS
    || mimeType(attachment.mimeType) !== 'text/plain') return null;
  return {
    id: value.id,
    device_id: value.device_id,
    kind: value.kind,
    created_at: value.created_at,
    expires_at: value.expires_at,
    size_bytes: value.size_bytes,
    attachment: { id: value.id, kind: value.kind, displayName: attachment.displayName,
      mimeType: attachment.mimeType, sizeBytes: value.size_bytes,
      ...(value.kind === 'image' ? { assetPath: attachment.assetPath } : {
        text: attachment.text, promptName: attachment.displayName, truncated: attachment.truncated === true,
      }),
    },
  };
}

function loadRecords(filePath) {
  let value;
  try {
    value = readJson(filePath);
  } catch (_error) {
    return { available: false, records: [] };
  }
  if (value === null) return { available: true, records: [] };
  if (value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.records)
    || value.records.length > MAX_RECORDS) return { available: false, records: [] };
  const records = value.records.map(normalizeStoredRecord);
  if (records.some((record) => !record)) return { available: false, records: [] };
  const ids = new Set();
  let total = 0;
  for (const record of records) {
    if (ids.has(record.id)) return { available: false, records: [] };
    ids.add(record.id);
    total += record.size_bytes;
  }
  return total <= MAX_TOTAL_BYTES ? { available: true, records } : { available: false, records: [] };
}

function createTextAttachment(bytes, displayName) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try { decoder.decode(bytes); } catch (_error) { return errorResult('invalid', 'text_encoding_invalid'); }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-attachment-'));
  const tempPath = path.join(tempDir, displayName);
  try {
    fs.writeFileSync(tempPath, bytes, { flag: 'wx', mode: 0o600 });
    const prepared = prepareAttachmentEntries([tempPath]);
    if (prepared.rejected.length || prepared.accepted.length !== 1) {
      return errorResult('invalid', 'text_attachment_rejected');
    }
    const entry = prepared.accepted[0];
    return {
      ok: true,
      attachment: {
        id: createAttachmentId('attachment'),
        kind: 'text',
        displayName,
        promptName: displayName,
        extension: path.extname(displayName).toLowerCase(),
        mimeType: 'text/plain',
        sizeBytes: bytes.length,
        text: entry.text,
        charCount: entry.charCount,
        truncated: entry.truncated,
        truncatedFromChars: entry.truncatedFromChars,
      },
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function createAssetCommands({ backend, userDataPath } = {}) {
  const metadataPath = path.join(String(userDataPath || '').trim(), 'host-attachments.json');
  const store = backend?.attachmentAssetStore || null;
  const textStore = createAttachmentContentStore(userDataPath);
  const loaded = loadRecords(metadataPath);
  let records = loaded.records;
  let available = loaded.available && Boolean(String(userDataPath || '').trim());
  let disposed = false;
  let lastPruneAt = 0;

  function readImage(attachment) {
    const realPath = store?.resolveManagedAssetRealPath?.(attachment.assetPath, { kind: 'image' });
    if (!realPath) throw new Error('invalid_asset_path');
    let fd;
    try {
      fd = fs.openSync(realPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== attachment.sizeBytes
        || before.size > MAX_IMAGE_SIZE_BYTES) throw new Error('invalid_asset_file');
      const buffer = Buffer.allocUnsafe(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const count = fs.readSync(fd, buffer, offset, buffer.length - offset, null);
        if (!count) break;
        offset += count;
      }
      const after = fs.fstatSync(fd);
      if (offset !== before.size || before.size !== after.size || before.ctimeMs !== after.ctimeMs
        || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) throw new Error('asset_changed');
      const bytes = buffer.subarray(0, offset);
      if (!hasImageSignature(bytes, attachment.mimeType)) throw new Error('invalid_asset_signature');
      return { bytes, realPath };
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  for (const record of records) {
    if (record.expires_at <= Date.now()) continue;
    try {
      if (record.kind === 'image') readImage(record.attachment);
      else if (textStore.read(record.id).bytes.length !== record.size_bytes) available = false;
    } catch { available = false; }
  }

  function ensureUsable({ requireStore = false } = {}) {
    if (disposed) return errorResult('unavailable', 'asset_commands_disposed');
    if (!available) return errorResult('persistence', 'asset_metadata_unavailable');
    if (requireStore && !store) return errorResult('unavailable', 'asset_store_unavailable');
    return null;
  }

  function persist() {
    try {
      writeJson(metadataPath, { schema_version: SCHEMA_VERSION, records });
      return null;
    } catch (_error) {
      available = false;
      return errorResult('persistence', 'asset_metadata_write_failed');
    }
  }

  function pruneExpired() {
    if (ensureUsable({ requireStore: true })) throw new Error('asset_store_unavailable');
    const now = Date.now();
    if (now - lastPruneAt < 3_600_000 && !records.some((record) => record.expires_at <= now)) return;
    const ids = backend?.sessionStore?.listSessions?.();
    if (!Array.isArray(ids) || ids.length > 10_000) throw new Error('canonical_references_unavailable');
    const referencedIds = new Set();
    const referencedPaths = [];
    for (const summary of ids) {
      for (const message of readSessionMessagesForReferenceScan(backend.sessionStore, summary)) {
        referencedPaths.push(...collectAssetPaths(message.attachments));
        for (const attachment of message.attachments || []) {
          referencedIds.add(attachment.id);
        }
      }
    }
    const active = records.filter((record) => record.expires_at > now);
    for (const record of active) {
      referencedIds.add(record.id);
      if (record.attachment.assetPath) referencedPaths.push(record.attachment.assetPath);
    }
    const previous = records;
    records = active;
    const failed = persist();
    if (failed) throw new Error('asset_cleanup_persist_failed');
    for (const record of previous) {
      if (record.expires_at > now || referencedIds.has(record.id)) continue;
      if (record.kind === 'text') textStore.remove(record.id);
    }
    store.pruneAssetPaths(previous.filter((record) => record.expires_at <= now && record.kind === 'image')
      .map((record) => record.attachment.assetPath), referencedPaths);
    store.pruneUnreferencedAssets(referencedPaths, { minAgeMs: STAGED_TTL_MS });
    textStore.prune(referencedIds, now);
    lastPruneAt = now;
  }

  function activeRecords(now = Date.now()) {
    return records.filter((record) => record.expires_at > now);
  }

  function upload({ deviceId, bytes, displayName, mimeType: requestedMimeType } = {}) {
    const unusable = ensureUsable({ requireStore: true });
    if (unusable) return unusable;
    const owner = boundedId(deviceId);
    const buffer = asBuffer(bytes);
    const type = mimeType(requestedMimeType);
    const name = normalizeDisplayName(displayName, type);
    if (!owner) return errorResult('forbidden', 'device_required');
    if (!buffer || !buffer.length) return errorResult('invalid', 'attachment_bytes_required');
    if (!name) return errorResult('invalid', 'display_name_invalid');
    if (!IMAGE_MIME_TYPES.has(type) && !TEXT_MIME_TYPES.has(type)) {
      return errorResult('invalid', 'mime_type_unsupported');
    }
    const maxBytes = IMAGE_MIME_TYPES.has(type) ? MAX_STAGED_IMAGE_BYTES : MAX_FILE_SIZE_BYTES;
    if (buffer.length > maxBytes) return errorResult('limit', 'attachment_size_limit');
    if (IMAGE_MIME_TYPES.has(type) && !hasImageSignature(buffer, type)) {
      return errorResult('invalid', 'image_signature_invalid');
    }
    try { pruneExpired(); } catch { return errorResult('persistence', 'asset_cleanup_failed'); }
    const current = activeRecords();
    if (current.length >= MAX_RECORDS || current.reduce((total, item) => total + item.size_bytes, 0) + buffer.length > MAX_TOTAL_BYTES) {
      return errorResult('limit', 'staged_attachment_capacity');
    }

    let built;
    try {
      built = IMAGE_MIME_TYPES.has(type)
        ? { ok: true, attachment: store.saveImageBufferSync(buffer, { displayName: name, mimeType: type, sourceKind: 'host_upload' }) }
        : createTextAttachment(buffer, name);
    } catch (_error) {
      return errorResult('unavailable', 'attachment_store_write_failed');
    }
    if (!built.ok) return built;
    const attachment = built.attachment;
    try {
      if (attachment.kind === 'text') textStore.save(attachment, buffer);
      else {
        const fd = fs.openSync(attachment.assetPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        if (process.platform !== 'win32') {
          const directoryFd = fs.openSync(path.dirname(attachment.assetPath), 'r');
          try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
        }
      }
    } catch {
      if (attachment.assetPath) store.deleteAssets([attachment.assetPath]);
      return errorResult('persistence', 'attachment_content_write_failed');
    }
    const now = Date.now();
    records = [...current, {
      id: attachment.id,
      device_id: owner,
      kind: attachment.kind,
      created_at: now,
      expires_at: now + STAGED_TTL_MS,
      size_bytes: buffer.length,
      attachment,
    }];
    const persisted = persist();
    // Metadata rename may already have committed when fsync fails. Keep the
    // bytes until a later complete-reference orphan sweep proves them unused.
    if (persisted) return persisted;
    return { ok: true, attachment: publicAttachment(attachment) };
  }

  async function resolveAttachments(ids, { deviceId, sessionId } = {}) {
    const unusable = ensureUsable({ requireStore: true });
    if (unusable) return unusable;
    if (!boundedId(deviceId) || !boundedId(sessionId)) return errorResult('invalid', 'attachment_context_invalid');
    if (!Array.isArray(ids) || ids.length > MAX_SELECTED_ATTACHMENTS) {
      return errorResult('limit', 'attachment_selection_limit');
    }
    const unique = new Set(ids);
    if (unique.size !== ids.length || [...unique].some((id) => !boundedId(id))) {
      return errorResult('invalid', 'attachment_id_invalid');
    }
    const byId = new Map(activeRecords().map((record) => [record.id, record]));
    const attachments = [];
    for (const id of ids) {
      const record = byId.get(id);
      if (!record || record.device_id !== deviceId) return errorResult('forbidden', 'attachment_not_owned');
      if (record.kind === 'image') {
        const assetPath = store.resolveManagedAssetRealPath?.(record.attachment.assetPath, { kind: 'image' });
        if (!assetPath) return errorResult('forbidden', 'attachment_path_rejected');
        try { readImage(record.attachment); } catch { return errorResult('invalid', 'attachment_file_invalid'); }
        attachments.push({ ...record.attachment, assetPath });
      } else {
        try {
          attachments.push({ ...record.attachment, text: textStore.read(record.id).text });
        } catch { return errorResult('unavailable', 'attachment_content_unavailable'); }
      }
    }
    const images = attachments.filter((attachment) => attachment.kind === 'image');
    if (images.length > 4 || images.reduce((sum, attachment) => sum + attachment.sizeBytes, 0) > 5 * 1024 * 1024) {
      return errorResult('limit', 'image_selection_limit');
    }
    if (attachments.reduce((sum, attachment) => sum + (attachment.text?.length || 0), 0) > 40_000) {
      return errorResult('limit', 'text_selection_limit');
    }
    if (Buffer.byteLength(JSON.stringify(attachments), 'utf8') > MAX_SELECTED_SERIALIZED_BYTES) {
      return errorResult('limit', 'attachment_serialized_limit');
    }
    return { ok: true, attachments };
  }

  async function canonicalMessages(sessionId) {
    if (!boundedId(sessionId)) return null;
    if (typeof backend?.getSessionMessages === 'function') {
      const result = await backend.getSessionMessages(sessionId);
      return Array.isArray(result?.data) ? result.data : [];
    }
    const data = backend?.sessionStore?.getSessionMessages?.(sessionId);
    return Array.isArray(data) ? data : [];
  }

  async function readAttachment(sessionId, attachmentId) {
    const unusable = ensureUsable();
    if (unusable) return unusable;
    const normalizedAttachmentId = boundedId(attachmentId);
    if (!boundedId(sessionId) || !normalizedAttachmentId) return errorResult('invalid', 'attachment_reference_invalid');
    let messages;
    try { messages = await canonicalMessages(sessionId); } catch (_error) { return errorResult('unavailable', 'canonical_history_unavailable'); }
    const reference = messages.flatMap((message) => Array.isArray(message?.attachments)
      ? message.attachments.map((attachment) => ({ message, attachment })) : [])
      .find(({ attachment }) => String(attachment?.id || '') === normalizedAttachmentId);
    if (!reference) return errorResult('forbidden', 'attachment_reference_not_found');
    const attachment = reference.attachment;
    const type = mimeType(attachment.mimeType || attachment.mime_type);
    if (attachment.kind === 'text' || type === 'text/plain') {
      try {
        const content = textStore.read(normalizedAttachmentId, attachment.sizeBytes);
        return { ok: true, attachment: publicAttachment({ ...attachment, mimeType: 'text/plain' }), bytes: content.bytes };
      } catch (error) {
        if (error.code !== 'ENOENT' || typeof attachment.text !== 'string') {
          return errorResult('unavailable', 'attachment_content_unavailable');
        }
        const bytes = Buffer.from(attachment.text, 'utf8');
        if (bytes.length > MAX_FILE_SIZE_BYTES) {
          return errorResult('limit', 'attachment_size_limit');
        }
        return { ok: true, attachment: publicAttachment({ ...attachment, mimeType: 'text/plain' }), bytes };
      }
    }
    if (!IMAGE_MIME_TYPES.has(type) || typeof store.resolveManagedAssetRealPath !== 'function') {
      return errorResult('unavailable', 'attachment_content_unavailable');
    }
    try {
      const { bytes } = readImage(attachment);
      return { ok: true, attachment: publicAttachment(attachment), bytes };
    } catch { return errorResult('unavailable', 'attachment_read_failed'); }
  }

  async function readMessage(sessionId, messageId) {
    const unusable = ensureUsable();
    if (unusable) return unusable;
    const normalizedMessageId = boundedId(messageId);
    if (!boundedId(sessionId) || !normalizedMessageId) return errorResult('invalid', 'message_reference_invalid');
    let messages;
    try { messages = await canonicalMessages(sessionId); } catch (_error) { return errorResult('unavailable', 'canonical_history_unavailable'); }
    const message = messages.find((candidate) => String(candidate?.id || '') === normalizedMessageId);
    if (!message) return errorResult('forbidden', 'message_reference_not_found');
    const serializedBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
    if (serializedBytes > MAX_SELECTED_SERIALIZED_BYTES) {
      return errorResult('limit', 'message_serialized_limit', { limit_bytes: MAX_SELECTED_SERIALIZED_BYTES, actual_bytes: serializedBytes });
    }
    return { ok: true, message };
  }

  function dispose() {
    disposed = true;
  }

  return { upload, resolveAttachments, readAttachment, readMessage, pruneExpired, dispose };
}

module.exports = {
  MAX_RECORDS,
  MAX_SELECTED_ATTACHMENTS,
  MAX_SELECTED_SERIALIZED_BYTES,
  MAX_STAGED_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  SCHEMA_VERSION,
  STAGED_TTL_MS,
  createAssetCommands,
};
