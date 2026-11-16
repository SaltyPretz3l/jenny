'use strict';

// Team boards T4 (row 151, plan PROJECT_BOARD_2026-11-13 sections 8.3 and 8.4): the five presence operations of a
// team board, and the announcements of what the presence store loses on its own (a device dropped, a record or a
// lease run out).
//
// Each operation is an entry of the shape board-commands.js `OPERATIONS` uses, `{ limit, run }`, for the host to
// merge into that table. The caller has already validated the closed params schema, run the one authorization
// function, spent the rate limit and re-checked the member: `run` adds no role check and reads no member state.
// `actor` is the caller's live member id and `deviceId` their device id, both given by the host and never read from
// `params`. Ids from `params` are re-checked against the project: a board is viewable or lockable only when the
// board store finds it in that project (`boards.get({ projectId, boardId })`), and a cursor, a leave and an unlock
// act only on a board tracked under that project (anything else changes nothing).
//
// Events go out as board-events.js sends its own: to `projectAudience(directory, projectId)` under the project's
// bucket, plus `ephemeral: true` (a cursor is worth nothing a second later, so the stream never replays it). An
// empty or failing audience publishes nothing, and a publish that throws is logged and fails no call.
//
// Logs carry an operation name or an event type and a reason word only: never a board name, a card's text, an id
// or a path.

const { hostFailure } = require('../../api-contract');
const { BOARD_CURSOR_EVENT: CURSOR_EVENT, BOARD_LOCK_EVENT: LOCK_EVENT, BOARD_VIEWERS_EVENT: VIEWERS_EVENT,
  PROJECT_BUCKET } = require('../event-scope');
const { projectAudience } = require('../project-visibility');
const { safeLogger } = require('../safe-logger');
const { PRESENCE_LIMITS } = require('./board-presence');

const MAX_SELECTED = 64;
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const unavailable = () => hostFailure('unavailable', 'team_board_unavailable', '', true);
const notViewing = () => hostFailure('forbidden', 'team_board_not_viewing');
const presenceLimit = () => hostFailure('limit', 'team_board_presence_limit');
const cardNotFound = () => hostFailure('invalid', 'team_board_card_not_found');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The selected card ids of a cursor, or null when they are not at most 64 card ids.
function selectedOf(value) {
  if (!Array.isArray(value) || value.length > MAX_SELECTED) return null;
  return value.every((id) => typeof id === 'string' && CARD_ID.test(id)) ? [...value] : null;
}

// The card of kind `note` with this id on a board the store answered, else false. A board is a map of cards by id
// (the board model) and an array of cards is read too.
function isNote(board, cardId) {
  const cards = board?.cards;
  if (typeof cardId !== 'string' || !CARD_ID.test(cardId) || cards === null || typeof cards !== 'object') return false;
  const card = Array.isArray(cards) ? cards.find((candidate) => candidate?.id === cardId) : (Object.hasOwn(cards, cardId) ? cards[cardId] : undefined);
  return isObject(card) && card.id === cardId && card.kind === 'note';
}

/**
 * presence: the store (board-presence.js). publish(type, payload, options): the host's scoped publish. directory: the
 * member directory (projectAudience). Answers the frozen { operations, announce(changes) }.
 */
