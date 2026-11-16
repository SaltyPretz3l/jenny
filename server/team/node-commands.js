'use strict';

// The team.node.* commands (slice 4c host; spec "4c host as built"). The node is always
// the caller's device, never a parameter: the live actor of the request's device is
// resolved and authorized before anything else, then that device's node is found.
//
// A claim that finds nothing may wait for its node's next queued job. The waiter
// listens for its request's close (`context.onClose`, which the team HTTP layer hands
// over; the single-owner host has none) and leaves at once when it fires; after any
// wake, a closed request claims nothing. A client that vanishes without its socket
// closing is seen only at the timeout.
//
// Slice 4e: a list row also carries the PC's name (the device label, never the device
// id), and the list answers the team model (the owner's stored choice, or null for
// Automatic) and what Automatic means now. `team_pool_nodes` carries the same answer to
// every active member whenever it changes, at most once a second, the latest state
// winning; it is ephemeral and its timer and feed listener end at dispose(). Besides the
// pool's change feed, a register, pause or unregister asks for it too (a node that
// registers again with other models and the same slots changes no count the feed
// watches); the publisher drops a list that did not change.

const { hostFailure } = require('../api-contract');
const { automaticModel } = require('./automatic-model');
const { TEAM_RESOURCE } = require('./engine-routes');
const { isId } = require('./ids');
const { safeLogger } = require('./safe-logger');

const NODE_PROTOCOL_VERSION = 1;
const NODE_SHARE_ACTION = 'node.share';
const NODE_LIST_ACTION = 'node.list';
const MAX_WAITING_CLAIMS = 16;
const OPERATIONS = Object.freeze(new Set(['team.node.register', 'team.node.claim', 'team.node.fail',
  'team.node.pause', 'team.node.unregister', 'team.node.list']));
// The commands that may change a list row: each asks for team_pool_nodes once it succeeded.
const ANNOUNCING = Object.freeze(new Set(['team.node.register', 'team.node.pause', 'team.node.unregister']));

const RATE_WINDOW_MS = 60_000;
const CLAIMS_PER_SLOT = 60;
const RATE_MAX_NODES = 32;
const monotonic = () => Math.round(performance.now());
const unavailable = () => hostFailure('unavailable', 'team_pool_unavailable');
const nodeNotFound = () => hostFailure('forbidden', 'node_not_found');

// Per-node fixed windows: 60 claims (request reads count as claims) and 600 chunk POSTs
// a minute a slot. At most 32 nodes a kind; a node's windows are dropped at unregister,
// expired ones before a new node is refused. A clock that went back starts a new window.
function createNodeRates({ chunkPerSlot = 600, clock = monotonic } = {}) {
  const perSlot = { claim: CLAIMS_PER_SLOT, chunk: chunkPerSlot };
  const tables = { claim: new Map(), chunk: new Map() };
  const expired = (entry, now) => now < entry.startedAt || now - entry.startedAt >= RATE_WINDOW_MS;

  function take(kind, nodeId, slots) {
    const table = tables[kind];
    const now = clock();
    let entry = table.get(nodeId);
    if (entry && expired(entry, now)) entry = undefined;
    if (!entry) {
      if (!table.has(nodeId) && table.size >= RATE_MAX_NODES) {
        for (const [key, value] of table) if (expired(value, now)) table.delete(key);
        if (table.size >= RATE_MAX_NODES) return false;
      }
      entry = { startedAt: now, count: 0 };
      table.set(nodeId, entry);
    }
    if (entry.count >= perSlot[kind] * slots) return false;
    entry.count += 1;
    return true;
  }

  return Object.freeze({
    take,
    forget(nodeId) { tables.claim.delete(nodeId); tables.chunk.delete(nodeId); },
    size: () => tables.claim.size + tables.chunk.size,
  });
}

// What every active member may see of a node: no device id, nothing about a job or a lease.
// `label` is the PC's name as the member gave it (null when it is not known).
function publicNode(view, label = null) {
  return { node_id: view.node_id, member_id: view.member_id, label: typeof label === 'string' ? label : null,
    online: view.online, paused: view.paused, owner_busy: view.owner_busy === true, busy_slots: view.busy_slots, slots: view.slots,
    models: view.models.map((entry) => ({ name: entry.id, context_length: entry.context_length, vision: entry.vision,
      thinking: entry.thinking })) };
}

// The view of the node `deviceId` registered, or null. Shared with node-routes.js.
function ownNode(scheduler, deviceId) {
  const nodeId = scheduler.nodeIdForDevice(deviceId);
  return nodeId ? scheduler.listNodes().find((view) => view.node_id === nodeId) || null : null;
}

