'use strict';

// The raw-route chokepoint. The HTTP layer builds one guard per request with the
// request's actor; each route calls routeDenial() before it reads and again after
// every awaited step, so a revocation or demotion during an await answers a
// denial and never the data.

const { hostFailure } = require('../api-contract');
const { getSingleOwnerAuthorizer, singleOwnerActor } = require('./authorize');

function createRouteGuard({ authorize, actor, requestId = '' } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('Route guard requires an authorize function.');
  return (action, resource) => authorize(actor, action, resource, requestId);
}

// Guard for the single-owner host: the constant owner actor through the same
// function, so there is never a second code path.
function createSingleOwnerGuard(deviceId, requestId = '') {
  return createRouteGuard({
    authorize: getSingleOwnerAuthorizer().authorize, actor: singleOwnerActor(deviceId), requestId,
  });
}

// A context from the HTTP layer carries `guard`. A context with an actor but no
// guard, or with a guard that throws, denies. A context with neither (a route
// called directly with just a device id) is the single-owner host, and only when
// the routes were not built with `guardRequired`: a team host builds them with
// it, so a context that lost its guard there denies instead of becoming the owner.
function resolveGuard(ctx, guardRequired = false) {
  if (typeof ctx?.guard === 'function') return ctx.guard;
  if (!guardRequired && ctx?.actor === undefined && typeof ctx?.deviceId === 'string' && ctx.deviceId) {
    return createSingleOwnerGuard(ctx.deviceId, ctx.requestId);
  }
  return null;
}

/** Returns null when the actor may do `action` on `resource`, else a hostFailure. */
function routeDenial(ctx, action, resource, { guardRequired = false } = {}) {
  const guard = resolveGuard(ctx, guardRequired);
  if (!guard) return hostFailure('forbidden', 'role_forbidden', ctx?.requestId);
  let verdict;
  try { verdict = guard(action, resource); } catch (_error) { verdict = null; }
  if (verdict && verdict.ok === true) return null;
  return verdict && verdict.ok === false && verdict.error
    ? verdict : hostFailure('forbidden', 'role_forbidden', ctx?.requestId);
}

/**
 * For one route set: returns denied(ctx, action, resource), which is true once the
 * denial has been sent with `send`. A team host passes `guardRequired`.
 */
function createRouteDenier({ guardRequired = false, send }) {
  return (ctx, action, resource) => {
    const failure = routeDenial(ctx, action, resource, { guardRequired });
    if (failure) send(ctx.response, failure, ctx.requestId);
    return failure !== null;
  };
}

module.exports = { createRouteDenier, createRouteGuard, createSingleOwnerGuard, resolveGuard, routeDenial };
