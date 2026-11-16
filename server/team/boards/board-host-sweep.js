'use strict';

// Team boards (row 151, plan PROJECT_BOARD_2026-11-13 section 8.1): the sweep of the host board store's trash, split
// out of board-host-store.js. A deleted board is kept 7 days, then its files are removed, document last.
//
// - One project at a time, inside that project's queue, at most SWEEP_MAX boards in one stretch of the host's
//   thread; a project with more comes round again after every other project had its turn, with a pause between
//   turns, until nothing expired is left (at most SWEEP_TOTAL_MAX a call). One project's backlog never holds
//   another's trash.
// - Oldest deleted first. A board whose document broke while it waited is never removed (a project admin can still
//   restore it); one that cannot be read right now (a lock) is left for the next sweep. Neither stops the others,
//   and the index is written for what was removed whatever else happened.
// - Each project's first turn also removes the temp files a crash in the middle of a write left in its folder and
//   its assets folder, once they are an hour old (board-host-files.js `removeStaleTemps`).
// - A sweep that could not look at all (team-boards is not a plain folder) says so in the log and answers
//   unavailable; the caller's timer reports that as a failed sweep.

const { Answer, REMOVAL_ORDER, answers, stop } = require('./board-host-load');

const TRASH_MS = 7 * 24 * 60 * 60 * 1000;
const TEMP_MS = 60 * 60 * 1000;
const SWEEP_MAX = 64;
const SWEEP_TOTAL_MAX = 4096;

const nextTurn = () => new Promise((resolve) => { setImmediate(resolve); });

/**
 * loader: the store's board loader. inProject(projectId, body): runs `body` in that project's queue and answers what
 * it answers (a refusal thrown inside is answered as it is). isRemoved(projectId): the project was removed in this
 * process. nowMs(): the store's clock. pause(): resolves on a later turn of the event loop.
 */
function createBoardSweep({ files, log, loader, inProject, isRemoved, nowMs, pause = nextTurn }) {
  const { projectOrNull, loadBoard, forget, persistIndex, boardFile } = loader;

  function removeBoardFiles(projectId, boardId) {
    return REMOVAL_ORDER.every((kind) => files.removeFile(boardFile(projectId, boardId, kind), projectId));
  }

  // One turn of one project: { ok, removed, failed, more }. `skip` holds the boards this call already gave up on;
  // `first` is the project's first turn of this sweep.
  function sweepProject(projectId, cutoff, skip, first) {
    if (first) {
      const temps = files.removeStaleTemps(projectId, nowMs() - TEMP_MS);
      if (temps > 0) log('INFO', 'team_board.temps_removed', { project_id: projectId, count: temps });
    }
    const boards = projectOrNull(projectId);
    if (!boards) return { ok: true, removed: 0, failed: 0, more: false };
    const expired = [...boards]
      .filter(([boardId, entry]) => entry.deleted_at !== null && Date.parse(entry.deleted_at) < cutoff && !skip.has(boardId))
      .sort(([, a], [, b]) => (a.deleted_at < b.deleted_at ? -1 : a.deleted_at > b.deleted_at ? 1 : 0));
    let removed = 0;
    let failed = 0;
    let left = expired.length;
    try {
      for (const [boardId] of expired) {
        if (removed >= SWEEP_MAX) break;
        left -= 1;
        let loaded;
        try {
          loaded = loadBoard(projectId, boardId, boards);
        } catch (error) {
          if (!(error instanceof Answer)) throw error;
          loaded = null; // not readable right now
        }
        forget(projectId, boardId);
        if (loaded && !loaded.readOnly && removeBoardFiles(projectId, boardId)) {
          boards.delete(boardId);
          removed += 1;
          continue;
        }
        failed += 1;
        skip.add(boardId);
        // Never removed: it broke while it waited, or cannot be read now.
        if (!loaded || loaded.readOnly) {
          log('WARN', 'team_board.sweep_kept', { project_id: projectId, board_id: boardId, reason: loaded ? 'read_only' : 'unreadable' });
        }
      }
    } finally {
      if (removed > 0) persistIndex(projectId, boards);
    }
    return { ok: true, removed, failed, more: left > 0 };
  }

  /** { ok, removed, failed }: called by the store inside its `call`. */
  async function sweep() {
    const cutoff = nowMs() - TRASH_MS;
    const names = files.listProjects();
    if (names === null) {
      log('WARN', 'team_board.sweep_unavailable', {});
      stop(answers.UNAVAILABLE());
    }
    const counts = { removed: 0, failed: 0 };
    const skipped = new Map();
    let waiting = names;
    while (waiting.length > 0 && counts.removed < SWEEP_TOTAL_MAX) {
      const again = [];
      for (const projectId of waiting) {
        if (isRemoved(projectId)) continue;
        const first = !skipped.has(projectId);
        if (first) skipped.set(projectId, new Set());
        const answer = await inProject(projectId, () => sweepProject(projectId, cutoff, skipped.get(projectId), first));
        if (answer?.ok !== true) {
          counts.failed += 1;
          continue;
        }
        counts.removed += answer.removed;
        counts.failed += answer.failed;
        if (answer.more) again.push(projectId);
        if (answer.removed > 0) await pause();
      }
      waiting = again;
    }
    if (counts.removed > 0 || counts.failed > 0) log('INFO', 'team_board.swept', { ...counts });
    return { ok: true, ...counts };
  }

  return { sweep };
}

module.exports = { SWEEP_MAX, SWEEP_TOTAL_MAX, TEMP_MS, TRASH_MS, createBoardSweep };
