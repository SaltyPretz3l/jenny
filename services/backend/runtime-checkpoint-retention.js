'use strict';

const { hasDurableProof } = require('./conversation-store-port');
const { assertRetirementWork } = require('../session-runtime/checkpoint-retirement');
const { validateWorkRecord, stableJson } = require('../session-runtime/contracts');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function assertMutationRetired(runtime, work, checkpoint) {
  if (checkpoint?.mutation_ref && runtime.mutationJournalProof?.verify({
    work: { ...work, attempt: checkpoint.source_attempt }, reference: checkpoint.mutation_ref,
    decision: checkpoint.decision, completedRefs: checkpoint.completed_effect_refs,
    historical: true, requireTerminal: true })?.valid !== true) fail('checkpoint_retirement_mutation_unsettled');
}
function finishRetirement(service, runtime, saved) {
  let work = runtime.store.get(saved.identity.work_id);
  assertRetirementWork(saved, work);
  assertMutationRetired(runtime, work, saved.continuation);
  if (service.sessionStore.hasPendingWrites() !== false
    || service.sessionStore.getSession(work.session_id)?.active_turn
    || service.turnEventJournal.list(work.session_id, work.turn_id).length
    || service.sessionTurnActors?.getQueuedSubmissionBlock(work.session_id)) fail('checkpoint_retirement_session_busy');
  if (work.checkpoint_ref?.checkpoint_id === saved.reference.checkpoint_id) {
    if (stableJson(work.checkpoint_ref) !== stableJson(saved.reference)) fail('checkpoint_retirement_reference_conflict');
    runtime.store._assertWritable();
    const checked = validateWorkRecord({ ...work, checkpoint_ref: null, revision: work.revision + 1 });
    if (!checked.ok) fail(checked.reason);
    runtime.store._commit(checked.record);
    work = runtime.store.get(work.work_id);
  }
  return runtime.checkpointStore.completeRetirement(saved.reference, work, item => hasDurableProof(
    runtime.conversationStore.removePendingContinuation(work.session_id, item.reference.checkpoint_id,
      item.reference.source_attempt, { durable: true })));
}
function retireWorkCheckpoints(service, runtime, work, at) {
  const records = runtime.checkpointStore.retirementRecords(work.work_id).filter(row => row.state !== 'retired');
  if (!records.length) return;
  if (records.some(row => row.state === 'preparing')) fail('checkpoint_retirement_preparing');
  const session = service.sessionStore.getSession(work.session_id);
  const entries = session?.runtime_continuations?.entries || [];
  // Validate the entire set before the first intent. The canonical owner records
  // inherited dependencies in publication order; remove newest first.
  for (const row of records) {
    if (row.state === 'committed') {
      assertMutationRetired(runtime, work, runtime.checkpointStore.readHistorical(row.reference, { ...work, attempt: row.reference.source_attempt }));
    } else assertRetirementWork(row, work);
  }
  const byId = new Map(records.map(row => [row.reference.checkpoint_id, row]));
  if (entries.some(entry => entry.body.work_id === work.work_id && !byId.has(entry.checkpoint_id))) {
    fail('checkpoint_retirement_artifact_unregistered');
  }
  records.sort((a, b) => entries.findIndex(entry => entry.checkpoint_id === b.reference.checkpoint_id)
    - entries.findIndex(entry => entry.checkpoint_id === a.reference.checkpoint_id));
  for (const row of records) {
    const current = runtime.store.get(work.work_id);
    const saved = runtime.checkpointStore.beginRetirement(row.reference, current, at);
    finishRetirement(service, runtime, saved);
  }
}
function recoverCheckpointRetirements(service, runtime) {
  let completed = 0;
  let blocked = 0;
  try {
    for (const saved of runtime.checkpointStore.retirementRecords().filter(row => row.state === 'retiring')) {
      try { finishRetirement(service, runtime, saved); completed++; }
      catch (_error) { blocked++; }
    }
  } catch (_error) { blocked++; }
  return { completed, blocked };
}
module.exports = { retireWorkCheckpoints, recoverCheckpointRetirements };
