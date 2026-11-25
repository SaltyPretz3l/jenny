'use strict';

// Team boards on a member's Jenny (row 151 slice T3; plan PROJECT_BOARD_2026-11-13 section 8.8): the `team.board…`
// IPC methods of every joined team. Required on the first board call only (team-service-helpers.js lazyBoards):
// before it nothing here is loaded, no host event is listened to and no board is held.
//
// - The list calls and the four board changes (create, rename, delete, restore) are one host command each; their
//   answers are rebuilt field by field, so nothing the host adds reaches the renderer unchecked.
// - boardOpen builds the board's client (board-client.js: the host's document, the unconfirmed queue, sync) and
//   keeps it until boardClose, the team's end, or the host's word that the board is gone for this member. At most
//   MAX_OPEN boards a team are open at once. boardApply goes to the open client.
// - One listener a team on the connection's event feed: `team_board_changed` goes to the open client it names,
//   `team_board_list_changed` goes out as `{ kind: 'list_changed' }`, `resync_required` to every open client.
//   A team that comes back online tells every open client to catch up.
// - An open board also has its presence (slice T4, board-presence-client.js): who is viewing, their pointers and
//   the note locks. It starts when the board opens and ends with it; `team_board_viewers`, `team_board_cursor` and
//   `team_board_lock` go to it, and boardCursor, boardLock and boardUnlock are its calls. boardOpen's answer
//   carries its state, and it pushes `{ kind: 'presence' }` after that.
// - Jenny's proposals and the revert of one batch (slice T5) are one host command each, answers rebuilt
//   (board-proposal-answers.js). `team_board_proposals_changed` for an open board goes out as
//   `{ kind: 'proposals_changed' }`: the page asks for the list again.
// - A board's pictures (slice T6) go through the host's picture routes on the live link (board-pictures.js); the
//   board need not be open. A board copied into a project (slice T7) goes through the import route the same way
//   (board-import.js).
// - Pushes (`team.onBoard`) carry team_id, project_id and board_id beside the client's own notice.
// - Force local (E64) refuses every call and feeds no event; a revoked or dropped team closes its boards, and each
//   open one is told `gone` (`team_board_closed`), so the page reads it again and shows why it cannot.

const { ENTRIES_MAX } = require('../../server/team/boards/board-host-index');
const ids = require('../boards/board-ids');
const { createBoardClient } = require('./board-client');
const { importBoard } = require('./board-import');
const { BOARD_OPERATIONS } = require('./board-ipc');
const { addPicture, readPicture } = require('./board-pictures');
const { createBoardPresenceClient } = require('./board-presence-client');
const { decisionAnswer, historyAnswer, proposalsAnswer, revertAnswer } = require('./board-proposal-answers');
const { forceLocalFailure } = require('./force-local-hold');
const { failureAnswer, invalidRequest, isFailureAnswer, teamFailure } = require('./team-errors');
const { liveLink } = require('./transfer-common');

const MAX_OPEN = 8;
// A project holds at most the host index's entries, live and in the trash together: a list of that many is whole.
const MAX_ROWS = ENTRIES_MAX;
const NAME_MAX = 200;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const WORD = /^[a-z][a-z0-9_]{0,79}$/u;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRev = (value) => Number.isSafeInteger(value) && value >= 0;
const isName = (value) => typeof value === 'string' && value.length >= 1 && value.length <= NAME_MAX;
const isMember = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 160;
// The host index rebuilds a board it could not read with no known creator (`created_by: null`).
const isCreator = (value) => value === null || isMember(value);
const invalidAnswer = () => teamFailure('CONNECTION_FAILED', 'team_response_invalid');
const word = (value) => (typeof value === 'string' && WORD.test(value) ? value : null);

// A host list row as the renderer sees it, or null: exactly these fields, each checked.
function row(value, deleted) {
  if (!isObject(value) || !ids.isBoardId(value.id) || !isName(value.name) || !isRev(value.rev)) return null;
  if (!ISO.test(value.created_at) || !ISO.test(value.updated_at) || !isCreator(value.created_by)) return null;
  const out = { id: value.id, name: value.name, rev: value.rev, created_at: value.created_at, updated_at: value.updated_at,
    created_by: value.created_by };
  if (!deleted) return out;
  if (!ISO.test(value.deleted_at) || !isMember(value.deleted_by)) return null;
  return { ...out, deleted_at: value.deleted_at, deleted_by: value.deleted_by };
}

// A refusal as the renderer sees it; a board model refusal keeps its closed words beside the error.
function refusal(answer) {
  const failure = isFailureAnswer(answer) ? failureAnswer(answer) : teamFailure('CONNECTION_FAILED', 'team_unavailable');
  if (!isObject(answer?.board)) return failure;
  const { reason, detail, limit, index } = answer.board;
  return { ...failure, board: { reason: word(reason), detail: word(detail), limit: word(limit),
    index: Number.isSafeInteger(index) && index >= 0 ? index : null } };
}

