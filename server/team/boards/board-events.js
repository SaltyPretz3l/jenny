'use strict';

// Team boards T3 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.3): what the host announces about a board.
//
// The board store calls `onChange` synchronously inside a board's queue, after the write (board-host-store.js
// `announce`), so for one board the announcements leave in rev order whatever path the batch came by: a member's
// command, and later an accepted proposal, a revert or an import.
//
// `team_board_changed { project_id, board_id, rev, batch? }`: `batch` is the item `team.board.sync` serves for that
// rev ({ rev, batch_id, actor, at, applied }). It rides in the event only when it is at most 16 KiB of JSON AND the
// project still has room in its inline allowance: 1 MiB of inline batches within the replay window (120 seconds).
// Otherwise the event carries `rev` alone and a client reads the batch with `team.board.sync`. The plan's 16 KiB rule
// alone bounds one member (60 batches a minute); the allowance bounds all of a project's members together, so board
// traffic never takes more than about half of the project's 2 MiB replay bucket and the stream's trim, which drops
// the oldest events of every bucket once one is over, is never set off by boards.
//
// `team_board_list_changed { project_id }`: a board was created, renamed, deleted or restored; a client reads the
// list again. It names no board.
//
// `team_board_proposals_changed { project_id, board_id }` (T5): Jenny proposed something or a member decided; a
// client reads the board's proposals again. It names no proposal and carries none of its text.
//
// All three go to the members who have the project now (project-visibility.js `projectAudience`), under the
// project's bucket, whose stream predicate re-checks project access on every delivery and replay. An event for a
// project nobody has is not published. Publishing never fails a board call.

const { BOARD_CHANGED_EVENT, BOARD_LIST_EVENT, BOARD_PROPOSALS_EVENT, PROJECT_BUCKET } = require('../event-scope');
const { projectAudience } = require('../project-visibility');
const { safeLogger } = require('../safe-logger');

const BOARD_EVENT_LIMITS = Object.freeze({
  inlineBytes: 16 * 1024, // one batch
  windowBytes: 1024 * 1024, // a project's inline batches within windowMs
  windowMs: 120_000, // the event stream's replay window
});
const MAX_PROJECTS = 64;
const MAX_WINDOW_ENTRIES = 2048;

function resolveLimits(limits) {
  const resolved = { ...BOARD_EVENT_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(BOARD_EVENT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > BOARD_EVENT_LIMITS[key]) {
      throw new RangeError('invalid_board_event_limit');
    }
    resolved[key] = value;
  }
  return resolved;
}

function bytesOf(value) {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); } catch { return Number.POSITIVE_INFINITY; }
}

/**
 * publish(type, payload, options): the host's scoped publish. directory: the member directory. `limits` may only
 * lower BOARD_EVENT_LIMITS (tests). Answers { onChange(change), proposalsChanged(projectId, boardId), resources() };
 * `onChange` is the board store's hook.
 */
function createBoardEvents({ publish, directory, clock = Date.now, logger = null, limits = {} } = {}) {
  if (typeof publish !== 'function') throw new TypeError('createBoardEvents requires publish().');
  if (!directory) throw new TypeError('createBoardEvents requires a directory.');
  const log = safeLogger(logger);
  const { inlineBytes, windowBytes, windowMs } = resolveLimits(limits);
  const windows = new Map(); // project id -> { spent: [[at, bytes], ...] oldest first, total }

  function expire(now) {
    for (const [projectId, window] of windows) {
      while (window.spent.length && window.spent[0][0] <= now - windowMs) window.total -= window.spent.shift()[1];
      if (!window.spent.length) windows.delete(projectId);
    }
  }

  // True when the project may carry `bytes` more inline now; the bytes are then counted.
  function takeRoom(projectId, bytes) {
    let now;
    try { now = clock(); } catch { now = Number.NaN; }
    if (!Number.isFinite(now)) return false;
    expire(now);
    let window = windows.get(projectId);
    if (!window) {
      if (windows.size >= MAX_PROJECTS) return false;
      window = { spent: [], total: 0 };
      windows.set(projectId, window);
    }
    if (window.total + bytes > windowBytes || window.spent.length >= MAX_WINDOW_ENTRIES) return false;
    window.spent.push([now, bytes]);
    window.total += bytes;
    return true;
  }

  function audienceOf(projectId) {
    try {
      const audience = projectAudience(directory, projectId);
      return audience instanceof Set && audience.size > 0 ? audience : null;
    } catch {
      return null;
    }
  }

  function send(type, payload, projectId, audience) {
    try {
      publish(type, payload, { audience, bucket: `${PROJECT_BUCKET}${projectId}` });
    } catch {
      log('WARN', 'team_board.publish_failed', { event_type: type });
    }
  }

  function onChange(change) {
    const projectId = change?.projectId;
    if (typeof projectId !== 'string' || !projectId) return;
    const audience = audienceOf(projectId);
    if (!audience) return;
    if (change.kind === 'applied') {
      const { boardId, item } = change;
      if (typeof boardId !== 'string' || !item || !Number.isSafeInteger(item.rev)) return;
      const payload = { project_id: projectId, board_id: boardId, rev: item.rev };
      const bytes = bytesOf(item);
      if (bytes <= inlineBytes && takeRoom(projectId, bytes)) payload.batch = item;
      send(BOARD_CHANGED_EVENT, payload, projectId, audience);
    }
    if (change.kind === 'list' || (change.kind === 'applied' && change.renamed === true)) {
      send(BOARD_LIST_EVENT, { project_id: projectId }, projectId, audience);
    }
  }

  function proposalsChanged(projectId, boardId) {
    if (typeof projectId !== 'string' || !projectId || typeof boardId !== 'string' || !boardId) return;
    const audience = audienceOf(projectId);
    if (audience) send(BOARD_PROPOSALS_EVENT, { project_id: projectId, board_id: boardId }, projectId, audience);
  }

  return Object.freeze({
    onChange,
    proposalsChanged,
    resources: () => ({ projects: windows.size, entries: [...windows.values()].reduce((sum, window) => sum + window.spent.length, 0) }),
  });
}

module.exports = { BOARD_EVENT_LIMITS, createBoardEvents };
