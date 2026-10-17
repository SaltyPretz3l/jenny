// Wire payloads arrive snake_case (id, kind, mime_type, data_base64,
// byte_length, width, height, page_number, source_tool) and are normalized to
// camelCase at ingest. Persisted turn events and session messages reference
// the STORED asset id/path only — raw bytes/base64 never persist.

const fs = require('fs');
const { t } = require('../i18n-main');
const { normalizeRuntimeToken } = require('./chat-stream-managed-runtime-utils');

// Mirrors sidecar TRUSTED_ATTACHMENTS_MAX_TOTAL_BYTES (aggregate decoded
// bytes per tool result) — anything larger was never admitted sidecar-side,
// so it is refused here too (defense in depth).
const MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES = 2 * 1024 * 1024;
const ADMITTED_KINDS = new Set(['image', 'pdf_page', 'chart']);
const ADMITTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Bounded session+id -> stored-asset index so reads never cross session
// ownership. Oldest entries fall out first; canonical session refs retain the
// restart/eviction fallback without a profile-wide scan.
const MAX_INDEX_ENTRIES = 512;

function boundedReadToken(value, maxChars) {
  const token = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- session/attachment identifiers reject controls.
  return token && token.length <= maxChars && !/[\u0000-\u001f\u007f]/u.test(token)
    ? token
    : '';
}

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

function attachmentIndexKey(sessionId, attachmentId) {
  return `${sessionId}\0${attachmentId}`;
}

function captureSessionIdentity(service, sessionId) {
  const store = service?.sessionStore;
  let record;
  try {
    record = typeof store?.getSessionSummary === 'function'
      ? store.getSessionSummary(sessionId)
      : typeof store?.peekSession === 'function'
        ? store.peekSession(sessionId)
        : typeof store?.getSession === 'function'
          ? store.getSession(sessionId)
          : null;
  } catch (_error) {
    return null;
  }
  const id = boundedReadToken(record?.id, 128);
  const projectId = boundedReadToken(record?.project_id, 128);
  const incarnation = boundedReadToken(record?.created_at, 128)
    || boundedReadToken(record?.session_incarnation, 128);
  return id === sessionId && projectId && incarnation
    ? Object.freeze({ id, projectId, incarnation })
    : null;
}

function sameSessionIdentity(left, right) {
  return Boolean(left && right && left.id === right.id
    && left.projectId === right.projectId && left.incarnation === right.incarnation);
}

function rememberStoredAttachment(service, record) {
  const index = attachmentIndexFor(service);
  index.set(attachmentIndexKey(record.sessionId, record.id), record);
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
  const sessionId = String(context.sessionId || '').trim();
  const sessionIdentity = captureSessionIdentity(service, sessionId);
  if (!sessionId || !store || typeof store.saveImageBufferSync !== 'function'
    || !entries.length || (service?.projectAuthority && !sessionIdentity)) {
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
      // The store sniffs the bytes (ART-07); the wire's claim is only a hint.
      mimeType: stored.mimeType || normalized.mimeType,
      byteLength: normalized.byteLength,
      width: normalized.width || stored.width || 0,
      height: normalized.height || stored.height || 0,
      pageNumber: normalized.pageNumber,
      assetPath: stored.assetPath,
      streamId: String(context.streamId || ''),
      toolCallId: String(context.callId || ''),
      toolName: String(context.toolName || ''),
      sessionId,
      sessionIdentity,
    };
    rememberStoredAttachment(service, record);
    refs.push(record);
  }
  return refs;
}

/**
 * Refs this process already ingested for one tool call. The canonical replay
 * of a tool.result carries no bytes, so it recovers the stored refs here
 * instead of overwriting them with an empty list.
 */