// The answer of one plain host command, rebuilt.
const ANSWERS = Object.freeze({
  boardList: (answer) => rows(answer, false),
  boardTrash: (answer) => rows(answer, true),
  boardCreate: (answer) => made(answer),
  boardRename: (answer) => (isRev(answer.rev) ? { ok: true, rev: answer.rev } : invalidAnswer()),
  boardDelete: () => ({ ok: true }),
  boardRestore: (answer) => made(answer),
  boardProposals: proposalsAnswer,
  boardProposalAccept: decisionAnswer,
  boardProposalReject: decisionAnswer,
  boardRevert: revertAnswer,
  boardHistory: historyAnswer,
});
const PRESENCE_EVENTS = new Set(['team_board_viewers', 'team_board_cursor', 'team_board_lock']);
function rows(answer, deleted) {
  if (!Array.isArray(answer.boards) || answer.boards.length > MAX_ROWS) return invalidAnswer();
  const boards = answer.boards.map((value) => row(value, deleted));
  return boards.includes(null) ? invalidAnswer() : { ok: true, boards };
}
function made(answer) {
  const board = answer.board;
  return isObject(board) && ids.isBoardId(board.id) && isName(board.name) && isRev(board.rev)
    ? { ok: true, board: { id: board.id, name: board.name, rev: board.rev } } : invalidAnswer();
}

/**
 * managerOf(teamId): the team's connection manager or null. isHeld(): force local. push(payload): `team.onBoard`.
 * `timers` and `clock` are test seams handed to each board client.
 */
