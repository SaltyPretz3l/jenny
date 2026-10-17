'use strict';

/* The producer of one exact-command Run turn (row 59 checkpoint 3, Batch B).
 *
 * A sibling of startManagedSidecarChatStream, not a branch of it: it reuses the
 * same exported seams (turn-actor lease, CanonicalTurnEventCollector, the managed
 * stream runtime, buildManagedSidecarChatSendOptions, the settlement helpers)
 * but resolves no model, takes no inference lease, assembles no history or
 * context, and calls `command.execute_proposal` instead of `chat.send`. It never
 * falls back to chat.send. The sidecar owns policy, approval and execution of the
 * ONE run_command call; this module owns the transcript line (Electron authors
 * the deterministic completion copy) and the two application events a proposal
 * service listens to:
 *   command-proposal-progress {schema_version, session_id, proposal_id, decision_id,
 *     work_id, turn_id, status: pending_approval|running}
 *   command-proposal-outcome  {... status: succeeded|failed|denied|cancelled|
 *     interrupted_unknown, exit_code: int|null, cleanup: confirmed|uncertain|null}
 * Outcome is emitted exactly once per run, and `interrupted_unknown` whenever no
 * structured outcome could be read. No event or log line carries the command text.
 */

const crypto = require('node:crypto');
const { t } = require('../i18n-main');
const { API_VERSION } = require('./sidecar-client');
const { CANCEL_DRAIN_MS, commandExecuteProposal } = require('./sidecar-client-command-proposal');
const { waitForToolApproval, handleToolNotification } = require('./chat-stream-tool-handling');
const { createManagedChatStreamRuntime } = require('./chat-stream-managed-runtime');
const { CanonicalTurnEventCollector } = require('./canonical-turn-event-collector');
const { buildManagedSidecarChatSendOptions } = require('./electron-tool-bridge');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const { createChatStreamWatchdog } = require('./managed-sidecar-chat-helpers');
const { waitForManagedInitialization } = require('./managed-sidecar-chat-reconnect');
const { finishManagedRuntimeCompletion, noteRuntimeInferenceSettlement } = require('./managed-sidecar-terminal-cleanup');
const { settleHostedExecution } = require('./hosted-execution-settlement');
const { noteToolObservationPromotions } = require('./tool-observation-promotion');
const { buildManagedStartResult, retainManagedRuntimeController } = require('./chat-lifecycle-contracts');
const { retainRuntimeSettlementHandler } = require('./sidecar-client-request-rpc');
const { assertCommandProposalProtocol, assertRuntimeOperationsProtocol } = require('../session-runtime/inference-protocol');
const {
  CANCEL_REASON_SESSION_DELETE, CANCEL_REASON_TIMEOUT, CANCEL_REASON_USER,
  TERMINAL_STATUS_COMPLETED, buildTerminalErrorPayload, createCancellationError,
  enrichTerminalErrorPayloadForEmit, resolveTerminalRouting, streamErrorDetailsFromAbortSignal,
} = require('./chat-stream-terminal-utils');

const REQUEST_SETTLE_GRACE_MS = 1_000; // matches managed-sidecar-chat's chat.send settle grace

const OUTCOME_STATUSES = new Set(['succeeded', 'failed', 'denied', 'cancelled', 'interrupted_unknown']);
const FAULT_ERROR = 'The command could not be started.';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

// A Run uses the approval mode the session is in, exactly as a model-issued call.
function approvalModeForSession(session) {
  return session?.run_mode === 'auto' ? 'auto_run' : 'prompt';
}

function readCommandOutcome(result) {
  const outcome = result && typeof result === 'object' ? result.command_outcome : null;
  if (!outcome || typeof outcome !== 'object' || outcome.schema_version !== 1
    || !OUTCOME_STATUSES.has(outcome.status)) return null;
  return Object.freeze({
    status: outcome.status,
    exit_code: Number.isSafeInteger(outcome.exit_code) ? outcome.exit_code : null,
    cleanup: outcome.cleanup === 'confirmed' || outcome.cleanup === 'uncertain' ? outcome.cleanup : null,
  });
}

