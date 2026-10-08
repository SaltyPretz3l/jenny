'use strict';

// Delete a project (ProjectApplicationService.deleteProject, desktop only):
// its knowledge folders, idle chats and memories move to General, then the
// entry is removed. A busy chat anywhere in the project blocks the whole
// operation. Every step is undone if a later one fails, so a refused delete
// leaves nothing half-moved, with one exception: a memory move the sidecar
// never answered. That move may have committed and cannot be undone, so the
// delete is finished forward instead (see "Memory move outcomes" below). The
// folder on disk is never touched;
// `workspace_bound` tells the caller the configured Workspace folder (by real
// path) was this project, so the renderer can clear it. Scoped permission
// grants captured for the project can never match again (the id is gone) and
// are dropped once the delete has succeeded.
//
// Memory move outcomes (review finding DPR-008). The delete is written to the
// project delete journal before the project entry is removed, then:
//   answered ok  -> record cleared, delete reported complete.
//   answered no  -> nothing committed: everything is undone, record cleared.
//   no answer    -> unknown. The project stays deleted and the record stays;
//                   the result says `memory_outcome: 'pending'`.
// reconcile() runs after every sidecar initialize and re-issues the move for
// each record whose project is gone (the move is idempotent: a second run
// moves only what is left) until the sidecar answers ok. Until then the
// memories sit under an id no chat belongs to, so recall scope is never wider
// than the user asked for. A record whose project still exists belongs to a
// delete that never removed it and is dropped without a move.

const { GENERAL_PROJECT_ID } = require('./project-schema');
const { assignSessionProjectDurably } = require('./session-project-assignment');

