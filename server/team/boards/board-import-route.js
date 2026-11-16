'use strict';

// Team boards T7, host part (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.2 and 8.7): copy a board into a team
// project in one request.
//
//   POST /api/v1/projects/<project_id>/boards/import    the body is a .jennyboard text with no pictures (board.write)
//
// A raw route because a board is up to 2 MiB and a command body is 1 MiB. It is all or nothing: the board is made
// with its content in one store call, or nothing is written. The guard runs with the explicit action on the project
// before a byte of the body is read, again once the body has arrived, and a third time inside the store's queue,
// where nothing can change between that check and the write; a member removed, demoted or revoked while the body
// arrives is refused and nothing is stored. A project the caller cannot see and one that does not exist answer the
// guard's one `team_not_found`.
//
// The body is read as a hostile file by the one package reader (services/boards/board-package.js `unpack`): unknown
// keys refused, depth and size bounded, the board model the one authority on the board. Only content is taken:
// every item gets a new id, every revision starts at 0, there is no journal and no proposal, and every card is
// written by the importing member, whatever the file says. Pictures do not travel here: a body that carries one is
// refused, and the member sends each through the picture route afterwards. A chat card must name a conversation of
// this project (the rule of `team.board.apply`), or the whole import is refused `team_board_chat_outside_project`.
// The free refusals (the length header, the member's rate, the disk gate, an import already in flight) come before
// a byte of the body is read, and drain or stop it as the picture upload does (raw-route-body.js). The acting member
// is the live caller only. Logs carry a reason word only: never a name, a card's text or a byte of the body.

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const { LIMITS } = require('../../../services/boards/board-model');
const pkg = require('../../../services/boards/board-package');
const { hostFailure } = require('../../api-contract');
const { json } = require('../../http-server');
const { createDiskAdmission } = require('../../resource-limits');
const { createRateLimiter } = require('../rate-limit');
const rawBody = require('../raw-route-body');
const { routeDenial } = require('../route-guard');
const { safeLogger } = require('../safe-logger');
const { chatCardRefusal } = require('./board-commands');
const { isTeamProjectId } = require('./board-host-files');
const { isToken } = require('./board-host-journal');

const WRITE_ACTION = 'board.write';
const IMPORT_PATH = /^\/api\/v1\/projects\/([^/]{1,200})\/boards\/import$/u;
// A member, a minute; options may only lower them. The body cap is a board document's.
const IMPORT_LIMITS = Object.freeze({ imports: 10, bodyBytes: LIMITS.document_bytes });
const WINDOW_MS = 60_000;
const MAX_KEYS = 64;
const IN_FLIGHT_PER_MEMBER = 1;
// The package reader's words that a member can act on; every other one is `team_board_import_invalid`.
const READER_WORDS = Object.freeze({ too_large: ['limit', 'team_board_import_size_limit'], limit: ['limit', 'team_board_import_limit'],
  version: ['invalid', 'team_board_import_version'] });

const invalid = () => hostFailure('invalid', 'team_board_import_invalid');
const sizeLimit = () => hostFailure('limit', 'team_board_import_size_limit');
const unavailable = () => hostFailure('unavailable', 'team_board_unavailable', '', true);
const failureOf = (answer) => (answer?.ok === false && answer.error ? answer : unavailable());

