'use strict';

const { API_VERSION } = require('./api-contract');

const DEFAULT_MAX_MESSAGES = 40;
const MAX_MESSAGES = 100;
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_TEXT = 500;
const MAX_LIVE_PROJECTION_TEXT = 262_144;
const MAX_LIVE_REASONING_TEXT = 65_536;

function text(value, limit = MAX_SUMMARY_TEXT) {
  return String(value == null ? '' : value).slice(0, limit);
}


function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedMessageLimit(value) {
  if (value === undefined) return DEFAULT_MAX_MESSAGES;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_MESSAGES) return null;
  return parsed;
}

// Authenticated canonical message content stays in the existing turn vocabulary.
// Pagination bounds bytes; the transport must not silently discard turn_events,
// tool results, or artifacts which the shared renderer projectors need.
const MESSAGE_FIELDS = Object.freeze([
  'id', 'role', 'kind', 'content', 'status', 'terminal_subcode', 'timestamp',
  'model_used', 'client_message_id', 'parent_stream_id', 'event_seq', 'turn_id',
  'turn_events', 'phases', 'visible_segments', 'tool_steps', 'reasoning',
  'tool_call', 'tool_result', 'generated_artifacts', 'interactive_batch',
  'interactive_round_recap', 'plan_object', 'plan_document',
]);

function projectMessage(value) {
  if (!record(value) || typeof value.id !== 'string' || !value.id) return null;
  const result = {};
  for (const key of MESSAGE_FIELDS) {
    if (Object.hasOwn(value, key)) result[key] = structuredClone(value[key]);
  }
  result.attachments = (Array.isArray(value.attachments) ? value.attachments : []).map((attachment) => ({
    id: text(attachment?.id, 128), kind: text(attachment?.kind, 32),
    display_name: text(attachment?.displayName || attachment?.display_name, 240),
    mime_type: text(attachment?.mimeType || attachment?.mime_type, 128),
    size_bytes: Number.isSafeInteger(attachment?.sizeBytes) ? attachment.sizeBytes : 0,
  })).filter((attachment) => attachment.id);
  if (value.finalizedAt) result.finalized_at = text(value.finalizedAt, 80);
  return result;
}

function projectActiveTurn(value) {
  if (!record(value)) return null;
  const result = {};
  const fields = [
    ['request_id', 128], ['turn_id', 128], ['stream_id', 128], ['session_id', 128],
    ['user_message_id', 256], ['trace_id', 128], ['status', 80], ['state', 80],
    ['phase', 80], ['terminal_reason', 160], ['terminal_subcode', 160],
    ['started_at', 80], ['last_event_at', 80],
  ];
  for (const [key, limit] of fields) {
    if (value[key] !== undefined && value[key] !== null) result[key] = text(value[key], limit);
  }
  if (Number.isSafeInteger(value.generation)) result.generation = value.generation;
  if (record(value.pending_approval)) {
    result.pending_approval = {
      approval_id: text(value.pending_approval.approval_id, 128),
      call_id: text(value.pending_approval.call_id, 128),
      tool_name: text(value.pending_approval.tool_name, 128),
      summary: text(value.pending_approval.summary),
      policy_scope: text(value.pending_approval.policy_scope, 128),
      policy_consequence: text(value.pending_approval.policy_consequence, 128),
      reason: text(value.pending_approval.reason, 500),
    };
  }
  return result.stream_id || result.request_id ? result : null;
}

const LIVE_PROJECTION_KEYS = new Set([
  'stream_id', 'session_id', 'status', 'phase', 'model', 'assistant_text',
  'current_segment_text', 'reasoning_text', 'thinking_text', 'thinking_status',
  'tool_name', 'tool_summary', 'approval_id', 'question_ref', 'updated_at',
]);