function positiveCount(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function succeeded(step) {
  try {
    return step()?.ok === true;
  } catch (_error) {
    return false;
  }
}

class ProjectDeleteOperation {
  constructor({
    projects, projectStore, sessions, shadow = null, permissions, isSessionBusy, sessionIsBusy,
    knowledge = null, moveMemories = null, journal = null, folderStatus, isCurrentProject, now, fail,
    onSessionProjectChanged = null,
    onProjectDeleted = null,
  }) {
    this._projects = projects;
    this._projectStore = projectStore;
    this._sessions = sessions;
    this._shadow = shadow;
    this._permissions = permissions;
    this._isSessionBusy = isSessionBusy;
    this._recordIsBusy = sessionIsBusy;
    this._knowledge = knowledge;
    this._moveMemories = moveMemories;
    this._journal = journal;
    this._onSessionProjectChanged = typeof onSessionProjectChanged === 'function' ? onSessionProjectChanged : null;
    this._onProjectDeleted = typeof onProjectDeleted === 'function' ? onProjectDeleted : null;
    // Projects whose delete is between its record and its return: reconcile
    // leaves them to the delete that owns them.
    this._inFlight = new Set();
    this._reconciling = null;
    this._folderStatus = folderStatus;
    this._isCurrentProject = isCurrentProject;
    this._now = now;
    this._fail = fail;
  }

  async run(projectId) {
    if (this._inFlight.has(projectId)) return this._fail('project_delete_in_progress');
    this._inFlight.add(projectId);
    try {
      return await this._run(projectId);
    } finally {
      this._inFlight.delete(projectId);
    }
  }

  async _run(projectId) {
    const fail = this._fail;
    const initial = this._projects.get(projectId);
    if (!initial) return fail('project_not_found');
    this._folderStatus.invalidate();
    const workspaceBound = await this._isCurrentProject(initial);
    // From here to the memory move nothing yields, so no chat can be assigned
    // into (or start work in) the project half-way through the moves.
    const project = this._projects.get(projectId);
    if (!project) return fail('project_not_found');
    const gate = this._deleteBlocker(projectId);
    if (gate.failure) return gate.failure;
    const knowledge = this._moveKnowledge(projectId);
    if (!knowledge.ok) {
      return fail('project_knowledge_unavailable', { knowledge_reason: knowledge.reason || null });
    }
    const movedIds = [];
    for (const record of gate.members) {
      const updated = this._assignDurably(record.id, GENERAL_PROJECT_ID);
      if (!updated.ok) {
        return fail(updated.reason, {
          repair: updated.repair, ...this._undo({ movedIds, projectId, knowledge }),
        });
      }
      movedIds.push(record.id);
    }
    // The record precedes the point of no return. Without it an unanswered
    // memory move could not be finished later, so the delete is refused.
    if (this._moveMemories) {
      const recorded = this._recordDelete(projectId);
      if (!recorded.ok) {
        return fail('project_delete_record_unavailable', {
          record_reason: recorded.reason, ...this._undo({ movedIds, projectId, knowledge }),
        });
      }
    }
    const removed = this._projects.remove(projectId);
    if (!removed?.ok) {
      const undone = this._undo({ movedIds, projectId, knowledge });
      this._clearRecord(projectId);
      return fail(removed?.reason || 'project_update_failed', undone);
    }
    let movedMemories = 0;
    let memoryPending = false;
    if (this._moveMemories) {
      const memory = await this._moveProjectMemories(projectId);
      if (memory.ok === true) {
        movedMemories = memory.moved;
        this._clearRecord(projectId);
      } else if (memory.uncertain) {
        memoryPending = true;
        this._log('WARN', 'projects.delete_memory_move_pending', { reason: memory.reason });
      } else {
        const undone = this._undo({ movedIds, projectId, knowledge, project });
        // A project that could not be put back stays deleted: keep the record
        // so its memories still follow it to General.
        if (this._projects.get(projectId)) this._clearRecord(projectId);
        return fail('project_memories_unavailable', { memory_reason: memory.reason, ...undone });
      }
    }
    // Past the point of no return: the project's own data (its notes) goes with it.
    if (this._onProjectDeleted) {
      try {
        const outcome = this._onProjectDeleted(projectId);
        if (outcome && outcome.ok === false) {
          this._log('WARN', 'projects.delete_hook_failed', { hook: 'project_deleted', steps: Array.isArray(outcome.failed) ? outcome.failed : [] });
        }
      } catch (error) {
        this._log('WARN', 'projects.delete_hook_failed', { hook: 'project_deleted', message: error?.message || String(error) });
      }
    }
    const droppedGrants = this._dropProjectGrants(projectId);
    this._folderStatus.invalidate();
    return {
      ok: true,
      project: { id: project.id, name: project.name, root_path: project.root_path },
      moved_sessions: movedIds.length,
      moved_memories: movedMemories,
      ...(memoryPending ? { memory_outcome: 'pending' } : {}),
      moved_knowledge: knowledge.moved,
      dropped_grants: droppedGrants,
      workspace_bound: workspaceBound,
    };
  }

  // Finish recorded deletes whose memory move was never confirmed. Safe to
  // call at any time and as often as wanted; concurrent calls share one pass.
  reconcile() {
    if (!this._reconciling) {
      this._reconciling = this._reconcile().finally(() => { this._reconciling = null; });
    }
    return this._reconciling;
  }

  async _reconcile() {
    const summary = { settled: 0, discarded: 0, pending: 0 };
    if (!this._journal || !this._moveMemories) return summary;
    const operations = this._journal.list();
    if (operations.length === 0) return summary;
    // A read-only project store serves a fallback document: an absent entry
    // there does not prove the project was deleted.
    if (this._projectStore.getStatus().read_only === true) {
      summary.pending = operations.length;
      return summary;
    }
    for (const operation of operations) {
      const projectId = operation.project_id;
      if (this._inFlight.has(projectId)) {
        summary.pending += 1;
      } else if (this._projects.get(projectId)) {
        this._clearRecord(projectId);
        summary.discarded += 1;
      } else {
        const memory = await this._requestMemoryMove(projectId);
        if (memory?.ok === true) {
          this._clearRecord(projectId);
          summary.settled += 1;
          this._log('INFO', 'projects.delete_memory_move_settled', {
            moved: positiveCount(memory.moved), attempts: operation.attempts + 1,
          });
        } else {
          this._journal.noteAttempt(projectId, typeof memory?.reason === 'string' ? memory.reason : 'no_answer');
          summary.pending += 1;
        }
      }
    }
    return summary;
  }

  _recordDelete(projectId) {
    if (!this._journal) return { ok: false, reason: 'journal_unavailable' };
    try {
      const recorded = this._journal.record(projectId);
      return recorded?.ok === true ? { ok: true } : { ok: false, reason: recorded?.reason || 'write_failed' };
    } catch (_error) {
      return { ok: false, reason: 'write_failed' };
    }
  }

  // A record that could not be cleared is harmless: reconcile drops it when
  // the project exists and re-issues a move that finds nothing when it is gone.
  _clearRecord(projectId) {
    try {
      this._journal?.clear(projectId);
    } catch (_error) {
      // See above.
    }
  }

  // The journal's logger is the service log; it never throws.
  _log(level, event, details) {
    this._journal?.log?.(level, event, details);
  }

  // The synchronous preconditions: a writable store, a readable chat
  // inventory, and every member chat idle.
  _deleteBlocker(projectId) {
    const storage = this._projectStore.getStatus();
    if (storage.read_only === true) {
      return { failure: this._fail(storage.reason || 'project_store_read_only') };
    }
    const inventory = this._readSessionInventory();
    if (!inventory) return { failure: this._fail('session_inventory_unavailable') };
    const members = inventory.filter((record) => record?.project_id === projectId);
    let busyCount = 0;
    for (const record of members) {
      if (this._isBusy(record)) busyCount += 1;
    }
    if (busyCount > 0) {
      return {
        failure: this._fail('project_sessions_busy', { busy_count: busyCount, reason: 'session_busy' }),
      };
    }
    return { failure: null, members };
  }

  _isBusy(record) {
    let busy = true;
    try {
      busy = this._isSessionBusy(record.id) !== false;
    } catch (_error) {
      // An unavailable lifecycle registry cannot prove a chat is idle.
    }
    return busy || this._recordIsBusy(record) === true;
  }

  // One request. The mover's contract: a result object means the sidecar
  // answered (`ok: false` is a definite refusal, nothing committed); a throw
  // means there was no answer, reported here as null.
  _requestMemoryMove(projectId) {
    return Promise.resolve()
      .then(() => this._moveMemories({ from_project_id: projectId, to_project_id: GENERAL_PROJECT_ID }))
      .catch(() => null);
  }

  // A lost or timed-out reply does not mean the sidecar rolled back: the move
  // may have committed. The move is idempotent (a second run moves only what
  // is left), so one retry settles an uncertain first attempt. `uncertain`
  // marks a failure where either attempt had no answer at all.
  async _moveProjectMemories(projectId) {
    let uncertain = false;
    let last = null;
    for (let tries = 0; tries < 2; tries += 1) {
      last = await this._requestMemoryMove(projectId);
      if (last?.ok === true) return { ok: true, moved: positiveCount(last.moved) };
      if (!last) uncertain = true;
    }
    return { ok: false, uncertain, reason: typeof last?.reason === 'string' ? last.reason : null };
  }

  // null when the inventory cannot be read: a delete must then refuse rather
  // than treat "unknown" as "no chats, none busy".
  _readSessionInventory() {
    const store = this._sessions;
    try {
      if (typeof store.listSessionRecords === 'function') return store.listSessionRecords() || [];
      if (typeof store.listSessions === 'function') return store.listSessions() || [];
    } catch (_error) {
      return null;
    }
    return [];
  }

  _moveKnowledge(projectId) {
    if (!this._knowledge) return { ok: true, moved: 0, receipt: null };
    try {
      const moved = this._knowledge.moveProjectFolders({
        fromProjectId: projectId, toProjectId: GENERAL_PROJECT_ID,
      });
      return moved?.ok === true
        ? { ok: true, moved: positiveCount(moved.moved), receipt: moved.receipt || null }
        : { ok: false, reason: moved?.reason || 'knowledge_move_failed' };
    } catch (error) {
      return { ok: false, reason: String(error?.code || 'knowledge_move_failed') };
    }
  }

  _assignDurably(sessionId, projectId) {
    const result = assignSessionProjectDurably({
      sessionStore: this._sessions,
      shadowStore: this._shadow,
      sessionId,
      projectId,
      updatedAt: this._now(),
    });
    if (result?.ok === true && this._onSessionProjectChanged) {
      try {
        this._onSessionProjectChanged({ sessionId, projectId });
      } catch (_error) {
        // A hook failure never fails or rolls back the move.
      }
    }
    return result;
  }

  // Best-effort rollback, newest step first. `moved_sessions` reports the
  // chats that were NOT put back; zero means clean. A chat goes back only
  // while it still sits idle in General where the delete left it: one the user
  // moved again, or that started work, during the memory move keeps its newer
  // state (a move never touches a busy chat).
  _undo({ movedIds, projectId, knowledge, project = null }) {
    const details = {};
    if (project) details.project_restored = succeeded(() => this._projects.restore(project));
    const current = new Map((this._readSessionInventory() || []).map((record) => [record?.id, record]));
    let restored = 0;
    for (const sessionId of movedIds) {
      const record = current.get(sessionId);
      if (!record || (record.project_id || GENERAL_PROJECT_ID) !== GENERAL_PROJECT_ID || this._isBusy(record)) continue;
      if (succeeded(() => this._assignDurably(sessionId, projectId))) restored += 1;
    }
    details.moved_sessions = movedIds.length - restored;
    details.restored_sessions = restored;
    if (knowledge?.receipt && this._knowledge) {
      details.knowledge_restored = succeeded(() => this._knowledge.restoreProjectFolders(knowledge.receipt));
    }
    return details;
  }

  _dropProjectGrants(projectId) {
    const store = this._permissions;
    if (typeof store?.listStoredDecisions !== 'function' || typeof store.removeRule !== 'function') return 0;
    let dropped = 0;
    try {
      for (const grant of store.listStoredDecisions()?.scoped_grants || []) {
        if (grant?.authority?.project_id !== projectId) continue;
        try {
          if (store.removeRule(grant.id)?.removed === true) dropped += 1;
        } catch (_error) {
          // A read-only permission store keeps the inert grant; it cannot match.
        }
      }
    } catch (_error) {
      // Grants of a deleted project are inert; cleanup never fails the delete.
    }
    return dropped;
  }
}

module.exports = { ProjectDeleteOperation };
