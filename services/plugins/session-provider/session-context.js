'use strict';

const { PLUGIN_SESSION_LIMITS } = require('../../plugin-session-budgets');

const MAX_CONTEXT_MESSAGES = PLUGIN_SESSION_LIMITS.transcript_page_messages;
const MAX_CONTEXT_PAGE_BYTES = PLUGIN_SESSION_LIMITS.transcript_page_bytes;

function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch (_error) { return Infinity; }
}

function boundedText(value, max = 12_000) {
  return String(value == null ? '' : value).slice(0, max);
}

function normalizeCursor(value, messageCount) {
  if (value == null || value === '') return messageCount;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= messageCount ? parsed : null;
}

function operationIdFor(message, attachment) {
  return String(message?.plugin_operation?.operation_id
    || attachment?.provenance?.operation_id
    || `message_${String(message?.id || 'legacy').replace(/[^A-Za-z0-9_-]/g, '_')}`)
    .slice(0, 96);
}

function presentAttachment(attachment, message, session, viewContext, ticketBroker) {
  const source = attachment && typeof attachment === 'object' ? attachment : {};
  const base = {
    id: boundedText(source.id, 160),
    kind: boundedText(source.kind, 32),
    display_name: boundedText(source.displayName, 240),
    mime_type: boundedText(source.mimeType, 120),
    size_bytes: Math.max(0, Math.trunc(Number(source.sizeBytes) || 0)),
    width: Math.max(0, Math.trunc(Number(source.width) || 0)),
    height: Math.max(0, Math.trunc(Number(source.height) || 0)),
    source_kind: boundedText(source.sourceKind, 64),
  };
  if (base.kind !== 'image' || !base.id) return base;
  const issued = ticketBroker.issueForAttachment({
    viewInstanceId: viewContext.viewInstanceId,
    generationId: viewContext.generationId,
    sessionId: session.id,
    sessionIncarnation: session.session_incarnation,
    operationId: operationIdFor(message, source),
    attachmentId: base.id,
    webContentsId: viewContext.senderId,
    artifactDigest: viewContext.artifactDigest,
  });
  return issued.ok ? { ...base, url: issued.url, expires_at: issued.expires_at } : base;
}

function presentMessage(message, session, viewContext, ticketBroker) {
  const source = message && typeof message === 'object' ? message : {};
  return {
    id: boundedText(source.id, 160),
    role: boundedText(source.role, 32),
    content: boundedText(source.content),
    status: boundedText(source.status, 64),
    timestamp: boundedText(source.timestamp, 64),
    attachments: (Array.isArray(source.attachments) ? source.attachments : [])
      .slice(0, 16)
      .map((attachment) => presentAttachment(
        attachment, source, session, viewContext, ticketBroker
      )),
    ...(source.plugin_operation ? { plugin_operation: { ...source.plugin_operation } } : {}),
  };
}

function buildTranscriptPage({ session, cursor, viewContext, ticketBroker } = {}) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const end = normalizeCursor(cursor, messages.length);
  if (end == null) return { ok: false, reason: 'plugin_session_cursor_invalid' };
  const page = [];
  let bytes = 2;
  let start = end;
  while (start > 0 && page.length < MAX_CONTEXT_MESSAGES) {
    const candidate = presentMessage(messages[start - 1], session, viewContext, ticketBroker);
    const candidateBytes = jsonBytes(candidate) + (page.length ? 1 : 0);
    if (page.length && bytes + candidateBytes > MAX_CONTEXT_PAGE_BYTES) break;
    if (!page.length && candidateBytes > MAX_CONTEXT_PAGE_BYTES) {
      candidate.content = boundedText(candidate.content, 2048);
      candidate.attachments = candidate.attachments.slice(0, 4);
    }
    page.unshift(candidate);
    bytes += jsonBytes(candidate) + (page.length > 1 ? 1 : 0);
    start -= 1;
  }
  return {
    ok: true,
    messages: page,
    next_cursor: start > 0 ? String(start) : null,
    page_bytes: bytes,
  };
}

module.exports = {
  MAX_CONTEXT_MESSAGES,
  MAX_CONTEXT_PAGE_BYTES,
  buildTranscriptPage,
  normalizeCursor,
  presentMessage,
};
