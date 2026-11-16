'use strict';

// The team.model.* commands of model sharing (row 123, slice 6-3; TEAM_MODEL_SHARING_SPEC "Host operations"). A
// family in team-commands.js: the router has validated the closed params schema and run the one authorization
// function for the operation's row (owner and full members only, E55), and team-commands.js has resolved the live
// actor from the connection and taken the member's admin rate-limit token. Each operation then:
//
// - answers the switch's fixed reason first while sharing is off (team-commands.js asks `preflight` before it takes
//   the rate-limit token, so a client polling a host with sharing off spends none) (`team_model_sharing_off`, setting 0) or stopped
//   (`host_unavailable`, host stop and Force local), whatever it names (MI10);
// - passes the relay the actor's member and device from the connection, and `canReceive` and a team offer's
//   receivers from the LIVE directory at the moment of the call, never from the request (a directory that cannot
//   be read answers `host_unavailable`; the relay caps the list at its `maxReceivers`);
// - answers what the relay answers, unchanged: the relay already answers one `team_not_found` for an unknown,
//   expired, malformed or other party's id.
//
// No operation uses the router's receipt (`isRead` is true for all): the relay is idempotent by `request_id` per
// member and offering device (MS6) and by start points on accept, and a receipt would write the display name, file
// names and licence text to command-receipts.json. Nothing here logs: team-commands.js logs the operation and the
// reason word.

const { TEAM_RESOURCE } = require('./engine-routes');
const { RELAY_FAILURES } = require('./model-relay-core');
const { ACTIONS } = require('./operation-registry');

const RECEIVE_ACTION = 'model.receive';
// Team roles that may send and receive models (E55), read from the registry's `model.receive` row: owner and member.
const SHARING_ROLES = Object.freeze(new Set(['owner', 'member', 'read_only'].filter((role) => ACTIONS[RECEIVE_ACTION][role])));

const OPERATIONS = Object.freeze({
  'team.model.offer': ({ relay, actor, params, receivers }) => {
    const list = receivers();
    return list ? relay.offer(actor, params, { receivers: list }) : RELAY_FAILURES.stopped();
  },
  'team.model.withdraw': ({ relay, actor, params }) => relay.withdraw(actor, params.offer_id),
  'team.model.offers': ({ relay, actor, canReceive }) => relay.listOffers(actor, { canReceive: canReceive() }),
  'team.model.offer.read': ({ relay, actor, params, canReceive }) => relay.getOffer(actor, params.offer_id,
    { canReceive: canReceive() }),
  'team.model.accept': ({ relay, actor, params, canReceive }) => relay.accept(actor, params.offer_id,
    { resume: params.resume, canReceive: canReceive() }),
  'team.model.decline': ({ relay, actor, params, canReceive }) => relay.decline(actor, params.offer_id,
    { canReceive: canReceive() }),
  'team.model.pause': ({ relay, actor, params }) => relay.pause(actor, params.transfer_id),
  'team.model.resume': ({ relay, actor, params }) => relay.resume(actor, params.transfer_id),
  'team.model.cancel': ({ relay, actor, params }) => relay.cancel(actor, params.transfer_id),
  'team.model.complete': ({ relay, actor, params }) => relay.complete(actor, params.transfer_id,
    { ok: params.ok, ...(params.reason === undefined ? {} : { reason: params.reason }) }),
});

/**
 * sharing: model-sharing.js's `{ state(), relay() }` (state() answers null while on, else the fixed failure).
 * directory: the live member directory. authorize: the one authorization function.
 */
function createModelCommands({ sharing, directory, authorize }) {
  if (typeof sharing?.state !== 'function' || typeof sharing.relay !== 'function') {
    throw new TypeError('Model commands need the model sharing state.');
  }
  if (typeof directory?.activeMemberIds !== 'function' || typeof directory.memberActor !== 'function') {
    throw new TypeError('Model commands need the member directory.');
  }
  if (typeof authorize !== 'function') throw new TypeError('Model commands need the authorize function.');

  // May this device receive now: the receive row through the one function, read live (a degraded directory or a
  // demotion answers false). Any throw is false.
  const mayReceive = (deviceId) => {
    try {
      return authorize({ device_id: deviceId }, RECEIVE_ACTION, TEAM_RESOURCE).ok === true;
    } catch {
      return false;
    }
  };

  // The active members who may receive a model now, without the sender: a team offer's audience, and the only
  // members a direct offer may name. null when the directory cannot be read.
  const receiversFor = (senderMemberId) => {
    try {
      return directory.activeMemberIds()
        .filter((memberId) => memberId !== senderMemberId && SHARING_ROLES.has(directory.memberActor(memberId)?.role));
    } catch {
      return null;
    }
  };

  const handles = (operation) => typeof operation === 'string' && Object.hasOwn(OPERATIONS, operation);

  // call: team-commands.js's { params, actor: { member_id, owner, device_id } } (the live actor).
  function dispatch(command, call) {
    const operation = command?.operation;
    if (!handles(operation)) return null;
    const off = sharing.state();
    if (off) return off;
    const actor = { memberId: call.actor.member_id, deviceId: call.actor.device_id };
    return OPERATIONS[operation]({
      relay: sharing.relay(), actor, params: call.params,
      canReceive: () => mayReceive(actor.deviceId), receivers: () => receiversFor(actor.memberId),
    });
  }

  // The switch's fixed refusal, asked by team-commands.js before the rate-limit token; null while sharing is on.
  const preflight = () => sharing.state();

  return Object.freeze({ handles, isRead: handles, dispatch, preflight });
}

module.exports = { SHARING_ROLES, createModelCommands };
