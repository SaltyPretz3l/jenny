'use strict';

/* services/session-directory-digest.js - the deterministic pieces of a chat digest
 * for `session_status` (row 69 W2): transcript tail, pending proposals, inbox counts,
 * project open tasks and note excerpt, and the working-tree change counts. Pure over
 * the records the directory service reads (no model call, no store); every reader
 * tolerates a missing or malformed record and returns an empty or null fact.
 */

const { sanitizeReportText } = require('./backend/session-report-records');

const TITLE_CHARS = 200;
const EXCERPT_CHARS = 280;
// session_status keeps a small text-only tail; session_transcript is the full, pageable read.
const STATUS_TAIL = Object.freeze({ limit: 12, budget: 4000, rowChars: 1000 });
const TRANSCRIPT_ROWS = 20;
const TRANSCRIPT_CHARS = 16000;
const TRANSCRIPT_ROW_CHARS = 2000;
const TOOL_ROW_CHARS = 300;
const LAST_REPLY_BYTES = 8192;
const CLIP_MARK = ' [clipped]';
const MAX_PROPOSALS = 20;
const MAX_TASKS = 50;
const OPEN_TASK_STATUSES = new Set(['active', 'deferred']);
const CHANGES_BUDGET_MS = 1500;

// A cut never ends on the first half of a surrogate pair.
function safeSlice(text, limit) {
  const cut = text.slice(0, limit);
  return /[\ud800-\udbff]$/u.test(cut) && cut.length < text.length ? cut.slice(0, -1) : cut;
}

function clip(value, limit) {
  return typeof value === 'string' ? safeSlice(value, limit) : '';
}

function oneLine(value, limit) {
  return clip(typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '', limit);
}

const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

function isTextRow(message) {
  return Boolean(message) && ['user', 'assistant'].includes(message.role) && !message.kind
    && typeof message.content === 'string' && Boolean(message.content.trim());
}

// Sanitizes at most twice `limit` characters of `value` (a huge row is never scanned whole), then clips to
// `limit` with the mark; a head cut always carries the mark.
function sanitizedClip(value, limit) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length <= limit * 2) return clipText(sanitizeReportText(raw), limit);
  return safeSlice(sanitizeReportText(safeSlice(raw, limit * 2)), limit - CLIP_MARK.length) + CLIP_MARK;
}

function clipText(text, limit) {
  if (text.length <= limit) return text;
  return limit > CLIP_MARK.length ? safeSlice(text, limit - CLIP_MARK.length) + CLIP_MARK : safeSlice(text, limit);
}

const rowId = (message) => (typeof message.id === 'string' ? message.id.slice(0, 128) : null);

// A tool row reduced to one line: the call's or the result's sanitized summary line (what the chat shows),
// never the raw output (a command's output or a file's content can hold secrets) and never reasoning.
function toolRow(message) {
  const call = message?.kind === 'tool_use' ? message.tool_call : null;
  const outcome = message?.kind === 'tool_result' ? message.tool_result : null;
  const body = call || outcome;
  if (!body || typeof body !== 'object') return null;
  const state = outcome?.is_error === true ? 'error' : body.approval_state || body.status;
  const source = body.summary || (call ? message.content : '');
  return { id: rowId(message), role: 'tool', tool_name: clip(body.tool_name, 128),
    state: typeof state === 'string' ? clip(state, 32) : null, text: oneLine(sanitizeReportText(typeof source === 'string' ? safeSlice(source, TOOL_ROW_CHARS * 4) : ''), TOOL_ROW_CHARS) };
}

// Cheap shape test for the paging flag (no clip or sanitize over the older rows).
const tailCandidate = (message, includeTools) => isTextRow(message)
  || (includeTools && (message?.kind === 'tool_use' || message?.kind === 'tool_result'));

function tailRow(message, includeTools, rowChars) {
  if (!isTextRow(message)) return includeTools ? toolRow(message) : null;
  return { id: rowId(message), role: message.role, text: sanitizedClip(message.content, rowChars),
    timestamp: typeof message.timestamp === 'string' ? message.timestamp.slice(0, 64) : null };
}

// The newest rows (older than `beforeId` when paging), oldest first: at most `limit` rows within `budget` characters,
// dropping the oldest first. `moreBefore` says an older row (text, or tool when asked) exists. An unknown id pages nowhere.
function transcriptTail(messages, { limit = TRANSCRIPT_ROWS, beforeId = null, includeTools = false,
  budget: maxChars = TRANSCRIPT_CHARS, rowChars = TRANSCRIPT_ROW_CHARS } = {}) {
  const source = Array.isArray(messages) ? messages : [];
  // The cursor matches the id exactly as rows return it (clipped to 128), so a long id still pages.
  const end = beforeId === null ? source.length : source.findIndex((message) => message && rowId(message) === beforeId);
  if (end < 0) return { rows: [], moreBefore: false };
  const rows = [];
  let budget = maxChars;
  let index = end - 1;
  for (; index >= 0 && rows.length < limit; index -= 1) {
    const row = tailRow(source[index], includeTools, rowChars);
    if (!row) continue;
    if (row.text.length > budget) break;
    budget -= row.text.length;
    rows.push(row);
  }
  const moreBefore = source.slice(0, index + 1).some((message) => tailCandidate(message, includeTools));
  return { rows: rows.reverse(), moreBefore };
}

