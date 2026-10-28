'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeSessionRuntime } = require('../shell-config-session-runtime');

const routes = new WeakSet();
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const ROUTE_KEYS = ['configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class'];
// A queued inference waiter that has not re-polled for this long is gone (the
// sidecar re-admits at most 1 s apart while it waits).
const INFERENCE_WAITER_TTL_MS = 3_000;

// Only application adapters call this factory with trusted provider/configuration
// metadata. Wire objects and model-supplied objects are not admission routes.
function captureRuntimeRoute(metadata) {
  if (!metadata || Object.keys(metadata).sort().join(',') !== ROUTE_KEYS.join(',')
    || !['engine_type', 'provider_id', 'configuration_revision'].every(key => (
      typeof metadata[key] === 'string' && TOKEN.test(metadata[key])
    ))
    || !['local', 'cloud'].includes(metadata.resource_class)
    || typeof metadata.requires_gpu !== 'boolean'
    || (metadata.resource_class === 'cloud' && metadata.requires_gpu)) {
    throw new TypeError('runtime_provider_route_invalid');
  }
  const route = Object.freeze({ ...metadata });
  routes.add(route);
  return route;
}

function isRuntimeRoute(route) {
  return Boolean(route && routes.has(route));
}

function laneKey(route) {
  return route.resource_class === 'local' ? 'local' : `cloud:${route.provider_id}`;
}

function positiveBound(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new TypeError('runtime_downstream_capacity_invalid');
  }
  return value;
}

function waiting(reason, records, queued = false) {
  const blockers = records.map(record => Object.freeze({
    session_id: typeof record.sessionId === 'string' ? record.sessionId : null,
    quarantined_at: Number.isFinite(record.quarantinedAt) ? record.quarantinedAt : null,
  }));
  return Object.freeze({ status: 'waiting', reason, blockers: Object.freeze(blockers),
    ...(queued ? { queued: true } : {}) });
}

class RuntimeLaneAdmission {
  constructor({ limits, maxRunnableTurns = 16, maxInferenceRequests = 16,
    createId = randomUUID, onChange = null, now = Date.now } = {}) {
    this.limits = normalizeSessionRuntime(limits);
    this.capacity = { turn: positiveBound(maxRunnableTurns), inference: positiveBound(maxInferenceRequests) };
    this.createId = createId;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.now = now;
    this.leases = new Map();
    // ownerId -> { key, firstAt, lastAt } for mid-turn re-admits still waiting.
    this.inferenceWaiters = new Map();
  }

  setLimits(limits) {
    this.limits = normalizeSessionRuntime(limits);
    // Lowering a limit blocks new admission; it never evicts an active producer.
    this._changed();
    return this.snapshot();
  }

  // `priority` (row 69/70: the primary Jenny chat) admits one turn beyond the lane's
  // `runnable_turns` so an orchestrating chat can run while a worker chat streams or waits on
  // an approval; generation stays serialized by the inference lane. Per-session exclusion and
  // the downstream capacity still apply, and a priority turn never displaces an ordinary one.
  tryAcquireTurn({ sessionId, route, signal, priority = false } = {}) {
    if (typeof sessionId !== 'string' || !TOKEN.test(sessionId)) {
      throw new TypeError('runtime_session_identity_invalid');
    }
    return this._acquire('turn', { sessionId, route, signal, priority: priority === true });
  }

  // sessionId (optional) only names the holder in a waiter's blockers, so a send held behind
  // another chat's generation can say which chat it waits for. `queue` marks a mid-turn re-admit
  // the sidecar keeps polling: queued owners are granted oldest first among themselves, so a chat
  // whose tool calls finish in milliseconds cannot win every gap against a polling one.
  tryAcquireInference({ ownerId, route, signal, sessionId = null, queue = false } = {}) {
    if (typeof ownerId !== 'string' || !TOKEN.test(ownerId)) {
      throw new TypeError('runtime_inference_owner_invalid');
    }
    const holder = typeof sessionId === 'string' && TOKEN.test(sessionId) ? sessionId : null;
    return this._acquire('inference', { ownerId, route, signal, sessionId: holder, queue: queue === true });
  }

  forgetInferenceWaiter(ownerId) {
    this.inferenceWaiters.delete(ownerId);
  }

  ownsInferenceLease(lease, route) {
    const record = this.leases.get(lease?.id);
    return Boolean(record?.lease === lease && record.kind === 'inference'
      && record.route === route && record.state === 'active');
  }

  release(lease, { producerSettled = false } = {}) {
    const current = this.leases.get(lease?.id);
    if (!current || current.lease !== lease) return false;
    if (!producerSettled) {
      if (current.state !== 'quarantined') current.quarantinedAt = this.now();
      current.state = 'quarantined';
      this._changed();
      return false;
    }
    this.leases.delete(lease.id);
    this._changed();
    return true;
  }

  confirmCleanup(lease) {
    const current = this.leases.get(lease?.id);
    if (!current || current.lease !== lease || current.state !== 'quarantined') return false;
    return this.release(lease, { producerSettled: true });
  }

