'use strict';

// Deleting a shared project on the team host (TEAM_PROJECTS_SPEC "Delete" and "3-4b as built"). One
// order for the command and for the start-up reconcile that finishes a delete a crash stopped.
//
// Before anything changes, everything that can refuse is asked: a project id that names neither a team
// row nor a record, a record with no team row for anyone but the active owner, a read-only project store
// (`projects.json` unreadable: nothing may be judged from it), the router's disk admission for deletes,
// a usable trash root (on a host with a projects root), and a running turn in any of its conversations
// (`team_project_busy`; a pending approval exists only inside a running turn). Then:
//   1. the team row to `deleting`, audit first, with the conversation count and the file count
//      (`files=<n>`, `files_at_least=<n>` past the count cap, or `files=unknown` when the folder cannot
//      be counted: the count never blocks a delete);
//   2. each conversation through the router's own delete, inside that conversation's mutation queue
//      (the active-turn refusal, the scope taken before the delete, `session_changed` to it, the
//      revision entry dropped);
//   3. the folder into the trash (one rename), then the project's boards, journals, proposals and pictures removed
//      from the board store (row 151 T1, D29; a removal that fails, or a `boards` dependency that gives no store,
//      stops the delete here so the next start's reconcile runs it again);
//   4. the channel removed from the chat store: document, segments, attachments and index row (E67; a
//      failure is logged and the delete goes on: its audience is nobody once the row is gone, and the next
//      start's reconcile removes a channel whose project has no row), then the project's "Always allowed"
//      rules and requests dropped (slice 3-12; a rules store that cannot be read is skipped and the next
//      start's prune drops them);
//   5. the application record removed (`projectService.remove`; already gone counts as done);
//   6. the team row removed (`project_deleted`). The mark was the authorization: if the store now
//      refuses the actor's standing (revoked, removed, no longer owner), the host removes the row
//      itself (`project_reconciled step=removed`) and the delete answers ok.
// Every step is safe to run again. A step that fails stops the delete with the row `deleting`; the next
// start's reconcile finishes it. A failed step is never retried inside one call. Log lines carry a reason
// word, ids and counts: never a path, a project name or a display name.

const { hostFailure } = require('../api-contract');
const { ROOT_UNAVAILABLE } = require('./project-folders');
const { safeLogger } = require('./safe-logger');
const { GENERAL_PROJECT_ID, callSafely, readRecords, reasonOf, storeFailed } = require('./team-project-common');

const BUSY = 'team_project_busy';
// The store's refusals of the actor's standing (deleteAccess: actor gone, pending, revoked, no longer admin or owner).
const STANDING = new Set(['team_not_found', 'member_pending', 'member_revoked', 'role_forbidden']);

const notFound = () => hostFailure('forbidden', 'team_not_found');
const unavailable = () => hostFailure('unavailable', 'team_unavailable', '', true);

