// Exclusive GPU coordinator: one identity-fenced owner for local chat and
// the image engine (via chat-gpu-handoff.js). A lease is released only by the
// operation that acquired it, and unproven native process cleanup deliberately keeps it held.
//
// Ollama serializes models inside its own daemon only. This coordinator fences
// local chat and image-engine renders with one owner-bound global lease.

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

// Owner kinds and the identity fields each must carry. `plugin` is the
// session-provider broker; `builtin` is an Electron-owned chat tool call
// (services/backend/chat-gpu-handoff.js), fenced by the calling stream.
const OWNER_IDENTITY_FIELDS = Object.freeze({
  plugin: Object.freeze(['publisher_id', 'plugin_id', 'operation_id']),
  builtin: Object.freeze(['tool_name', 'call_id', 'stream_id']),
});

function normalizeOwner(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = String(source.kind || '').trim().toLowerCase();
  const fields = OWNER_IDENTITY_FIELDS[kind];
  if (!fields) {
    return null;
  }
  const owner = { kind };
  for (const field of fields) {
    owner[field] = String(source[field] || '').trim();
    if (!owner[field]) {
      return null;
    }
  }
  return owner;
}

function sameOwner(left, right) {
  if (!left || !right || left.kind !== right.kind || !OWNER_IDENTITY_FIELDS[left.kind]) {
    return false;
  }
  return OWNER_IDENTITY_FIELDS[left.kind].every((field) => left[field] === right[field]);
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
