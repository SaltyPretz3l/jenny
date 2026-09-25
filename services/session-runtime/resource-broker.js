'use strict';

const { randomUUID } = require('node:crypto');
const { isPhysicalPathIdentity, physicalPathsConflict } = require('./physical-paths');

const DEFAULT_RESOURCE_LIMITS = Object.freeze({
  tool_operations: 2,
  native_processes: 2,
  tests: 1,
  sandbox_commands: 1,
});
const MAX_OWNER_CHARS = 128;
const MAX_LEASE_ID_CHARS = 128;
const MAX_RESOURCE_KEY_CHARS = (32 * 1024) + 64;
const MAX_RESOURCES_PER_REQUEST = 64;

function abortError(reason) {
  const error = reason instanceof Error ? reason : new Error('Resource acquisition was cancelled.');
  if (!error.name || error.name === 'Error') error.name = 'AbortError';
  return error;
}

function boundedToken(value, limit) {
  const token = typeof value === 'string' ? value.trim() : '';
  // eslint-disable-next-line no-control-regex -- resource identities reject control bytes.
  return token && token.length <= limit && !/[\u0000-\u001f\u007f]/u.test(token) ? token : '';
}

function normalizeLimits(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const limits = {};
  for (const [key, fallback] of Object.entries(DEFAULT_RESOURCE_LIMITS)) {
    const candidate = Object.hasOwn(source, key) ? source[key] : fallback;
    if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > 1_000) {
      throw new Error(`Resource limit for ${key} is invalid.`);
    }
    limits[key] = candidate;
  }
  return Object.freeze(limits);
}

function normalizeFilesystemResource(resource) {
  const identity = resource?.identity;
  if (!isPhysicalPathIdentity(identity) || identity.type !== 'filesystem'
    || !boundedToken(identity.identity_key, MAX_RESOURCE_KEY_CHARS)
    || typeof identity.comparison_path !== 'string' || !identity.comparison_path) {
    throw new Error('Filesystem resource identity is invalid.');
  }
  return Object.freeze({ type: 'filesystem', identity });
}

function normalizeResources(resources, limits) {
  if (!Array.isArray(resources) || !resources.length
    || resources.length > MAX_RESOURCES_PER_REQUEST) {
    throw new Error('Resource request must contain a bounded non-empty resource list.');
  }
  const capacity = new Map();
  const filesystem = new Map();
  for (const resource of resources) {
    if (resource?.type === 'capacity') {
      const key = boundedToken(resource.key, MAX_RESOURCE_KEY_CHARS);
      const units = resource.units === undefined ? 1 : resource.units;
      if (!Object.hasOwn(limits, key) || !Number.isSafeInteger(units) || units < 1) {
        throw new Error('Capacity resource is invalid.');
      }
      capacity.set(key, (capacity.get(key) || 0) + units);
      continue;
    }
    const normalized = normalizeFilesystemResource(resource);
    filesystem.set(normalized.identity.identity_key, normalized);
  }
  const normalized = [
    ...[...capacity.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, units]) => {
        if (units > limits[key]) throw new Error(`Resource request exceeds the ${key} limit.`);
        return Object.freeze({ type: 'capacity', key, units });
      }),
    ...filesystem.values(),
  ];
  if (!normalized.length || normalized.length > MAX_RESOURCES_PER_REQUEST) {
    throw new Error('Normalized resource request exceeds its bound.');
  }
  return Object.freeze(normalized);
}

function capacityResource(key, units = 1) {
  return Object.freeze({ type: 'capacity', key, units });
}

function filesystemResource(identity) {
  return Object.freeze({ type: 'filesystem', identity });
}

function buildOperationResources({
  operationType = 'tool',
  workspacePath = '',
  declaredPaths = [],
  effectsKnown = false,
  sandboxCommands = false,
  pathResolver,
} = {}) {
  if (!pathResolver || typeof pathResolver.resolve !== 'function') {
    throw new TypeError('Operation resources require a physical path resolver.');
  }
  const type = String(operationType || '').trim();
  if (!['control', 'tool', 'filesystem', 'command', 'test'].includes(type)) {
    throw new Error('Operation type is invalid.');
  }
  if (type === 'control') return Object.freeze([]);
  const resources = [capacityResource('tool_operations')];
  if (type === 'command') {
    resources.push(capacityResource('native_processes'));
    if (sandboxCommands === true) resources.push(capacityResource('sandbox_commands'));
  } else if (type === 'test') {
    resources.push(capacityResource('native_processes'), capacityResource('tests'));
  }
  const declared = Array.isArray(declaredPaths) ? declaredPaths.filter(Boolean) : [];
  const workspaceExclusive = ['filesystem', 'command', 'test'].includes(type);
  const paths = workspaceExclusive && (!effectsKnown || !declared.length) ? [workspacePath] : declared;
  if (paths.some((value) => !String(value || '').trim())) {
    throw new Error('Unknown command or test effects require a workspace path.');
  }
  for (const target of paths) resources.push(filesystemResource(pathResolver.resolve(target)));
  return Object.freeze(resources);
}

