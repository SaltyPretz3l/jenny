'use strict';

// The closed payload table of the `team.board…` IPC methods (row 151 slice T3): merged into ipc-methods.js METHODS,
// so `validatePayload` checks every board payload in main before anything is read or sent, and a refused payload
// sends nothing. BOARD_OPERATIONS names the host operation each method sends (null: answered by the open board's
// client, services/team/board-client.js). A board is named by its team, project and board ids, never a path; a
// batch is checked here for its shape and size only: the shared board model and the host check what it does.
// Slices T4 and T5 add the pointer, the note lock, Jenny's proposals and the revert of one batch; slice T6's member
// side adds a board's pictures (bytes up, bytes down, named by their SHA-256); slice T7 adds a board copied into a
// team project whole (its document; board-import.js reads it with the board model before anything is sent).
// This module is a table only: it loads no client, model or connection (tests/team-off).

const { isProjectId } = require('../../server/team/member-schema');
const { isId } = require('../../server/team/ids');
const ids = require('../boards/board-ids');

const NAME_MAX = 200;
const BATCH_OPS_MAX = 4096;
const BATCH_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,199}$/u;
const CONTROL = /\p{Cc}/u;
const CARD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COORDINATE_MAX = 10_000_000;
const SELECTED_MAX = 64;
const PROPOSAL_ID_MAX = 500;
const CHANGE_MAX = 100_000;

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const name = (value) => typeof value === 'string' && value.length >= 1 && value.length <= NAME_MAX && !CONTROL.test(value)
  && (typeof value.isWellFormed !== 'function' || value.isWellFormed());
const batch = (value) => isPlain(value) && Object.keys(value).every((key) => key === 'batch_id' || key === 'ops')
  && typeof value.batch_id === 'string' && BATCH_ID.test(value.batch_id)
  && Array.isArray(value.ops) && value.ops.length >= 1 && value.ops.length <= BATCH_OPS_MAX && value.ops.every(isPlain);
const cardId = (value) => typeof value === 'string' && CARD_ID.test(value);
const coordinate = (value) => Number.isFinite(value) && Math.abs(value) <= COORDINATE_MAX;
const selected = (value) => Array.isArray(value) && value.length <= SELECTED_MAX && value.every(cardId);
const proposalId = (value) => typeof value === 'string' && value.length >= 1 && value.length <= PROPOSAL_ID_MAX && !CONTROL.test(value);
const change = (value) => Number.isSafeInteger(value) && value >= 1 && value <= CHANGE_MAX;
const rev = (value) => Number.isSafeInteger(value) && value >= 1;
// An ArrayBuffer or a typed array of at least one byte; the size cap is board-pictures.js's, with its own reason.
const bytes = (value) => (Object.prototype.toString.call(value) === '[object ArrayBuffer]' || ArrayBuffer.isView(value))
  && value.byteLength >= 1;

// project_general has no team boards: a team board belongs to a shared project.
const PROJECT = { team_id: (value) => isId('team', value),
  project_id: (value) => isProjectId(value) && ids.isProjectId(value) && value !== ids.GENERAL_PROJECT_ID };
const BOARD = { ...PROJECT, board_id: (value) => ids.isBoardId(value) };

const DECISION = { fields: { ...BOARD, proposal_id: proposalId, n: change }, optional: ['n'] };

// method -> { fields, optional } (ipc-methods.js's shape).
const BOARD_METHODS = Object.freeze({
  boardList: { fields: { ...PROJECT } },
  boardTrash: { fields: { ...PROJECT } },
  boardCreate: { fields: { ...PROJECT, name } },
  boardRename: { fields: { ...BOARD, name } },
  boardDelete: { fields: { ...BOARD } },
  boardRestore: { fields: { ...BOARD } },
  boardOpen: { fields: { ...BOARD } },
  boardApply: { fields: { ...BOARD, batch } },
  boardClose: { fields: { ...BOARD } },
  boardCursor: { fields: { ...BOARD, x: coordinate, y: coordinate, selected }, optional: ['selected'] },
  boardLock: { fields: { ...BOARD, card_id: cardId } },
  boardUnlock: { fields: { ...BOARD } },
  boardProposals: { fields: { ...BOARD } },
  boardProposalAccept: DECISION,
  boardProposalReject: DECISION,
  boardRevert: { fields: { ...BOARD, rev } },
  boardHistory: { fields: { ...BOARD } },
  boardAssetAdd: { fields: { ...BOARD, bytes } },
  boardAssetRead: { fields: { ...BOARD, asset: ids.isAssetId } },
  boardImport: { fields: { ...PROJECT, board: isPlain } },
});

// The host operation each method sends; null is the open board's client (its snapshot, its queue, its close) or
// its presence (the pointer and the note lock, board-presence-client.js), a picture route (board-pictures.js) or
// the import route (board-import.js).
const BOARD_OPERATIONS = Object.freeze({
  boardList: 'team.board.list',
  boardTrash: 'team.board.trash',
  boardCreate: 'team.board.create',
  boardRename: 'team.board.rename',
  boardDelete: 'team.board.delete',
  boardRestore: 'team.board.restore',
  boardOpen: null,
  boardApply: null,
  boardClose: null,
  boardCursor: null,
  boardLock: null,
  boardUnlock: null,
  boardProposals: 'team.board.proposal.list',
  boardProposalAccept: 'team.board.proposal.accept',
  boardProposalReject: 'team.board.proposal.reject',
  boardRevert: 'team.board.revert',
  boardHistory: 'team.board.history',
  boardAssetAdd: null,
  boardAssetRead: null,
  boardImport: null,
});

const isBoardMethod = (method) => Object.hasOwn(BOARD_METHODS, method);

module.exports = { BOARD_METHODS, BOARD_OPERATIONS, isBoardMethod };
