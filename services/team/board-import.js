'use strict';

// Copy a board to a team project from a member's Jenny (row 151 slice T7, member side; plan PROJECT_BOARD_2026-11-13
// section 8.7): one board document, sent whole to the host's import route (server/team/boards/board-import-route.js)
// through the live link's session. All or nothing: the host makes the board with its content, or nothing.
//
// The document comes from the page and is not trusted: the board model reads it here first. What goes out is the
// .jennyboard text the desktop writes (services/boards/board-package.js `pack`) with no pictures: content only,
// never the board's id, its project, its revisions' history or a proposal. A chat card of the member's own Jenny
// names a private conversation, so it leaves as a note that holds the card's title and nothing else: no
// conversation id, no message id, no excerpt. The host gives every item a new id and writes every card as this
// member's. Pictures do not travel here: the answer names the ones the board's picture cards use, and the page sends
// each through `boardAssetAdd` afterwards.
//
// The answer is rebuilt: { ok, board: { id, name }, pictures: [asset] }. Nothing is kept here and nothing is logged.

const ids = require('../boards/board-ids');
const model = require('../boards/board-model');
const pkg = require('../boards/board-package');
const { failureAnswer, invalidRequest, isFailureAnswer, teamFailure } = require('./team-errors');

const MAX_BYTES = model.LIMITS.document_bytes;
const CHAT_TITLE = 'Chat';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidAnswer = () => teamFailure('CONNECTION_FAILED', 'team_response_invalid');
const refusal = (answer) => (isFailureAnswer(answer) ? failureAnswer(answer) : teamFailure('CONNECTION_FAILED', 'team_unavailable'));

// A private chat card as a note: the title only, under the note letter of the same alias number (one counter
// numbers every kind, so the alias stays free).
function titleNote(card) {
  const title = typeof card.data.title === 'string' ? card.data.title.trim() : '';
  return { ...card, kind: 'note', alias: card.alias === null ? null : `${model.ALIAS_LETTER.note}${card.alias.slice(1)}`,
    data: { text: title || CHAT_TITLE, tone: null } };
}

/** The bytes to send for a board document, and the pictures its cards name: { ok, bytes, pictures } or a refusal. */
function importBody(value, nowIso) {
  const read = model.normalizeBoard(value);
  if (!read.ok) return invalidRequest('team_board_import_invalid');
  const cards = {};
  const pictures = new Set();
  for (const [id, card] of Object.entries(read.board.cards)) {
    cards[id] = card.kind === 'chat' ? titleNote(card) : card;
    if (card.kind === 'image' && ids.isAssetId(card.data.asset)) pictures.add(card.data.asset);
  }
  const packed = pkg.pack({ board: { ...read.board, cards }, assets: [], now: nowIso });
  if (!packed.ok) return invalidRequest(packed.reason === 'too_large' ? 'team_board_import_size_limit' : 'team_board_import_invalid');
  const bytes = Buffer.from(packed.text, 'utf8');
  if (bytes.length > MAX_BYTES) return invalidRequest('team_board_import_size_limit');
  return { ok: true, bytes, pictures: [...pictures] };
}

/** Sends one board document to a team project as a new board there. */
async function importBoard(link, { projectId }, board, { clock = Date.now } = {}) {
  const body = importBody(board, new Date(clock()).toISOString());
  if (body.ok !== true) return body;
  let answer;
  try { answer = await link.session.boardImport(link.client, { projectId, bytes: body.bytes }); } catch { answer = null; }
  if (answer?.ok !== true) return refusal(answer);
  const made = answer.board;
  if (!isObject(made) || !ids.isBoardId(made.id) || typeof made.name !== 'string' || made.name.length < 1 || made.name.length > 200) {
    return invalidAnswer();
  }
  return { ok: true, board: { id: made.id, name: made.name }, pictures: body.pictures };
}

module.exports = { importBoard, importBody };