class ResourceBroker {
  constructor({
    limits = DEFAULT_RESOURCE_LIMITS,
    maxWaiters = 256,
    maxLeases = 512,
    createId = randomUUID,
    now = Date.now,
  } = {}) {
    this._limits = normalizeLimits(limits);
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 1
      || !Number.isSafeInteger(maxLeases) || maxLeases < 1) {
      throw new Error('Resource broker record bounds are invalid.');
    }
    this._maxWaiters = maxWaiters;
    this._maxLeases = maxLeases;
    this._createId = createId;
    this._now = now;
    this._waiters = [];
    this._leases = new Map();
    this._leaseTokens = new WeakMap();
    this._availabilityObservers = new Set();
    this._availabilityNotificationPending = false;
  }

  setLimits(limits) {
    const next = normalizeLimits(limits);
    if (next.sandbox_commands !== 1) throw new Error('sandbox_capacity_fixed');
    this._limits = next;
    // Existing leases remain charged, including quarantined physical work.
    this._drain();
    this._notifyAvailability();
    return this.snapshot();
  }

  // An eligibility hint only: callers must still acquire the complete resource
  // set and revalidate authority before dispatching any producer.
  canAcquire(resources) {
    return this._canAcquire(normalizeResources(resources, this._limits));
  }

  onAvailabilityChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('resource_observer_invalid');
    if (this._availabilityObservers.size >= 8) throw new Error('resource_observer_capacity');
    const observer = { listener };
    this._availabilityObservers.add(observer);
    return () => this._availabilityObservers.delete(observer);
  }

  acquire({ ownerId, resources, signal = null, validate = null } = {}) {
    const owner = boundedToken(ownerId, MAX_OWNER_CHARS);
    if (!owner) return Promise.reject(new Error('Resource owner identity is invalid.'));
    let normalized;
    try {
      normalized = normalizeResources(resources, this._limits);
    } catch (error) {
      return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(abortError(signal.reason));
    if (this._waiters.length >= this._maxWaiters) {
      return Promise.reject(new Error('Resource waiter capacity is exhausted.'));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        owner,
        resources: normalized,
        validate: typeof validate === 'function' ? validate : null,
        signal,
        resolve,
        reject,
        state: 'waiting',
        enqueuedAt: this._now(),
        abortListener: null,
      };
      if (signal && typeof signal.addEventListener === 'function') {
        waiter.abortListener = () => this._cancelWaiter(waiter, signal.reason);
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      this._waiters.push(waiter);
      this._drain();
    });
  }

  tryAcquire({ ownerId, resources, signal = null, validate = null, includeWaitingResource = false } = {}) {
    const owner = boundedToken(ownerId, MAX_OWNER_CHARS);
    if (!owner) throw new Error('Resource owner identity is invalid.');
    const normalized = normalizeResources(resources, this._limits);
    if (signal?.aborted) return Object.freeze({ status: 'rejected', reason: 'cancelled' });
    const initialWait = this._waitingResult(normalized, includeWaitingResource);
    if (initialWait) return initialWait;
    if (validate !== null && typeof validate !== 'function') {
      throw new TypeError('Resource validation callback is invalid.');
    }
    try {
      const valid = validate?.() ?? true;
      if (valid && typeof valid.then === 'function') {
        throw new TypeError('Resource validation must be synchronous.');
      }
      if (valid !== true) {
        return Object.freeze({ status: 'rejected', reason: 'resource_authority_stale' });
      }
    } catch (_error) {
      return Object.freeze({ status: 'rejected', reason: 'resource_authority_stale' });
    }
    // Validation callbacks may synchronously re-enter the broker. Recheck the
    // entire resource set immediately before minting one atomic lease.
    if (signal?.aborted) return Object.freeze({ status: 'rejected', reason: 'cancelled' });
    const finalWait = this._waitingResult(normalized, includeWaitingResource);
    if (finalWait) return finalWait;
    const id = boundedToken(this._createId(), MAX_LEASE_ID_CHARS);
    if (!id || this._leases.has(id)) {
      return Object.freeze({ status: 'rejected', reason: 'resource_lease_identity' });
    }
    const lease = Object.freeze({ id, owner_id: owner, resources: normalized,
      acquired_at: this._now() });
    const holder = { state: 'active', signal, abortListener: null };
    const record = { id, owner, resources: normalized, status: 'active', waiter: holder,
      lease, quarantinedAt: null };
    if (signal && typeof signal.addEventListener === 'function') {
      holder.abortListener = () => {
        if (this._recordForLease(lease) !== record) return;
        record.status = 'quarantined';
        record.quarantinedAt = this._now();
      };
      signal.addEventListener('abort', holder.abortListener, { once: true });
    }
    this._leases.set(id, record);
    this._leaseTokens.set(lease, id);
    return Object.freeze({ status: 'granted', lease });
  }

  release(lease, { producerSettled = false } = {}) {
    const record = this._recordForLease(lease);
    if (!record) return false;
    if (producerSettled !== true) {
      record.status = 'quarantined';
      record.quarantinedAt = this._now();
      return false;
    }
    this._deleteLease(record);
    this._drain();
    return true;
  }

  confirmCleanup(lease) {
    return this.release(lease, { producerSettled: true });
  }

  isHeld(lease) {
    return this._recordForLease(lease) != null;
  }

  // Backend-restart proof: a quarantined lease's owner already released it
  // without settlement proof, and the process tree that ran the operation is
  // gone. An app restart starts this in-memory broker empty anyway; an in-app
  // backend restart gets the same clean slate for those leases only.
  confirmQuarantinedCleanup() {
    let confirmed = 0;
    for (const record of [...this._leases.values()]) {
      if (record.status !== 'quarantined') continue;
      this._deleteLease(record);
      confirmed += 1;
    }
    if (confirmed) this._drain();
    return confirmed;
  }

  snapshot() {
    const capacity = Object.fromEntries(Object.keys(this._limits).map((key) => [key, 0]));
    const leases = [];
    let oldestQuarantinedAt = null;
    for (const record of this._leases.values()) {
      if (record.status === 'quarantined' && record.quarantinedAt != null
        && (oldestQuarantinedAt === null || record.quarantinedAt < oldestQuarantinedAt)) {
        oldestQuarantinedAt = record.quarantinedAt;
      }
      for (const resource of record.resources) {
        if (resource.type === 'capacity') capacity[resource.key] += resource.units;
      }
      leases.push(Object.freeze({ id: record.id, owner_id: record.owner, status: record.status,
        resource_count: record.resources.length }));
    }
    return Object.freeze({
      limits: this._limits,
      capacity: Object.freeze(capacity),
      waiter_count: this._waiters.length,
      lease_count: this._leases.size,
      quarantined_count: leases.filter((lease) => lease.status === 'quarantined').length,
      // Oldest unconfirmed cleanup still charging capacity; operators read this to spot starvation.
      oldest_quarantined_at: oldestQuarantinedAt,
      leases: Object.freeze(leases),
    });
  }

  _recordForLease(lease) {
    if (!lease || typeof lease !== 'object') return null;
    const id = this._leaseTokens.get(lease);
    const record = id ? this._leases.get(id) || null : null;
    return record?.lease === lease ? record : null;
  }

  _cancelWaiter(waiter, reason) {
    if (waiter.state === 'waiting') {
      const index = this._waiters.indexOf(waiter);
      if (index >= 0) this._waiters.splice(index, 1);
      waiter.state = 'cancelled';
      this._detachAbort(waiter);
      waiter.reject(abortError(reason));
      this._drain();
      return;
    }
    if (waiter.state === 'validating') {
      const record = this._leases.get(waiter.leaseId);
      if (record) this._deleteLease(record);
      waiter.state = 'cancelled';
      this._detachAbort(waiter);
      waiter.reject(abortError(reason));
      this._drain();
      return;
    }
    if (waiter.state === 'active') {
      const record = this._leases.get(waiter.leaseId);
      if (record) {
        record.status = 'quarantined';
        record.quarantinedAt = this._now();
      }
    }
  }

  _detachAbort(waiter) {
    if (waiter.abortListener && typeof waiter.signal?.removeEventListener === 'function') {
      waiter.signal.removeEventListener('abort', waiter.abortListener);
    }
    waiter.abortListener = null;
  }

  _canAcquire(resources) {
    return this._blockingResource(resources) === null;
  }

  _waitingResult(resources, includeResource) {
    const blocked = this._blockingResource(resources);
    return blocked === null ? null : Object.freeze({ status: 'waiting', reason: 'resource_capacity',
      ...(includeResource === true && blocked ? { resource_class: blocked, dependency_id: null } : {}) });
  }

  _blockingResource(resources) {
    // Lease-record pressure has no single physical resource dependency. It must
    // not be misreported as a resource eligible for checkpoint suspension.
    if (this._leases.size >= this._maxLeases) return '';
    const used = Object.fromEntries(Object.keys(this._limits).map((key) => [key, 0]));
    for (const record of this._leases.values()) {
      for (const held of record.resources) {
        if (held.type === 'capacity') used[held.key] += held.units;
      }
    }
    for (const requested of resources) {
      if (requested.type === 'capacity'
        && used[requested.key] + requested.units > this._limits[requested.key]) return requested.key;
      if (requested.type === 'filesystem') {
        for (const record of this._leases.values()) {
          if (record.resources.some((held) => held.type === 'filesystem'
            && physicalPathsConflict(requested.identity, held.identity))) return 'filesystem';
        }
      }
    }
    return null;
  }

  _drain() {
    for (const waiter of [...this._waiters]) {
      if (waiter.state !== 'waiting' || !this._canAcquire(waiter.resources)) continue;
      const index = this._waiters.indexOf(waiter);
      if (index < 0) continue;
      this._waiters.splice(index, 1);
      this._beginValidation(waiter);
    }
  }

  _beginValidation(waiter) {
    const id = boundedToken(this._createId(), MAX_LEASE_ID_CHARS);
    if (!id || this._leases.has(id)) {
      waiter.state = 'rejected';
      this._detachAbort(waiter);
      waiter.reject(new Error('Resource lease identity is invalid or duplicated.'));
      return;
    }
    const lease = Object.freeze({ id, owner_id: waiter.owner,
      resources: waiter.resources, acquired_at: this._now() });
    const record = { id, owner: waiter.owner, resources: waiter.resources,
      status: 'validating', waiter, lease, quarantinedAt: null };
    waiter.state = 'validating';
    waiter.leaseId = id;
    this._leases.set(id, record);
    this._leaseTokens.set(lease, id);
    Promise.resolve().then(() => waiter.validate?.() ?? true).then((valid) => {
      if (waiter.state !== 'validating') return;
      if (valid !== true || waiter.signal?.aborted) {
        this._deleteLease(record);
        waiter.state = 'rejected';
        this._detachAbort(waiter);
        waiter.reject(waiter.signal?.aborted
          ? abortError(waiter.signal.reason)
          : new Error('Resource authority changed before lease commit.'));
        this._drain();
        return;
      }
      record.status = 'active';
      waiter.state = 'active';
      waiter.resolve(lease);
      this._drain();
    }, (error) => {
      if (waiter.state !== 'validating') return;
      this._deleteLease(record);
      waiter.state = 'rejected';
      this._detachAbort(waiter);
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
      this._drain();
    });
  }

  _deleteLease(record) {
    this._leases.delete(record.id);
    this._leaseTokens.delete(record.lease);
    this._detachAbort(record.waiter);
    record.waiter.state = 'released';
    this._notifyAvailability();
  }

  _notifyAvailability() {
    if (this._availabilityNotificationPending || !this._availabilityObservers.size) return;
    this._availabilityNotificationPending = true;
    queueMicrotask(() => {
      this._availabilityNotificationPending = false;
      // Existing broker waiters get first access in _drain before observers run.
      // No notification conveys a lease or authorizes an operation.
      for (const observer of [...this._availabilityObservers]) {
        if (!this._availabilityObservers.has(observer)) continue;
        try { observer.listener(); } catch (_error) { /* Observation cannot undo cleanup. */ }
      }
    });
  }
}

module.exports = {
  DEFAULT_RESOURCE_LIMITS,
  ResourceBroker,
  buildOperationResources,
  capacityResource,
  filesystemResource,
  normalizeResources,
};
