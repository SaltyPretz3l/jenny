'use strict';

// Model sharing on the team host (row 123, slice 6-3; TEAM_MODEL_SHARING_SPEC "6-3 as built"), built once by
// team-main.js: the in-memory relay (model-relay.js), the command family (model-commands.js), the two part routes
// (model-routes.js), the events sink, the lifecycle hooks, the one sweep timer and the switches.
//
// - The setting `team.model_relay_flowing` (config.js, 0 to 4, default 2) is the relay's flowing limit; 0 is
//   sharing off on this host: no relay exists, no timer runs, no event goes out, and every operation and part route
//   answers `team_model_sharing_off` (MI10). `setFlowingLimit(n)` changes it in place: to 0 the relay's own
//   `setFlowingLimit(0)` ends everything as `sharing_off` (those end events are the last) and the relay is dropped;
//   from 0 a fresh relay starts; otherwise the relay's `setFlowingLimit(n)`. The host has no live config reload,
//   so today a changed setting reaches it at the next host start; the method is the seam a setting path calls.
// - Host stop and Force local (E64, which stops the team host on this PC) run team-main's teardown, whose
//   unsubscribe list holds `dispose()` (registered by `attach`): the relay's `dispose()` ends everything as
//   `host_stopping`, the sweep timer is cleared, and every later call answers `host_unavailable`.
// - Events: the relay's `onEvents(list)` sink publishes each entry as a publisher-scoped type (event-scope.js) to
//   the entry's audience only, live only (`ephemeral`: nothing is replayed; a reconnecting client lists offers),
//   under the #team channel's chat bucket, which every active member's stream admits without a new bucketless type
//   (the team_deleted precedent). The sink never throws into the relay.
// - Lifecycle (attach): a member revoked or leaving (`member_revoked`) -> `memberGone`; `role_changed` ->
//   `roleChanged(memberId, role is owner or member)`; `device_revoked` -> each live transfer that device was
//   receiving is cancelled as its receiver (`cancelled_by_receiver`), so a queued transfer no device can take stops
//   counting toward the member's live transfers, and each offer that device made is withdrawn (an offer is withdrawn
//   only by the device that made it, and that device is gone). A hook that throws is logged and never reaches the store.
// - Device presence comes from the one signal the host has, the team HTTP layer's member event-stream open and
//   close (`onMemberStream`, also heard by chat presence and the viewers): the first open of a device ->
//   `deviceBack`, its last close -> `deviceGone`, counted per device for at most 64 devices. A device first seen
//   while 64 are counted is ignored until all its streams close (fail open: it is never seen as gone, and the
//   dropped opens are counted in resources()). A device that offers with no stream counted is gone from the start.
// - One sweep timer, unref'd, every quarter of the smallest relay timeout (15 s with the default limits), only
//   while the relay is on.
// - Logs: event names, counts and reason words; the relay keeps names, hashes and provenance out of its own.

const crypto = require('node:crypto');

const { hostFailure } = require('../api-contract');
const { chatBucket } = require('./authorize');
const { SHARING_ROLES, createModelCommands } = require('./model-commands');
const { MODEL_TRANSFER_LIMITS } = require('./model-manifest');
const { createModelRelay } = require('./model-relay');
const { LIVE } = require('./model-relay-core');
const { createModelRoutes } = require('./model-routes');
const { safeLogger } = require('./safe-logger');
const { TEAM_CHANNEL } = require('./team-deleted-notice');

const DEVICE_STREAMS_MAX = 64;
const TIMERS = Object.freeze({ setInterval, clearInterval });

/** A quarter of the smallest timeout the relay settles on its clock. */
function sweepPeriodMs(limits) {
  return Math.max(1, Math.floor(Math.min(limits.pauseIdleMs, limits.senderGraceMs, limits.forgetIdleMs,
    limits.directOfferLifeMs) / 4));
}

/**
 * One member-stream hook for the listener's context. hooks: `{ name: { onMemberStream } }`, checked here; every
 * hook hears each open and close, and one that throws is logged by its name while the next still hears it.
 */
