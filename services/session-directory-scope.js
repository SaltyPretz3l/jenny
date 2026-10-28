'use strict';

/* services/session-directory-scope.js - which chats a calling chat may see in the
 * session directory, and the D7 status vocabulary (row 69 W2). Pure over the facts
 * the directory service reads: session index records (with `active_turn`), the
 * newest runtime work row and the pending approval count.
 *
 * Scope (D6): the primary chat (`session_role: 'primary'`) sees the whole profile;
 * any other chat sees its own project plus its linked relatives (its spawning
 * parent, the chats it spawned and `linked_session_ids`). In every scope the
 * injected visibility predicate (`visibleChatPredicate`: no lockdown, plugin,
 * diagnostic, opted-out or runtime-child chat) applies; without one nothing but the
 * caller itself is in scope (fail closed). A caller in lockdown is refused. The
 * caller is always in its own scope, so it can read its own digest.
 */

const { GENERAL_PROJECT_ID, normalizeProjectId } = require('./projects/project-schema');

const { isPrimaryRole } = require('./backend/primary-session');
const ACTIVE_TURN_STATUSES = new Set(['awaiting_assistant', 'streaming']);
const WAITING_ON_USER = new Set(['waiting_approval', 'waiting_question', 'waiting_plan']);

const projectOf = (summary) => normalizeProjectId(summary?.project_id) || GENERAL_PROJECT_ID;

function parentOf(summary) {
  const id = summary?.spawned_from?.parent_session_id;
  return typeof id === 'string' && id ? id : null;
}

function safePredicate(visible) {
  if (typeof visible !== 'function') return () => false;
  return (summary) => {
    try { return visible(summary) === true; } catch (_error) { return false; }
  };
}

// -> {ok:true, kind, project_ids: Set | null, session_ids: Set, caller, byId: Map} | {ok:false, reason}
// The primary chat's transcript spans every project, so no ordinary caller ever sees it (not a General
// chat, not a chat it spawned), kill switch on or off; with the primary_chat kill switch off the primary
// itself is scoped like an ordinary General chat.
function computeScope({ records, callerSessionId, visible, primaryChatEnabled = true }) {
  const byId = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record && typeof record.id === 'string' && record.id) byId.set(record.id, record);
  }
  const caller = typeof callerSessionId === 'string' ? byId.get(callerSessionId) : null;
  if (!caller) return { ok: false, reason: 'unavailable' };
  if (caller.lockdown === true) return { ok: false, reason: 'lockdown' };
  const isVisible = safePredicate(visible);
  const sessionIds = new Set([caller.id]);
  if (isPrimaryRole(caller) && primaryChatEnabled !== false) {
    for (const record of byId.values()) if (isVisible(record)) sessionIds.add(record.id);
    return { ok: true, kind: 'profile', project_ids: null, session_ids: sessionIds, caller, byId };
  }
  const projectId = projectOf(caller);
  const linked = Array.isArray(caller.linked_session_ids) ? caller.linked_session_ids : [];
  const relatives = new Set([parentOf(caller), ...linked].filter((id) => typeof id === 'string' && id));
  for (const record of byId.values()) if (parentOf(record) === caller.id) relatives.add(record.id);
  for (const record of byId.values()) {
    if (isPrimaryRole(record) && record.id !== caller.id) continue;
    if ((projectOf(record) === projectId || relatives.has(record.id)) && isVisible(record)) sessionIds.add(record.id);
  }
  return { ok: true, kind: 'project', project_ids: new Set([projectId]), session_ids: sessionIds, caller, byId };
}

// D7. A turn waiting on an approval is also streaming, so the approval is named first: it is the
// state the user can act on. Work that runs without a live stream (a resumed or child run) is running.
// Work not yet running reads `queued`: pending work (admission wait or not) and paused, resumable
// work (an app restart pauses it), which is exactly what `session_stop` cancels.
function sessionStatus({ summary, activeTurn, work, approvalCount }) {
  if (approvalCount > 0) return 'waiting_approval';
  if (ACTIVE_TURN_STATUSES.has(activeTurn?.status) || work?.status === 'running') return 'running';
  if (work?.status === 'pending' || work?.status === 'paused') return 'queued';
  if (summary?.pending_question_batch) return 'waiting_question';
  if (summary?.pending_plan_proposal) return 'waiting_plan';
  if (work?.status === 'needs_attention') return 'needs_attention';
  if (work?.status === 'failed') return 'failed';
  return 'idle';
}

function lastOutcome(work) {
  if (!work || typeof work.status !== 'string') return null;
  return {
    status: work.status,
    updated_at: typeof work.updated_at === 'string' ? work.updated_at : null,
    resumable: typeof work.resumable === 'boolean' ? work.resumable : null,
  };
}

module.exports = {
  WAITING_ON_USER,
  computeScope,
  lastOutcome,
  parentOf,
  projectOf,
  sessionStatus,
};
