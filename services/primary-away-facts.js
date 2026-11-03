'use strict';

// Row 86 D2: the facts behind the Jenny chat's "While you were away" turn. A
// pure composer over plain data the caller already read (no Electron, no IO,
// no store of its own), so the precheck and the `away_digest` tool share one
// honest answer.
//
// Honesty rules come from the Home widget's model, never re-implemented here:
// `renderer-away-digest-model.js` (UMD) picks the terminal work after `since`,
// the outcome word comes only from `status`, no failure reason is invented and
// a chat the summaries no longer list is titled with its wording. Titles and
// labels are untrusted text, flattened and clipped with the same helper as the
// `profile_overview` block. No message body ever appears.
//
// Window: facts strictly after `since` and at or before `until`, except
// `waiting_now`, which is current state stamped `until` and labelled "now".
// Archived chats are left out, and the Jenny chat itself never reports its own
// work or updates (a digest turn would otherwise report the previous digest).

const awayModel = require('../renderer/shell/renderer-away-digest-model');
const { plainLabel } = require('./backend/profile-overview-block');

const DEFAULT_LIMITS = Object.freeze({ maxItems: 40, maxChars: 6000 });
const WAITING_STATUSES = new Set(['waiting_approval', 'waiting_question', 'waiting_plan', 'needs_attention']);
const SCHEDULE_KINDS = new Set(['schedule_missed', 'schedule_skipped', 'schedule_fired']);
const KIND_ORDER = Object.freeze([
  'waiting_now', 'work_failed', 'work_cancelled', 'work_completed', 'chat_updated', 'mail_received',
  'schedule_missed', 'schedule_skipped', 'schedule_fired',
]);

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value.filter((entry) => entry && typeof entry === 'object') : []);

