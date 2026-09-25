'use strict';

const { capacityResource, filesystemResource } = require('./resource-broker');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');
const preparations = new WeakMap();
const WORKER_FIELDS = ['request_id', 'session_id', 'stream_id', 'tool_call_id',
  'command_digest', 'snapshot_id', 'snapshot_digest', 'container_id', 'image_id',
  'job_id', 'incarnation'];

function unavailable(reason, waiting = false) {
  return Object.assign(new Error(reason), { reason,
    code: waiting ? RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED : RUNTIME_ERROR_CODES.ADMISSION_REJECTED, retryable: waiting });
}

// This capability is application-local. The sidecar wire never carries lease
// credits, a prepared worker, or authority to borrow another operation's slots.
function createSandboxPreparation({ gateway, broker, pathResolver, operationId,
  workspacePath, assertCurrent, signal, assertLive, onSettled, onWaiting }) {
  const identity = pathResolver.resolve(workspacePath, { allowMissing: false });
  const state = { gateway, operationId, broker, identity, worker: null,
    snapshotLease: null, workerLease: null, snapshotStarted: false,
    workerStarted: false, snapshotUncertain: false, quarantined: false, closed: false, settled: false };
  const current = () => {
    if (state.closed || state.settled || signal?.aborted) throw unavailable('sandbox_stale_authority');
    assertCurrent();
    assertLive();
    if (pathResolver.resolve(workspacePath, { allowMissing: false }).identity_key
      !== identity.identity_key) throw unavailable('sandbox_stale_authority');
    return true;
  };
  const acquire = (resources, suffix) => {
    current();
    const result = broker.tryAcquire({ ownerId: `sandbox-${operationId}`.slice(0, 115) + suffix,
      resources, signal, validate: current, includeWaitingResource: gateway.continuationEnabled });
    if (result.status === 'waiting' && result.resource_class) onWaiting?.(result, Object.freeze([...resources]));
    if (result.status !== 'granted') throw unavailable(
      result.reason || 'sandbox_resource_unavailable', result.status === 'waiting');
    return result.lease;
  };
  const handle = Object.freeze({
    async withSnapshot(produce) {
      if (state.snapshotStarted) throw unavailable('sandbox_duplicate_preparation');
      state.snapshotStarted = true;
      state.snapshotLease = acquire([filesystemResource(identity)], '-snapshot');
      let cleanupConfirmed = false;
      try {
        const result = await produce(verdict => { cleanupConfirmed = verdict?.cleanupConfirmed === true; });
        // The snapshot owner has completed all file reads/writes and closes.
        broker.release(state.snapshotLease, { producerSettled: true });
        state.snapshotLease = null;
        // Return ownership before the service's post-stage authority check so
        // cancellation cannot strand an already-created snapshot directory.
        return result;
      } catch (error) {
        if (state.snapshotLease) {
          state.snapshotUncertain = !cleanupConfirmed;
          broker.release(state.snapshotLease, { producerSettled: cleanupConfirmed });
          if (cleanupConfirmed) state.snapshotLease = null;
        }
        throw error;
      }
    },
    acquireWorker() {
      if (!state.snapshotStarted || state.snapshotLease || state.workerStarted) {
        throw unavailable('sandbox_preparation_order_invalid');
      }
      state.workerLease = acquire([
        capacityResource('native_processes'), capacityResource('sandbox_commands'),
      ], '-worker');
      state.workerStarted = true;
    },
    bindWorker(binding) {
      current();
      if (!state.workerLease || state.worker) throw unavailable('sandbox_worker_binding_invalid');
      if (WORKER_FIELDS.some(key => typeof binding?.[key] !== 'string' || !binding[key])) {
        throw unavailable('sandbox_worker_binding_invalid');
      }
      state.worker = Object.freeze(Object.fromEntries(WORKER_FIELDS.map(key => [key, binding[key]])));
    },
    settle({ cleanup }) {
      if (!['confirmed', 'uncertain'].includes(cleanup)) throw unavailable('sandbox_cleanup_invalid');
      if (state.settled) return true;
      const confirmed = cleanup === 'confirmed' && !state.snapshotUncertain;
      for (const lease of [state.snapshotLease, state.workerLease]) {
        if (lease) broker.release(lease, { producerSettled: confirmed });
      }
      if (confirmed) {
        state.snapshotLease = null;
        state.workerLease = null;
        state.settled = true;
        onSettled();
      } else state.quarantined = true;
      return confirmed;
    },
    close() {
      state.closed = true;
      // A chat reader's closure cannot prove an externally owned worker exited.
      handle.settle({ cleanup: 'uncertain' });
    },
    holdsWorkerResources() { return state.workerLease !== null; },
    snapshot() {
      return Object.freeze({ active: !state.closed && !state.settled
        && !!(state.snapshotLease || state.workerLease),
      quarantined: !state.settled && (!!state.snapshotUncertain || state.quarantined
        || (state.closed && !!(state.snapshotLease || state.workerLease))),
      settled: state.settled });
    },
  });
  state.current = current;
  preparations.set(handle, state);
  return handle;
}

function assertSandboxPreparation(handle, { gateway, operationId, binding }) {
  const state = preparations.get(handle);
  if (!state || state.gateway !== gateway || state.operationId !== operationId
    || !state.workerLease || !state.worker || !binding
    || WORKER_FIELDS.some(key => state.worker[key] !== binding[key])) {
    throw unavailable('sandbox_worker_binding_invalid');
  }
  state.current();
  return true;
}

module.exports = { createSandboxPreparation, assertSandboxPreparation };
