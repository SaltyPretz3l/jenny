'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeSessionRuntime } = require('../shell-config-session-runtime');

const routes = new WeakSet();
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u;
const ROUTE_KEYS = ['configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class'];

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

class RuntimeLaneAdmission {
  constructor({ limits, maxRunnableTurns = 16, maxInferenceRequests = 16,
    createId = randomUUID, onChange = null } = {}) {
    this.limits = normalizeSessionRuntime(limits);
    this.capacity = { turn: positiveBound(maxRunnableTurns), inference: positiveBound(maxInferenceRequests) };
    this.createId = createId;
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.leases = new Map();
  }

  setLimits(limits) {
    this.limits = normalizeSessionRuntime(limits);
    // Lowering a limit blocks new admission; it never evicts an active producer.
    this._changed();
    return this.snapshot();
  }

  tryAcquireTurn({ sessionId, route, signal } = {}) {
    if (typeof sessionId !== 'string' || !TOKEN.test(sessionId)) {
      throw new TypeError('runtime_session_identity_invalid');
    }
    return this._acquire('turn', { sessionId, route, signal });
  }

  tryAcquireInference({ ownerId, route, signal } = {}) {
    if (typeof ownerId !== 'string' || !TOKEN.test(ownerId)) {
      throw new TypeError('runtime_inference_owner_invalid');
    }
    return this._acquire('inference', { ownerId, route, signal });
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

  _acquire(kind, { sessionId = null, ownerId = null, route, signal }) {
    if (!isRuntimeRoute(route)) throw new TypeError('runtime_provider_route_untrusted');
    if (signal?.aborted) return Object.freeze({ status: 'rejected', reason: 'cancelled' });
    const key = laneKey(route);
    // Quarantined leases still count: capacity stays charged until cleanup is confirmed.
    let sessionBusy = false;
    let kindCount = 0;
    let keyCount = 0;
    for (const record of this.leases.values()) {
      if (record.kind !== kind) continue;
      kindCount += 1;
      if (record.key === key) keyCount += 1;
      if (kind === 'turn' && record.sessionId === sessionId) sessionBusy = true;
    }
    if (sessionBusy) return Object.freeze({ status: 'waiting', reason: 'session_busy' });
    if (kindCount >= this.capacity[kind]) {
      return Object.freeze({ status: 'waiting', reason: 'downstream_capacity' });
    }
    const setting = kind === 'turn' ? 'runnable_turns' : 'inference_requests';
    if (keyCount >= this.limits[route.resource_class][setting]) {
      return Object.freeze({ status: 'waiting', reason: 'lane_capacity' });
    }
    const id = this.createId();
    if (typeof id !== 'string' || !TOKEN.test(id) || this.leases.has(id)) {
      throw new Error('runtime_lane_identity_conflict');
    }
    const lease = Object.freeze({ id });
    this.leases.set(id, { lease, kind, sessionId, ownerId, route, key, state: 'active' });
    this._changed();
    return Object.freeze({ status: 'granted', lease });
  }

  _changed() {
    try { this.onChange?.(); } catch (_error) { /* Observers cannot release or replace a producer. */ }
  }
}

module.exports = { RuntimeLaneAdmission, captureRuntimeRoute, isRuntimeRoute };
