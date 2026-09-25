'use strict';

const { RETENTION_MS, TERMINAL, isTerminalTombstone } = require('../session-runtime/terminal-retention-contract');
const { isoNow } = require('../session-runtime/store-control');
const { retireWorkCheckpoints } = require('./runtime-checkpoint-retention');
function createRuntimeTerminalRetention(service, runtime) {
  let afterSequence = 0;
  let running = false;
  function settled(work, cutoff) {
    if (work.input?.schema_version !== 1 || !['immediate_chat', 'root_chat', 'child_chat'].includes(work.input.kind)
      || work.input.request?.sessionId !== work.session_id
      || !TERMINAL.has(work.status) || Date.parse(work.transition.at) > cutoff) return false;
    if (runtime.scheduler.hasSessionActiveWork(work.session_id)
      || service.sessionTurnActors?.getQueuedSubmissionBlock(work.session_id)
      || service.sessionStore.hasPendingWrites() !== false
      || service.turnEventJournal.list(work.session_id, work.turn_id).length !== 0) return false;
    if (!treeSettled(work, cutoff)) return false;
    if (!work.attempt) return work.status === 'cancelled';
    // Runtime terminal settlement requires physical AND canonical proof. Retain
    // imported/custom terminal states without this settlement proof conservatively.
    if (work.transition.reason !== 'producer_settled') return false;
    const session = service.sessionStore.getSession(work.session_id);
    if (!session || session.active_turn) return false;
    const epochs = runtime.conversationStore.getEpochs(work.session_id);
    return epochs.dirtyEpoch > 0 && epochs.durableEpoch >= epochs.dirtyEpoch
      && service.sessionStore.hasPendingWrites() === false
      && session.messages.some(message => message.role === 'assistant' && message.turn_id === work.turn_id);
  }
  function treeSettled(work, cutoff) {
    const rootId = work.input.root_run?.root_run_id || work.input.child_run?.root_run_id;
    if (!rootId) return true;
    const budget = runtime.budgetStore.get(rootId);
    if (budget.reservations.some(row => row.settlement === null)) return false;
    if (!runtime.lineageStore.rootIds.has(rootId)) return work.input.kind === 'root_chat';
    const lineage = runtime.lineageStore.get(rootId);
    if (lineage.children.some(row => row.state !== 'committed')) return false;
    return [lineage.root_work_id, ...lineage.children.map(row => row.work_id)].every(id => {
      const item = runtime.store.get(id);
      return item && TERMINAL.has(item.status) && Date.parse(item.transition.at) <= cutoff;
    });
  }
  function canCompact(work) {
    return settled(work, Date.parse(isoNow(runtime.store.now)) - RETENTION_MS)
      && runtime.checkpointStore.canDiscardWorkContext(work.work_id)
      && !(service.sessionStore.getSession(work.session_id)?.runtime_continuations?.entries?.length);
  }
  function reportDeferred(error) {
    try { service._emitServiceLog?.('WARN', 'session_runtime.retention_deferred',
      { reason: error?.code || 'retention_unavailable' }); } catch (_error) { /* Diagnostics only. */ }
  }
  return function maintainTerminalDetail() {
    if (running || runtime.scheduler.closing || runtime.hasPendingOrAdmittedWork()) return null;
    running = true;
    try {
      const lanes = runtime.lanes.snapshot();
      const resources = runtime.resourceBroker.snapshot();
      if (lanes.active_leases || lanes.quarantined || resources.lease_count || resources.waiter_count
        || resources.quarantined_count || runtime.scheduler.cancellationFences.size
        || runtime.children?.publications.size || runtime.lineageStore.readOnly || runtime.budgetStore.readOnly) return null;
      const at = isoNow(runtime.store.now);
      const cutoff = Date.parse(at) - RETENTION_MS;
      const batch = runtime.store.index.summaries.filter(row => row.submission_sequence > afterSequence).slice(0, 8);
      for (const row of batch) {
        if (!TERMINAL.has(row.status) || Date.parse(row.updated_at) > cutoff) continue;
        const work = runtime.store.get(row.work_id);
        try {
          if (!isTerminalTombstone(work.input) && settled(work, cutoff)) retireWorkCheckpoints(service, runtime, work, at);
        } catch (error) { reportDeferred(error); }
      }
      const result = runtime.store.compactTerminalDetail({ afterSequence, canCompact });
      afterSequence = result.next_sequence;
      return result;
    } catch (error) {
      reportDeferred(error);
      return null;
    } finally { running = false; }
  };
}

module.exports = { createRuntimeTerminalRetention };