// router(): the command router (its `projectDeletes`: busy, admit, remove), null until the host core
// exists. sessionStore(): the backend's session store (listSessions). records(): the backend's project
// service, whose `remove` drops a record. folders: project-folders.js. chat(): the chat store, or null.
// rules(): team-project-rules.js, or null (slice 3-12). boards(): the host board store (server/team/boards/team-boards.js);
// not passed, there is no board step at all (row 151 T1).
function createProjectDeleter({
  store, folders = null, router, sessionStore, records, chat = () => null, rules = () => null, boards = null, logger = null,
} = {}) {
  if (!store || typeof store.markProjectDeleting !== 'function') throw new TypeError('createProjectDeleter requires a member store.');
  if (typeof router !== 'function' || typeof sessionStore !== 'function' || typeof records !== 'function') {
    throw new TypeError('createProjectDeleter requires router(), sessionStore() and records().');
  }
  const log = safeLogger(logger);
  const hasRoot = folders?.hasRoot === true;
  const stop = (projectId, step, answer) => {
    log('WARN', 'team_project.delete_stopped', { project_id: projectId, step, reason: reasonOf(answer) || null });
    return answer;
  };

  // What a delete needs from the host core, read once: the router's delete facade, the record remover
  // and the ids of the project's conversations. null until the core exists or when they cannot be read.
  function tools(projectId) {
    const deletes = callSafely(router)?.projectDeletes;
    const remover = callSafely(records);
    const listed = callSafely(() => sessionStore()?.listSessions());
    if (!deletes || typeof remover?.remove !== 'function' || !Array.isArray(listed)) return null;
    const ids = listed.filter((summary) => summary?.project_id === projectId && typeof summary.id === 'string')
      .map((summary) => summary.id);
    return { deletes, remover, ids };
  }

  // The project ids that hold at least one conversation, or null when the conversations cannot be listed.
  function conversationProjects() {
    const listed = callSafely(() => sessionStore()?.listSessions());
    return Array.isArray(listed) ? new Set(listed.map((summary) => summary?.project_id)) : null;
  }

  // A channel that was never made (its step failed at create) answers ok with nothing removed.
  async function removeChannel(projectId) {
    const chatStore = callSafely(chat);
    if (!chatStore || typeof chatStore.removeChannel !== 'function') return;
    let answer;
    try { answer = await chatStore.removeChannel({ channelId: `chan_${projectId}` }); } catch { answer = null; }
    if (answer?.ok !== true) {
      log('WARN', 'team_project.channel_remove_failed', { project_id: projectId, reason: reasonOf(answer) || null });
    }
  }

  // The board store's removal of the project's folder; a store that is missing or throws answers unavailable.
  async function removeBoards(projectId) {
    const boardStore = callSafely(boards);
    let answer = null;
    if (boardStore && typeof boardStore.removeProject === 'function') {
      try { answer = await boardStore.removeProject({ projectId }); } catch { answer = null; }
    }
    return answer?.ok === true || answer?.ok === false ? answer : hostFailure('unavailable', 'team_board_unavailable', '', true);
  }

  // Steps 2 to 5, then `removeRow` (step 6). `held` is `tools(projectId)`. Used by the command and the reconcile.
  async function finish(projectId, held, removeRow) {
    for (const sessionId of held.ids) {
      let removed;
      try { removed = await held.deletes.remove(sessionId); } catch { removed = undefined; }
      if (removed === null) return stop(projectId, 'conversations', hostFailure('conflict', BUSY));
      if (removed?.deleted !== true) return stop(projectId, 'conversations', storeFailed());
    }
    if (hasRoot) {
      const trashed = folders.trash(projectId);
      if (!trashed.ok) return stop(projectId, 'folder', hostFailure('unavailable', trashed.reason));
    }
    if (typeof boards === 'function') {
      const removedBoards = await removeBoards(projectId);
      if (removedBoards?.ok !== true) return stop(projectId, 'boards', removedBoards);
    }
    await removeChannel(projectId);
    callSafely(() => callSafely(rules)?.dropProject(projectId));
    const removed = callSafely(() => held.remover.remove(projectId));
    if (removed?.ok !== true && reasonOf(removed) !== 'project_not_found') return stop(projectId, 'record', storeFailed());
    return removeRow();
  }

  // The file count for the audit entry: exact, at least, or unknown (never a refusal).
  function fileCount(projectId) {
    if (!hasRoot) return { files: 0 };
    const counted = folders.countFiles(projectId);
    if (!counted.ok) return { files: null };
    return counted.capped ? { files: counted.files, filesAtLeast: true } : { files: counted.files };
  }

  // The row goes with the actor's own entry; a store that now refuses the actor's standing (the mark
  // already authorized this delete) gets the host's removal instead.
  async function removeRowAs(target) {
    const removed = await store.deleteProject(target);
    if (removed.ok || !STANDING.has(reasonOf(removed))) return removed;
    log('WARN', 'team_project.delete_finished_by_host', { project_id: target.projectId, reason: reasonOf(removed) || null });
    return store.reconcileProject({ projectId: target.projectId, step: 'removed' });
  }

  // `team.project.delete { project_id }`; `actor` is { member_id, owner } from team-commands.js.
  async function run({ projectId, actor }, app) {
    if (projectId === GENERAL_PROJECT_ID) return notFound();
    const doc = store.snapshot();
    if (!doc) return storeFailed();
    const row = doc.projects.find((entry) => entry.project_id === projectId) ?? null;
    // A record with no team row (a stopped create) is the active owner's alone. The router decided that
    // before the queue wait and the store has no row to decide it again, so it is asked here first.
    if (!row && actor?.owner !== true) return notFound();
    const listed = readRecords(app);
    if (!listed || listed.readOnly) return storeFailed();
    if (!row && !listed.records.has(projectId)) return notFound();
    const held = tools(projectId);
    if (!held) return unavailable();
    if (callSafely(() => held.deletes.admit()) !== true) return hostFailure('unavailable', 'disk_pressure', '', true);
    if (hasRoot && !folders.trashReady()) return hostFailure('unavailable', ROOT_UNAVAILABLE);
    if (held.ids.some((sessionId) => callSafely(() => held.deletes.busy(sessionId)) !== false)) {
      return hostFailure('conflict', BUSY);
    }
    const target = { actorMemberId: actor.member_id, projectId };
    if (row) {
      const marked = await store.markProjectDeleting({ ...target,
        counts: { conversations: held.ids.length, ...fileCount(projectId) } });
      if (!marked.ok) return marked;
    }
    const removed = await finish(projectId, held, () => (row ? removeRowAs(target) : { ok: true }));
    return removed.ok ? { ok: true, project_id: projectId, deleted: true } : removed;
  }

  return Object.freeze({ run, finish, tools, conversationProjects });
}

module.exports = { createProjectDeleter };