function projectLiveProjection(value) {
  if (!record(value)) return null;
  const result = {};
  for (const key of LIVE_PROJECTION_KEYS) {
    if (value[key] !== undefined && value[key] !== null) {
      result[key] = text(value[key], MAX_LIVE_PROJECTION_TEXT);
    }
  }
  // BackendEvents owns the live projection shape: content is the bounded
  // aggregate and reasoning is a bounded list of entries. Preserve both at
  // their source limits instead of silently reducing reconnect state to 16k.
  if (typeof value.content === 'string') {
    result.assistant_text = value.content.slice(0, MAX_LIVE_PROJECTION_TEXT);
    result.current_segment_text = result.assistant_text;
    if (value.content.length > MAX_LIVE_PROJECTION_TEXT) result.truncated = true;
  }
  if (Array.isArray(value.reasoning)) {
    const reasoningEntries = value.reasoning.slice(-128).map((entry) => {
      if (!record(entry)) return null;
      const entryText = text(entry.text, MAX_LIVE_REASONING_TEXT);
      return entryText ? {
        id: text(entry.id, 256),
        text: entryText,
        timestamp: text(entry.timestamp, 80),
        thinking_id: text(entry.thinking_id || entry.thinkingId, 256),
      } : null;
    }).filter(Boolean);
    const reasoning = reasoningEntries.map((entry) => entry.text);
    result.reasoning = reasoningEntries;
    const joined = reasoning.join('\n');
    result.reasoning_text = joined.slice(0, MAX_LIVE_REASONING_TEXT);
    if (joined.length > MAX_LIVE_REASONING_TEXT) result.truncated = true;
  }
  if (value.truncated === true) result.truncated = true;
  return Object.keys(result).length ? result : null;
}

function canonicalSession(backend, sessionId) {
  const store = backend?.sessionStore;
  if (typeof store?.getSession === 'function') return store.getSession(sessionId);
  if (typeof backend?.getSession === 'function') return backend.getSession(sessionId);
  return null;
}

function messagesFor(backend, sessionId, session) {
  if (Array.isArray(session?.messages)) return session.messages;
  if (typeof backend?.getSessionMessages === 'function') {
    const value = backend.getSessionMessages(sessionId);
    return Array.isArray(value?.data) ? value.data : Array.isArray(value) ? value : [];
  }
  return [];
}

function readPage(messages, options = {}) {
  const limit = boundedMessageLimit(options.max_messages);
  if (!limit) return { ok: false, reason: 'invalid_message_limit' };
  const before = options.before_message_id === undefined
    ? '' : String(options.before_message_id || '').trim();
  let end = messages.length;
  if (before) {
    const index = messages.findIndex((message) => String(message?.id || '') === before);
    if (index < 0) return { ok: false, reason: 'message_cursor_unknown' };
    end = index;
  }
  let start = end;
  let bytes = 2;
  let count = 0;
  const selected = [];
  while (start > 0 && count < limit) {
    let candidate = projectMessage(messages[start - 1]);
    if (!candidate) { start -= 1; continue; }
    let candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (candidateBytes > MAX_PAGE_BYTES) {
      // An authenticated full-message endpoint can serve the canonical row;
      // snapshots carry an explicit bounded marker rather than dropping it.
      candidate = { id: candidate.id, role: candidate.role, content: text(candidate.content, 2000),
        message_projection_truncated: true, full_message_available: true };
      candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
    }
    if (count > 0 && bytes + candidateBytes > MAX_PAGE_BYTES) break;
    start -= 1;
    count += 1;
    bytes += candidateBytes;
    selected.unshift(candidate);
  }
  return {
    ok: true,
    messages: selected,
    message_count: messages.length,
    has_more: start > 0,
    ...(start > 0 && messages[start]?.id ? { next_before_message_id: String(messages[start].id) } : {}),
  };
}

function buildSessionSnapshot({ backend, eventStream, decisionAdapter, sessionId, revision, options = {} } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const session = canonicalSession(backend, normalizedSessionId);
  if (!normalizedSessionId || !session) return null;
  const page = readPage(messagesFor(backend, normalizedSessionId, session), options);
  if (!page.ok) return page;
  // BackendService.getActiveTurnState is asynchronous. Snapshots are a
  // synchronous projection boundary, so use the canonical store's persisted
  // active turn here; the live event projection carries in-flight detail.
  const activeTurn = session.active_turn;
  const approvals = decisionAdapter?.listApprovals?.(normalizedSessionId) || [];
  const questions = decisionAdapter?.listQuestions?.(normalizedSessionId) || [];
  let liveProjection;
  try {
    const raw = eventStream?.snapshot?.(normalizedSessionId);
    liveProjection = raw && typeof raw.then !== 'function' ? projectLiveProjection(raw) : null;
  } catch (_error) {
    liveProjection = null;
  }
  const cursor = Number(eventStream?.cursor);
  const { ok: _pageOk, ...pageDto } = page;
  return {
    api_version: API_VERSION,
    boot_epoch: text(options.boot_epoch, 128),
    cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
    session: {
      session_id: normalizedSessionId,
      title: text(session.title, 240),
      revision: text(revision, 160),
      plan_mode: session.plan_mode === true,
    },
    ...pageDto,
    active_turn: projectActiveTurn(activeTurn),
    pending_approvals: approvals,
    pending_questions: questions,
    live_projection: liveProjection,
  };
}

module.exports = { buildSessionSnapshot, projectMessage };