function createPresenceOperations({ presence, publish, directory, logger = null } = {}) {
  if (!presence || typeof presence !== 'object') throw new TypeError('createPresenceOperations requires a presence store.');
  if (typeof publish !== 'function') throw new TypeError('createPresenceOperations requires publish().');
  if (!directory) throw new TypeError('createPresenceOperations requires a directory.');
  const log = safeLogger(logger);

  function audienceOf(projectId) {
    try {
      const audience = projectAudience(directory, projectId);
      return audience instanceof Set && audience.size > 0 ? audience : null;
    } catch {
      return null;
    }
  }

  function emit(type, projectId, payload) {
    if (typeof projectId !== 'string' || !projectId) return;
    const audience = audienceOf(projectId);
    if (!audience) return;
    try {
      publish(type, payload, { audience, bucket: `${PROJECT_BUCKET}${projectId}`, ephemeral: true });
    } catch {
      log('WARN', 'team_board_presence.publish_failed', { event_type: type });
    }
  }

  const tellViewers = (projectId, boardId) => emit(VIEWERS_EVENT, projectId,
    { project_id: projectId, board_id: boardId, viewers: presence.viewersOf(boardId) });
  const tellLock = (projectId, boardId, cardId, memberId) => emit(LOCK_EVENT, projectId,
    { project_id: projectId, board_id: boardId, card_id: cardId, member_id: memberId });

  function announce(changes) {
    try {
      for (const change of Array.isArray(changes) ? changes : []) {
        if (!isObject(change) || typeof change.projectId !== 'string' || typeof change.boardId !== 'string') continue;
        if (change.viewers === true) tellViewers(change.projectId, change.boardId);
        for (const cardId of Array.isArray(change.unlocked) ? change.unlocked : []) tellLock(change.projectId, change.boardId, cardId, null);
      }
    } catch {
      log('WARN', 'team_board_presence.announce_failed');
    }
  }

  // The board store's answer for (project, board): { board } on a board it found, else { refusal } with the answer
  // to give. The store's own refusal passes through; one that throws or answers nonsense reads as unavailable.
  async function find(boards, params, operation) {
    let found;
    try {
      found = await boards.get({ projectId: params.project_id, boardId: params.board_id });
    } catch {
      log('WARN', 'team_board_presence.store_failed', { operation });
      return { refusal: unavailable() };
    }
    if (found?.ok === true) return { board: found.board ?? null };
    if (found?.ok === false && isObject(found.error)) return { refusal: found };
    return { refusal: unavailable() };
  }

  async function view({ boards, params, actor, deviceId }) {
    const p = isObject(params) ? params : {};
    const found = await find(boards, p, 'team.board.view');
    if (found.refusal) return found.refusal;
    const seen = presence.view({ projectId: p.project_id, boardId: p.board_id, deviceId, memberId: actor });
    if (seen.ok !== true) return presenceLimit();
    if (seen.changed) tellViewers(p.project_id, p.board_id);
    return { ok: true, viewers: presence.viewersOf(p.board_id), locks: presence.locksOf(p.board_id), lock_ms: PRESENCE_LIMITS.LOCK_MS };
  }

  async function leave({ params, deviceId }) {
    const p = isObject(params) ? params : {};
    if (presence.projectOf(p.board_id) !== p.project_id) return { ok: true };
    const left = presence.leave({ boardId: p.board_id, deviceId });
    if (left.projectId) {
      announce([{ projectId: left.projectId, boardId: p.board_id, viewers: left.changed === true, unlocked: left.unlocked }]);
    }
    return { ok: true };
  }

  async function cursor({ params, actor, deviceId }) {
    const p = isObject(params) ? params : {};
    if (!presence.isViewing(p.board_id, deviceId) || presence.projectOf(p.board_id) !== p.project_id) return notViewing();
    const selected = selectedOf(p.selected);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || selected === null) return hostFailure('invalid', 'team_board_cursor_invalid');
    emit(CURSOR_EVENT, p.project_id, { project_id: p.project_id, board_id: p.board_id, member_id: actor, x: p.x, y: p.y, selected });
    return { ok: true };
  }

  async function lock({ boards, params, actor, deviceId }) {
    const p = isObject(params) ? params : {};
    const found = await find(boards, p, 'team.board.lock');
    if (found.refusal) return found.refusal;
    if (!isNote(found.board, p.card_id)) return cardNotFound();
    if (presence.projectOf(p.board_id) !== p.project_id) return notViewing();
    const taken = presence.lock({ boardId: p.board_id, cardId: p.card_id, deviceId, memberId: actor });
    if (taken.ok !== true) {
      if (taken.reason === 'held') return { ...hostFailure('forbidden', 'team_board_note_locked'), held_by: taken.held_by };
      if (taken.reason === 'not_viewing') return notViewing();
      return taken.reason === 'limit' ? presenceLimit() : cardNotFound();
    }
    if (taken.released) tellLock(p.project_id, p.board_id, taken.released, null);
    if (taken.changed) tellLock(p.project_id, p.board_id, p.card_id, actor);
    return { ok: true, lock_ms: PRESENCE_LIMITS.LOCK_MS };
  }

  async function unlock({ params, deviceId }) {
    const p = isObject(params) ? params : {};
    if (presence.projectOf(p.board_id) !== p.project_id) return { ok: true };
    const freed = presence.unlock({ boardId: p.board_id, cardId: p.card_id, deviceId });
    if (freed.changed) tellLock(p.project_id, p.board_id, p.card_id, null);
    return { ok: true };
  }

  const operations = Object.freeze({
    'team.board.view': Object.freeze({ limit: 'presence', run: view }),
    'team.board.leave': Object.freeze({ limit: 'presence', run: leave }),
    'team.board.cursor': Object.freeze({ limit: 'cursor', run: cursor }),
    'team.board.lock': Object.freeze({ limit: 'presence', run: lock }),
    'team.board.unlock': Object.freeze({ limit: 'presence', run: unlock }),
  });
  return Object.freeze({ operations, announce });
}

module.exports = { CURSOR_EVENT, LOCK_EVENT, VIEWERS_EVENT, createPresenceOperations };
