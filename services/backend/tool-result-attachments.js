// Wire payloads arrive snake_case (id, kind, mime_type, data_base64,
// byte_length, width, height, page_number, source_tool) and are normalized to
// camelCase at ingest. Persisted turn events and session messages reference
// the STORED asset id/path only — raw bytes/base64 never persist.

const fs = require('fs');

// Mirrors sidecar TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES (aggregate decoded
// bytes per tool result) — anything larger was never admitted sidecar-side,
// so it is refused here too (defense in depth).
const MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES = 2 * 1024 * 1024;
const ADMITTED_KINDS = new Set(['image', 'pdf_page', 'chart']);
const ADMITTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Bounded id -> stored-asset index so reads are ID-based without scanning
// disk; oldest entries fall out first (they remain readable via session
// message refs which persist the assetPath).
const MAX_INDEX_ENTRIES = 512;

function normalizeWireToolResultAttachment(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }
  const id = String(entry.id || '').trim();
  const kind = String(entry.kind || '').trim();
  const mimeType = String(entry.mime_type || entry.mimeType || '').trim().toLowerCase();
  const dataBase64 = typeof entry.data_base64 === 'string'
    ? entry.data_base64
    : (typeof entry.dataBase64 === 'string' ? entry.dataBase64 : '');
  const byteLength = Number(entry.byte_length ?? entry.byteLength);
  if (!id || !dataBase64) {
    return null;
  }
  if (!ADMITTED_KINDS.has(kind) || !ADMITTED_MIME_TYPES.has(mimeType)) {
    return null;
  }
  if (!Number.isInteger(byteLength) || byteLength <= 0
    || byteLength > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
    return null;
  }
  const width = Number(entry.width);
  const height = Number(entry.height);
  const pageNumber = Number(entry.page_number ?? entry.pageNumber);
  return {
    id,
    kind,
    mimeType,
    dataBase64,
    byteLength,
    width: Number.isInteger(width) && width >= 0 ? width : 0,
    height: Number.isInteger(height) && height >= 0 ? height : 0,
    pageNumber: Number.isInteger(pageNumber) && pageNumber > 0 ? pageNumber : null,
  };
}

const COMPLETE_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeCompleteBase64(dataBase64, expectedByteLength) {
  // Complete-encoding invariant: strict alphabet, padded 4-char groups, and
  // a decode that round-trips to the declared byte length. Node's lenient
  // Buffer.from would silently accept sliced/garbled base64 — refuse instead.
  if (dataBase64.length % 4 !== 0 || !COMPLETE_BASE64_RE.test(dataBase64)) {
    return null;
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length !== expectedByteLength) {
    return null;
  }
  return buffer;
}

function attachmentIndexFor(service) {
  if (!(service._toolResultAttachmentIndex instanceof Map)) {
    service._toolResultAttachmentIndex = new Map();
  }
  return service._toolResultAttachmentIndex;
}

function rememberStoredAttachment(service, record) {
  const index = attachmentIndexFor(service);
  index.set(record.id, record);
  while (index.size > MAX_INDEX_ENTRIES) {
    const oldestKey = index.keys().next().value;
    index.delete(oldestKey);
  }
}

/**
 * Ingest the typed `trusted_attachments` from one live tool.result
 * notification synchronously into the existing AttachmentAssetStore.
 * Returns stored refs (id/assetPath/scalars — never bytes) for persistence.
 */
function ingestToolResultAttachments(service, wireAttachments, context = {}) {
  const store = service ? service.attachmentAssetStore : null;
  const entries = Array.isArray(wireAttachments) ? wireAttachments : [];
  if (!store || typeof store.saveImageBufferSync !== 'function' || !entries.length) {
    return [];
  }
  const refs = [];
  let totalBytes = 0;
  for (const entry of entries) {
    const normalized = normalizeWireToolResultAttachment(entry);
    if (!normalized) {
      continue;
    }
    if (totalBytes + normalized.byteLength > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
      // Aggregate cap: drop the WHOLE attachment, never a truncated tail.
      continue;
    }
    const buffer = decodeCompleteBase64(normalized.dataBase64, normalized.byteLength);
    if (!buffer) {
      continue;
    }
    let stored;
    try {
      stored = store.saveImageBufferSync(buffer, {
        displayName: `${String(context.toolName || 'tool')}-${normalized.kind}`,
        mimeType: normalized.mimeType,
        sourceKind: 'tool_result',
      });
    } catch (_error) {
      continue;
    }
    totalBytes += normalized.byteLength;
    const record = {
      id: stored.id,
      sourceId: normalized.id,
      kind: normalized.kind,
      mimeType: normalized.mimeType,
      byteLength: normalized.byteLength,
      width: normalized.width || stored.width || 0,
      height: normalized.height || stored.height || 0,
      pageNumber: normalized.pageNumber,
      assetPath: stored.assetPath,
      streamId: String(context.streamId || ''),
      toolCallId: String(context.callId || ''),
      toolName: String(context.toolName || ''),
    };
    rememberStoredAttachment(service, record);
    refs.push(record);
  }
  return refs;
}

/** Persisted (turn event / session message) shape: refs only, no bytes. */
function toPersistedToolResultAttachmentRefs(refs) {
  return (Array.isArray(refs) ? refs : []).map((ref) => ({
    id: ref.id,
    source_id: ref.sourceId,
    kind: ref.kind,
    mime_type: ref.mimeType,
    byte_length: ref.byteLength,
    width: ref.width,
    height: ref.height,
    ...(ref.pageNumber ? { page_number: ref.pageNumber } : {}),
    asset_path: ref.assetPath,
  }));
}

/**
 * Bounded ID-based read of one ingested attachment. Resolves through the
 * asset store's managed-path check and refuses anything oversized, missing,
 * or outside the store.
 */
function readToolResultAttachment(service, attachmentId) {
  const id = String(attachmentId || '').trim();
  const index = attachmentIndexFor(service || {});
  const record = id ? index.get(id) : null;
  if (!record) {
    return { ok: false, reason: 'unknown attachment id' };
  }
  const store = service.attachmentAssetStore;
  const managedPath = store && typeof store.resolveManagedAssetRealPath === 'function'
    ? store.resolveManagedAssetRealPath(record.assetPath, { kind: 'image' })
    : '';
  if (!managedPath) {
    return { ok: false, reason: 'attachment is not in the managed asset store' };
  }
  let stats;
  try {
    stats = fs.statSync(managedPath);
  } catch (_error) {
    return { ok: false, reason: 'attachment asset is unavailable' };
  }
  if (!stats.isFile() || stats.size > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
    return { ok: false, reason: 'attachment asset failed the bounded-read check' };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(managedPath);
  } catch (_error) {
    return { ok: false, reason: 'attachment asset is unavailable' };
  }
  if (bytes.length > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
    return { ok: false, reason: 'attachment asset failed the bounded-read check' };
  }
  return {
    ok: true,
    id: record.id,
    kind: record.kind,
    mimeType: record.mimeType,
    byteLength: bytes.length,
    width: record.width,
    height: record.height,
    ...(record.pageNumber ? { pageNumber: record.pageNumber } : {}),
    dataBase64: bytes.toString('base64'),
  };
}

module.exports = {
  MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES,
  ingestToolResultAttachments,
  normalizeWireToolResultAttachment,
  readToolResultAttachment,
  toPersistedToolResultAttachmentRefs,
};