function resolveLimits(limits = {}) {
  const resolved = { ...IMPORT_LIMITS };
  for (const [key, value] of Object.entries(limits ?? {})) {
    if (!Object.hasOwn(IMPORT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > IMPORT_LIMITS[key]) {
      throw new RangeError('invalid_board_import_limit');
    }
    resolved[key] = value;
  }
  return Object.freeze(resolved);
}

// The body as text, or null: UTF-8 only, and no byte order mark.
function textOf(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

/**
 * boards: the host board store (team-boards.js; `create` is used). sessionProject(id): the project a conversation is
 * in, or null. canAdmit: the disk gate; by default the host core's own rule on `diskRoots` (`statfs` for tests).
 * makeId(): a lowercase UUID for each item. limits lowers { imports, bodyBytes }. Answers an async route: true when
 * it took the request.
 */
function createBoardImportRoute({ boards, sessionProject, clock = Date.now, logger = null, diskRoots = [], canAdmit = null, statfs,
  makeId = () => crypto.randomUUID(), limits = {} } = {}) {
  if (!boards || typeof boards.create !== 'function') throw new TypeError('The board import route needs the board store.');
  if (typeof sessionProject !== 'function') throw new TypeError('The board import route needs sessionProject.');
  const caps = resolveLimits(limits);
  const log = safeLogger(logger);
  const refuse = rawBody.createRefuser(log, 'team_board_import.route_refused');
  const early = (ctx, failure) => refuse(ctx, failure, { close: true, body: rawBody.bodyRule(ctx, caps.bodyBytes) });
  const admit = typeof canAdmit === 'function' ? canAdmit
    : createDiskAdmission(diskRoots, { logger: log, ...(statfs ? { statfs } : {}) });
  const hold = rawBody.createInFlight(IN_FLIGHT_PER_MEMBER);
  const imports = createRateLimiter({ limit: caps.imports, windowMs: WINDOW_MS, maxKeys: MAX_KEYS, clock });

  // Exactly null while the caller may still write the project's boards, else the refusal. Only routeDenial's `null`
  // lets a request go on; anything else it answers is a refusal.
  function check(ctx, projectId) {
    if (!rawBody.authorized(ctx)) return hostFailure('forbidden', 'client_required');
    const denied = routeDenial(ctx, WRITE_ACTION, { kind: 'project', id: projectId }, { guardRequired: true });
    if (denied === null) return null;
    return denied?.ok === false && denied.error ? denied : hostFailure('forbidden', 'role_forbidden');
  }

  // The refusals that cost nothing, answered at once, before a byte of the body is read: { declared } or { failure }.
  function headerChecks(ctx, projectId, actor) {
    const first = check(ctx, projectId);
    if (first !== null) return { failure: first };
    if (!isTeamProjectId(projectId) || !isToken(actor)) return { failure: hostFailure('forbidden', 'team_not_found') };
    const text = ctx.request?.headers?.['content-length'];
    if (typeof text !== 'string' || !rawBody.LENGTH.test(text) || Number(text) === 0) return { failure: invalid() };
    const declared = Number(text);
    if (declared > caps.bodyBytes) return { failure: sizeLimit() };
    if (imports.take(actor) !== true) return { failure: hostFailure('limit', 'team_board_rate_limit') };
    if (admit() !== true) return { failure: hostFailure('unavailable', 'disk_pressure', '', true) };
    return { declared };
  }

  // The board the store is to write, inside its queue: { ok: true, board } or the refusal. `frame` is the store's
  // { boardId, now }.
  function boardFrom(text, projectId, actor, frame) {
    const read = pkg.unpack(text, { makeId, now: frame.now, projectId, newBoardId: frame.boardId });
    if (!read.ok) {
      const [kind, word] = Object.hasOwn(READER_WORDS, read.reason) ? READER_WORDS[read.reason] : ['invalid', 'team_board_import_invalid'];
      return hostFailure(kind, word);
    }
    if (read.pictures.length !== 0) return invalid();
    const cards = {};
    for (const [id, card] of Object.entries(read.board.cards)) cards[id] = { ...card, created_by: actor, updated_by: actor };
    const chats = { ops: Object.values(cards).filter((card) => card.kind === 'chat').map((card) => ({ op: 'card.add', card })) };
    return chatCardRefusal(chats, projectId, sessionProject) ?? { ok: true, board: { ...read.board, cards } };
  }

  async function receive(ctx, projectId, actor, declared) {
    const bytes = await rawBody.readExactly(ctx.request, declared);
    if (!bytes) return refuse(ctx, sizeLimit(), { close: true });
    // Removed, demoted or revoked while the body arrived: refused before the body is read as anything.
    const after = check(ctx, projectId);
    if (after !== null) return refuse(ctx, after);
    const text = textOf(bytes);
    if (text === null) return refuse(ctx, invalid());
    const made = await boards.create({ projectId, actor, recheck: () => check(ctx, projectId),
      content: (frame) => boardFrom(text, projectId, actor, frame) });
    if (made?.ok !== true || !made.board) return refuse(ctx, failureOf(made));
    json(ctx.response, 200, { ok: true, board: made.board });
    return true;
  }

  async function take(ctx, projectId) {
    const actor = ctx.actor?.member_id;
    const ready = headerChecks(ctx, projectId, actor);
    if (ready.failure) return early(ctx, ready.failure);
    return hold(actor, () => early(ctx, hostFailure('limit', 'team_board_upload_limit', '', true)),
      () => receive(ctx, projectId, actor, ready.declared));
  }

  return async function boardImportRoute(ctx = {}) {
    const match = String(ctx.request?.method || '').toUpperCase() === 'POST' ? IMPORT_PATH.exec(String(ctx.pathname || '')) : null;
    if (!match) return false;
    try {
      return await take(ctx, match[1]);
    } catch {
      log('WARN', 'team_board_import.route_failed', {});
      if (ctx.response?.headersSent) ctx.response.destroy();
      else refuse(ctx, hostFailure('unavailable', 'host_unavailable'), { close: true });
      return true;
    }
  };
}

module.exports = { IMPORT_LIMITS, createBoardImportRoute };