  // Backend-restart proof only: confirms every quarantined lease no live owner
  // still holds (a turn lease in `heldLeases`, an inference lease whose owner is
  // in `heldOwners`). Returns how many were confirmed.
  confirmOrphaned({ heldLeases, heldOwners }) {
    let confirmed = 0;
    for (const record of [...this.leases.values()]) {
      if (record.state !== 'quarantined') continue;
      if (record.kind === 'turn' ? heldLeases.has(record.lease) : heldOwners.has(record.ownerId)) continue;
      if (this.confirmCleanup(record.lease)) confirmed += 1;
    }
    return confirmed;
  }

  snapshot() {
    const lanes = new Map();
    let quarantined = 0;
    for (const record of this.leases.values()) {
      const key = record.key;
      const lane = lanes.get(key) || { lane: key, turns: 0, inference_requests: 0, quarantined: 0 };
      lane[record.kind === 'turn' ? 'turns' : 'inference_requests'] += 1;
      if (record.state === 'quarantined') { lane.quarantined += 1; quarantined += 1; }
      lanes.set(key, lane);
    }
    return Object.freeze({
      active_leases: this.leases.size, quarantined,
      downstream: Object.freeze({ runnable_turns: this.capacity.turn, inference_requests: this.capacity.inference }),
      configured: Object.freeze(normalizeSessionRuntime(this.limits)),
      lanes: Object.freeze([...lanes.values()].map(Object.freeze)),
    });
  }

  _acquire(kind, { sessionId = null, ownerId = null, route, signal, priority = false, queue = false }) {
    if (!isRuntimeRoute(route)) throw new TypeError('runtime_provider_route_untrusted');
    if (signal?.aborted) return Object.freeze({ status: 'rejected', reason: 'cancelled' });
    const key = laneKey(route);
    // Quarantined leases still count: capacity stays charged until cleanup is confirmed.
    let sessionBusy = false;
    let kindCount = 0;
    let keyCount = 0;
    let priorityKeyCount = 0; // turns on this lane holding its one extra slot
    const kindRecords = [];
    for (const record of this.leases.values()) {
      if (record.kind !== kind) continue;
      kindRecords.push(record);
      kindCount += 1;
      if (record.key === key) {
        keyCount += 1;
        if (record.priority) priorityKeyCount += 1;
      }
      if (kind === 'turn' && record.sessionId === sessionId) sessionBusy = true;
    }
    const ordinaryKeyCount = keyCount - priorityKeyCount;
    if (sessionBusy) return waiting('session_busy', kindRecords.filter(record => record.sessionId === sessionId));
    if (kindCount >= this.capacity[kind]) {
      return waiting('downstream_capacity', kindRecords);
    }
    const setting = kind === 'turn' ? 'runnable_turns' : 'inference_requests';
    const limit = this.limits[route.resource_class][setting];
    // Ordinary turns count only ordinary holders. A priority turn takes the lane's single extra slot
    // while it is free (so the primary alone never blocks a worker), else an ordinary slot like anyone
    // else: two priority sessions never add up to two extra slots.
    const usesPrioritySlot = kind === 'turn' && priority && priorityKeyCount < 1;
    const waitersAhead = queue ? this._inferenceWaitersAhead(ownerId, key) : 0;
    const laneFull = kind === 'turn'
      ? (!usesPrioritySlot && ordinaryKeyCount >= limit)
      : keyCount + waitersAhead >= limit;
    if (laneFull) {
      if (queue) this._noteInferenceWaiter(ownerId, key);
      return waiting('lane_capacity', kindRecords.filter(record => record.key === key),
        queue && keyCount < limit);
    }
    if (queue) this.inferenceWaiters.delete(ownerId);
    const id = this.createId();
    if (typeof id !== 'string' || !TOKEN.test(id) || this.leases.has(id)) {
      throw new Error('runtime_lane_identity_conflict');
    }
    const lease = Object.freeze({ id });
    this.leases.set(id, { lease, kind, sessionId, ownerId, route, key, priority: usesPrioritySlot,
      state: 'active', quarantinedAt: null });
    this._changed();
    return Object.freeze({ status: 'granted', lease });
  }

  _inferenceWaitersAhead(ownerId, key) {
    const cutoff = this.now() - INFERENCE_WAITER_TTL_MS;
    const own = this.inferenceWaiters.get(ownerId);
    let ahead = 0;
    for (const [id, waiter] of this.inferenceWaiters) {
      if (waiter.lastAt < cutoff) { this.inferenceWaiters.delete(id); continue; }
      if (id !== ownerId && waiter.key === key && (!own || waiter.firstAt < own.firstAt)) ahead += 1;
    }
    return ahead;
  }

  _noteInferenceWaiter(ownerId, key) {
    const now = this.now();
    const current = this.inferenceWaiters.get(ownerId);
    this.inferenceWaiters.set(ownerId, { key, firstAt: current?.key === key ? current.firstAt : now, lastAt: now });
  }

  _changed() {
    try { this.onChange?.(); } catch (_error) { /* Observers cannot release or replace a producer. */ }
  }
}

module.exports = { RuntimeLaneAdmission, captureRuntimeRoute, isRuntimeRoute };
