'use strict';

// The team host's start-up reconcile of shared projects (TEAM_PROJECTS_SPEC "3-4b as built"). It runs
// once, after the backend has started and before the host says it is ready, and repairs what a create
// or a delete left half done by a crash. Bounded: at most 64 team rows (the store's own cap) and 64
// records with no team row a pass, one directory listing of the projects root and no tree walk.
//   1. a team row in `deleting`: the delete is finished;
//   2. an active team row with no application record: left exactly as it is and counted
//      (`rows_without_record`). It is no crash prefix (a delete marks the row first, which is case 1);
//      it only appears when the record list is wrong, and the owner's or an admin's Delete removes it;
//   3. an active team row with no channel: the channel is made;
//   4. an active team row with no bound root, on a host with a projects root: the folder is made if
//      absent (or found, if a create stopped before its bind) and bound;
//   5. a record with no team row (General aside): removed only when it has no conversation, its
//      `root_path` is null or exactly `<projects root>/<id>`, and that folder is absent or empty (an
//      empty folder goes to the trash after the record); otherwise left and counted `records_kept`;
//   6. a folder under the projects root that no record or row names: left and counted, never removed;
//   7. a project channel whose project has no team row (archived by an earlier build's delete, or a
//      removal that failed or was cut): removed from the chat store with its folders (E67), counted
//      `channels_removed`; the chat store's own line carries the counts.
// A project store answering `storage.read_only` (its `projects.json` unreadable or newer) skips the whole
// reconcile: nothing may be judged from a list that only holds General. Each repair writes one
// `project_reconciled` entry (actor null, the host). Nothing here throws into the start but the start's
// own cancellation (`alive()`, asked between rows): a failure is logged and the host starts. One log line
// carries the counts; no line carries a path or a name.

const { safeLogger } = require('./safe-logger');
const { callSafely, readRecords } = require('./team-project-common');

const MAX_PASS = 64;

