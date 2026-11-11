'use strict';

// Failure shapes of the desktop team client. Every failure is
// { ok: false, error: { code, reason } }: a host answer keeps the host's own
// CMP-HOST code and reason untouched; the client's own failures carry a
// CMP-TEAM code; a payload refused in main carries `invalid_request`. A reason is
// one bounded word and an error message is only that reason, so a thrown error
// can never carry a key, an invite string, a name or an address.

const { TEAM_ERROR_CODES } = require('../backend/error-codes');

const REASON = /^[a-z][a-z0-9_]{0,79}$/u;
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

module.exports = { TEAM_ERROR_CODES, TeamError, VERSION_REASONS, failureOf, invalidRequest, isFailureAnswer, teamFailure };
