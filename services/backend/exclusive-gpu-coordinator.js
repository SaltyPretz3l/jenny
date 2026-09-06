// Exclusive GPU coordinator: one identity-fenced owner for local chat and
// privileged plugin workloads. A lease is released only by the operation that
// acquired it, and unproven native process cleanup deliberately keeps it held.
//
// Ollama serializes models inside its own daemon only. This coordinator fences
// local chat and privileged native plugins with one owner-bound global lease.

const { EventEmitter } = require('events');
const crypto = require('crypto');

const EXCLUSIVE_GPU_STATE_EVENT = 'exclusive-gpu:state';

const STATE_CHAT_RESIDENT = 'chat_resident';
const STATE_TRANSITIONING = 'transitioning';
const STATE_PRIVILEGED_RESIDENT = 'privileged_resident';

const GPU_ADMISSION_STATES = Object.freeze([
  STATE_CHAT_RESIDENT,
  STATE_TRANSITIONING,
  STATE_PRIVILEGED_RESIDENT,
]);

const ERROR_GPU_BUSY = 'gpu_busy';
const ERROR_STALE_LEASE = 'stale_lease';

/**
 * Structured coordinator failure. `code` is the stable wire-facing token
 * (`gpu_busy` / `stale_lease`); callers branch on it, never on the message.
 */
class ExclusiveGpuError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ExclusiveGpuError';
    this.code = code;
  }
}

function defaultLeaseIdFactory() {
  if (typeof crypto.randomUUID === 'function') {
    return `gpu_${crypto.randomUUID()}`;
  }
  return `gpu_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeOwner(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const owner = {
    kind: String(source.kind || '').trim().toLowerCase(),
    publisher_id: String(source.publisher_id || '').trim(),
    plugin_id: String(source.plugin_id || '').trim(),
    operation_id: String(source.operation_id || '').trim(),
  };
  if (owner.kind !== 'plugin' || !owner.publisher_id || !owner.plugin_id || !owner.operation_id) {
    return null;
  }
  return owner;
}

function sameOwner(left, right) {
  return Boolean(left && right && left.kind === right.kind
    && left.publisher_id === right.publisher_id
    && left.plugin_id === right.plugin_id
    && left.operation_id === right.operation_id);
}

class ExclusiveGpuCoordinator extends EventEmitter {
  constructor({
    logger = null,
    leaseIdFactory = defaultLeaseIdFactory,
  } = {}) {
    super();
    this.logger = typeof logger === 'function' ? logger : null;
    this.leaseIdFactory = typeof leaseIdFactory === 'function' ? leaseIdFactory : defaultLeaseIdFactory;
    this.state = STATE_CHAT_RESIDENT;
    this.lease = null;
    this.disposed = false;
  }

  /**
   * C3: `getState()` -> `{ state, leaseId }`. This exact snapshot is also the
   * `gpu-admission:state` event payload.
   */
  getState() {
    return {
      state: this.state,
      leaseId: this.lease ? this.lease.leaseId : null,
    };
  }

  /** Acquire the one owner-bound privileged GPU lease. */
  async acquireExclusiveLease({ owner } = {}) {
    if (this.disposed) {
      throw new ExclusiveGpuError(ERROR_GPU_BUSY, 'GPU admission coordinator is disposed.');
    }
    const normalizedOwner = normalizeOwner(owner);
    if (!normalizedOwner) {
      throw new ExclusiveGpuError(ERROR_STALE_LEASE, 'GPU lease owner identity is invalid.');
    }
    if (this.lease) {
      throw new ExclusiveGpuError(
        ERROR_GPU_BUSY,
        'The GPU is already leased by another workload.'
      );
    }
    const leaseId = String(this.leaseIdFactory() || '').trim() || defaultLeaseIdFactory();
    this.lease = {
      leaseId,
      owner: normalizedOwner,
    };
    this._setState(STATE_TRANSITIONING, 'acquire');
    return { leaseId };
  }

  /** Promote the current lease after chat-model eviction is verified. */
  markPrivilegedResident(leaseId, owner) {
    this.assertLease(leaseId, owner);
    this._setState(STATE_PRIVILEGED_RESIDENT, 'privileged_resident');
    return this.getState();
  }

  /** Release only when both lease and owner identity still match. */
  releaseLease(leaseId, owner) {
    const token = String(leaseId == null ? '' : leaseId).trim();
    const normalizedOwner = normalizeOwner(owner);
    if (!this.lease || !token || this.lease.leaseId !== token
      || !normalizedOwner || !sameOwner(this.lease.owner, normalizedOwner)) {
      return false;
    }
    this.lease = null;
    this._setState(STATE_CHAT_RESIDENT, 'release');
    return true;
  }

  /**
   * C3: `assertLease(leaseId)` -> throws `code: 'stale_lease'` if not current.
   * Every worker spawn and Ollama load/unload calls this so an operation that
   * outlived its lease can never touch the GPU.
   */
  assertLease(leaseId, owner) {
    const token = String(leaseId == null ? '' : leaseId).trim();
    const normalizedOwner = normalizeOwner(owner);
    if (!token || !this.lease || this.lease.leaseId !== token
      || !normalizedOwner || !sameOwner(this.lease.owner, normalizedOwner)) {
      throw new ExclusiveGpuError(
        ERROR_STALE_LEASE,
        'The GPU lease for this operation is no longer current.'
      );
    }
    return true;
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.lease = null;
    this.state = STATE_CHAT_RESIDENT;
    this.removeAllListeners();
  }

  _setState(nextState, reason) {
    if (!GPU_ADMISSION_STATES.includes(nextState)) {
      throw new Error(`Unsupported GPU admission state: ${nextState}`);
    }
    this.state = nextState;
    const snapshot = this.getState();
    if (this.logger) {
      this.logger('INFO', 'gpu_admission.state', {
        state: snapshot.state,
        hasLease: Boolean(snapshot.leaseId),
        reason: String(reason || '').slice(0, 120),
      });
    }
    // Same event-bridge shape as the other backend state signals
    // (`service.emit('backend-status', snapshot)` in local-engine-lifecycle.js):
    // an EventEmitter signal carrying the getState() snapshot, bridged to the
    // renderer by the main-process wiring rather than sent from here.
    this.emit(EXCLUSIVE_GPU_STATE_EVENT, snapshot);
  }
}

module.exports = {
  ERROR_GPU_BUSY,
  ERROR_STALE_LEASE,
  EXCLUSIVE_GPU_STATE_EVENT,
  ExclusiveGpuCoordinator,
  STATE_CHAT_RESIDENT,
  STATE_PRIVILEGED_RESIDENT,
  STATE_TRANSITIONING,
};