// Electron owns the visible completion copy; the sidecar's response_text is only
// a fallback string and is never shown for a run that produced an outcome.
function completionLine(outcome, { notStarted = false } = {}) {
  const code = outcome?.exit_code;
  const known = Number.isSafeInteger(code);
  if (notStarted) return t('commandProposal.completion.notStarted', 'Command could not be started. Nothing ran.');
  switch (outcome?.status) {
    case 'succeeded': return known
      ? t('commandProposal.completion.succeeded', 'Command finished (exit {code}).', { code })
      : t('commandProposal.completion.succeededNoCode', 'Command finished.');
    case 'failed': return known
      ? t('commandProposal.completion.failed', 'Command failed (exit {code}).', { code })
      : t('commandProposal.completion.failedNoCode', 'Command failed.');
    case 'denied': return t('commandProposal.completion.denied', 'Command was denied. Nothing ran.');
    case 'cancelled': return t('commandProposal.completion.cancelled', 'Command was cancelled.');
    default: return t('commandProposal.completion.unknown', 'Command outcome unknown.');
  }
}

function eventIdentity(work, proposal) {
  return Object.freeze({
    schema_version: 1, session_id: work.session_id, proposal_id: proposal.proposal_id,
    decision_id: proposal.decision_id, work_id: work.work_id, turn_id: work.turn_id,
  });
}

// Exactly once per run, however it ends. An absent outcome is interrupted_unknown.
function createOutcomeEmitter(service, identity) {
  let emitted = false;
  const progressSent = new Set();
  return {
    progress(status) {
      if (emitted || progressSent.has(status)) return;
      progressSent.add(status);
      try { service.emit('command-proposal-progress', { ...identity, status }); } catch (_error) { /* a listener never changes the run */ }
    },
    outcome(outcome) {
      if (emitted) return false;
      emitted = true;
      const value = outcome || { status: 'interrupted_unknown', exit_code: null, cleanup: 'uncertain' };
      try {
        service.emit('command-proposal-outcome', { ...identity, status: value.status,
          exit_code: Number.isSafeInteger(value.exit_code) ? value.exit_code : null, cleanup: value.cleanup ?? null });
      } catch (_error) { /* a listener never changes the run */ }
      return true;
    },
    get emitted() { return emitted; },
  };
}

