'use strict';

// Every reason word the member's model sharing client (row 123 slice 6-5) can answer a call with or push, closed: its
// own refusals, the receiver's (model-receive.js), the host reasons its operations and part routes pass through
// (server/api-contract.js TEAM_MODEL_REASONS plus the router's own), and the relay's pause, end and offer words that
// ride a transfer or offer row. The renderer (slice 6-7) has a sentence for each; a string test reads this list. A
// word outside it never leaves main: model-answers.js maps it to null (a row) or `team_unavailable` (a failure).

const { TEAM_MODEL_REASONS } = require('../../server/api-contract');
const { COMPLETE_REASONS } = require('../../server/team/model-relay-core');
const { MODEL_RECEIVE_REASONS } = require('./model-receive');
const { teamFailure } = require('./team-errors');

const CLIENT = Object.freeze([
  // Sharing and the connection.
  'team_model_sharing_off', 'team_model_host_too_old', 'team_not_connected', 'team_not_found', 'team_force_local',
  'team_disposed', 'team_request_invalid', 'team_answer_invalid', 'team_connection_stopped', 'team_unavailable',
  // The sender: what may be offered, its checks before any hashing, its reading and its push.
  'model_not_listed', 'model_ollama_copy', 'model_file_not_offered', 'model_manifest_invalid',
  'model_provenance_too_large', 'model_audience_invalid', 'model_read_failed', 'model_source_changed',
  // The receiver's module: a root named by an index this module did not answer, or no transfer to act on.
  'model_root_invalid', 'model_not_receiving',
]);

// The host's model reasons, and the router's own refusals a model command can meet.
const HOST = Object.freeze([...TEAM_MODEL_REASONS, 'client_unauthorized', 'invalid_command_parameters',
  'invalid_command_envelope', 'unsupported_operation', 'team_unavailable']);

// The relay's words on a row: why a transfer paused or ended (server/team/model-relay-core.js PAUSES, ENDS), the
// receiver's own failure word on a failed transfer, and why an offer ended.
const PAUSES = Object.freeze(['paused_by_sender', 'paused_by_receiver', 'sender_offline', 'idle']);
const ENDS = Object.freeze(['cancelled_by_sender', 'cancelled_by_receiver', 'withdrawn', 'declined', 'expired',
  'member_gone', 'role_changed', 'sender_offline', 'sharing_off', 'host_stopping', 'fulfilled']);
const RELAY = Object.freeze([...new Set([...PAUSES, ...ENDS, ...COMPLETE_REASONS])]);

const MODEL_REASONS = Object.freeze([...new Set([...CLIENT, ...MODEL_RECEIVE_REASONS, ...HOST, ...RELAY])]);
const ROW_REASONS = new Set([...RELAY, ...MODEL_RECEIVE_REASONS, ...CLIENT, ...HOST]);

/** A row's reason as it may leave main: a closed word, else null. */
const rowReason = (value) => (typeof value === 'string' && ROW_REASONS.has(value) ? value : null);

/** A refusal of this PC's model module: CMP-TEAM-0011 and a closed word (`team_unavailable` for any other). */
const modelRefusal = (reason) => teamFailure('MODEL_FAILED', MODEL_REASONS.includes(reason) ? reason : 'team_unavailable');

module.exports = { MODEL_REASONS, modelRefusal, rowReason };
