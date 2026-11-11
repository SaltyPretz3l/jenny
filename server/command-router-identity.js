'use strict';

const { hostFailure } = require('./api-contract');
const { getSingleOwnerAuthorizer, singleOwnerActor } = require('./team/authorize');
const { resolveCommand } = require('./team/operation-registry');

/**
 * Build the router's identity check: the authenticated client, the boot epoch,
 * and then the one authorization function with the actor's live role. Every
 * dispatcher calls it before and after each await, so each call re-authorizes.
 * The mode is fixed when the router is built, never per request: a router given
 * an `authorize` function is a team host and requires `context.actor`; a router
 * given none is the single-owner host, whose constant owner actor goes through
 * the same function. A team host that forgets the actor denies.
 */
function createIdentityCheck({ clients, bootEpoch, disposed, authorize }) {
  const singleOwner = typeof authorize !== 'function';
  const check = singleOwner ? getSingleOwnerAuthorizer().authorize : authorize;
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
    const actor = singleOwner ? singleOwnerActor(context.deviceId) : context.actor;
    const wanted = resolveCommand(command);
    // The actor must be the device this request is authenticated as.
    if (!wanted || actor?.device_id !== context.deviceId) return hostFailure('forbidden', 'role_forbidden', command.request_id);
    const verdict = check(actor, wanted.action, wanted.resource, command.request_id);
    return verdict.ok === true ? null : verdict;
  };
}

module.exports = { createIdentityCheck };
