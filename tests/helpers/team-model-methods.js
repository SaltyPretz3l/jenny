'use strict';

// The model sharing IPC surface (row 123 slice 6-5), written out by hand so a test notices any method added, renamed
// or dropped in services/team/model-ipc.js: tests/team-ipc-contract.test.js adds these to its closed method list, and
// tests/team-model-ipc.test.js checks each one's payloads and answers. Push kinds on `team.onModel` likewise.

const MODEL_METHODS = Object.freeze(['modelState', 'modelSendable', 'modelFiles', 'modelReceivers', 'modelOffer',
  'modelWithdraw', 'modelSendPause', 'modelSendResume', 'modelSendStop', 'modelOfferRead', 'modelAccept', 'modelDecline',
  'modelReceivePause', 'modelReceiveResume', 'modelReceiveCancel', 'modelReceiveRetry', 'modelSetRate', 'modelProvenance']);
const MODEL_PUSH_KINDS = Object.freeze(['state', 'progress', 'received']);
// Row 151 T3: the team board IPC surface (services/team/board-ipc.js) and the push kinds on `team.onBoard`, likewise
// by hand; tests/team-board-ipc.test.js checks each method's payloads and answers.
const BOARD_METHODS = Object.freeze(['boardList', 'boardTrash', 'boardCreate', 'boardRename', 'boardDelete', 'boardRestore',
  'boardOpen', 'boardApply', 'boardClose',
  // Slices T4 and T5: the pointer, the note lock, Jenny's proposals and the revert of one batch.
  'boardCursor', 'boardLock', 'boardUnlock', 'boardProposals', 'boardProposalAccept', 'boardProposalReject', 'boardRevert', 'boardHistory',
  // Slice T6, member side: a board's pictures.
  'boardAssetAdd', 'boardAssetRead',
  // Slice T7: a board copied into a team project.
  'boardImport']);
const BOARD_PUSH_KINDS = Object.freeze(['applied', 'refused', 'reloaded', 'gone', 'list_changed', 'presence', 'proposals_changed']);

module.exports = { BOARD_METHODS, BOARD_PUSH_KINDS, MODEL_METHODS, MODEL_PUSH_KINDS };