function ingestedToolResultAttachmentRefs(service, { sessionId, streamId, callId } = {}) {
  const owner = String(sessionId || '').trim();
  const call = String(callId || '').trim();
  if (!service || !owner || !call) return [];
  const stream = String(streamId || '');
  const refs = [];
  for (const record of attachmentIndexFor(service).values()) {
    if (record.sessionId === owner && record.toolCallId === call
      && (!stream || record.streamId === stream)) {
      refs.push(record);
    }
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
 * Bounded session-owned read of one ingested attachment. Resolves through the
 * asset store's managed-path check and refuses anything oversized, missing,
 * or outside the requested canonical session.
 */
function readContext(attachmentIdOrPayload, options) {
  const payload = attachmentIdOrPayload && typeof attachmentIdOrPayload === 'object'
    && !Array.isArray(attachmentIdOrPayload) ? attachmentIdOrPayload : null;
  return {
    id: boundedReadToken(String(payload
      ? payload.attachment_id || payload.attachmentId || ''
      : attachmentIdOrPayload || ''), 256),
    sessionId: boundedReadToken(String(payload?.session_id || payload?.sessionId
      || options?.sessionId || options?.session_id || ''), 128),
  };
}

function persistedRecordForSession(service, sessionId, attachmentId) {
  const store = service?.sessionStore;
  let messages;
  try {
    messages = typeof store?.peekSessionMessages === 'function'
      ? store.peekSessionMessages(sessionId)
      : typeof store?.getSessionMessages === 'function'
        ? store.getSessionMessages(sessionId)
        : [];
  } catch (_error) {
    return null;
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const refs = message?.kind === 'tool_result'
      && Array.isArray(message?.tool_result?.trusted_attachment_refs)
      ? message.tool_result.trusted_attachment_refs
      : [];
    const ref = refs.find((entry) => String(entry?.id || '').trim() === attachmentId);
    if (!ref) continue;
    return {
      id: attachmentId,
      kind: String(ref.kind || '').trim(),
      mimeType: String(ref.mime_type || ref.mimeType || '').trim(),
      byteLength: Number(ref.byte_length ?? ref.byteLength) || 0,
      width: Number(ref.width) || 0,
      height: Number(ref.height) || 0,
      pageNumber: Number(ref.page_number ?? ref.pageNumber) || null,
      assetPath: String(ref.asset_path || ref.assetPath || '').trim(),
      sessionId,
    };
  }
  return null;
}

/**
 * Session-owned resolution of one ingested attachment to its managed real
 * path (live index first, then the persisted session refs). Main-process
 * only: the path must never reach the renderer.
 */
function resolveToolResultAttachmentPath(service, sessionId, attachmentId) {
  const id = boundedReadToken(attachmentId, 256);
  const owner = boundedReadToken(sessionId, 128);
  const index = attachmentIndexFor(service || {});
  let record = id && owner ? index.get(attachmentIndexKey(owner, id)) : null;
  if (record && service?.projectAuthority
    && !sameSessionIdentity(record.sessionIdentity, captureSessionIdentity(service, owner))) {
    record = null;
  }
  if (!record && id && owner) {
    record = persistedRecordForSession(service, owner, id);
  }
  if (!record) {
    return { ok: false, reason: 'unknown_id' };
  }
  const store = service.attachmentAssetStore;
  const managedPath = store && typeof store.resolveManagedAssetRealPath === 'function'
    ? store.resolveManagedAssetRealPath(record.assetPath, { kind: 'image' })
    : '';
  if (!managedPath) {
    return { ok: false, reason: 'not_managed' };
  }
  return { ok: true, path: managedPath, mimeType: record.mimeType, kind: record.kind, record };
}

function readToolResultAttachment(service, attachmentIdOrPayload, options = {}) {
  const { id, sessionId } = readContext(attachmentIdOrPayload, options);
  const resolved = resolveToolResultAttachmentPath(service, sessionId, id);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason === 'unknown_id'
      ? t('main.attachments.unknownId', 'unknown attachment id')
      : t('main.attachments.notManaged', 'attachment is not in the managed asset store') };
  }
  const { path: managedPath, record } = resolved;
  let stats;
  try {
    stats = fs.statSync(managedPath);
  } catch (_error) {
    return { ok: false, reason: t('main.attachments.assetUnavailable', 'attachment asset is unavailable') };
  }
  if (!stats.isFile() || stats.size > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
    return { ok: false, reason: t('main.attachments.boundedReadFailed', 'attachment asset failed the bounded-read check') };
  }
  let bytes;
  try {
    bytes = fs.readFileSync(managedPath);
  } catch (_error) {
    return { ok: false, reason: t('main.attachments.assetUnavailable', 'attachment asset is unavailable') };
  }
  if (bytes.length > MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES) {
    return { ok: false, reason: t('main.attachments.boundedReadFailed', 'attachment asset failed the bounded-read check') };
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

// The sidecar journals a tool result's trusted attachments by wire id only
// (att_*), but the renderer draws them from the stored asset (image_* id and
// asset_path) that Electron ingested from the live tool.result. Swap in the
// stored refs before capture so a Python chart renders live and after reload.
function withIngestedAttachmentRefs(ctx, event) {
  const type = normalizeRuntimeToken(event?.type);
  const payload = event?.payload;
  if ((type !== 'tool_execution_completed' && type !== 'tool_execution_failed')
    || !Array.isArray(payload?.trusted_attachment_refs) || !payload.trusted_attachment_refs.length) {
    return event;
  }
  const stored = ingestedToolResultAttachmentRefs(ctx.service, {
    sessionId: ctx.resolvedSessionId,
    streamId: ctx.streamId,
    callId: normalizeRuntimeToken(event.tool_call_id || payload.tool_call_id || payload.toolCallId),
  });
  if (!stored.length) return event;
  const bySourceId = new Map(stored.map((record) => [record.sourceId, record]));
  let changed = false;
  const refs = payload.trusted_attachment_refs.map((ref) => {
    const record = bySourceId.get(String(ref?.id || ''));
    if (!record) return ref;
    changed = true;
    return toPersistedToolResultAttachmentRefs([record])[0];
  });
  return changed ? { ...event, payload: { ...payload, trusted_attachment_refs: refs } } : event;
}

module.exports = {
  MAX_TOOL_RESULT_ATTACHMENT_TOTAL_BYTES,
  ingestToolResultAttachments,
  ingestedToolResultAttachmentRefs,
  normalizeWireToolResultAttachment,
  readToolResultAttachment,
  resolveToolResultAttachmentPath,
  toPersistedToolResultAttachmentRefs,
  withIngestedAttachmentRefs,
};
