'use strict';

const { pauseRuntimeDecision } = require('../backend/runtime-decision-control');

const path = require('node:path');
const { createMutationJournalProof } = require('./mutation-journal-proof');
const { recoverPausedCancellations } = require('./paused-cancellation-recovery');
const { backfillCancelledPausedTurnEvents, repairCancelledPausedTurns } = require('../backend/runtime-paused-turn-backfill');
const { reconcileMutationPreparations } = require('./mutation-preparation-recovery');
const { createRuntimeTerminalRetention } = require('../backend/runtime-terminal-retention');
const { recoverCheckpointRetirements } = require('../backend/runtime-checkpoint-retention');
const { RuntimeLaneAdmission } = require('./lanes');
const { SessionRuntimeScheduler } = require('./scheduler');
const { RuntimeStore } = require('./store');
const { SessionRuntimeService } = require('./service');
const { SessionRuntimeChatAdapter } = require('../backend/session-runtime-chat-adapter');
const { ResourceBroker } = require('./resource-broker');
const { PhysicalPathResolver } = require('./physical-paths');
const { CheckpointStore } = require('./checkpoint-store');
const { RootRunBudgetStore } = require('./budgets');
const { RuntimeLineageStore } = require('./lineage-store');
const { recoverPublishedRuntimeContinuations } = require('../backend/runtime-continuation-recovery');
const { dependencyReady } = require('./dependency-proof');
const { RuntimeChildOperations } = require('./child-operations');
const { recoverRuntimeCancellationTrees } = require('./subtree-cancellation');
const { RuntimeEligibilityCoordinator } = require('./eligibility');