// The LAST `maxBytes` UTF-8 bytes of `text`, starting on a code point boundary.
function tailUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let start = buffer.length - maxBytes;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1; // never inside a continuation run
  return buffer.subarray(start).toString('utf8').trimStart();
}

// The chat's latest assistant text reply: the newest assistant text row, joined with the earlier assistant
// text rows of its turn, sanitized and cut to its LAST 8,192 UTF-8 bytes (a long turn keeps its conclusion).
const isAssistantText = (message) => isTextRow(message) && message.role === 'assistant';

function lastReply(messages) {
  const source = Array.isArray(messages) ? messages : [];
  const newest = source.findLast(isAssistantText);
  if (!newest) return { text: null, clipped: false, messageId: null };
  const turn = typeof newest.turn_id === 'string' && newest.turn_id ? newest.turn_id : null;
  const parts = turn ? source.filter((message) => isAssistantText(message) && message.turn_id === turn) : [newest];
  // UTF-8 bytes >= characters, so a tail of twice the byte cap in characters always covers the cut.
  const joined = parts.map((message) => message.content).join('\n\n');
  let tail = joined.length > LAST_REPLY_BYTES * 2 ? joined.slice(-LAST_REPLY_BYTES * 2) : joined;
  if (/^[\udc00-\udfff]/u.test(tail) && tail !== joined) tail = tail.slice(1); // never a lone low surrogate
  const sanitized = sanitizeReportText(tail);
  const text = tailUtf8(sanitized, LAST_REPLY_BYTES);
  return { text, clipped: tail !== joined || text !== sanitized, messageId: rowId(newest) };
}

function proposalTitle(record) {
  const input = record?.normalized_input;
  if (!input || typeof input !== 'object') return '';
  if (record.kind === 'session') return input.title;
  if (record.kind === 'git') return input.summary;
  return input.purpose;
}

// Proposals still waiting for the user's decision; command text and paths never appear.
function pendingProposals(detail) {
  const records = detail?.chat_proposals?.records;
  if (!Array.isArray(records)) return [];
  return records.filter((record) => record?.decision_state === 'pending').slice(0, MAX_PROPOSALS).map((record) => ({
    proposal_id: clip(record.proposal_id, 128),
    kind: clip(record.kind, 32),
    decision_state: 'pending',
    action_state: clip(record.action_state, 32),
    title: oneLine(proposalTitle(record), TITLE_CHARS),
  }));
}

function inboxCounts(summary, detail) {
  const inbox = Array.isArray(detail?.session_mail?.inbox) ? detail.session_mail.inbox : [];
  return {
    unread: count(summary?.unread_message_count),
    // Reserved mail is queued for a turn in flight; list_inbox reads it as queued too.
    queued: inbox.filter((record) => ['queued', 'reserved'].includes(record?.context?.state)).length,
  };
}

// The project's open agent tasks (the task_board rows), never another project's.
function openTasks(state, projectId) {
  const followUps = Array.isArray(state?.followUps) ? state.followUps : [];
  return followUps.filter((task) => task?.sourceKind === 'agent_task' && task.projectId === projectId
    && OPEN_TASK_STATUSES.has(task.status)).slice(0, MAX_TASKS).map((task) => ({
    id: clip(task.id, 128), label: oneLine(task.label, TITLE_CHARS), status: task.status,
  }));
}

function noteFacts(result) {
  const note = result?.ok === true ? result.note : null;
  if (!note || typeof note !== 'object') return null;
  return {
    revision: count(note.revision),
    updated_at: typeof note.updatedAt === 'string' ? note.updatedAt : null,
    excerpt: clip(note.text, EXCERPT_CHARS),
  };
}

function changesFacts(result) {
  const data = result?.ok === true ? result.summary?.changes?.data : null;
  if (!data || typeof data !== 'object') return null;
  return {
    file_count: count(data.file_count),
    additions: count(data.additions),
    deletions: count(data.deletions),
    ref: typeof data.ref === 'string' ? data.ref.slice(0, TITLE_CHARS) : null,
  };
}

// Live Git through the chat workspace summary, bounded to 1.5 s; a slow or failed read is null.
async function readChanges(chatWorkspaceService, sessionId) {
  if (typeof chatWorkspaceService?.getSummary !== 'function') return null;
  let timer = null;
  try {
    const budget = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), CHANGES_BUDGET_MS);
      timer.unref?.();
    });
    return changesFacts(await Promise.race([
      chatWorkspaceService.getSummary({ schema_version: 1, session_id: sessionId }), budget,
    ]));
  } catch (_error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  TITLE_CHARS,
  clip,
  count,
  inboxCounts,
  lastReply,
  statusTail: (messages) => transcriptTail(messages, STATUS_TAIL).rows,
  noteFacts,
  openTasks,
  pendingProposals,
  readChanges,
  transcriptTail,
};