// projects: the application project service (listProjects, bindProjectRoot); records(): the record
// remover (`projectService`); deleter: team-project-delete.js; chat: the chat store or null.
async function reconcileProjects({
  store, projects, records, folders = null, chat = null, deleter, logger = null, alive = () => {},
} = {}) {
  const log = safeLogger(logger);
  const counts = { finished: 0, channels: 0, folders: 0, records: 0, records_kept: 0, rows_without_record: 0,
    orphan_folders: 0, failed: 0, deferred: 0, channels_removed: 0 };
  const hasRoot = folders?.hasRoot === true;
  let stopped = null;
  const check = () => {
    try { alive(); } catch (error) { stopped = error; throw error; }
  };
  const audited = async (projectId, step) => {
    const written = await store.reconcileProject({ projectId, step });
    if (!written.ok) log('WARN', 'team_project.reconcile_audit_failed', { project_id: projectId, step });
  };

  // Case 4: make (or find) the folder and bind it; true when bound.
  function bindFolder(projectId, record) {
    const state = folders.has(projectId);
    if (!state.ok) return false;
    let made = null;
    if (state.state === 'absent') made = folders.create(projectId);
    else if (state.state === 'present') made = folders.locate(projectId);
    if (!made?.ok) return false;
    const bound = callSafely(() => projects.bindProjectRoot({ project_id: projectId, root_path: made.path,
      expected_root_revision: Number.isSafeInteger(record.root_revision) ? record.root_revision : 0 }));
    return bound?.ok === true;
  }

  async function repairRow(row, record) {
    const projectId = row.project_id;
    if (row.state === 'deleting') {
      const held = deleter.tools(projectId);
      const done = held ? await deleter.finish(projectId, held, () => store.reconcileProject({ projectId, step: 'removed' }))
        : { ok: false };
      counts[done.ok ? 'finished' : 'failed'] += 1;
      return;
    }
    if (row.state !== 'active') return;
    if (!record) {
      counts.rows_without_record += 1;
      return;
    }
    if (chat && typeof chat.createChannel === 'function') {
      let made;
      try { made = await chat.createChannel({ channelId: `chan_${projectId}` }); } catch { made = null; }
      if (made?.ok === true && made.created === true) {
        counts.channels += 1;
        await audited(projectId, 'channel');
      } else if (made?.ok !== true) counts.failed += 1;
    }
    if (hasRoot && record.root_path === null) {
      if (bindFolder(projectId, record)) {
        counts.folders += 1;
        await audited(projectId, 'folder');
      } else counts.failed += 1;
    }
  }

  // Case 5's decision: null when the record stays, else whether its empty folder goes to the trash after it.
  function recordRemoval(projectId, record, busy) {
    if (busy.has(projectId)) return null;
    const ownFolder = record.root_path === null || (hasRoot && folders.ownsRoot(projectId, record.root_path));
    if (!ownFolder) return null;
    if (!hasRoot) return { trash: false };
    const state = folders.has(projectId);
    if (state.ok && state.state === 'absent') return { trash: false };
    if (!state.ok || state.state !== 'present') return null;
    const empty = folders.isEmpty(projectId);
    return empty.ok && empty.empty ? { trash: true } : null;
  }

  async function repairRecord(projectId, record, busy, remover) {
    const removal = recordRemoval(projectId, record, busy);
    if (!removal) {
      counts.records_kept += 1;
      return;
    }
    const removed = callSafely(() => remover.remove(projectId));
    if (removed?.ok !== true) {
      counts.failed += 1;
      return;
    }
    counts.records += 1;
    await audited(projectId, 'record');
    // The record is gone; an empty folder that will not move stays, an orphan folder from the next start on
    // (`trash` logs why).
    if (removal.trash) folders.trash(projectId);
  }

  // Case 7, after the rows (a finished delete has removed its own channel): every row the store holds now is live.
  async function removeDeadChannels() {
    if (!chat || typeof chat.removeDeadProjectChannels !== 'function') return;
    const doc = store.snapshot();
    if (!doc) return;
    const live = new Set(doc.projects.map((row) => row.project_id));
    let answer;
    try {
      answer = await chat.removeDeadProjectChannels({ isLive: (projectId) => live.has(projectId) });
    } catch { answer = null; }
    if (answer?.ok === true) counts.channels_removed = answer.removed;
    else counts.failed += 1;
  }

  try {
    const doc = store.snapshot();
    const listed = readRecords(projects);
    if (!doc || !listed || listed.readOnly) {
      const reason = !doc ? 'store_unavailable' : (listed ? 'records_read_only' : 'records_unreadable');
      log('WARN', 'team_project.reconcile_skipped', { reason });
      return counts;
    }
    const rowIds = new Set(doc.projects.map((row) => row.project_id));
    for (const row of doc.projects) {
      check();
      await repairRow(row, listed.records.get(row.project_id) ?? null);
    }
    const unbound = [...listed.records.keys()].filter((projectId) => !rowIds.has(projectId));
    if (unbound.length > 0) {
      const busy = deleter.conversationProjects();
      const remover = callSafely(records);
      if (!busy || typeof remover?.remove !== 'function') counts.records_kept += unbound.length;
      else {
        for (const projectId of unbound.slice(0, MAX_PASS)) {
          check();
          await repairRecord(projectId, listed.records.get(projectId), busy, remover);
        }
        counts.deferred += Math.max(0, unbound.length - MAX_PASS);
      }
    }
    check();
    await removeDeadChannels();
    if (hasRoot) {
      const present = folders.list();
      if (present.ok) {
        counts.orphan_folders = present.project_ids.filter((projectId) => !listed.records.has(projectId)
          && !rowIds.has(projectId)).length;
      }
    }
  } catch {
    if (stopped) throw stopped;
    log('WARN', 'team_project.reconcile_failed', {});
    return counts;
  }
  log('INFO', 'team_project.reconciled', counts);
  return counts;
}

module.exports = { reconcileProjects };
