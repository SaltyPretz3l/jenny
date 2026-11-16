'use strict';

const { hostFailure } = require('./api-contract');
const { runningTurn } = require('./team/turn-starter');

/**
 * The control lease handlers (`control.acquire`, `control.heartbeat`,
 * `control.release`), moved out of command-router.js (slice 3-7). The router
 * hands in what they need and keeps one line per handler; every handler starts
 * with the router's identity check.
 *
 * On a team host (slice 3-7) the lease names the member who drives, from the
 * authenticated actor (`trustedAuthor`), and `control_changed` carries it. The
 * turn rule guards the turn, not the lease: while a turn runs, an acquire that
 * would make the caller the holder goes through only for the member who
 * started that turn or a caller the one authorization function allows
 * `session.takeover_running`; anyone else gets `control_turn_active`, not
 * retryable (the person decides when to try again). The single-owner host has
 * neither: `trustedAuthor` answers undefined there and there is no turn rule.
 */
function createControlHandlers({ leases, identity, allows, teamHost, trustedAuthor, backend, hasSession, publish }) {
  // The turn rule: null when the acquire may go on. It asks only when the acquire would make the caller the holder
  // (a free conversation, or a takeover) and the caller is not already the holder (a re-acquire is a heartbeat).
  function turnRefusal(command, context, memberId) {
    if (!teamHost) return null;
    const current = leases.get(command.session_id);
    if (current && (command.params.takeover !== true
      || (current.client_id === command.client_id && current.device_id === context.deviceId))) return null;
    const turn = runningTurn(backend, command.session_id); // the shared read (server/team/turn-starter.js)
    if (!turn || (turn.starter !== null && turn.starter === memberId)) return null;
    if (allows(command, context, 'session.takeover_running', { kind: 'session', id: command.session_id })) return null;
    return hostFailure('conflict', 'control_turn_active', command.request_id);
  }

  async function acquire(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!hasSession(command.session_id)) return hostFailure('conflict', 'session_not_found', command.request_id);
    const author = trustedAuthor(context);
    if (author === null) return hostFailure('forbidden', 'member_author_required', command.request_id);
    const memberId = author?.member_id;
    const refused = turnRefusal(command, context, memberId);
    if (refused) return refused;
    const lease = leases.acquire(command.session_id, command.client_id, context.deviceId,
      command.params.takeover === true, memberId);
    if (!lease) return hostFailure('conflict', 'control_lease_unavailable', command.request_id, true);
    publish('control_changed', {
      session_id: command.session_id,
      client_id: lease.client_id,
      ...(lease.member_id !== undefined ? { member_id: lease.member_id } : {}),
      generation: lease.generation,
      expires_at: lease.expires_at,
    });
    return { ok: true, lease };
  }

  async function heartbeat(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!Number.isSafeInteger(command.control_generation)) {
      return hostFailure('forbidden', 'control_generation_required', command.request_id);
    }
    const lease = leases.heartbeat(command.session_id, command.client_id, context.deviceId, command.control_generation);
    if (!lease) return hostFailure('forbidden', 'control_lease_required', command.request_id);
    return { ok: true, lease };
  }

  async function release(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    if (!Number.isSafeInteger(command.control_generation)) {
      return hostFailure('forbidden', 'control_generation_required', command.request_id);
    }
    if (!leases.release(command.session_id, command.client_id, context.deviceId, command.control_generation)) {
      return hostFailure('forbidden', 'control_lease_required', command.request_id);
    }
    publish('control_changed', { session_id: command.session_id, state: 'released' });
    return { ok: true, released: true };
  }

  return Object.freeze({ acquire, heartbeat, release });
}

module.exports = { createControlHandlers };
