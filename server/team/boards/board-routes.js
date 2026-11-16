'use strict';

// Team boards T2 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.2): the raw board snapshot route.
//
//   GET /api/v1/projects/<project_id>/boards/<board_id>    the board as the host holds it: { ok, board, rev, read_only }
//
// A raw route because a board document is up to 2 MiB and a command answer is not the place for it. The guard runs
// with the explicit action (`board.read`) on the project before the read and again after it, so a member removed
// or revoked while the read was awaited gets the denial and never the board. A project the caller cannot see and one
// that does not exist answer the guard's one `team_not_found`; inside a project the caller can see, an unknown
// board, another project's board, a board in the trash and a malformed id answer the store's one
// `team_board_not_found`. The answer is `no-store` and `nosniff`. A member reads at most 60 snapshots a minute.
// Logs carry a reason word only: never a board name, a card's text or a path.

const ids = require('../../../services/boards/board-ids');
const { hostFailure } = require('../../api-contract');
const { createRateLimiter } = require('../rate-limit');
const rawBody = require('../raw-route-body');
const { routeDenial } = require('../route-guard');
const { safeLogger } = require('../safe-logger');

const READ_ACTION = 'board.read';
const SNAPSHOT_PATH = /^\/api\/v1\/projects\/([^/]{1,200})\/boards\/([^/]{1,200})$/u;
const SNAPSHOT_LIMIT = Object.freeze({ limit: 60, windowMs: 60_000, maxKeys: 64 });

const notFound = () => hostFailure('forbidden', 'team_board_not_found');

/** boards: the host board store (team-boards.js). Answers an async route: true when it took the request. */
function createBoardRoutes({ boards, clock = Date.now, logger = null, limit = SNAPSHOT_LIMIT } = {}) {
  if (!boards || typeof boards.get !== 'function') throw new TypeError('Board routes need the board store.');
  const log = safeLogger(logger);
  const refuse = rawBody.createRefuser(log, 'team_board.route_refused');
  const snapshots = createRateLimiter({ ...limit, clock });

  // null while the caller may still read the project's boards, else the refusal.
  function check(ctx, projectId) {
    if (!rawBody.authorized(ctx)) return hostFailure('forbidden', 'client_required');
    return routeDenial(ctx, READ_ACTION, { kind: 'project', id: projectId }, { guardRequired: true });
  }

  async function snapshot(ctx, projectId, boardId) {
    const before = check(ctx, projectId);
    if (before) return refuse(ctx, before);
    if (!ids.isProjectId(projectId) || !ids.isBoardId(boardId)) return refuse(ctx, notFound());
    if (snapshots.take(ctx.actor?.member_id) !== true) return refuse(ctx, hostFailure('limit', 'team_board_rate_limit'));
    const read = await boards.get({ projectId, boardId });
    // The read was awaited: the caller is checked again before a byte goes out.
    const after = check(ctx, projectId);
    if (after) return refuse(ctx, after);
    if (read?.ok !== true) return refuse(ctx, read?.ok === false && read.error ? read : hostFailure('unavailable', 'team_board_unavailable', '', true));
    const body = Buffer.from(JSON.stringify({ ok: true, board: read.board, rev: read.rev, read_only: read.read_only === true,
      ...(read.read_only === true ? { reason: read.reason } : {}) }), 'utf8');
    ctx.response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.response.end(body);
    return true;
  }

  return async function boardRoutes(ctx = {}) {
    const match = String(ctx.request?.method || '').toUpperCase() === 'GET' ? SNAPSHOT_PATH.exec(String(ctx.pathname || '')) : null;
    if (!match) return false;
    try {
      return await snapshot(ctx, match[1], match[2]);
    } catch {
      log('WARN', 'team_board.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'host_unavailable'), { close: true });
      return true;
    }
  };
}

module.exports = { SNAPSHOT_LIMIT, createBoardRoutes };