// `pool()` answers the pool composition or null (no `pool` block, or not built yet);
// only its `scheduler` is used. `authorize(actor, action, resource)` is the host's one
// authorization function.
// `names()` answers { labels: Map of device id to PC name, team_model } (the member store's
// poolNames(), one read per answer; null when unknown), and `publish(type, payload, options)` sends
// `team_pool_nodes` (the team host's BackendEvents publish).
function createTeamNodeCommands({ pool = () => null, directory, authorize, rates = createNodeRates(), logger = null,
  maxWaiting = MAX_WAITING_CLAIMS, names = () => null, publish = null,
  timers = { setTimeout, clearTimeout }, clock = Date.now } = {}) {
  if (typeof pool !== 'function') throw new TypeError('Node commands need a pool reader.');
  if (!directory || typeof directory.liveActor !== 'function') throw new TypeError('Node commands need a directory.');
  if (typeof authorize !== 'function') throw new TypeError('Node commands need the authorization function.');
  if (!rates || typeof rates.take !== 'function' || typeof rates.forget !== 'function') {
    throw new TypeError('Node commands need node rates.');
  }
  if (!Number.isSafeInteger(maxWaiting) || maxWaiting < 1 || maxWaiting > MAX_WAITING_CLAIMS) {
    throw new RangeError(`maxWaiting must be from 1 to ${MAX_WAITING_CLAIMS}.`);
  }
  const log = safeLogger(logger);
  const waiters = new Set(); // { nodeId, timer, wake }, at most maxWaiting
  let unsubscribe = null; // the one scheduler listener, held only while a claim waits
  let disposed = false;
  // team_pool_nodes: the feed listener, the coalescing timer and the last state published.
  let unwatch = null;
  let announceTimer = null;
  let announcedAt = -Infinity;
  let announced = '';
  // The names of the hardware seen this run (node id -> owner and PC name), bounded: the usage read
  // names the hardware a row was served on with it.
  const seen = new Map();
  const MAX_SEEN = 64;

  function safe(fn, fallback) { try { return fn(); } catch (_error) { return fallback; } }
  // A PC's name from one names() read, or null.
  function labelIn(read, deviceId) {
    const label = safe(() => read?.labels?.get(deviceId), null);
    return typeof label === 'string' ? label : null;
  }

  // The list every active member sees: the rows, the stored team model and what Automatic means now.
  function listAnswer(scheduler) {
    const views = scheduler.listNodes();
    const read = safe(() => names(), null);
    const nodes = views.map((view) => {
      const label = labelIn(read, view.device_id);
      seen.delete(view.node_id);
      seen.set(view.node_id, { member_id: view.member_id, label });
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
      return publicNode(view, label);
    });
    const stored = read?.team_model;
    return { ok: true, nodes, team_model: typeof stored === 'string' ? stored : null, automatic_model: automaticModel(views) };
  }

  // Publishes the list when it changed: at most once a second, and the state read when the timer fires.
  function flushAnnounce() {
    announceTimer = null;
    const scheduler = schedulerOf();
    if (!scheduler || typeof publish !== 'function') return;
    const { ok: _ok, ...payload } = listAnswer(scheduler);
    const text = JSON.stringify(payload);
    if (text === announced) return;
    let audience;
    try { audience = new Set(directory.activeMemberIds()); } catch (_error) { return; }
    announced = text;
    announcedAt = clock();
    try { publish('team_pool_nodes', payload, { audience, ephemeral: true }); } catch (_error) {
      log('WARN', 'team.node.announce_failed', {});
    }
  }

  function announce() {
    if (disposed || announceTimer !== null || typeof publish !== 'function') return;
    const wait = Math.max(0, Math.min(1000, 1000 - (clock() - announcedAt)));
    announceTimer = timers.setTimeout(flushAnnounce, Number.isFinite(wait) ? wait : 0);
    announceTimer?.unref?.();
  }

  // Follows the pool's change feed once the pool exists (team-main calls it after the pool starts).
  function watch() {
    const scheduler = schedulerOf();
    if (!scheduler || unwatch || typeof publish !== 'function') return false;
    unwatch = scheduler.onChange(() => announce());
    return true;
  }

  function schedulerOf() {
    if (disposed) return null;
    let current;
    try { current = pool(); } catch (_error) { current = null; }
    return current && current.scheduler && typeof current.scheduler.claim === 'function' ? current.scheduler : null;
  }

  // The live actor of `deviceId`, allowed `action`; else { failure }. A missing, pending or
  // revoked actor, or an invite principal, is refused before anything else.
  function caller(deviceId, action) {
    let live;
    try { live = directory.liveActor(deviceId); } catch (_error) { live = null; }
    if (!live || live.state !== 'active' || live.device_id !== deviceId || !isId('member', live.member_id)) {
      return { failure: hostFailure('forbidden', 'role_forbidden') };
    }
    let verdict;
    try { verdict = authorize({ device_id: deviceId }, action, TEAM_RESOURCE); } catch (_error) { verdict = null; }
    if (!verdict || verdict.ok !== true) {
      const refused = verdict?.ok === false && typeof verdict.error?.reason === 'string' ? verdict.error.reason : 'role_forbidden';
      return { failure: hostFailure('forbidden', refused) };
    }
    return { live };
  }

  // ----------------------------------------------------------- the long poll

  function wake(nodeId, why) {
    for (const waiter of [...waiters]) if (nodeId === null || waiter.nodeId === nodeId) waiter.wake(why);
  }

  function onFeed(event) {
    if (event?.type === 'job' && event.to === 'queued') wake(event.node_id, 'job');
  }

  function release() {
    if (waiters.size > 0 || !unsubscribe) return;
    const stop = unsubscribe;
    unsubscribe = null;
    try { stop(); } catch (_error) { /* the scheduler is gone */ }
  }

  // Resolves 'job', 'timeout', 'gone', 'closed' or 'disposed'. Registered synchronously
  // after the first claim, so no queued event can fall between that claim and the listener.
  function waitForJob(scheduler, nodeId, ms, onClose) {
    return new Promise((resolve) => {
      const waiter = { nodeId, timer: null, wake: null };
      let unlisten = null;
      waiter.wake = (why) => {
        if (!waiters.delete(waiter)) return;
        clearTimeout(waiter.timer);
        waiter.timer = null;
        if (unlisten) { try { unlisten(); } catch (_error) { /* the request is gone */ } }
        release();
        resolve(why);
      };
      waiters.add(waiter);
      waiter.timer = setTimeout(() => waiter.wake('timeout'), ms);
      waiter.timer.unref?.();
      if (typeof onClose === 'function') {
        try { unlisten = onClose(() => waiter.wake('closed')); } catch (_error) { waiter.wake('closed'); }
      }
      if (!unsubscribe && waiters.has(waiter)) {
        try { unsubscribe = scheduler.onChange(onFeed); } catch (_error) {
          log('WARN', 'team.node.listener_refused', {});
          waiter.wake('timeout');
        }
      }
    });
  }

  async function claim(params, live, scheduler, context) {
    const node = ownNode(scheduler, live.device_id);
    if (!node) return nodeNotFound();
    if (!rates.take('claim', node.node_id, node.slots)) return hostFailure('limit', 'node_rate_limit');
    const first = scheduler.claim(node.node_id, params.claim_seq);
    if (!first.ok || first.job || params.wait_ms === 0) return first;
    const mine = [...waiters].filter((waiter) => waiter.nodeId === node.node_id).length;
    if (mine >= node.slots || waiters.size >= maxWaiting) return { ok: true, job: null };
    const why = await waitForJob(scheduler, node.node_id, params.wait_ms, context?.onClose);
    // Nobody reads the answer of a closed request, so it claims nothing; nor does a disposed one.
    if (why === 'closed' || why === 'disposed') return { ok: true, job: null };
    // Revoked, demoted or unregistered while waiting: refused, and nothing is claimed for them.
    const again = caller(context?.deviceId, NODE_SHARE_ACTION);
    if (again.failure) return again.failure;
    const current = schedulerOf();
    if (!current) return unavailable();
    if (current.nodeIdForDevice(again.live.device_id) !== node.node_id) return nodeNotFound();
    return current.claim(node.node_id, params.claim_seq);
  }

  // Removes a node, its rate windows and its waiters.
  function dropNode(scheduler, nodeId) {
    const removed = scheduler.unregisterNode(nodeId);
    if (!removed.ok) return removed;
    rates.forget(nodeId);
    wake(nodeId, 'gone');
    return { ok: true };
  }

  // ----------------------------------------------------------- handlers

  // The caller's node id, or null; `fail`, `pause` and `unregister` need no more.
  const nodeIdOf = (scheduler, live) => scheduler.nodeIdForDevice(live.device_id);

  const HANDLERS = {
    'team.node.register': (params, live, scheduler) => {
      if (params.protocol_version !== NODE_PROTOCOL_VERSION) return hostFailure('conflict', 'node_version_mismatch');
      // engine.kind and engine.version are advertised, checked by the schema and not stored (N11).
      const models = params.models.map((entry) => ({ id: entry.name, context_length: entry.context_length,
        vision: entry.vision, thinking: entry.thinking }));
      const registered = scheduler.registerNode({ deviceId: live.device_id, memberId: live.member_id,
        slots: params.slots, models });
      if (!registered.ok) return registered;
      const expires = scheduler.limits.nodeContactMs;
      return { ok: true, node_id: registered.node_id, heartbeat_ms: Math.max(1, Math.floor(expires / 3)), expires_ms: expires };
    },
    'team.node.claim': claim,
    'team.node.fail': (params, live, scheduler) => {
      const nodeId = nodeIdOf(scheduler, live);
      return nodeId ? scheduler.failJob(params.job_id, nodeId, params.reason) : nodeNotFound();
    },
    'team.node.pause': (params, live, scheduler) => {
      const nodeId = nodeIdOf(scheduler, live);
      if (!nodeId) return nodeNotFound();
      // E76: a node's own pause for its member's work names no stop_running; a pause the member sets always does.
      const ownerBusy = params.on === true && params.stop_running === undefined;
      const paused = scheduler.setNodePaused(nodeId, { on: params.on, stopRunning: params.stop_running === true, ownerBusy });
      return paused.ok ? { ok: true, node: publicNode(paused.node, labelIn(safe(() => names(), null), paused.node.device_id)) } : paused;
    },
    'team.node.unregister': (params, live, scheduler) => {
      const nodeId = nodeIdOf(scheduler, live);
      return nodeId ? dropNode(scheduler, nodeId) : nodeNotFound();
    },
    'team.node.list': (params, live, scheduler) => listAnswer(scheduler),
  };

  async function dispatch(command, context) {
    const operation = command?.operation;
    if (!OPERATIONS.has(operation)) return hostFailure('invalid', 'unsupported_operation');
    const who = caller(context?.deviceId, operation === 'team.node.list' ? NODE_LIST_ACTION : NODE_SHARE_ACTION);
    if (who.failure) return who.failure;
    const scheduler = schedulerOf();
    if (!scheduler) return unavailable();
    let answer;
    try {
      answer = await HANDLERS[operation](command.params || {}, who.live, scheduler, context);
    } catch (_error) {
      log('WARN', 'team.node.failed', { operation });
      answer = unavailable();
    }
    log('INFO', 'team.node.answered', { operation, ok: answer.ok === true,
      ...(answer.ok ? {} : { reason: answer.error?.reason || 'refused' }) });
    if (answer.ok === true && ANNOUNCING.has(operation)) announce();
    return answer;
  }

  // After a membership change: every node whose device may no longer share is unregistered
  // at once (its rate windows dropped, its waiting claims woken to be refused).
  function recheck() {
    const scheduler = schedulerOf();
    if (!scheduler) return;
    for (const view of scheduler.listNodes()) {
      if (!caller(view.device_id, NODE_SHARE_ACTION).failure) continue;
      try {
        dropNode(scheduler, view.node_id);
        log('INFO', 'team.node.unshared', { node_id: view.node_id });
      } catch (_error) {
        log('WARN', 'team.node.recheck_failed', { node_id: view.node_id });
      }
    }
  }

  function dispose() {
    disposed = true;
    wake(null, 'disposed');
    release();
    if (announceTimer !== null) timers.clearTimeout(announceTimer);
    announceTimer = null;
    if (unwatch) { try { unwatch(); } catch (_error) { /* the scheduler is gone */ } }
    unwatch = null;
  }

  return Object.freeze({
    handles: (operation) => OPERATIONS.has(operation),
    dispatch,
    recheck,
    dispose,
    watch,
    // A change the feed does not carry (the owner set the team model): the list is published again.
    announce,
    // The owner and PC name of hardware seen this run, for the usage read; null once forgotten.
    describeNode(nodeId) {
      if (!seen.has(nodeId)) {
        const scheduler = safe(() => schedulerOf(), null);
        if (scheduler && safe(() => scheduler.listNodes().some((view) => view.node_id === nodeId), false)) safe(() => listAnswer(scheduler), null);
      }
      return seen.has(nodeId) ? { ...seen.get(nodeId) } : null;
    },
    resources: () => ({ waiters: waiters.size, timers: [...waiters].filter((waiter) => waiter.timer !== null).length
      + (announceTimer === null ? 0 : 1), listeners: (unsubscribe ? 1 : 0) + (unwatch ? 1 : 0) }),
  });
}

module.exports = {
  MAX_WAITING_CLAIMS, NODE_LIST_ACTION, NODE_PROTOCOL_VERSION, NODE_SHARE_ACTION, automaticModel, createNodeRates,
  createTeamNodeCommands, ownNode, publicNode,
};