function createTeamBoardClients({ managerOf, isHeld = () => false, push = () => {}, log = () => {}, timers, clock } = {}) {
  if (typeof managerOf !== 'function') throw new TypeError('createTeamBoardClients requires managerOf().');
  const teams = new Map(); // team id -> { manager, unsubscribe, open: Map<key, client>, live: Map<key, presence>, online }
  let stopped = false;
  const say = (level, event, fields) => { try { log(level, event, fields); } catch { /* best effort */ } };
  const send = (payload) => { if (!stopped) { try { push(payload); } catch { say('WARN', 'team.board.push_failed'); } } };
  const keyOf = (projectId, boardId) => `${projectId}/${boardId}`;
  const snapshotOf = (manager) => { try { return manager.snapshot(); } catch { return null; } };
  const isOnline = (manager) => {
    const state = snapshotOf(manager);
    return state?.state === 'online' && state.member_state === 'active';
  };

  function onEvent(teamId, entry, event) {
    if (stopped || teams.get(teamId) !== entry || isHeld() || !isObject(event)) return;
    if (event.event_type === 'team_board_list_changed') {
      if (ids.isProjectId(event.project_id)) send({ kind: 'list_changed', team_id: teamId, project_id: event.project_id });
    } else if (event.event_type === 'team_board_changed') {
      entry.open.get(keyOf(event.project_id, event.board_id))?.onEvent(event);
    } else if (PRESENCE_EVENTS.has(event.event_type)) {
      entry.live.get(keyOf(event.project_id, event.board_id))?.onEvent(event);
    } else if (event.event_type === 'team_board_proposals_changed') {
      if (entry.open.has(keyOf(event.project_id, event.board_id))) {
        send({ kind: 'proposals_changed', team_id: teamId, project_id: event.project_id, board_id: event.board_id });
      }
    } else if (event.event_type === 'resync_required') {
      for (const client of entry.open.values()) client.onEvent(event);
    }
  }

  function entryFor(teamId, manager) {
    let entry = teams.get(teamId);
    if (entry && entry.manager !== manager) { end(teamId, entry); entry = null; }
    if (!entry) {
      entry = { manager, open: new Map(), live: new Map(), online: isOnline(manager), unsubscribe: () => {} };
      entry.unsubscribe = manager.onEvent((event) => onEvent(teamId, entry, event));
      teams.set(teamId, entry);
    }
    return entry;
  }

  function end(teamId, entry) {
    if (teams.get(teamId) === entry) teams.delete(teamId);
    try { entry.unsubscribe(); } catch { /* the manager is gone */ }
    for (const client of entry.open.values()) client.close('team_board_closed');
    entry.open.clear();
    for (const presence of entry.live.values()) presence.close();
    entry.live.clear();
  }

  // The board is no longer open here: its client and its presence end together.
  function shut(entry, key, client) {
    if (entry.open.get(key) !== client) return;
    entry.open.delete(key);
    client.close();
    entry.live.get(key)?.close();
    entry.live.delete(key);
  }

  async function readSnapshot(manager, projectId, boardId) {
    const link = await liveLink(manager);
    if (!link) return teamFailure('CONNECTION_FAILED', 'team_not_connected');
    return link.session.boardSnapshot(link.client, projectId, boardId);
  }

  function build(teamId, entry, projectId, boardId) {
    const key = keyOf(projectId, boardId);
    const { manager } = entry;
    const shared = {
      projectId, boardId, ...(timers ? { timers } : {}), ...(clock ? { clock } : {}),
      send: (operation, params) => manager.command(operation, params),
      self: () => snapshotOf(manager)?.member_id ?? null,
      online: () => !stopped && teams.get(teamId) === entry && entry.online && !isHeld(),
      push: (notice) => send({ ...notice, team_id: teamId, project_id: projectId, board_id: boardId }),
    };
    const client = createBoardClient({
      ...shared, log: say,
      readSnapshot: () => readSnapshot(manager, projectId, boardId),
      onGone: () => shut(entry, key, client),
    });
    entry.open.set(key, client);
    entry.live.set(key, createBoardPresenceClient(shared));
    return client;
  }

  async function openBoard(teamId, entry, { project_id: projectId, board_id: boardId }) {
    const key = keyOf(projectId, boardId);
    let client = entry.open.get(key);
    if (!client) {
      if (entry.open.size >= MAX_OPEN) return invalidRequest('team_board_open_limit');
      client = build(teamId, entry, projectId, boardId);
    }
    const answer = await client.open();
    const presence = entry.open.get(key) === client ? entry.live.get(key) : null;
    if (answer?.ok === true && presence) {
      // The first view is not waited for: the board is shown now, and who else is here follows as a push.
      void presence.start();
      return { ...answer, presence: presence.state() };
    }
    // A board that did not open holds no slot.
    shut(entry, key, client);
    return refusal(answer);
  }

  // The pointer and the note lock of an open board. A pointer is never answered with more than `ok`.
  async function live(presence, method, value) {
    if (method === 'boardCursor') {
      presence.cursor({ x: value.x, y: value.y, selected: value.selected ?? [] });
      return { ok: true };
    }
    if (method === 'boardUnlock') { await presence.unlock(); return { ok: true }; }
    const answer = await presence.lock(value.card_id);
    if (answer?.ok === true) return { ok: true };
    return { ...refusal(answer), held_by: typeof answer?.held_by === 'string' ? answer.held_by : null };
  }

  async function picture(manager, method, value) {
    const link = await liveLink(manager);
    if (!link) return teamFailure('CONNECTION_FAILED', 'team_not_connected');
    const where = { projectId: value.project_id, boardId: value.board_id };
    return method === 'boardAssetAdd' ? addPicture(link, where, value.bytes) : readPicture(link, where, value.asset);
  }

  async function copyIn(manager, value) {
    const link = await liveLink(manager);
    if (!link) return teamFailure('CONNECTION_FAILED', 'team_not_connected');
    return importBoard(link, { projectId: value.project_id }, value.board, clock ? { clock } : {});
  }

  async function plain(manager, method, { team_id: _team, ...params }) {
    let answer;
    try { answer = await manager.command(BOARD_OPERATIONS[method], params); } catch { answer = null; }
    if (!isObject(answer) || answer.ok !== true) return refusal(answer);
    return ANSWERS[method](answer);
  }

  async function call(method, value) {
    if (isHeld()) return forceLocalFailure();
    if (stopped) return invalidRequest('team_disposed');
    const manager = managerOf(value.team_id);
    if (!manager) return invalidRequest('team_not_found');
    // The first board call for a team starts its listener, so a list the page shows hears `list_changed`.
    const entry = entryFor(value.team_id, manager);
    if (BOARD_OPERATIONS[method]) return plain(manager, method, value);
    if (method === 'boardAssetAdd' || method === 'boardAssetRead') return picture(manager, method, value);
    if (method === 'boardImport') return copyIn(manager, value);
    if (method === 'boardOpen') return openBoard(value.team_id, entry, value);
    const key = keyOf(value.project_id, value.board_id);
    const client = entry.open.get(key);
    if (method === 'boardClose') {
      if (client) shut(entry, key, client);
      return { ok: true };
    }
    if (!client) return invalidRequest('team_board_not_open');
    if (method !== 'boardApply') return live(entry.live.get(key), method, value);
    const answer = client.apply(value.batch);
    return answer?.ok === true ? answer : refusal(answer);
  }

  /** A team's connection changed: its boards follow the manager; a new manager or a revoked team closes them. */
  function connectionChanged(teamId, manager) {
    const entry = teams.get(teamId);
    if (!entry || stopped) return;
    if (entry.manager !== manager || snapshotOf(manager)?.state === 'revoked') { end(teamId, entry); return; }
    const online = isOnline(manager);
    const back = online && !entry.online;
    entry.online = online;
    if (!back) return;
    for (const client of entry.open.values()) client.reconnected();
    for (const presence of entry.live.values()) presence.reconnected();
  }

  function drop(teamId) {
    const entry = teams.get(teamId);
    if (entry) end(teamId, entry);
  }

  function stopAll() {
    stopped = true;
    for (const [teamId, entry] of [...teams]) end(teamId, entry);
  }

  function resources() {
    const totals = { teams: teams.size, boards: 0, pending: 0, timers: 0 };
    for (const entry of teams.values()) {
      for (const client of entry.open.values()) {
        const used = client.resources();
        totals.boards += 1;
        totals.pending += used.pending;
        totals.timers += used.timers;
      }
      for (const presence of entry.live.values()) totals.timers += presence.resources().timers;
    }
    return totals;
  }

  return Object.freeze({ call, connectionChanged, drop, stopAll, resources });
}

module.exports = { MAX_OPEN, createTeamBoardClients };