function initializeSessionRuntimeComposition(service) {
  if (!Object.hasOwn(service?.featureFlags || {}, 'session_runtime')) return null;
  const userDataPath = String(service?.options?.userDataPath || '').trim();
  if (!userDataPath || !service.sessionExecutionAuthority || !service.sessionStore) {
    throw new Error('session_runtime_production_composition_invalid');
  }
  const log = (level, event, details) => service._emitServiceLog?.(level, event, details);
  const limits = service.configService?.getState?.()?.sessionRuntime;
  const store = new RuntimeStore(path.join(userDataPath, 'session-runtime'), { logger: log });
  let scheduler;
  let eligibilityCoordinator;
  const lanes = new RuntimeLaneAdmission({ limits, onChange: () => {
    scheduler?.notifyLaneAvailability();
    eligibilityCoordinator?.wake();
  } });
  const resourceBroker = new ResourceBroker({ limits: limits?.resources });
  const pathResolver = new PhysicalPathResolver();
  const conversationStore = service.sessionStore.conversationStore;
  const checkpointStore = new CheckpointStore(path.join(userDataPath, 'session-runtime-checkpoints'), {
    validateCanonical: (continuation, work, options) => conversationStore.resolvePendingContinuation(continuation, work, options),
  });
  const mutationJournalProof = createMutationJournalProof(userDataPath);
  log('INFO', 'session_runtime.retirement_recovery', recoverCheckpointRetirements(service, {
    store, checkpointStore, conversationStore, mutationJournalProof }));
  const recovery = recoverPublishedRuntimeContinuations({
    runtimeStore: store,
    checkpointStore,
    conversationStore,
    sessionStore: service.sessionStore,
    journal: service.turnEventJournal,
    actorRegistry: service.sessionTurnActors,
    activeStreams: service.activeStreams,
    logger: log,
  });
  log('INFO', 'runtime_continuation.recovery_completed', recovery);
  const lineageStore = new RuntimeLineageStore(path.join(userDataPath, 'session-runtime-lineage'));
  const budgetStore = new RootRunBudgetStore(path.join(userDataPath, 'session-runtime-budgets'));
  const chatAdapter = new SessionRuntimeChatAdapter(service, {
    lanes, resourceBroker, pathResolver, checkpointStore, conversationStore, budgetStore,
  });
  scheduler = new SessionRuntimeScheduler({
    store,
    lanes,
    enabled: service.featureFlags.session_runtime === true,
    resolveRoute: work => chatAdapter.resolveRoute(work),
    validateWork: (work, route) => chatAdapter.validateWork(work, route),
    prepareCanonical: (work, route) => chatAdapter.prepareCanonical(work, route),
    claimCanonical: (work, route) => chatAdapter.claimCanonical(work, route),
    startProducer: context => chatAdapter.startProducer(context),
    pauseProducer: work => pauseRuntimeDecision(service, chatAdapter.contexts.get(work.work_id), work),
    cancelProducer: (work, reason, options) => chatAdapter.cancelProducer(work, reason, options),
    discardPending: work => chatAdapter.discardPending(work),
    provePausedCleanup: (work, options) => chatAdapter.provePausedCleanup(work, options),
    onAttention: details => log('ERROR', 'session_runtime.attention_required', details),
    onWorkChange: work => {
      eligibilityCoordinator?.wake();
      // A cancelled paused turn never reaches terminal finalization.
      try { backfillCancelledPausedTurnEvents(conversationStore, work); } catch (error) {
        log('WARN', 'session_runtime.paused_turn_backfill_failed', { message: String(error?.message || error) });
      }
    },
    captureEligibility: sessionId => eligibilityCoordinator?.captureAdmission(sessionId),
    releaseEligibility: admission => eligibilityCoordinator?.releaseAdmission(admission),
    onSuspended: ({ work, waitResources, admission }) => eligibilityCoordinator
      ?.track(work.work_id, waitResources, { admission }),
    validateCheckpoint: (work, reference) => checkpointStore.validate(work, reference),
  });
  let runtime;
  eligibilityCoordinator = new RuntimeEligibilityCoordinator({
    broker: resourceBroker,
    incarnation: scheduler.incarnation,
    getWork: workId => store.get(workId),
    dependencyReady: (work, childWorkId) => dependencyReady(runtime, work, childWorkId),
    resume: (workId, revision) => runtime.resume(workId, revision),
    enabled: service.featureFlags.session_runtime === true,
    canDispatch: () => !scheduler.closing,
    onAttention: details => log('ERROR', 'session_runtime.eligibility_attention_required', details),
  });
  runtime = new SessionRuntimeService({ store, scheduler, chatAdapter, resourceBroker, pathResolver,
    checkpointStore, budgetStore, lineageStore, conversationStore, eligibilityCoordinator });
  runtime.mutationJournalProof = mutationJournalProof;
  runtime.reconcileMutationPreparations = () => reconcileMutationPreparations(service, runtime);
  runtime.recoverPausedCancellations = () => recoverPausedCancellations(runtime);
  service.sessionRuntime = runtime;
  runtime.children = new RuntimeChildOperations(runtime, service);
  log('INFO', 'session_runtime.cancellation_recovery', recoverRuntimeCancellationTrees(runtime));
  runtime.maintainTerminalDetail = createRuntimeTerminalRetention(service, runtime);
  runtime.maintainTerminalDetail();
  // One repair pass per start; cache availability fires on every settled
  // write, so it only retries a pass that had failed rows (at most 3 passes).
  let pausedTurnRepairPasses = 0;
  const repairPausedTurns = () => {
    if (pausedTurnRepairPasses < 0 || pausedTurnRepairPasses >= 3) return;
    const { appended, failed } = repairCancelledPausedTurns(store, conversationStore);
    pausedTurnRepairPasses = failed ? pausedTurnRepairPasses + 1 : -1;
    if (appended || failed) log('INFO', 'session_runtime.paused_turn_backfill_repaired', { appended, failed });
  };
  repairPausedTurns();
  service.sessionStore.onTranscriptCacheAvailable?.(() => {
    if (service.sessionRuntime === runtime) {
      repairPausedTurns();
      scheduler.notifyLaneAvailability();
      eligibilityCoordinator.wake();
    }
  });
  return runtime;
}

module.exports = { initializeSessionRuntimeComposition };
