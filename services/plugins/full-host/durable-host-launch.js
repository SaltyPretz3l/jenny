'use strict';

const { resourceTerminationConfirmed } = require('./host-resource-admission');

// A reservation is recovery evidence, never evidence that a producer stopped.
// It remains durable throughout the host's lifetime and survives failed updates.
function createDurableHostLaunch({ cleanupStore, supervisor } = {}) {
  const withPersistence = (result, persisted) => persisted?.ok === true ? result : {
    ...result, ok: false, reason: 'host_cleanup_persistence_failed',
    cleanup_persistence: { ok: false, reason: persisted?.reason || 'cleanup_receipt_store_unavailable' },
  };

  async function recordUnproven(record) {
    const persisted = await cleanupStore.record(record);
    return persisted;
  }

  async function settleConfirmed(identity, result) {
    const persisted = await cleanupStore.settle(identity);
    if (persisted?.ok === true && resourceTerminationConfirmed(result)) {
      // Native proof outlives every failed durable write. A lost acknowledgement
      // may retain bounded native evidence, but cannot resurrect execution.
      try { await supervisor.acknowledgeTermination?.(identity); } catch (_error) { /* Retain proof. */ }
    }
    return persisted;
  }

  async function start(options, session) {
    const reserved = await cleanupStore.reserve({ session });
    if (!reserved.ok) return { ok: false, no_start: true, reason: reserved.reason };
    let result;
    try { result = await supervisor.start(options); }
    catch (_error) { result = { ok: false, reason: 'host_start_outcome_unknown' }; }
    if (result?.ok === true) return result;
    if (result?.no_start === true || resourceTerminationConfirmed(result)) {
      return withPersistence(result, await settleConfirmed(session, result));
    }
    const persisted = await recordUnproven({ session, result: result?.termination || result,
      reason: 'host_start_cleanup_unproven' });
    return withPersistence(result || { ok: false, reason: 'host_start_outcome_unknown' }, persisted);
  }

  async function terminate(options) {
    let result;
    try { result = await supervisor.terminate(options); }
    catch (_error) { result = { ok: false, reason: 'host_termination_outcome_unknown' }; }
    const persisted = resourceTerminationConfirmed(result)
      ? await settleConfirmed(options, result)
      : await recordUnproven({ session: options, result: result || {}, reason: options.reason });
    return withPersistence(result || { ok: false, reason: 'host_termination_outcome_unknown' }, persisted);
  }

  return Object.freeze({ start, terminate, recordUnproven });
}

module.exports = { createDurableHostLaunch };