function instant(value) {
  const ms = typeof value === 'string' && value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Status, outcome and reason words are closed vocabularies; anything else reads "unknown".
const word = (value) => (typeof value === 'string' && /^[a-z_]{1,32}$/.test(value) ? value : 'unknown');

function positive(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// Directory rows say `session_id` + `archived`; runtime summaries say `id` + `archived_at`.
function indexSessions(sessions) {
  const index = new Map();
  for (const row of list(sessions)) {
    const id = text(row.id) || text(row.session_id);
    if (id && !index.has(id)) index.set(id, { ...row, id, archived: row.archived === true || Boolean(row.archived_at) });
  }
  return index;
}

const titleOf = (session) => plainLabel(awayModel.sessionTitleFor(session), 'Untitled chat');

function item(kind, atMs, title, detail, sessionId) {
  return {
    kind,
    at: new Date(atMs).toISOString(),
    title,
    ...(detail ? { detail } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function workFacts({ work, sessions, primaryId, sinceIso, untilMs }) {
  const hidden = new Set([...sessions.values()].filter((s) => s.archived).map((s) => s.id));
  if (primaryId) hidden.add(primaryId);
  const page = list(work).filter((summary) => !hidden.has(text(summary.session_id)));
  const listed = [...sessions.values()].filter((s) => !s.archived);
  const digest = awayModel.buildAwayDigest({
    work: page, seenAt: sinceIso, sessions: listed, limit: Infinity, now: untilMs,
  });
  return digest.rows
    .filter((row) => {
      const at = instant(row.finishedAt);
      return at !== null && at <= untilMs;
    })
    // The model's own title: "Chat deleted" for a chat no longer listed, never an invented name.
    .map((row) => item(`work_${row.outcome}`, instant(row.finishedAt), plainLabel(row.sessionTitle, 'Untitled chat'),
      null, row.sessionId));
}

function chatFacts({ sessions, primaryId, sinceMs, untilMs, reported }) {
  const out = [];
  for (const session of sessions.values()) {
    if (session.archived || session.id === primaryId) continue;
    const status = text(session.status);
    if (session.waiting_on_user === true || session.needs_attention === true || WAITING_STATUSES.has(status)) {
      out.push(item('waiting_now', untilMs, titleOf(session), `now: ${status ? word(status) : 'waiting_on_user'}`, session.id));
    }
    const updated = instant(session.updated_at);
    const outcome = text(session.last_outcome?.status);
    // A chat whose finished work is already listed is not listed twice.
    if (!outcome || updated === null || updated <= sinceMs || updated > untilMs || reported.has(session.id)) continue;
    out.push(item('chat_updated', updated, titleOf(session), `last outcome: ${word(outcome)}`, session.id));
  }
  return out;
}

// Inbox records as services/backend/session-mail-store.js reads them:
// `{ delivered_at, envelope: { message_id, source_session_id, kind, report } }`.
function mailFacts({ mail, sessions, sinceMs, untilMs }) {
  const out = [];
  const seen = new Set();
  for (const record of list(mail)) {
    const envelope = record.envelope && typeof record.envelope === 'object' ? record.envelope : null;
    const at = instant(record.delivered_at);
    const messageId = text(envelope?.message_id);
    if (!envelope || at === null || at <= sinceMs || at > untilMs || !messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    const sourceId = text(envelope.source_session_id);
    const detail = envelope.kind === 'terminal_report'
      ? `report: ${word(envelope.report?.outcome)}`
      : 'message';
    out.push(item('mail_received', at, titleOf(sessions.get(sourceId)), detail, sourceId));
  }
  return out;
}

// The Jenny chat's history entries (services/shell-config-primary-chat.js):
// `{ kind, at, reminder_id, label, reason? }`.
function scheduleFacts({ schedules, sinceMs, untilMs }) {
  const out = [];
  for (const entry of list(schedules)) {
    const at = instant(entry.at);
    if (!SCHEDULE_KINDS.has(entry.kind) || at === null || at <= sinceMs || at > untilMs) continue;
    const reason = text(entry.reason);
    out.push(item(entry.kind, at, plainLabel(entry.label, 'Scheduled check'), reason ? word(reason) : null));
  }
  return out;
}

function compareItems(left, right) {
  if (left.at !== right.at) return Date.parse(right.at) - Date.parse(left.at);
  const byKind = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
  if (byKind) return byKind;
  for (const key of ['session_id', 'title', 'detail']) {
    const a = left[key] || '';
    const b = right[key] || '';
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

function countKinds(items) {
  const counts = { total: items.length };
  for (const entry of items) counts[entry.kind] = (counts[entry.kind] || 0) + 1;
  return counts;
}

/**
 * @param {{ since: string, until: string, primarySessionId?: string,
 *   sources?: { work?: object[], sessions?: object[], mail?: object[], schedules?: object[] },
 *   limits?: { maxItems?: number, maxChars?: number } }} input
 * @returns {{ ok: true, since, until, items, truncated, counts } | { ok: false, reason: 'invalid_window' }}
 */
function composeAwayFacts({ since, until, primarySessionId = null, sources = {}, limits = {} } = {}) {
  const sinceMs = instant(since);
  const untilMs = instant(until);
  if (sinceMs === null || untilMs === null || sinceMs > untilMs) return { ok: false, reason: 'invalid_window' };
  const sinceIso = new Date(sinceMs).toISOString();
  const untilIso = new Date(untilMs).toISOString();
  const input = sources && typeof sources === 'object' ? sources : {};
  const sessions = indexSessions(input.sessions);
  const primaryId = text(primarySessionId);
  const work = workFacts({ work: input.work, sessions, primaryId, sinceIso, untilMs });
  const reported = new Set(work.map((entry) => entry.session_id));
  const all = [
    ...work,
    ...chatFacts({ sessions, primaryId, sinceMs, untilMs, reported }),
    ...mailFacts({ mail: input.mail, sessions, sinceMs, untilMs }),
    ...scheduleFacts({ schedules: input.schedules, sinceMs, untilMs }),
  ].sort(compareItems);
  const maxItems = positive(limits?.maxItems, DEFAULT_LIMITS.maxItems);
  const maxChars = positive(limits?.maxChars, DEFAULT_LIMITS.maxChars);
  const items = [];
  let chars = 0;
  for (const entry of all) {
    const size = entry.title.length + (entry.detail || '').length;
    if (items.length >= maxItems || chars + size > maxChars) break;
    items.push(entry);
    chars += size;
  }
  // Counts cover every fact found, so a cut list can still say how much there was.
  return { ok: true, since: sinceIso, until: untilIso, items, truncated: items.length < all.length, counts: countKinds(all) };
}

function hasAwayFacts(result) {
  return Boolean(result && result.ok === true && Array.isArray(result.items) && result.items.length > 0);
}

module.exports = { DEFAULT_LIMITS, composeAwayFacts, hasAwayFacts };
