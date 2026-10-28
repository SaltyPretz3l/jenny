'use strict';

/* services/session-directory-service.js - the session directory projector behind the
 * `sessions_list`, `session_status` and `session_stop` agent tools (row 69 W2).
 *
 * It answers from existing Electron-owned facts only (the session index with active
 * turns, runtime work rows, in-memory pending approvals, proposals, mail, todo lists,
 * project tasks and notes, transcript tails); it calls no model and keeps no store.
 * Every dependency is an injected getter (composition-root style); a missing getter
 * or a throwing reader yields an unknown fact, never a throw. The caller comes from
 * the tool's trusted live-call binding, and every requested session id is checked
 * against the computed scope: an id outside it reads as `not_found`, never as
 * forbidden, so existence does not leak. Diagnostics carry ids, states and counts
 * only, never titles, bodies or paths.
 */

const { collectOutputs } = require('./chat-workspace-summary-sections');
const { latestTodoList } = require('./backend/session-todo-projection');
const scopeRules = require('./session-directory-scope');
const { normalizeSessionRole } = require('./backend/primary-session');
const { normalizePreferredModel } = require('./backend/session-normalizers');
const { sanitizeReportText } = require('./backend/session-report-records');
const D = require('./session-directory-digest');

const RECENT_ROWS = 20;
const MAX_LIST_ROWS = 50;
const MAX_CHILDREN = 32;
const STOPPABLE_WORK = new Set(['pending', 'paused']); // plus running work with no live stream (a resumed run)
// A stream abort is a request: the sidecar drains the turn afterwards. `stop` confirms the stream only once
// the chat's active turn has cleared within this budget, polled from the store's scan registry.
const STOP_SETTLE_MS = 1000;
const STOP_POLL_MS = 50;
// Work-derived states come from one bounded scan of the runtime's newest rows per call (pages of 100),
// bucketed by chat, instead of one runtime snapshot per listed chat.
const WORK_SCAN_PAGES = 3;
const WORK_SCAN_PAGE_ROWS = 100;
// Answers for terminal failed rows (immutable per work revision), kept across calls.
const DENIED_CACHE_ROWS = 256;
const NOT_FOUND = Object.freeze({ ok: false, reason: 'not_found' });
const ERROR_TEXT_CHARS = 200;
const ERROR_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function read(getter) {
  try { return typeof getter === 'function' ? getter() || null : null; } catch (_error) { return null; }
}

function attempt(fn, fallback) {
  try { return fn(); } catch (_error) { return fallback; }
}

// Why the newest assistant row of the failed turn failed: its error code and a short one-line message.
// Data from the engine, bounded; nothing for a row of another turn.
function failureFacts(messages, work) {
  const newest = messages.findLast((message) => message?.role === 'assistant' && !message.kind);
  if (!newest || (work?.turn_id && newest.turn_id && newest.turn_id !== work.turn_id)) return {};
  const text = D.clip(sanitizeReportText(typeof newest.stream_error === 'string' ? newest.stream_error : '')
    .replace(/\s+/gu, ' '), ERROR_TEXT_CHARS).trim();
  const code = typeof newest.error_code === 'string' && ERROR_CODE_RE.test(newest.error_code) ? newest.error_code : null;
  return { ...(code ? { last_error_code: code } : {}), ...(text ? { last_error: text } : {}) };
}

