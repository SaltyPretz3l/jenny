'use strict';

// The closed payload table of the `team.model…` IPC methods (row 123 slice 6-5, decision 9): merged into
// ipc-methods.js METHODS, so `validatePayload` checks every model payload in main before anything is read or sent,
// and a refused payload sends nothing. MODEL_OPERATIONS names the host operation each method sends (null: answered
// from this Jenny's own state, or a local action of the team module, services/team/team-models.js). A model is named
// by its discovery tag, never a path; a destination root by its index in the roots list the team module answers.
// This module is a table only: it loads no sender, receiver, hasher or disk reader (decision 1, tests/team-off).
//
// Answers are built field by field in team-models.js; their exact fields are listed in TEAM_MODEL_SHARING_SPEC
// "6-5 as built".

const { isId } = require('../../server/team/ids');
const { MODEL_TRANSFER_LIMITS } = require('../../server/team/model-manifest');
const { MODEL_RELAY_ID_PATTERNS } = require('../../server/team/model-relay-core');

const L = MODEL_TRANSFER_LIMITS;
const CONTROL = /\p{Cc}/u;
const MULTILINE_CONTROL = /(?![\n\t])\p{Cc}/u;
const wellFormed = (value) => typeof value.isWellFormed !== 'function' || value.isWellFormed();
const text = (min, max, { lines = false } = {}) => (value) => typeof value === 'string' && value.length >= min
  && value.length <= max && !(lines ? MULTILINE_CONTROL : CONTROL).test(value) && wellFormed(value);

const TEAM = { team_id: (value) => isId('team', value) };
const tag = text(1, 256);
const fileName = text(1, L.maxNameUnits);
const files = (value) => Array.isArray(value) && value.length <= L.maxFiles && value.every(fileName)
  && new Set(value).size === value.length;
const offerId = (value) => typeof value === 'string' && MODEL_RELAY_ID_PATTERNS.offer.test(value);
const transferId = (value) => typeof value === 'string' && MODEL_RELAY_ID_PATTERNS.transfer.test(value);
const requestId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(value);
const integer = (min, max) => (value) => Number.isSafeInteger(value) && value >= min && value <= max;
// The member's outgoing limit in whole MB/s (1 MB = 1,000,000 bytes); 0 is no limit. The renderer offers 1, 5, 10, 25.
const MAX_RATE_MB = 1000;
const MAX_ROOTS = 16;

const OFFER = { ...TEAM, offer_id: offerId };
const TRANSFER = { ...TEAM, transfer_id: transferId };

// method -> { fields, optional } (ipc-methods.js's shape).
const MODEL_METHODS = Object.freeze({
  modelState: { fields: { ...TEAM } },
  modelSendable: { fields: { ...TEAM } },
  modelFiles: { fields: { ...TEAM, tag } },
  modelReceivers: { fields: { ...TEAM } },
  modelOffer: {
    fields: { ...TEAM, tag, files, member_id: (value) => isId('member', value), display_name: text(1, L.maxDisplayNameChars),
      licence: text(0, L.maxLicenceChars, { lines: true }), source_url: text(0, L.maxSourceUrlChars),
      note: text(0, L.maxNoteChars, { lines: true }) },
    optional: ['member_id', 'licence', 'source_url', 'note'],
  },
  modelWithdraw: { fields: { ...TEAM, request_id: requestId } },
  modelSendPause: { fields: { ...TRANSFER } },
  modelSendResume: { fields: { ...TRANSFER } },
  modelSendStop: { fields: { ...TRANSFER } },
  modelOfferRead: { fields: { ...OFFER } },
  modelAccept: { fields: { ...OFFER, root_index: integer(0, MAX_ROOTS - 1) } },
  modelDecline: { fields: { ...OFFER } },
  modelReceivePause: { fields: { ...OFFER } },
  modelReceiveResume: { fields: { ...OFFER } },
  modelReceiveCancel: { fields: { ...OFFER } },
  modelReceiveRetry: { fields: { ...OFFER } },
  modelSetRate: { fields: { ...TEAM, mb_per_second: integer(0, MAX_RATE_MB) } },
  modelProvenance: { fields: { ...TEAM, tag } },
});

// The host operation each method sends; null answers from this Jenny's state or acts locally first.
const MODEL_OPERATIONS = Object.freeze({
  modelState: null, // local: the module's state (one team.model.offers per online connect)
  modelSendable: null, // local: the discovery listing
  modelFiles: null, // local: the discovery listing and the main file's header
  modelReceivers: 'team.members.list',
  modelOffer: 'team.model.offer', // local first: checks, then the read, then the offer
  modelWithdraw: 'team.model.withdraw',
  modelSendPause: 'team.model.pause',
  modelSendResume: 'team.model.resume',
  modelSendStop: 'team.model.cancel',
  modelOfferRead: 'team.model.offer.read',
  modelAccept: 'team.model.accept', // local first: the receiver's checks, then the accept with its start points
  modelDecline: 'team.model.decline',
  modelReceivePause: 'team.model.pause',
  modelReceiveResume: 'team.model.resume',
  modelReceiveCancel: 'team.model.cancel', // a receiver failure word travels as team.model.complete { ok: false }
  modelReceiveRetry: 'team.model.accept', // local first: the receiver adopts its staging, then accepts again
  modelSetRate: null, // local: the member's own setting
  modelProvenance: null, // local: the received model's provenance file
});

const MODEL_METHOD_NAMES = Object.freeze(Object.keys(MODEL_METHODS));
const isModelMethod = (method) => Object.hasOwn(MODEL_METHODS, method);

module.exports = { MAX_RATE_MB, MODEL_METHODS, MODEL_METHOD_NAMES, MODEL_OPERATIONS, isModelMethod };
