'use strict';

const { assertRuntimeContinuationProtocol, supportsRuntimeContinuationProtocol } = require('../session-runtime/inference-protocol');
const { createManagedContinuationBoundary } = require('./runtime-continuation-managed');
const { captureRuntimeContinuationHistory } = require('./runtime-continuation-history');
const { applyCompactionSnapshotToHistory } = require('./session-compaction-snapshot');
const { prepareResumedHistory } = require('./managed-sidecar-chat-helpers');

function prepareManagedCheckpointHistory(service, runtimeContinuation) {
  const hydration = runtimeContinuation?.resumeHydration;
  if (!hydration) return null;
  const view = hydration.historyView();
  const compactedHistory = view.compactionSnapshot
    ? applyCompactionSnapshotToHistory(view.compactionSnapshot, view.canonicalHistoryMessages)
    : { applied: false, messages: view.canonicalHistoryMessages };
  if (view.compactionSnapshot && !compactedHistory.applied) throw new Error('runtime_resume_compaction_unavailable');
  return { ...view, compactedHistory,
    preparedMessages: hydration.buildMessages({ hydrateHistory: messages => prepareResumedHistory(service, { messages }) }) };
}

// Negotiated after sidecar readiness and before dispatch. Legacy initial sends
// retain their existing behavior; a checkpoint resume never falls back to a new
// generation when the paired receiver cannot consume its saved tool batch.
function createManagedContinuationSend({ service, runtimeContinuation, gateway, collector,
  canonicalSessionMessages, contextPreferences, compactedHistory, sessionSummary, traceId, controller, activateCanonical } = {}) {
  if (!runtimeContinuation) return null;
  if (!supportsRuntimeContinuationProtocol(service.sidecarClient)) {
    if (runtimeContinuation.resumeHydration) assertRuntimeContinuationProtocol(service.sidecarClient);
    return null;
  }
  if (collector?.canonicalPrimary !== true) activateCanonical?.();
  if (collector?.canonicalPrimary !== true || gateway?.enableContinuation?.() !== true) {
    throw new Error('runtime_continuation_canonical_protocol_required');
  }
  const assertProtocol = () => assertRuntimeContinuationProtocol(service.sidecarClient);
  const fields = { continuation_context: runtimeContinuation.context };
  if (runtimeContinuation.resumeHydration) {
    fields.runtime_continuation_resume = runtimeContinuation.resumeHydration.buildResumeFields({
      work: runtimeContinuation.getCurrentWork(), context: runtimeContinuation.context,
    });
  }
  function bindFrame(frameFit) {
    if (frameFit.outcome.fitsBudget !== true || (runtimeContinuation.resumeHydration
      && frameFit.outcome.historyScopeFallback !== null)) throw new Error('runtime_continuation_frame_unavailable');
    const historySelector = runtimeContinuation.resumeHydration?.historyView().historySelector
      || captureRuntimeContinuationHistory({ canonicalSessionMessages, contextPreferences,
        compactedHistory, sessionSummary, frameOutcome: frameFit.outcome });
    const boundary = createManagedContinuationBoundary({ ...runtimeContinuation, assertProtocol, gateway,
      collector, historySelector, traceId, signal: controller?.signal, dependencyRuntime: service.sessionRuntime,
      onPublicationFailure: details => service._emitServiceLog?.('WARN', 'session_runtime.continuation_publication_failed', {
        ...details, sessionId: collector.sessionId, streamId: runtimeContinuation.context.source_attempt.stream_id,
      }) });
    if (controller) controller._runtimeDecisionControl = boundary.decisionControl;
    return boundary;
  }
  return Object.freeze({ fields, bindFrame, assertProtocol });
}

module.exports = { prepareManagedCheckpointHistory, createManagedContinuationSend };
