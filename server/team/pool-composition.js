'use strict';

// The team pool composition (row 123, slice 4a-4; node protocol spec "4a-4 as
// built"). One per team boot, built only when the team config carries a `pool`
// block. It owns the pool scheduler, the loopback pool gateway, the per-boot key
// the host's own sidecar presents to that gateway, the sweep timer, the lane
// feed, the turn route the backend calls before each chat.send, and the engine
// route the team engine routes call for a request with no conversation (slice 4b).
//
// A turn route decides model availability for a turn that is already admitted
// and whose user message is already stored. Who may use the pool is the injected
// `mayUsePool(memberId, sessionId)` (owner decisions E6 and E37): asked before a
// lease is requested, again when a queued lease turns active, and for every live
// lease by `recheckLeases` whenever membership or roles change. Only an answer of
// `true` allows; a throw or any other answer refuses with role_forbidden.
//
// The scheduler's clock is monotonic by default: its timeouts compare two
// readings, and a wall clock stepped by the OS must not expire or prolong one.
//
// The per-boot key and every route token stay in this process's memory: never
// in a log line, an error, an environment variable, an argument or a file. Logs
// carry event names, ids, states, reasons and counts only.

const crypto = require('node:crypto');

const { ERROR_CODES } = require('../api-contract');
const { automaticModel } = require('./automatic-model');
const { TEAM_POOL_CONTEXT_MAX, TEAM_POOL_CONTEXT_MIN } = require('../config');
const { isId } = require('./ids');
const { POOL_MODEL_ALIAS, createPoolGateway } = require('./pool-gateway');
const { safeLogger } = require('./safe-logger');
const { createPoolScheduler } = require('./scheduler');
const { normalizeAllowedNodes } = require('./scheduler/state');

const BOOT_KEY_BYTES = 32;
const SWEEP_INTERVAL_MS = 1_000;
// How long a queued lease waits for a slot before the turn fails (spec "Lane and queue").
const QUEUE_WAIT_MS = 120_000;
const LANE_LIMIT_MAX = 16;
// The member engine port's affinity value: 32 bytes as unpadded base64url.
const ENGINE_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ENGINE_BUCKETS = 16;
const LEASE_TERMINAL = new Set(['released', 'failed', 'expired']);
const KIND_BY_CODE = new Map(Object.entries(ERROR_CODES).map(([kind, code]) => [code, kind]));

// Integer milliseconds that never step back with the wall clock.
const monotonicClock = () => Math.round(performance.now());

function poolError(kind, reason, { code = ERROR_CODES[kind] || ERROR_CODES.unavailable, retryable = false, message } = {}) {
  return Object.assign(new Error(message || reason), { kind, reason, code, retryable: retryable === true });
}

// A conversation whose allowed-node list names no node registered now.
const noAllowedNode = () => poolError('limit', 'allowed_nodes_unavailable', {
  message: 'None of the nodes this conversation may use is connected. Allow another node, or send again when one is back.',
});

const forbidden = () => poolError('forbidden', 'role_forbidden');

// The owner's stored team model, offered by no online node now: said, never swapped for another model.
const teamModelNotOffered = () => poolError('limit', 'team_model_not_offered', {
  message: "The team's model is not offered by any connected PC now. Pick another model or Automatic, or send again when it is back.",
});

// A scheduler refusal keeps the scheduler's own reason and code; the kind is read back from the code.
function fromRefusal(refusal) {
  const error = refusal?.error || {};
  const code = typeof error.code === 'string' ? error.code : ERROR_CODES.unavailable;
  return poolError(KIND_BY_CODE.get(code) || 'unavailable', String(error.reason || 'team_pool_unavailable'),
    { code, retryable: error.retryable });
}

// The affinity bucket of an engine key: the first byte of its SHA-256 modulo 16, as
// one hex digit, or '-' without a key. A malformed key is refused.
function engineBucket(engineKey) {
  if (engineKey === undefined || engineKey === null) return '-';
  if (typeof engineKey !== 'string' || !ENGINE_KEY_PATTERN.test(engineKey)) throw poolError('invalid', 'engine_key_invalid');
  return (crypto.createHash('sha256').update(engineKey, 'utf8').digest()[0] % ENGINE_BUCKETS).toString(16);
}