function memberStreamFanOut(hooks, logger = null) {
  const entries = Object.entries(hooks ?? {});
  for (const [name, hook] of entries) {
    if (typeof hook?.onMemberStream !== 'function') throw new TypeError(`Member stream hook ${name} has no onMemberStream.`);
  }
  const say = safeLogger(logger);
  return (memberId, deviceId, change) => {
    for (const [name, hook] of entries) {
      try { hook.onMemberStream(memberId, deviceId, change); } catch { say('WARN', 'team.member_stream_hook_failed', { hook: name }); }
    }
  };
}

/**
 * flowing: the setting (0 to limits.maxFlowingPerHost; undefined is the default). store: the member store (its live
 * directory and membership events). authorize: the one function. publish(type, payload, options): the host's event
 * publish. createRelay and hostPartRequests are seams for tests.
 */
function createTeamModelSharing({
  flowing = MODEL_TRANSFER_LIMITS.flowingPerHost, store, authorize, publish, logger = null, clock = Date.now,
  randomBytes = crypto.randomBytes, limits = MODEL_TRANSFER_LIMITS, timers = TIMERS, createRelay = createModelRelay,
  hostPartRequests,
} = {}) {
  if (typeof publish !== 'function') throw new TypeError('Model sharing needs a publish function.');
  if (typeof store?.onMembershipChange !== 'function') throw new TypeError('Model sharing needs the member store.');
  const say = safeLogger(logger);
  const validLimit = (n) => Number.isSafeInteger(n) && n >= 0 && n <= limits.maxFlowingPerHost;
  if (!validLimit(flowing)) throw new RangeError('team_model_relay_flowing_invalid');
  let relay = null;
  let sweepTimer = null;
  let disposed = false;
  // Nothing starts before attach (team-main attaches once the host core exists), so a start that fails earlier
  // leaves no relay and no timer; until then `desired` holds the setting.
  let attached = false;
  let desired = flowing;
  // device id -> open member streams (the presence signal's count), and the devices ignored at the cap.
  const streams = new Map();
  const ignored = new Map();
  let droppedOpens = 0;

  function sink(list) {
    for (const entry of list) {
      try {
        publish(entry.type, entry.payload, { audience: new Set(entry.audience), bucket: chatBucket(TEAM_CHANNEL),
          ephemeral: true });
      } catch {
        say('WARN', 'team_model.publish_failed', { event_type: entry.type });
      }
    }
  }

  function start(n) {
    relay = createRelay({ clock, randomBytes, limits: { ...limits, flowingPerHost: n }, logger, onEvents: sink });
    sweepTimer = timers.setInterval(() => { try { relay?.sweep(); } catch { say('WARN', 'team_model.sweep_failed'); } },
      sweepPeriodMs(limits));
    sweepTimer?.unref?.();
    say('INFO', 'team_model.sharing_on', { flowing: n });
  }

  // `off`: the setting went to 0 (sharing_off); otherwise host stop (host_stopping).
  function stopRelay(off) {
    if (sweepTimer !== null) timers.clearInterval(sweepTimer);
    sweepTimer = null;
    const current = relay;
    relay = null;
    if (!current) return;
    if (off) current.setFlowingLimit(0);
    current.dispose();
    say('INFO', 'team_model.sharing_stopped', { reason: off ? 'sharing_off' : 'host_stopping' });
  }

  // null while sharing is on, else the fixed refusal every operation and route answers.
  const state = () => {
    if (disposed) return hostFailure('unavailable', 'host_unavailable');
    return relay ? null : hostFailure('unavailable', 'team_model_sharing_off');
  };
  const access = Object.freeze({ state, relay: () => relay });

  function setFlowingLimit(n) {
    if (disposed) return hostFailure('unavailable', 'host_unavailable');
    if (!validLimit(n)) return hostFailure('invalid', 'team_model_request_invalid');
    desired = n;
    if (!attached) return { ok: true };
    if (n === 0) stopRelay(true);
    else if (!relay) start(n);
    else return relay.setFlowingLimit(n);
    return { ok: true };
  }

  function dispose() {
    if (disposed) return;
    stopRelay(false);
    disposed = true;
    streams.clear();
    ignored.clear();
  }

  function onMemberStream(_memberId, deviceId, change) {
    if (disposed || typeof deviceId !== 'string') return;
    const table = ignored.has(deviceId) ? ignored : streams;
    const count = table.get(deviceId) ?? 0;
    if (change === 'open') {
      if (table === streams && count === 0 && streams.size >= DEVICE_STREAMS_MAX) {
        ignored.set(deviceId, 1);
        droppedOpens += 1;
        return;
      }
      if (table === ignored) droppedOpens += 1;
      table.set(deviceId, count + 1);
      if (table === streams && count === 0) relay?.deviceBack(deviceId);
    } else if (change === 'close' && count > 0) {
      if (count > 1) { table.set(deviceId, count - 1); return; }
      table.delete(deviceId);
      if (table === streams) relay?.deviceGone(deviceId);
    }
  }

  // An offering device with no stream counted (and the table not full): gone from the start, so its offer ends
  // after the sender grace unless a stream opens.
  function offeredFrom(deviceId) {
    if (!relay || typeof deviceId !== 'string' || streams.has(deviceId) || ignored.has(deviceId)) return;
    if (streams.size < DEVICE_STREAMS_MAX) relay.deviceGone(deviceId);
  }

  // A revoked device's live transfers as receiver end as cancelled by the receiver, and the offers it made are
  // withdrawn. The member's offers are all listed to the device; `withdraw` answers not-found for one another device
  // of the member made, so only this device's go.
  function endDevices(memberId, deviceIds) {
    for (const deviceId of deviceIds) {
      const actor = { memberId, deviceId };
      const listed = relay.listOffers(actor);
      if (!listed.ok) continue;
      for (const view of listed.transfers) {
        if (view.receiver_member_id === memberId && LIVE.has(view.state)) relay.cancel(actor, view.transfer_id);
      }
      for (const offer of listed.offers) {
        if (offer.sender_member_id === memberId) relay.withdraw(actor, offer.offer_id);
      }
    }
  }

  // The membership hooks and the teardown entry; team-main runs the returned functions at stop.
  function attach() {
    if (attached || disposed) return [];
    attached = true;
    if (desired > 0) start(desired);
    const unsubscribe = store.onMembershipChange((event) => {
      if (!relay) return;
      try {
        if (event.kind === 'member_revoked') relay.memberGone(event.member_id);
        else if (event.kind === 'role_changed') relay.roleChanged(event.member_id, SHARING_ROLES.has(event.role));
        else if (event.kind === 'device_revoked') endDevices(event.member_id, event.device_ids);
      } catch {
        say('WARN', 'team_model.hook_failed', { event_kind: event.kind });
      }
    });
    return [unsubscribe, dispose];
  }

  const family = createModelCommands({ sharing: access, directory: store.directory, authorize });
  const commands = Object.freeze({
    ...family,
    dispatch(command, call) {
      const answer = family.dispatch(command, call);
      if (command?.operation === 'team.model.offer' && answer?.ok === true) offeredFrom(call.actor.device_id);
      return answer;
    },
  });
  const routes = createModelRoutes({ sharing: access, limits, logger, clock, timers,
    ...(hostPartRequests === undefined ? {} : { hostRequests: hostPartRequests }) });

  return Object.freeze({
    commands, routes, attach, onMemberStream, setFlowingLimit, dispose,
    resources: () => ({ on: relay !== null, disposed, sweepTimers: sweepTimer === null ? 0 : 1,
      relay: relay ? relay.resources() : null, routes: routes.resources(), devices: streams.size,
      ignoredDevices: ignored.size, droppedOpens }),
  });
}

module.exports = { createTeamModelSharing, memberStreamFanOut, sweepPeriodMs };
