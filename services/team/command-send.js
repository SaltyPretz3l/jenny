'use strict';

// One team command over one connection, with the one recovery a call owns: a client the host no longer knows
// (`client_unauthorized`, `boot_epoch_mismatch`, `client_required`) is registered again and the command goes out
// once more. A `team_hello_required` answer is the session's to retry (team-session.js `call`: one more hello and
// one resend), so it never reaches this file. The connection manager keeps the rate-limit hold and the client cache.

const { isFailureAnswer, teamFailure } = require('./team-errors');

const CLIENT_REASONS = new Set(['client_unauthorized', 'boot_epoch_mismatch', 'client_required']);

const notConnected = () => teamFailure('CONNECTION_FAILED', 'team_not_connected');

/**
 * Sends `operation` over `target` (a link with `session` and `client`). `ensureClient(target)` resolves null once
 * `target.client` is set, or the host's failure; `forgetClient(used)` drops the manager's cached copy of `used`.
 * A client another caller dropped in between answers `team_not_connected`, never a thrown TypeError.
 */
async function sendCommand({ target, operation, params, requestId, envelope, ensureClient, forgetClient }) {
  const blocked = await ensureClient(target);
  if (blocked) return blocked;
  const used = target.client;
  if (!used) return notConnected();
  const answer = await target.session.command(operation, params, { client: used, bootEpoch: used.bootEpoch, requestId, envelope });
  if (!(isFailureAnswer(answer) && CLIENT_REASONS.has(answer.error.reason))) return answer;
  // Only the client this call used is dropped: a concurrent call may already have a new one.
  if (target.client === used) target.client = null;
  forgetClient(used);
  const again = await ensureClient(target);
  if (again) return again;
  const next = target.client;
  if (!next) return notConnected();
  // The first attempt was refused at identity, before dispatch, so resending under the caller's id is safe;
  // without one the retry carries a new id. A later resend under the same id replays the stored answer
  // only for chat (the chat store keys member, device and id). An admin mutation's receipt also digests
  // client_id and boot_epoch, so after a new registration it answers request_payload_changed.
  return target.session.command(operation, params, { client: next, bootEpoch: next.bootEpoch, requestId, envelope });
}

module.exports = { CLIENT_REASONS, sendCommand };
