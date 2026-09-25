"use strict";
const { assertRuntimeContinuationProtocol } = require('./inference-protocol');
const { isTerminalTombstone } = require('./terminal-retention-contract');
const { stableJson } = require('./contracts');
const { hydrateRuntimeContinuation } = require('../backend/runtime-continuation-resume');
const { performance } = require('node:perf_hooks');
const MAX_REQUESTS = 16;
const RECOVERY_BUDGET_MS = 15000;

async function reconcileMutationPreparations(service, runtime, { now = () => performance.now() } = {}) {
  const process = service.sidecarClient?.process;
  const deadline = now() + RECOVERY_BUDGET_MS;
  let candidates;
  try { candidates = runtime.store.listMutationRecoveryCandidates(); }
  catch (_error) { return { inspected: 0, interrupted: 0, confirmed: 0, blocked: 1 }; }
  const result = { inspected: 0, interrupted: 0, confirmed: 0,
    blocked: candidates.deferred + Number(Boolean(candidates.cursor_blocked)) };
  for (const [index, summary] of candidates.items.entries()) {
    const remaining = Math.floor(deadline - now());
    if (result.inspected >= MAX_REQUESTS || remaining <= 0) {
      result.blocked += candidates.items.length - index; break;
    }
    // Advance before a potentially failing RPC, so restart retries cannot starve later work.
    let work;
    try {
      runtime.store.advanceMutationRecoveryCursor(summary.work_id);
      work = runtime.store.get(summary.work_id);
    } catch (_error) { result.blocked += candidates.items.length - index; break; }
    if (!work?.attempt || !work.authority?.root_path || runtime.scheduler.active.has(work.work_id)
      || isTerminalTombstone(work.input)
      || !['paused', 'needs_attention', 'failed', 'cancelled'].includes(work.status)
      || (['failed', 'cancelled'].includes(work.status) && !['pause', 'cancel'].includes(work.control_request?.kind))
      || (work.status === 'paused' && !work.checkpoint_ref && (work.recovery?.kind !== 'restart_paused'
        || work.recovery.previous_status !== 'running'))) continue;
    try {
      if (service.sidecarClient.process !== process) throw new Error('mutation_recovery_process_changed');
      assertRuntimeContinuationProtocol(service.sidecarClient);
      if (work.checkpoint_ref) {
        const checkpoint = runtime.checkpointStore.read(work.checkpoint_ref, work);
        if (!checkpoint.mutation_ref) continue;
        const args = { work, reference: checkpoint.mutation_ref, decision: checkpoint.decision,
          completedRefs: checkpoint.completed_effect_refs };
        if (!runtime.mutationJournalProof.verify({ ...args, allowPreparing: true }).preparing) continue;
        const assertCurrent = () => stableJson(runtime.store.get(work.work_id)) === stableJson(work)
          && !runtime.scheduler.active.has(work.work_id) && service.sidecarClient.process === process;
        hydrateRuntimeContinuation({ work, checkpointStore: runtime.checkpointStore,
          conversationStore: runtime.conversationStore, assertCurrent, dependencyRuntime: { ...runtime,
            mutationJournalProof: { verify: args => runtime.mutationJournalProof.verify({ ...args, allowPreparing: true }) } } });
        result.inspected++;
        const response = await service.sidecarClient.request('workspace.confirm_runtime_checkpoint', {
          accept_version: '2026-08-17', schema_version: 1, checkpoint,
          workspace_root: work.authority.root_path, device_id: String(work.authority.device_id),
          inode: String(work.authority.inode),
        }, { timeoutMs: Math.min(3000, remaining) });
        if (response?.status !== 'confirmed' || !assertCurrent()
          || runtime.mutationJournalProof.verify(args).valid !== true) throw new Error('mutation_confirmation_unproven');
        result.confirmed++; continue;
      }
      if (runtime.checkpointStore.findCommittedForWork(work).status !== 'none') { result.blocked++; continue; }
      result.inspected++;
      const response = await service.sidecarClient.request('workspace.reconcile_runtime_preparations', {
        accept_version: '2026-08-17', schema_version: 1, work_id: work.work_id,
        session_id: work.session_id, turn_id: work.turn_id, source_attempt: work.attempt,
        workspace_root: work.authority.root_path, device_id: String(work.authority.device_id),
        inode: String(work.authority.inode),
      }, { timeoutMs: Math.min(3000, remaining) });
      if (response?.schema_version !== 1 || response.status !== 'reconciled'
        || !Number.isSafeInteger(response.interrupted) || response.interrupted < 0
        || service.sidecarClient.process !== process
        || stableJson(runtime.store.get(work.work_id)?.attempt) !== stableJson(work.attempt)) {
        throw new Error('mutation_recovery_unconfirmed');
      }
      result.interrupted += response.interrupted;
    } catch (_error) { result.blocked++; }
  }
  return result;
}
module.exports = { reconcileMutationPreparations };