// A test may lower a time limit, never raise it.
function lowerOnly(value, max, name) {
  if (value === undefined) return max;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`Pool ${name} must be an integer from 1 to ${max}.`);
  }
  return value;
}

function createPoolComposition({
  contextLength, clock = monotonicClock, randomBytes = crypto.randomBytes, logger, limits = {}, mayUsePool,
  teamModel = () => null, createScheduler = createPoolScheduler, createGateway = createPoolGateway,
} = {}) {
  if (!Number.isSafeInteger(contextLength) || contextLength < TEAM_POOL_CONTEXT_MIN || contextLength > TEAM_POOL_CONTEXT_MAX) {
    throw new TypeError(`Pool composition requires a context length from ${TEAM_POOL_CONTEXT_MIN} to ${TEAM_POOL_CONTEXT_MAX}.`);
  }
  // Never "missing means allowed".
  if (typeof mayUsePool !== 'function') throw new TypeError('Pool composition requires a pool access function.');
  if (typeof teamModel !== 'function') throw new TypeError('Pool composition requires a team model reader.');
  const queueWaitMs = lowerOnly(limits.queueWaitMs, QUEUE_WAIT_MS, 'queue wait');
  const sweepIntervalMs = lowerOnly(limits.sweepIntervalMs, SWEEP_INTERVAL_MS, 'sweep interval');
  const say = safeLogger(logger);
  // The scheduler and gateway log lower-case levels; the host's logger takes upper case.
  const childLog = (level, event, fields) => say(String(level || 'info').toUpperCase(), event, fields);
  let bootKey = Buffer.from(randomBytes(BOOT_KEY_BYTES)).toString('base64url');
  const scheduler = createScheduler({ clock, randomBytes, logger: childLog, limits: limits.scheduler });
  const gateway = createGateway({ scheduler, bootKey, clock, logger: childLog,
    limits: { ...limits.gateway, contextCap: contextLength } });

  const waiters = new Map(); // lease id -> settle(error | null)
  // Live lease id -> { sessionId (null for the team engine), allowedNodes (null for any node) }.
  // Bounded by the scheduler's own lease limits; an entry goes when its lease ends.
  const leaseSessions = new Map();
  let state = 'new'; // new | starting | started | stopping | stopped
  let sweepTimer = null;
  let unsubscribe = null;
  let lanes = null;

  function feedLanes(onlineSlots) {
    if (!lanes) return;
    const limit = Math.min(Math.max(Number.isSafeInteger(onlineSlots) ? onlineSlots : 0, 1), LANE_LIMIT_MAX);
    const configured = lanes.snapshot().configured;
    const local = configured.local;
    if (local.runnable_turns === limit && local.inference_requests === limit) return;
    lanes.setLimits({ ...configured, local: { ...local, runnable_turns: limit, inference_requests: limit } });
    say('INFO', 'team.pool.lane_limits', { limit });
  }

  // The node ids registered now (online or not yet swept away), and whether a list names one.
  const registeredNodes = () => new Set(scheduler.listNodes().map((node) => node.node_id));
  const namesRegisteredNode = (list, registered) => list.some((nodeId) => registered.has(nodeId));

  // A waiting lease whose list no longer names a registered node fails now, not at its queue timeout.
  function failOrphanedWaiters() {
    if (waiters.size === 0) return;
    const registered = registeredNodes();
    for (const [leaseId, { allowedNodes }] of leaseSessions) {
      const settle = waiters.get(leaseId);
      if (settle && allowedNodes && !namesRegisteredNode(allowedNodes, registered)) settle(noAllowedNode());
    }
  }

  // The one scheduler listener of this module: lease waiters, the lane feed and the allowed-node lists.
  function onSchedulerChange(event) {
    if (event?.type === 'lease') {
      if (LEASE_TERMINAL.has(event.to)) leaseSessions.delete(event.lease_id);
      const settle = waiters.get(event.lease_id);
      if (!settle) return;
      if (event.to === 'active') settle(null);
      else if (LEASE_TERMINAL.has(event.to)) settle(poolError('unavailable', String(event.reason || 'team_pool_unavailable')));
    } else if (event?.type === 'nodes') {
      try { feedLanes(event.online_slots); } catch (_error) { say('WARN', 'team.pool.lane_feed_failed'); }
      try { failOrphanedWaiters(); } catch (_error) { say('WARN', 'team.pool.allowed_nodes_check_failed'); }
    }
  }

  function sweep() {
    try { scheduler.sweep(clock()); } catch (_error) { say('WARN', 'team.pool.sweep_failed'); }
  }

  async function start() {
    if (state !== 'new') throw poolError('unavailable', 'team_pool_unavailable');
    state = 'starting';
    try {
      unsubscribe = scheduler.onChange(onSchedulerChange);
      const port = await gateway.start();
      if (state !== 'starting') throw poolError('unavailable', 'team_pool_unavailable');
      sweepTimer = setInterval(sweep, sweepIntervalMs);
      sweepTimer.unref?.();
      state = 'started';
      say('INFO', 'team.pool.started', { context_length: contextLength });
      return { modelEndpoint: { engine: 'openai-compatible', model: POOL_MODEL_ALIAS, apiUrl: `http://127.0.0.1:${port}/v1` } };
    } catch (error) {
      say('ERROR', 'team.pool.start_failed');
      await stop();
      throw error?.reason ? error : poolError('unavailable', 'team_pool_unavailable');
    }
  }

  // Binds the lane feed once the backend exists; a missing lane object refuses the pool.
  function bindRuntime({ lanes: candidate } = {}) {
    if (state !== 'started' || !candidate || typeof candidate.setLimits !== 'function'
      || typeof candidate.snapshot !== 'function') {
      throw poolError('unavailable', 'team_pool_unavailable');
    }
    lanes = candidate;
    try {
      feedLanes(scheduler.poolSummary().online_slots);
    } catch (_error) {
      // A lane object whose snapshot is not the runtime's shape refuses the pool, like a missing one.
      lanes = null;
      throw poolError('unavailable', 'team_pool_unavailable');
    }
  }

  // The conversation's saved allowed-node list, checked before the scheduler sees it: the
  // scheduler's own rule, then at least one listed node registered now.
  function allowedNodesFor(value) {
    if (value === undefined || value === null) return null;
    const list = normalizeAllowedNodes(value, scheduler.limits);
    if (!list) throw poolError('invalid', 'allowed_nodes_invalid');
    if (!namesRegisteredNode(list, registeredNodes())) throw noAllowedNode();
    return list;
  }

  // The lease's model, never the alias: the conversation's own; else the owner's stored team
  // model (read live from the store, each lease) when the pool offers it now, and a stored model
  // nobody offers is refused; else Automatic, by the GPU list's own chooser and views; else the
  // pool's only model. Both routes (turn and team engine) resolve here.
  function leaseModel(model) {
    if (typeof model === 'string' && model.trim() && model !== POOL_MODEL_ALIAS) return model;
    const models = scheduler.poolSummary().models;
    const stored = teamModel();
    if (typeof stored === 'string' && stored) {
      if (models.some((entry) => entry.id === stored)) return stored;
      throw teamModelNotOffered();
    }
    const automatic = automaticModel(scheduler.listNodes());
    if (automatic) return automatic;
    if (models.length === 1) return models[0].id;
    throw poolError('limit', 'model_not_in_pool');
  }

  // `timeoutMs` null: no wait of its own; the scheduler's sweep ends a queued lease (queue_timeout).
  function waitForActive(leaseId, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let timer = null;
      const onAbort = () => settle(poolError('conflict', 'cancelled'));
      function settle(error) {
        if (!waiters.has(leaseId)) return;
        waiters.delete(leaseId);
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        if (error) reject(error); else resolve();
      }
      waiters.set(leaseId, settle);
      if (timeoutMs !== null) {
        timer = setTimeout(() => settle(poolError('unavailable', 'queue_timeout', { retryable: true })), timeoutMs);
        timer.unref?.();
      }
      signal?.addEventListener?.('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      const lease = scheduler.getLease(leaseId);
      if (!lease) settle(poolError('unavailable', 'team_pool_unavailable'));
      else if (lease.state === 'active') settle(null);
      else if (LEASE_TERMINAL.has(lease.state)) settle(poolError('unavailable', String(lease.reason || 'team_pool_unavailable')));
    });
  }

  // `sessionId` names a conversation's turn; null is the team engine (no conversation).
  function allowed(memberId, sessionId) {
    try { return mayUsePool(memberId, sessionId) === true; } catch (_error) { return false; }
  }

  // True when this call ended the lease.
  function cancelQuietly(leaseId) {
    const lease = scheduler.getLease(leaseId);
    if (!lease || LEASE_TERMINAL.has(lease.state)) return false;
    const cancelled = scheduler.cancelLease(leaseId, { reason: 'cancelled' });
    if (!cancelled.ok) say('WARN', 'team.pool.cancel_refused', { lease_id: leaseId, reason: cancelled.error.reason });
    return cancelled.ok === true;
  }

  function releaser(leaseId) {
    let done = false;
    return ({ ok = false } = {}) => {
      if (done) return;
      done = true;
      try {
        const lease = scheduler.getLease(leaseId);
        if (!lease || LEASE_TERMINAL.has(lease.state)) return;
        if (ok === true) {
          const released = scheduler.releaseLease(leaseId);
          if (released.ok || released.error.reason !== 'lease_busy') return;
        }
        cancelQuietly(leaseId);
      } catch (_error) {
        say('WARN', 'team.pool.release_failed', { lease_id: leaseId });
      }
    };
  }

  // The shared head of both routes: the member, access and pool checks, the lease's
  // model, the lease request and its wait. `conversationKey()` is called after those
  // checks (it may refuse); `timeoutMs` null leaves the wait to the scheduler's sweep;
  // `onQueued(lease)` runs once with the queued lease's view, before the wait. A
  // queued lease that turns active is checked again before anything uses it.
  async function leaseFor({
    memberId, sessionId, model, wantsVision, allowedNodes: savedList, signal, conversationKey, timeoutMs, onQueued,
  }) {
    if (!isId('member', memberId)) throw poolError('forbidden', 'member_author_required');
    if (state !== 'started') throw poolError('unavailable', 'team_pool_unavailable');
    if (!allowed(memberId, sessionId)) throw forbidden();
    const leaseModelId = leaseModel(model);
    const allowedNodes = allowedNodesFor(savedList);
    if (signal?.aborted) throw poolError('conflict', 'cancelled');
    const requested = scheduler.requestLease({ conversationKey: conversationKey(), memberId, model: leaseModelId,
      wantsVision: wantsVision === true, allowedNodes });
    if (!requested.ok) throw fromRefusal(requested);
    const leaseId = requested.lease.lease_id;
    leaseSessions.set(leaseId, { sessionId, allowedNodes });
    if (requested.lease.state !== 'active') {
      if (onQueued) {
        try { onQueued(requested.lease); } catch (_error) { say('WARN', 'team.pool.on_queued_failed'); }
      }
      try { await waitForActive(leaseId, signal, timeoutMs); } catch (error) { cancelQuietly(leaseId); throw error; }
      if (!allowed(memberId, sessionId)) { cancelQuietly(leaseId); throw forbidden(); }
    }
    return leaseId;
  }

  // `projectId` is the turn's filesystem binding, not its team project; the access
  // function resolves the conversation's project itself. `allowedNodes` is the
  // conversation's saved list (null or absent: any node).
  async function acquire({ sessionId, projectId, memberId, model, wantsVision, allowedNodes, signal } = {}) {
    const leaseId = await leaseFor({ memberId, model, wantsVision, allowedNodes, signal, timeoutMs: queueWaitMs,
      sessionId: typeof sessionId === 'string' ? sessionId : '',
      conversationKey: () => `conv:${typeof projectId === 'string' && projectId ? projectId : '-'}:${sessionId}` });
    const info = scheduler.getLease(leaseId)?.model_info || null;
    const taken = scheduler.takeRouteToken(leaseId);
    if (!taken.ok) {
      cancelQuietly(leaseId);
      throw fromRefusal(taken);
    }
    // The leased model, so the turn is sized for it (slice 4f): not a secret, unlike the token.
    const leased = info ? { id: info.id, context_length: info.context_length ?? null } : null;
    return { token: taken.token, release: releaser(leaseId), model: leased };
  }

  // The team engine's lease (slice 4b): no conversation, with the scheduler's own
  // queue wait (10 minutes, spec N10). The member port's affinity value is folded
  // into one of 16 buckets, so a member holds at most 16 affinity keys and the raw
  // value leaves this function nowhere. Resolves the active lease's view and its
  // once-only releaser; no route token is taken.
  async function acquireEngine({ memberId, engineKey, model, wantsVision, signal, onQueued } = {}) {
    const leaseId = await leaseFor({ memberId, sessionId: null, model, wantsVision, signal, timeoutMs: null, onQueued,
      conversationKey: () => `engine:${memberId}:${engineBucket(engineKey)}` });
    return { lease: scheduler.getLease(leaseId), release: releaser(leaseId) };
  }

  // Asks the access function again for every queued and active lease, with the
  // lease's member and the session it was requested for (null for a lease this
  // composition did not issue: the team-level check). The revoke fan-out calls it
  // on every membership or role change. Refused leases end: queued ones first,
  // across all members, so a freed slot never goes to a refused lease, then active
  // ones (`cancelLease` cancels a running job). A queued waiter rejects
  // role_forbidden. Each cancel is guarded on its own. Returns how many ended.
  function recheckLeases() {
    if (state !== 'started') return 0;
    const sessionOf = (leaseId) => (leaseSessions.has(leaseId) ? leaseSessions.get(leaseId).sessionId : null);
    const refused = scheduler.listLeases().filter((lease) => (lease.state === 'queued' || lease.state === 'active')
      && !allowed(lease.member_id, sessionOf(lease.lease_id)));
    let ended = 0;
    let failed = 0;
    for (const wanted of ['queued', 'active']) {
      for (const lease of refused.filter((entry) => entry.state === wanted)) {
        try {
          waiters.get(lease.lease_id)?.(forbidden());
          if (cancelQuietly(lease.lease_id)) ended += 1;
        } catch (_error) {
          failed += 1;
        }
      }
    }
    if (failed > 0) say('WARN', 'team.pool.recheck_failed', { failed });
    if (ended > 0) say('INFO', 'team.pool.leases_rechecked', { ended });
    return ended;
  }

  // Idempotent: every queued and active lease is cancelled, every waiter rejected, nothing left.
  async function stop() {
    if (state === 'stopped' || state === 'stopping') return;
    state = 'stopping';
    clearInterval(sweepTimer);
    sweepTimer = null;
    for (const settle of [...waiters.values()]) settle(poolError('unavailable', 'cancelled'));
    for (const lease of scheduler.listLeases()) {
      if (lease.state === 'queued' || lease.state === 'active') {
        try { scheduler.cancelLease(lease.lease_id, { reason: 'cancelled' }); } catch (_error) { /* stop goes on */ }
      }
    }
    try { unsubscribe?.(); } catch (_error) { /* stop goes on */ }
    unsubscribe = null;
    lanes = null;
    try { await gateway.stop(); } catch (_error) { say('WARN', 'team.pool.gateway_stop_failed'); }
    leaseSessions.clear();
    bootKey = null;
    state = 'stopped';
  }

  // `leases`: the live leases whose session this composition remembers.
  function resources() {
    const held = gateway.resources();
    return { listening: held.listening, sockets: held.sockets,
      timers: held.timers + (sweepTimer ? 1 : 0) + waiters.size, waiters: waiters.size, leases: leaseSessions.size };
  }

  return Object.freeze({
    start, stop, bindRuntime, resources, scheduler, recheckLeases,
    // The per-boot key, for the sidecar's initialize secrets only; null after stop.
    modelCredential: () => bootKey,
    turnRoute: Object.freeze({ acquire }),
    engineRoute: Object.freeze({ acquire: acquireEngine }),
  });
}

module.exports = { ENGINE_KEY_PATTERN, createPoolComposition };
