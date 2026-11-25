'use strict';

// Team boards T6 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.2): the two raw board picture routes.
//
//   PUT /api/v1/projects/<project_id>/boards/<board_id>/assets/<sha256>   the body is the picture (board.write)
//   GET /api/v1/projects/<project_id>/boards/<board_id>/assets/<sha256>   the picture (board.read)
//
// Raw routes because a picture is up to 10 MiB and a command body is 1 MiB. The guard runs with the explicit action
// on the project before anything else and again after every await; a member removed, demoted or revoked while the
// body arrives is refused and nothing is stored, and one removed while a read is awaited gets the denial and no
// byte. A project the caller cannot see and one that does not exist answer the guard's one `team_not_found`; inside
// a project the caller can see, a board of another project, in the trash, unknown or malformed answers
// `team_board_not_found`, and a picture not stored in this project `team_board_asset_not_found`. The free refusals
// of an upload (the length header, the member's rate, the board, the disk gate, two uploads in flight) come before a
// byte of the body is read, and drain or stop it as the chat upload does (raw-route-body.js). A download carries
// the type its bytes say, `no-store`, `nosniff` and an `attachment` disposition, as the chat attachment download
// does. The acting member is the live caller only. Logs carry a reason word only: never a hash, a path or a byte.

const ids = require('../../../services/boards/board-ids');
const { LIMITS } = require('../../../services/boards/board-model');
const { hostFailure } = require('../../api-contract');
const { downloadDisposition } = require('../../download-headers');
const { json } = require('../../http-server');
const { createDiskAdmission } = require('../../resource-limits');
const { createRateLimiter } = require('../rate-limit');
const rawBody = require('../raw-route-body');
const { routeDenial } = require('../route-guard');
const { safeLogger } = require('../safe-logger');
const { isTeamProjectId } = require('./board-host-files');

const READ_ACTION = 'board.read';
const WRITE_ACTION = 'board.write';
const ASSET_PATH = /^\/api\/v1\/projects\/([^/]{1,200})\/boards\/([^/]{1,200})\/assets\/([^/]{1,200})$/u;
const HASH_RE = /^[0-9a-f]{64}$/u;
// A member each, a minute; options may only lower them.
const ROUTE_LIMITS = Object.freeze({ uploads: 30, reads: 600, pictureBytes: LIMITS.image_asset_bytes });
const WINDOW_MS = 60_000;
const MAX_KEYS = 64;
const IN_FLIGHT_PER_MEMBER = 2;
const EXT_BY_TYPE = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' });

const isHash = (value) => typeof value === 'string' && value.length === 64 && HASH_RE.test(value);
const notFound = () => hostFailure('forbidden', 'team_board_not_found');
const unavailable = () => hostFailure('unavailable', 'team_board_unavailable', '', true);
const sizeLimit = () => hostFailure('limit', 'team_board_asset_size_limit');
const rateLimit = () => hostFailure('limit', 'team_board_rate_limit');
// A dependency's answer as a refusal: its own failure when it is one, else unavailable.
const failureOf = (answer) => (answer?.ok === false && answer.error ? answer : unavailable());