function createSessionDirectoryService({
  sessionStore, projectService, runtime, configService, projectNotesService, chatWorkspaceService,
  pendingApprovals, visibleChat, cancelChatStream, primaryChatEnabled = null, stopSettleMs = STOP_SETTLE_MS,
  log = () => {},
} = {}) {
  const note = (event, fields) => attempt(() => log('INFO', event, fields), null);

  function records(store) {
    if (typeof store?.listSessionRecords === 'function') return attempt(() => store.listSessionRecords(), null);
    if (typeof store?.listSessions === 'function') {
      return attempt(() => store.listSessions().map((summary) => ({ ...summary, active_turn: null })), null);
    }
    return null;
  }

  function scopeFor(callerSessionId) {
    const store = read(sessionStore);
    const list = records(store);
    if (!list) return { ok: false, reason: 'unavailable' };
    const primaryOn = attempt(() => typeof primaryChatEnabled === 'function' ? primaryChatEnabled() !== false : true, true);
    return { ...scopeRules.computeScope({ records: list, callerSessionId, visible: read(visibleChat), primaryChatEnabled: primaryOn }), store };
  }

  // True once the chat's active turn is gone or belongs to a later stream; false when it lingers past the
  // budget or cannot be read (both read as an uncertain cleanup).
  async function turnCleared(store, sessionId, streamId) {
    const deadline = Date.now() + stopSettleMs;
    for (;;) {
      const turn = attempt(() => (typeof store?.peekActiveTurn === 'function'
        ? store.peekActiveTurn(sessionId) : store?.getActiveTurn?.(sessionId)), undefined);
      if (turn === undefined) return false;
      if (!turn || turn.stream_id !== streamId) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
  }

  // Newest work row per chat from one bounded scan of the runtime (newest first across the profile).
  function workScan() {
    const newest = new Map();
    let cursor = null;
    for (let page = 0; page < WORK_SCAN_PAGES; page += 1) {
      const request = { limit: WORK_SCAN_PAGE_ROWS, ...(cursor ? { cursor } : {}) };
      const snapshot = attempt(() => read(runtime)?.getSnapshot?.(request), null);
      if (snapshot?.ok !== true || !Array.isArray(snapshot.work)) break;
      for (const row of snapshot.work) {
        if (typeof row?.session_id === 'string' && !newest.has(row.session_id)) newest.set(row.session_id, row);
      }
      cursor = typeof snapshot.next_cursor === 'string' && snapshot.next_cursor ? snapshot.next_cursor : null;
      if (!cursor) break;
    }
    return newest;
  }

  // The runtime's newest work rows for one chat (ok -> rows, anything else -> none).
  function workRows(sessionId, limit) {
    const snapshot = attempt(() => read(runtime)?.getSnapshot?.({ session_id: sessionId, limit }), null);
    return snapshot?.ok === true && Array.isArray(snapshot.work) ? snapshot.work : [];
  }

  // The runtime records a user-denied turn as `failed`. For display only, a failed newest row whose turn
  // ended on an approval the user denied reads `denied`: the turn's newest tool event carries
  // `approval_state: "denied"` on its `tool_call` / `tool_result` (2026-10-20 live run; the assistant text
  // row keeps an empty status). A turn that went on past a denial and then failed stays `failed`. The
  // row's own turn when it names one, else the newest turn. Messages are read only for a failed row,
  // without filling the session cache, and the answer is kept per work revision.
  const deniedByWork = new Map();
  function deniedTurn(store, sessionId, work) {
    const key = typeof work.work_id === 'string' && work.work_id ? `${work.work_id}@${work.revision}` : null;
    if (key && deniedByWork.has(key)) return deniedByWork.get(key);
    const denied = turnEndedDenied(store, sessionId, work);
    if (key) {
      if (deniedByWork.size >= DENIED_CACHE_ROWS) deniedByWork.delete(deniedByWork.keys().next().value);
      deniedByWork.set(key, denied);
    }
    return denied;
  }

  function turnEndedDenied(store, sessionId, work) {
    const detail = attempt(() => store?.peekSession?.(sessionId), null);
    const messages = Array.isArray(detail?.messages) ? detail.messages
      : attempt(() => store?.peekSessionMessages?.(sessionId), null);
    if (!Array.isArray(messages)) return false;
    let turnId = typeof work.turn_id === 'string' && work.turn_id ? work.turn_id : null;
    let seen = false;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!turnId && typeof message?.turn_id === 'string' && message.turn_id) turnId = message.turn_id;
      if (!turnId || message?.turn_id !== turnId) {
        if (seen) break;
        continue;
      }
      seen = true;
      if (message.status === 'denied' || message.tool_call?.approval_state === 'denied'
        || message.tool_result?.approval_state === 'denied') return true;
      if (message.tool_call || message.tool_result) return false;
    }
    return false;
  }

  // Facts shared by every row of one call: approval counts, newest work, project names, children.
  function facts(scope) {
    const approvals = new Map();
    for (const pending of attempt(() => [...(read(pendingApprovals)?.values?.() || [])], [])) {
      if (typeof pending?.sessionId === 'string') approvals.set(pending.sessionId, (approvals.get(pending.sessionId) || 0) + 1);
    }
    const children = new Map();
    for (const record of scope.byId.values()) {
      const parent = scopeRules.parentOf(record);
      if (!parent || !scope.session_ids.has(record.id)) continue;
      if (children.has(parent)) children.get(parent).push(record);
      else children.set(parent, [record]);
    }
    let scan = null;
    const names = new Map();
    const projects = read(projectService);
    const shown = new Map();
    return {
      approvals,
      children,
      newestWork(sessionId) {
        if (!scan) scan = workScan();
        return scan.get(sessionId) || null;
      },
      // The newest work row as displayed: a user-denied failure reads `denied`.
      shownWork(sessionId) {
        if (shown.has(sessionId)) return shown.get(sessionId);
        const work = this.newestWork(sessionId);
        const view = work?.status === 'failed' && deniedTurn(scope.store, sessionId, work)
          ? { ...work, status: 'denied' } : work;
        shown.set(sessionId, view);
        return view;
      },
      projectName(projectId) {
        if (!names.has(projectId)) {
          const name = attempt(() => projects?.get?.(projectId)?.name, null);
          names.set(projectId, typeof name === 'string' && name ? name.slice(0, 80) : null);
        }
        return names.get(projectId);
      },
    };
  }

  function status(fact, summary) {
    return scopeRules.sessionStatus({ summary, activeTurn: summary.active_turn,
      work: fact.shownWork(summary.id), approvalCount: fact.approvals.get(summary.id) || 0 });
  }

  function row(scope, fact, summary) {
    const projectId = scopeRules.projectOf(summary);
    const parent = scopeRules.parentOf(summary);
    const state = status(fact, summary);
    return {
      session_id: summary.id,
      title: D.clip(summary.title, D.TITLE_CHARS),
      project: { id: projectId, name: fact.projectName(projectId) },
      status: state,
      last_outcome: scopeRules.lastOutcome(fact.shownWork(summary.id)),
      preferred_model: D.clip(normalizePreferredModel(summary.preferred_model), 200),
      updated_at: typeof summary.updated_at === 'string' ? summary.updated_at : null,
      message_count: D.count(summary.message_count),
      unread_message_count: D.count(summary.unread_message_count),
      pinned: summary.pinned === true,
      archived: Boolean(summary.archived_at),
      role: normalizeSessionRole(summary.session_role),
      linked: {
        parent_session_id: parent && scope.session_ids.has(parent) ? parent : null,
        children_count: (fact.children.get(summary.id) || []).length,
      },
      waiting_on_user: scopeRules.WAITING_ON_USER.has(state),
    };
  }

  function list({ callerSessionId, scope: view = 'recent', project_id: projectId = null,
    include_archived: includeArchived = false, limit = RECENT_ROWS } = {}) {
    const scope = scopeFor(callerSessionId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    const fact = facts(scope);
    const bound = Number.isSafeInteger(limit) ? Math.max(1, Math.min(MAX_LIST_ROWS, limit)) : RECENT_ROWS;
    let candidates = [...scope.byId.values()].filter((summary) => summary.id !== scope.caller.id
      && scope.session_ids.has(summary.id) && (includeArchived === true || !summary.archived_at)
      && (projectId === null || scopeRules.projectOf(summary) === projectId))
      .sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    // `recent` is at most the 20 most recently active chats, whatever the limit.
    const cap = view === 'recent' ? Math.min(bound, RECENT_ROWS) : bound;
    // Rows cost a runtime snapshot each: build the page plus one (for `truncated`), not every chat.
    if (view !== 'active') candidates = candidates.slice(0, cap + 1);
    let rows = candidates.map((summary) => row(scope, fact, summary));
    if (view === 'active') rows = rows.filter((entry) => entry.status !== 'idle');
    return { ok: true, scope_kind: scope.kind, rows: rows.slice(0, cap), truncated: rows.length > cap };
  }

  // Open tasks and the note only for a project the caller may see (its own, or every one for the primary).
  function projectFacts(fact, projectId, scope) {
    const name = fact.projectName(projectId);
    if (scope.project_ids && !scope.project_ids.has(projectId)) return { id: projectId, name, open_tasks: [], note: null };
    const state = attempt(() => read(configService)?.getState?.(), null);
    return {
      id: projectId,
      name,
      open_tasks: D.openTasks(state, projectId),
      note: D.noteFacts(attempt(() => read(projectNotesService)?.get?.(projectId), null)),
    };
  }

  async function digest({ callerSessionId, sessionId, includeTranscriptTail = true, includeChanges = false } = {}) {
    const scope = scopeFor(callerSessionId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    if (typeof sessionId !== 'string' || !scope.session_ids.has(sessionId)) return NOT_FOUND;
    const fact = facts(scope);
    const summary = scope.byId.get(sessionId);
    const detail = attempt(() => scope.store.peekSession?.(sessionId), null);
    const messages = (Array.isArray(detail?.messages) ? detail.messages : attempt(() => scope.store.peekSessionMessages?.(sessionId), null)) || [];
    const parent = scopeRules.parentOf(summary);
    const result = {
      ok: true,
      session: {
        ...row(scope, fact, summary),
        run_mode: summary.run_mode ?? null,
        plan_mode: summary.plan_mode === true,
        lockdown: summary.lockdown === true,
        last_model_used: typeof summary.last_model_used === 'string' ? summary.last_model_used.slice(0, 200) : null,
        ...(fact.shownWork(sessionId)?.status === 'failed' ? failureFacts(messages, fact.shownWork(sessionId)) : {}),
        context_usage: summary.context_usage || null,
        compaction_context: summary.compaction_context || null,
      },
      todo: latestTodoList(messages),
      proposals: D.pendingProposals(detail),
      inbox: D.inboxCounts(summary, detail),
      children: (fact.children.get(sessionId) || []).slice(0, MAX_CHILDREN).map((child) => ({
        session_id: child.id, title: D.clip(child.title, D.TITLE_CHARS), status: status(fact, child),
        last_outcome: scopeRules.lastOutcome(fact.shownWork(child.id)),
      })),
      parent: parent && scope.session_ids.has(parent)
        ? { session_id: parent, title: D.clip(scope.byId.get(parent).title, D.TITLE_CHARS) } : null,
      project: projectFacts(fact, scopeRules.projectOf(summary), scope),
      outputs_count: attempt(() => collectOutputs(messages).total_count, 0),
    };
    if (includeTranscriptTail !== false) result.transcript_tail = D.statusTail(messages);
    if (includeChanges === true) result.changes = await D.readChanges(read(chatWorkspaceService), sessionId);
    return result;
  }

  // session_transcript: one chat's pageable transcript, same scope as the digest. The first page (no
  // `beforeMessageId`) also carries the latest reply; a paged read carries rows only.
  async function transcript({ callerSessionId, sessionId, rows, beforeMessageId = null, includeToolActivity = false } = {}) {
    const scope = scopeFor(callerSessionId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    if (typeof sessionId !== 'string' || !scope.session_ids.has(sessionId)) return NOT_FOUND;
    const messages = attempt(() => scope.store.peekSessionMessages?.(sessionId), null) || [];
    const tail = D.transcriptTail(messages, { limit: rows, beforeId: beforeMessageId, includeTools: includeToolActivity === true });
    const result = { ok: true, session_id: sessionId, title: D.clip(scope.byId.get(sessionId)?.title, D.TITLE_CHARS),
      rows: tail.rows, more_before: tail.moreBefore };
    if (beforeMessageId !== null) return result;
    const reply = D.lastReply(messages);
    return { ...result, last_reply: reply.text, last_reply_clipped: reply.clipped, last_reply_message_id: reply.messageId };
  }

  // D8: cancels the target's active stream and its queued or paused work. Never the caller's own
  // turn; a cancel that is refused or not confirmed is reported as `uncertain`, not as done.
  async function stop({ callerSessionId, sessionId } = {}) {
    const scope = scopeFor(callerSessionId);
    if (!scope.ok) return { ok: false, reason: scope.reason };
    if (sessionId === scope.caller.id) return { ok: false, reason: 'self' };
    if (typeof sessionId !== 'string' || !scope.session_ids.has(sessionId)) return NOT_FOUND;
    let attempted = 0;
    let uncertain = false;
    let stream = false;
    const active = scope.byId.get(sessionId)?.active_turn || null;
    const streamId = typeof active?.stream_id === 'string' ? active.stream_id : '';
    if (streamId) {
      attempted += 1;
      const accepted = attempt(() => cancelChatStream?.(streamId, 'user_cancel') === true, false);
      stream = accepted && await turnCleared(scope.store, sessionId, streamId);
      uncertain = !stream;
    }
    const app = read(runtime);
    let queued = 0;
    const stoppable = (entry) => STOPPABLE_WORK.has(entry?.status) || (!streamId && entry?.status === 'running');
    for (const work of workRows(sessionId, 100).filter(stoppable)) {
      attempted += 1;
      const outcome = await Promise.resolve()
        .then(() => app.cancel({ work_id: work.work_id, expected_revision: work.revision }))
        .catch(() => null);
      if (outcome?.ok === true) queued += 1;
      if (outcome?.ok !== true || outcome.cleanup_confirmed !== true) uncertain = true;
    }
    const cleanup = attempted === 0 ? 'nothing_running' : uncertain ? 'uncertain' : 'confirmed';
    note('session_directory.stop', { session_id: sessionId, stream, queued_work: queued, cleanup });
    return { ok: true, session_id: sessionId, stopped: { stream, queued_work: queued }, cleanup };
  }

  return { digest, list, stop, transcript };
}

module.exports = { createSessionDirectoryService };
