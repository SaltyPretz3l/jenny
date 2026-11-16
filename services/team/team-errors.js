'use strict';

// Failure shapes of the desktop team client. Every failure is
// { ok: false, error: { code, reason } }: a host answer keeps the host's own
// CMP-HOST code and reason untouched; the client's own failures carry a
// CMP-TEAM code; a payload refused in main carries `invalid_request`. A reason is
// one bounded word and an error message is only that reason, so a thrown error
// can never carry a key, an invite string, a name or an address.

const { TEAM_ERROR_CODES } = require('../backend/error-codes');

const REASON = /^[a-z][a-z0-9_]{0,79}$/u;
// A failure code the client passes on: a CMP code of any domain, or a payload refused in main.
const CODE = /^(?:CMP-[A-Z]{2,16}-\d{4}|invalid_request)$/u;
// The hello refusals that mean one side must update; the connection stops for good on these.
const VERSION_REASONS = new Set(['team_client_too_old', 'team_server_too_old']);

function safeReason(reason) {
  return typeof reason === 'string' && REASON.test(reason) ? reason : 'team_unavailable';
}

class TeamError extends Error {
  constructor(kind, reason, { reset = false } = {}) {
    const safe = safeReason(reason);
    super(safe);
    this.name = 'TeamError';
    this.code = TEAM_ERROR_CODES[kind] || TEAM_ERROR_CODES.CONNECTION_FAILED;
    this.reason = safe;
    // True when a call got no answer at all, so a committed change may or may not have happened.
    this.reset = reset === true;
  }
}

function teamFailure(kind, reason) {
  return { ok: false, error: { code: TEAM_ERROR_CODES[kind] || TEAM_ERROR_CODES.CONNECTION_FAILED,
    reason: safeReason(reason) } };
}

function invalidRequest(reason = 'team_request_invalid') {
  return { ok: false, error: { code: 'invalid_request', reason: safeReason(reason) } };
}

// Team chat (slice 2a-4b): the host reasons the client presents under its own codes.
const CHAT_REASON_KINDS = Object.freeze({
  team_chat_rate_limit: 'CHAT_RETRY_LATER',
  disk_pressure: 'CHAT_RETRY_LATER',
  team_unavailable: 'CONNECTION_FAILED',
  team_chat_not_found: 'CHAT_NOT_FOUND',
  // A refused reaction or pin, never retryable whatever the host says.
  team_chat_emoji_invalid: 'CHAT_CHANGE_REFUSED',
  team_chat_reaction_limit: 'CHAT_CHANGE_REFUSED',
  team_chat_pin_limit: 'CHAT_CHANGE_REFUSED',
  // A direct conversation the host will not open (slice 2d): a named member is not active, or is the caller.
  team_chat_dm_members_invalid: 'CHAT_CHANGE_REFUSED',
});

/** A host failure as the renderer sees it: { ok: false, error: { code, reason, retryable? } } and nothing else. */
function failureAnswer(answer) {
  const error = answer && typeof answer.error === 'object' && answer.error ? answer.error : {};
  const code = typeof error.code === 'string' && CODE.test(error.code) ? error.code : TEAM_ERROR_CODES.CONNECTION_FAILED;
  return { ok: false, error: { code, reason: safeReason(error.reason), ...(error.retryable === true ? { retryable: true } : {}) } };
}

/** A chat failure: `failureAnswer`, with the mapped reasons under CMP-TEAM codes (a refused change never retryable). */
function chatFailure(answer) {
  const rebuilt = failureAnswer(answer);
  const { reason, retryable } = rebuilt.error;
  const kind = Object.hasOwn(CHAT_REASON_KINDS, reason) ? CHAT_REASON_KINDS[reason] : null;
  if (!kind) return rebuilt;
  const keep = retryable === true && kind !== 'CHAT_CHANGE_REFUSED';
  return { ok: false, error: { code: TEAM_ERROR_CODES[kind], reason, ...(keep ? { retryable: true } : {}) } };
}

// A TeamError becomes its failure; anything else is a connection failure with no detail.
function failureOf(error) {
  if (error instanceof TeamError) return { ok: false, error: { code: error.code, reason: error.reason } };
  return teamFailure('CONNECTION_FAILED', 'team_unavailable');
}

// True for a host failure answer: { ok: false, error: { code: string, reason: string } }.
function isFailureAnswer(answer) {
  return Boolean(answer) && answer.ok === false && Boolean(answer.error)
    && typeof answer.error.code === 'string' && typeof answer.error.reason === 'string';
}

module.exports = {
  CHAT_REASON_KINDS, CODE, REASON, TEAM_ERROR_CODES, TeamError, VERSION_REASONS, chatFailure, failureAnswer, failureOf,
  invalidRequest, isFailureAnswer, teamFailure,
};