function refusal(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function buildRequestParams({ service, proposal, work, turnLease, requestId, traceId, executionContext, approvalMode }) {
  const chatUi = service.configService?.getChatUiState?.();
  const session = service.sessionStore.getSessionSummary?.(work.session_id);
  const { command_binding: binding, command_input: input } = proposal;
  return {
    accept_version: API_VERSION,
    schema_version: 1,
    request_id: requestId,
    trace_id: traceId,
    session_id: work.session_id,
    generation: turnLease.identity.generation,
    // The mode captured with the Run's binding at submit, so the wire matches what was admitted.
    approval_mode: approvalMode || approvalModeForSession(session),
    ...(chatUi ? { safety_mode: chatUi.safetyMode, auto_approve_streak_cap: chatUi.autoApproveStreakCap } : {}),
    plan_mode: false,
    turn_id: work.turn_id,
    operation_id: proposal.command_operation_id,
    proposal_id: proposal.proposal_id,
    accepted_revision: proposal.accepted_revision,
    decision_id: proposal.decision_id,
    command_sha256: proposal.command_sha256,
    tool_call_id: proposal.tool_call_id,
    execution_context: executionContext,
    binding: { backend: binding.backend, shell: binding.shell, cwd: binding.cwd, root_revision: binding.root_revision },
    input: { command: input.command, cwd: input.cwd, timeout_seconds: input.timeout_seconds,
      expected_exit_codes: [...input.expected_exit_codes], purpose: input.purpose },
  };
}

async function startCommandProposalTurn(service, { work, proposal, turnLease, runtimeAdmission = null,
  runtimeExecutionAuthority, runtimeOperationGateway = null, runtimeAssertCurrent = null,
  runtimeOnInferenceSettlement = null, approvalMode = null }) {
  const sessionId = work.session_id;
  const transcriptPrompt = String(turnLease.prompt || '').trim();
  const actorRegistry = ensureSessionTurnActorRegistry(service);
  const { streamId, turnId, userMessageId } = turnLease.identity;
  const requestId = streamId;
  const controller = new AbortController();
  controller.traceId = streamId;
  if (!actorRegistry.attachController(turnLease, controller)) {
    throw createCancellationError(CANCEL_REASON_SESSION_DELETE, 'Session deleted before the stream could start.');
  }
  const events = createOutcomeEmitter(service, eventIdentity(work, proposal));
  let runtimeCompletion = { status: 'failed', producerSettled: false, canonicalSettled: false };
  const pendingRun = (async () => {
    await new Promise((resolve) => setImmediate(resolve));
    let streamTimeoutError = null;
    let restartReason = '';
    let terminalState;
    let terminalSettledAt;
    let requestSent = false;
    let commandOutcome = null;
    const canonicalBridge = service.featureFlags?.canonical_bridge === true
      && service.featureFlags?.canonical_turn_events === true;
    const turnEventCollector = new CanonicalTurnEventCollector({
      store: service.sessionStore, turnId, attemptId: streamId, sessionId,
      journal: service.turnEventJournal, canonicalPrimary: canonicalBridge,
      featureFlags: service.featureFlags || null,
      logger: typeof service._emitServiceLog === 'function'
        ? (level, event, details) => service._emitServiceLog(level, event, details) : null,
    });
    const normalizedPreferences = { plan_mode: false };
    const watchdog = createChatStreamWatchdog({
      isAborted: () => controller.signal.aborted,
      onTimeout: (message) => {
        if (controller.signal.aborted) return;
        streamTimeoutError = createCancellationError(CANCEL_REASON_TIMEOUT, message);
        controller.abort(streamTimeoutError);
      },
    });
    watchdog.armAbsolute();
    watchdog.noteActivity();
    const runtime = createManagedChatStreamRuntime({
      service, resolvedSessionId: sessionId, streamId, traceId: streamId, normalizedPreferences,
      normalizedInteractiveResponse: null, normalizedAttachments: [], transcriptPrompt, userMessageId,
      turnLease, runtimeAdmission, turnEventCollector, canonicalBridge,
      isUserStop: () => controller.signal.reason?.cancel_reason === CANCEL_REASON_USER,
      onVisibleCompletion: () => watchdog.clear(),
    });
    if (runtimeAdmission) service.emit('chat-stream', { type: 'started', ...runtime.getEventBase() });
    try {
      if (controller.signal.aborted) throw streamTimeoutError || new Error('Stream cancelled.');
      runtime.persistUserMessage();
      runtimeAssertCurrent?.();
      const executionAuthority = runtimeExecutionAuthority;
      const executionContext = service.sessionExecutionAuthority.toExecutionContext(executionAuthority);
      const { command_binding: binding, command_input: input } = proposal;
      if (binding.root_revision !== executionContext.root_revision) {
        throw refusal('command_proposal_authority_changed', FAULT_ERROR);
      }
      if (sha256Hex(input.command) !== proposal.command_sha256) {
        throw refusal('command_proposal_hash_mismatch', FAULT_ERROR);
      }
      // A sidecar without the method fails the Run closed; it never becomes chat.send.
      assertCommandProposalProtocol(service.sidecarClient);
      if (runtimeOperationGateway) assertRuntimeOperationsProtocol(service.sidecarClient);
      await waitForManagedInitialization(service, controller.signal);
      const client = service.sidecarClient;
      if (!client?.process || client.connected === false) {
        throw refusal('command_proposal_sidecar_unavailable', FAULT_ERROR);
      }
      const toolContext = {
        seenToolCalls: new Set(), toolSummaries: new Map(),
        workspaceRoot: service.sessionExecutionAuthority.requireCurrent(executionAuthority).root_path || '',
        executionAuthority, model: 'command', resolvedSessionId: sessionId, streamId,
        adapter: runtime.adapter, turnEventCollector,
        get eventBase() { return runtime.getEventBase(); },
      };
      const params = buildRequestParams({ service, proposal, work, turnLease, requestId, traceId: streamId, executionContext,
        approvalMode });
      const onCommandApproval = (...args) => {
        if (String(args[4]?.tool_call_id || '') === proposal.tool_call_id) events.progress('pending_approval');
        return waitForToolApproval(...args);
      };
      const onCommandNotification = (svc, context, notification, options) => {
        if (notification?.method === 'tool.executing'
          && String(notification.params?.tool_call_id || '') === proposal.tool_call_id) events.progress('running');
        return handleToolNotification(svc, context, notification, options);
      };
      const runtimeOperationHandler = (operation) => {
        const result = ['inference', 'tool'].includes(operation?.kind) && runtimeOperationGateway
          ? runtimeOperationGateway.handle(operation)
          : service.sessionExecutionAuthority.checkRuntimeOperation(executionAuthority, operation);
        return noteRuntimeInferenceSettlement(operation, result, runtimeOnInferenceSettlement);
      };
      if (runtimeOperationGateway) {
        controller._runtimeSettlementUnregister = retainRuntimeSettlementHandler(client, requestId, runtimeOperationHandler);
      }
      const options = buildManagedSidecarChatSendOptions({
        service, controller, streamId, resolvedSessionId: sessionId, requestId, requestTraceId: streamId,
        runtime, toolContext, handleToolNotification: onCommandNotification, waitForToolApproval: onCommandApproval,
        turnEventCollector, normalizedPreferences,
        noteStreamActivity: watchdog.noteActivity, pauseStreamIdleTimer: watchdog.pauseForApproval,
        executionAuthority, turnIdentity: turnLease.identity,
        commandResourceStartToolCallId: proposal.tool_call_id,
      });
      runtimeAssertCurrent?.();
      requestSent = true;
      // The transport deadline is the turn's working-time budget (approval waits included) plus room
      // for the cancel drain, as chat.send does; the watchdog owns the absolute stop.
      const result = await commandExecuteProposal(client, params, {
        ...options, onRuntimeOperation: runtimeOperationHandler,
        timeoutMs: watchdog.getCeilings().absoluteTimeoutMs + REQUEST_SETTLE_GRACE_MS + CANCEL_DRAIN_MS,
      });
      // An answer that arrived during the cancel drain keeps the sidecar's real outcome.
      commandOutcome = readCommandOutcome(result);
      if (controller.signal.aborted) throw streamTimeoutError || new Error('Stream cancelled.');
      noteToolObservationPromotions({ turnEventCollector, observations: result?.tool_observations,
        requestId, turnId, logger: service._emitServiceLog?.bind(service),
        logContext: { sessionId, streamId, traceId: streamId } });
      commandOutcome ||= { status: 'interrupted_unknown', exit_code: null, cleanup: 'uncertain' };
      await settleHostedExecution(service, streamId);
      // A turn that ended because of the command (done, denied, cancelled) is a completed
      // transcript turn whose line Electron authors; anything else settles as sidecar failure.
      const terminalResult = ['completed', 'denied', 'cancelled'].includes(result?.status)
        ? { ...result, status: 'completed', terminal_subcode: undefined,
          response_text: completionLine(commandOutcome), completion_source: 'command_proposal' }
        : result;
      await require('../execution/execution-settlement').settleExecution(service, streamId);
      const settled = await runtime.settleTerminalResult(terminalResult);
      terminalState = String(settled?.status || '').trim() || TERMINAL_STATUS_COMPLETED;
      terminalSettledAt = Date.now();
    } catch (error) {
      const userAbort = controller.signal.aborted && !streamTimeoutError;
      const effectiveError = streamTimeoutError || (controller.signal.aborted
        ? streamErrorDetailsFromAbortSignal(controller.signal).error : error);
      if (streamTimeoutError) restartReason = 'chat.timeout';
      runtime.emitThinkingStatus('');
      const { sidecarErrorCode, sidecarErrorRetryable, sidecarTerminalSubcode } = runtime.getErrorState();
      const payload = buildTerminalErrorPayload(effectiveError,
        streamTimeoutError ? 'timeout' : (controller.signal.aborted ? 'cancelled' : undefined));
      if (sidecarErrorCode && !payload.error_code) payload.error_code = sidecarErrorCode;
      if (sidecarErrorRetryable === false) payload.retryable = false;
      if (sidecarTerminalSubcode && !payload.terminal_subcode) payload.terminal_subcode = sidecarTerminalSubcode;
      await settleHostedExecution(service, streamId, payload);
      await require('../execution/execution-settlement').settleExecution(service, streamId, payload);
      // A lost sidecar result can precede Electron's cancelled Docker receipt.
      // Let the actual drain classify that unproven failure; retain known exits.
      if (userAbort && proposal.command_binding.backend === 'docker'
        && commandOutcome?.status === 'failed' && commandOutcome.exit_code === null
        && commandOutcome.cleanup === null) commandOutcome = null;
      if (!commandOutcome) {
        if (!requestSent) commandOutcome = { status: userAbort ? 'cancelled' : 'failed', exit_code: null, cleanup: null };
        else if (userAbort && proposal.command_binding.backend === 'docker' && service.commandSandbox?.enabled === true
          && payload.terminal_subcode !== 'execution_uncertain') {
          commandOutcome = { status: 'cancelled', exit_code: null, cleanup: 'confirmed' }; // the sandbox drain proved cleanup
        } else commandOutcome = { status: 'interrupted_unknown', exit_code: null, cleanup: 'uncertain' };
      }
      service._emitServiceLog?.('WARN', 'command_proposal.turn_failed', {
        sessionId, streamId, requestSent, status: payload.status, errorCode: payload.error_code || null });
      // A refused, lost or unproven Run still ends in the deterministic transcript line (the sidecar's
      // own error text is not the copy). A user stop and an unconfirmed sandbox cleanup keep the
      // ordinary cancelled / failed terminal, which says so itself.
      let lined = false;
      if (!userAbort && payload.terminal_subcode !== 'execution_uncertain' && !runtime.isVisibleCompletionEmitted()) {
        try {
          lined = (await runtime.emitDeterministicCompletion(completionLine(commandOutcome, { notStarted: !requestSent }))) === true;
        } catch (_lineError) { lined = false; }
      }
      const terminal = lined ? null : resolveTerminalRouting({ status: payload.status,
        terminalSubcode: payload.terminal_subcode, visibleCompletionEmitted: runtime.isVisibleCompletionEmitted() });
      terminalState = terminal ? terminal.status : TERMINAL_STATUS_COMPLETED;
      terminalSettledAt = Date.now();
      if (terminal?.logOnlyLateFailure) {
        if (!runtime.isTerminalCoordinatorHandled()) runtime.clearReconnectStateOnFailure();
      } else if (terminal) {
        const coordinated = await runtime.settleFailureTerminal(payload, terminal);
        if (!coordinated.handled) {
          if (runtime.shouldPersistFailureMessage() && terminal.persistAssistantFailure) runtime.persistFailureMessage(payload);
          else runtime.clearReconnectStateOnFailure();
          if (terminal.emitErrorEvent) {
            service.emit('chat-stream', { type: 'error', ...enrichTerminalErrorPayloadForEmit(payload, {
              terminalStatus: terminal.status, terminalSubcode: terminal.terminalSubcode }), ...runtime.getEventBase() });
          }
        }
      }
    } finally {
      watchdog.clear();
      try {
        runtimeCompletion = await finishManagedRuntimeCompletion({
          service, runtime, actorRegistry, lease: turnLease, turnEventCollector, sessionId, streamId,
          terminalStatus: terminalState ?? 'cancelled', deferredQuestionBatchEvent: null, runtimeOperationGateway,
          terminalSettledAt, managedSidecarRestartReason: restartReason, requestTraceId: streamId,
        });
      } finally { events.outcome(commandOutcome); }
    }
  })();
  controller._pendingPromise = pendingRun;
  controller._runtimeCompletion = pendingRun.then(() => runtimeCompletion, () => runtimeCompletion);
  controller._commandProposalEvents = events;
  return retainManagedRuntimeController(buildManagedStartResult(service, {
    sessionId, streamId, identity: turnLease.identity }), controller);
}

module.exports = {
  approvalModeForSession,
  completionLine,
  createOutcomeEmitter,
  eventIdentity,
  readCommandOutcome,
  sha256Hex,
  startCommandProposalTurn,
};
