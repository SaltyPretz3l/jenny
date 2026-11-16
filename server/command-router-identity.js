'use strict';

const { hostFailure } = require('./api-contract');
const { getSingleOwnerAuthorizer, singleOwnerActor } = require('./team/authorize');
const { TEAM_HOST_REFUSED_OPERATIONS, resolveCommand } = require('./team/operation-registry');

// The mode is fixed when the router is built, never per request: a router given
// an `authorize` function is a team host and requires `context.actor`; a router
// given none is the single-owner host, whose constant owner actor goes through
// the same function. A team host that forgets the actor denies. Only an omitted
// `authorize` is the single-owner host: one that is present but not a function
// (null, an object in place of its function) throws, never reads as the owner.
function modeFor(authorize) {
  if (authorize !== undefined && typeof authorize !== 'function') {
    throw new TypeError('An authorize given to the command router must be a function.');
  }
  const singleOwner = authorize === undefined;
  return {
    team: !singleOwner,
    check: singleOwner ? getSingleOwnerAuthorizer().authorize : authorize,
    actorOf: (context) => (singleOwner ? singleOwnerActor(context.deviceId) : context.actor),
  };
}

/**
 * Build the router's identity check: the authenticated client, the boot epoch,
 * and then the one authorization function with the actor's live role, for every
 * resource the command names (slice 3-2: project.assign also names its target).
 * Every dispatcher calls it before and after each await, so each call
 * re-authorizes.
 */
function createIdentityCheck({ clients, bootEpoch, disposed, authorize }) {
  const { team, check, actorOf } = modeFor(authorize);
  return function identity(command, context) {
    if (disposed.value) return hostFailure('unavailable', 'router_disposed', command.request_id);
    let authenticated;
    try {
      authenticated = typeof context?.isAuthenticated === 'function'
        ? context.isAuthenticated() === true : context?.isAuthenticated === true;
    } catch (_error) { authenticated = false; }
    if (!context || !authenticated
      || typeof context.deviceId !== 'string' || !context.deviceId
      || !clients.authorize(command.client_id, context.clientToken, context.deviceId)) {
      return hostFailure('unauthorized', 'client_unauthorized', command.request_id);
    }
    if (command.boot_epoch !== bootEpoch) return hostFailure('conflict', 'boot_epoch_mismatch', command.request_id, true);
    // A team host refuses these for everyone, before any handler or receipt (slice 3-4a).
    if (team && TEAM_HOST_REFUSED_OPERATIONS.includes(command.operation)) {
      return hostFailure('invalid', 'unsupported_operation', command.request_id);
    }
    const actor = actorOf(context);
    const wanted = resolveCommand(command);
    // The actor must be the device this request is authenticated as.
    if (!wanted || actor?.device_id !== context.deviceId) return hostFailure('forbidden', 'role_forbidden', command.request_id);
    for (const resource of wanted.resources) {
      const verdict = check(actor, wanted.action, resource, command.request_id);
      if (verdict.ok !== true) return verdict;
    }
    return null;
  };
}

/**
 * The per-row check behind the list and runtime filters (slice 3-2): whether the
 * command's actor may do `action` on one more resource, through the same
 * function. It assumes the identity check already passed for this command and
 * answers false for anything it cannot decide.
 */
function createAccessCheck({ authorize }) {
  const { check, actorOf } = modeFor(authorize);
  return function allows(command, context, action, resource) {
    try {
      if (typeof context?.deviceId !== 'string' || !context.deviceId) return false;
      const actor = actorOf(context);
      if (actor?.device_id !== context.deviceId) return false;
      return check(actor, action, resource, command?.request_id)?.ok === true;
    } catch (_error) { return false; }
  };
}

module.exports = { createAccessCheck, createIdentityCheck };