function resolveLimits(limits = {}) {
  const resolved = { ...ROUTE_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(ROUTE_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > ROUTE_LIMITS[key]) {
      throw new RangeError('invalid_board_asset_route_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

/**
 * boards: the host board store (team-boards.js; `list` is used). assets: the picture store (board-host-assets.js).
 * canAdmit: the disk gate; by default the host core's own rule on `diskRoots` (`statfs` for tests). limits lowers
 * { uploads, reads, pictureBytes }. Answers an async route: true when it took the request.
 */
function createBoardAssetRoutes({ boards, assets, clock = Date.now, logger = null, diskRoots = [], canAdmit = null, statfs,
  limits = {} } = {}) {
  if (!boards || typeof boards.list !== 'function') throw new TypeError('Board asset routes need the board store.');
  if (!assets || typeof assets.put !== 'function' || typeof assets.read !== 'function' || typeof assets.discard !== 'function') {
    throw new TypeError('Board asset routes need the picture store.');
  }
  const caps = resolveLimits(limits);
  const log = safeLogger(logger);
  const refuse = rawBody.createRefuser(log, 'team_board_asset.route_refused');
  const early = (ctx, failure) => refuse(ctx, failure, { close: true, body: rawBody.bodyRule(ctx, caps.pictureBytes) });
  const admit = typeof canAdmit === 'function' ? canAdmit
    : createDiskAdmission(diskRoots, { logger: log, ...(statfs ? { statfs } : {}) });
  const hold = rawBody.createInFlight(IN_FLIGHT_PER_MEMBER);
  const uploads = createRateLimiter({ limit: caps.uploads, windowMs: WINDOW_MS, maxKeys: MAX_KEYS, clock });
  const reads = createRateLimiter({ limit: caps.reads, windowMs: WINDOW_MS, maxKeys: MAX_KEYS, clock });

  // Exactly null while the caller may still do `action` on the project, else the refusal. Only routeDenial's `null`
  // lets a request go on; anything else it answers is a refusal.
  function check(ctx, action, projectId) {
    if (!rawBody.authorized(ctx)) return hostFailure('forbidden', 'client_required');
    const denied = routeDenial(ctx, action, { kind: 'project', id: projectId }, { guardRequired: true });
    if (denied === null) return null;
    return denied?.ok === false && denied.error ? denied : hostFailure('forbidden', 'role_forbidden');
  }

  // Exactly null while the caller may still act and the board is live in the project, else the refusal. The list is
  // awaited, so the guard runs again before its answer is read; a list that throws or fails is a refusal.
  async function stillAllowed(ctx, action, projectId, boardId) {
    const before = check(ctx, action, projectId);
    if (before !== null) return before;
    let listed;
    try { listed = await boards.list({ projectId }); } catch { listed = null; }
    const after = check(ctx, action, projectId);
    if (after !== null) return after;
    if (listed === null || typeof listed !== 'object' || listed.ok !== true || !Array.isArray(listed.boards)) return failureOf(listed);
    return listed.boards.some((board) => board?.id === boardId) ? null : notFound();
  }

  // The refusals that cost nothing, answered at once, before a byte of the body is read: { declared } or { failure }.
  function headerChecks(ctx, projectId, boardId, hash) {
    const first = check(ctx, WRITE_ACTION, projectId);
    if (first !== null) return { failure: first };
    if (!isTeamProjectId(projectId) || !ids.isBoardId(boardId)) return { failure: notFound() };
    if (!isHash(hash)) return { failure: hostFailure('invalid', 'team_board_asset_invalid') };
    const text = ctx.request?.headers?.['content-length'];
    if (typeof text !== 'string' || !rawBody.LENGTH.test(text) || Number(text) === 0) {
      return { failure: hostFailure('invalid', 'team_board_asset_invalid') };
    }
    const declared = Number(text);
    if (declared > caps.pictureBytes) return { failure: sizeLimit() };
    if (uploads.take(ctx.actor?.member_id) !== true) return { failure: rateLimit() };
    return { declared };
  }

  // Then the board and the disk gate, still before a byte of the body is read: exactly null, or the refusal.
  async function boardAndDisk(ctx, projectId, boardId) {
    const live = await stillAllowed(ctx, WRITE_ACTION, projectId, boardId);
    if (live !== null) return live;
    return admit() === true ? null : hostFailure('unavailable', 'disk_pressure', '', true);
  }

  async function receive(ctx, projectId, boardId, hash, declared) {
    const bytes = await rawBody.readExactly(ctx.request, declared);
    if (!bytes) return refuse(ctx, sizeLimit(), { close: true });
    // Removed, demoted or revoked while the body arrived, or the board left: refused, and nothing is stored.
    const after = await stillAllowed(ctx, WRITE_ACTION, projectId, boardId);
    if (after !== null) return refuse(ctx, after);
    // The store asks the caller's check again inside its queue, before the write. A refusal after the write (the
    // caller was removed in between) takes back only a picture this request stored and no card names.
    const stored = await assets.put({ projectId, hash, bytes, recheck: () => check(ctx, WRITE_ACTION, projectId) });
    if (stored?.ok !== true) return refuse(ctx, failureOf(stored));
    const late = check(ctx, WRITE_ACTION, projectId);
    if (late !== null) {
      if (stored.stored === true) await assets.discard({ projectId, hash, ifUnreferenced: true });
      return refuse(ctx, late);
    }
    json(ctx.response, 200, { ok: true, asset: stored.asset, type: stored.type, width: stored.width, height: stored.height,
      bytes: stored.bytes, stored: stored.stored === true });
    return true;
  }

  async function upload(ctx, projectId, boardId, hash) {
    const ready = headerChecks(ctx, projectId, boardId, hash);
    if (ready.failure) return early(ctx, ready.failure);
    const gate = await boardAndDisk(ctx, projectId, boardId);
    if (gate !== null) return early(ctx, gate);
    return hold(ctx.actor?.member_id, () => early(ctx, hostFailure('limit', 'team_board_upload_limit', '', true)),
      () => receive(ctx, projectId, boardId, hash, ready.declared));
  }

  async function download(ctx, projectId, boardId, hash) {
    const first = check(ctx, READ_ACTION, projectId);
    if (first !== null) return refuse(ctx, first);
    if (!isTeamProjectId(projectId) || !ids.isBoardId(boardId) || !isHash(hash)) return refuse(ctx, notFound());
    if (reads.take(ctx.actor?.member_id) !== true) return refuse(ctx, rateLimit());
    const live = await stillAllowed(ctx, READ_ACTION, projectId, boardId);
    if (live !== null) return refuse(ctx, live);
    const read = await assets.read({ projectId, hash });
    // The read was awaited: the caller is checked again before the first byte goes out.
    const after = check(ctx, READ_ACTION, projectId);
    if (after !== null) return refuse(ctx, after);
    if (read?.ok !== true) return refuse(ctx, failureOf(read));
    const ext = Object.hasOwn(EXT_BY_TYPE, read.type) ? EXT_BY_TYPE[read.type] : null;
    if (ext === null || ext !== read.ext || !(read.bytes instanceof Uint8Array)) return refuse(ctx, unavailable());
    ctx.response.writeHead(200, { 'Content-Type': read.type, 'Content-Length': read.bytes.length, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Content-Disposition': downloadDisposition(`${hash}.${ext}`) });
    ctx.response.end(read.bytes);
    return true;
  }

  return async function boardAssetRoutes(ctx = {}) {
    const method = String(ctx.request?.method || '').toUpperCase();
    const match = method === 'PUT' || method === 'GET' ? ASSET_PATH.exec(String(ctx.pathname || '')) : null;
    if (!match) return false;
    const [, projectId, boardId, hash] = match;
    try {
      return method === 'PUT' ? await upload(ctx, projectId, boardId, hash) : await download(ctx, projectId, boardId, hash);
    } catch {
      log('WARN', 'team_board_asset.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'host_unavailable'), { close: true });
      return true;
    }
  };
}

module.exports = { ROUTE_LIMITS, createBoardAssetRoutes };
