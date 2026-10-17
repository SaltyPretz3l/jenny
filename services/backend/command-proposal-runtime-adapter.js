'use strict';

/* The runtime adapter for durable `command_proposal` work (row 59 checkpoint 3,
 * Batch B). It implements the scheduler ports for one exact-command Run, beside
 * SessionRuntimeChatAdapter, and differs from it on purpose:
 *   - the route is the synthetic cloud-class command route, restored here and
 *     never looked up in the provider registry, so a Run keeps the per-session
 *     serialization but never takes the local GPU turn slot;
 *   - no model resolution, no inference lease, no model-switch gate;
 *   - the producer is startCommandProposalTurn (command.execute_proposal);
 *   - restart-paused or abandoned command work is never resumed or re-run: it has
 *     no checkpoint, resume refuses the kind, and the scheduler only dispatches
 *     work that was registered by this process.
 */

const { captureRuntimeRoute } = require('../session-runtime/lanes');
const { RuntimeOperations } = require('../session-runtime/operations');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { isSessionOfflineLockdownActive } = require('./session-lockdown-gate');
const { assertChatTurnAdmissible, assertRuntimeTranscriptAdmission } = require('./chat-turn-admission');
const { getManagedRuntimeController } = require('./chat-lifecycle-contracts');
const { approvalModeForSession, startCommandProposalTurn, createOutcomeEmitter,
  eventIdentity } = require('./command-proposal-turn');
const { stableJson } = require('../session-runtime/contracts');
const { normalizeCommandProposal, COMMAND_PROPOSAL_KIND } = require('./command-proposal-input');
const { t } = require('../i18n-main');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
// One module-level route: the scheduler requires a branded runtime route object.
const COMMAND_ROUTE = captureRuntimeRoute({
  configuration_revision: 'command-proposal-v1', engine_type: 'command', provider_id: 'jenny-command',
  requires_gpu: false, resource_class: 'cloud',
});

function sameAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function codedError(code, { retryable = false } = {}) {
  return Object.assign(new Error(code), { code, retryable });
}

// A run-mode flip while a Run waits fails it visibly: the Run was admitted under the captured mode,
// and a retryable stop would leave the card on "Queued" until the user flips back.
function assertCommandAuthorityCurrent(trusted) {
  try {
    trusted.assertCurrent();
  } catch (error) {
    if (error?.code === 'run_mode_changed' && error.retryable === true) error.retryable = false;
    throw error;
  }
}

function terminalStatus(value) {
  return TERMINAL_STATUSES.has(value) ? value : 'failed';
}

function visiblePromptFor(proposal) {
  const purpose = Array.from(proposal.command_input.purpose.replace(/\s+/gu, ' ').trim()).slice(0, 200).join('');
  return t('commandProposal.visiblePrompt', 'Run: {purpose}', { purpose });
}

class CommandProposalRuntimeAdapter {
  constructor(service, { lanes, resourceBroker, pathResolver } = {}) {
    if (!service?.sessionStore || !service?.sessionExecutionAuthority || !lanes || !resourceBroker || !pathResolver) {
      throw new TypeError('command_proposal_adapter_dependencies_invalid');
    }
    this.service = service;
    this.lanes = lanes;
    this.resourceBroker = resourceBroker;
    this.pathResolver = pathResolver;
    this.contexts = new Map();
  }

  isCommandWork(work) {
    return work?.input?.kind === COMMAND_PROPOSAL_KIND;
  }

  assertSubmissionSession(sessionId) {
    const summary = this.service.sessionStore.getSessionSummary(sessionId);
    if (!summary) throw new Error('runtime_session_unavailable');
    // Offline lockdown removes run_command from model turns; a Run must not reopen it.
    if (isSessionOfflineLockdownActive(this.service.featureFlags, summary)) throw codedError('command_proposal_lockdown');
    const actors = this.service.sessionTurnActors || this.service.sessionTurnActorRegistry;
    const blocked = actors?.getQueuedSubmissionBlock(sessionId);
    if (blocked) throw new Error(blocked);
  }

  prepareSubmission(sessionId, commandProposal, { workId, turnId } = {}) {
    const proposal = normalizeCommandProposal(commandProposal);
    if (typeof sessionId !== 'string' || !sessionId || !workId || !turnId) {
      throw new TypeError('command_proposal_request_invalid');
    }
    this.assertSubmissionSession(sessionId);
    if (this.service.commandSandbox?.transition) {
      throw codedError('command_sandbox_transition', { retryable: true });
    }
    const session = this.service.sessionStore.getSessionSummary(sessionId);
    const executionOptions = { signal: null, mode: 'assist', readOnly: false, toolPreferences: null,
      approvalMode: approvalModeForSession(session) };
    const binding = this.service.sessionExecutionAuthority.captureSession(sessionId,
      { requestId: workId, ...executionOptions });
    const trusted = getTrustedExecutionBinding(binding);
    if (!trusted) {
      this.service.sessionExecutionAuthority.close(binding);
      throw new Error('session_runtime_execution_authority_invalid');
    }
    if (trusted.readOnly === true || trusted.mode === 'plan'
      || trusted.authority.root_revision !== proposal.command_binding.root_revision) {
      this.service.sessionExecutionAuthority.close(binding);
      throw codedError(trusted.readOnly === true || trusted.mode === 'plan'
        ? 'command_proposal_read_only' : 'command_proposal_authority_changed');
    }
    return {
      authority: trusted.authority, binding, trusted, executionOptions, sessionId, workId, turnId, proposal,
      kind: COMMAND_PROPOSAL_KIND, route: COMMAND_ROUTE, visiblePrompt: visiblePromptFor(proposal),
      input: Object.freeze({ schema_version: 1, kind: COMMAND_PROPOSAL_KIND, route: { ...COMMAND_ROUTE }, ...proposal }),
      awaitingAcknowledgement: false, cancelled: false, lease: null, runtimeOperationGateway: null,
    };
  }

  validateSubmission(prepared) {
    this.assertSubmissionSession(prepared.sessionId);
    if (this.service.commandSandbox?.transition) throw codedError('command_sandbox_transition', { retryable: true });
    prepared.trusted.assertCurrent();
    assertChatTurnAdmissible(this.service, prepared.sessionId, prepared.route);
    return true;
  }

  register(workId, prepared) {
    if (this.contexts.has(workId)) throw new Error('session_runtime_context_conflict');
    this.contexts.set(workId, prepared);
  }

  discard(prepared) {
    if (!prepared) return false;
    if (this.contexts.get(prepared.workId) === prepared) this.contexts.delete(prepared.workId);
    this.service.sessionExecutionAuthority.close(prepared.binding);
    return true;
  }

  discardPending(work) {
    const context = this.contexts.get(work?.work_id);
    if (!context || context.lease) return false;
    this.contexts.delete(work.work_id);
    this.service.sessionExecutionAuthority.close(context.binding);
    this.settleNeverStarted(work, context);
    return true;
  }

  // Command work is never resumed (DB7), so work the scheduler pauses, refuses or cancels before
  // startProducer never ran. Settle its card once the scheduler's own transition has landed (a
  // proposal Cancel settles it first, and the late event is then a no-op).
  settleNeverStarted(work, context) {
    setImmediate(() => {
      const stored = this.service.sessionRuntime?.getApplicationWork?.(work.work_id);
      const status = (stored?.status ?? work.status) === 'cancelled' ? 'cancelled' : 'failed';
      createOutcomeEmitter(this.service, eventIdentity(work, context.proposal))
        .outcome({ status, exit_code: null, cleanup: null });
    });
  }

  cancelProducer(work, reason = 'user', { abort = true } = {}) {
    const context = this.contexts.get(work?.work_id);
    if (!context) return false;
    context.cancelled = true;
    context.runtimeOperationGateway?.close({ producerSettled: false });
    this.service.sessionExecutionAuthority.close(context.binding);
    if (!context.lease) {
      this.contexts.delete(work.work_id);
      return true;
    }
    if (abort === true) this.service.cancelChatStream?.(context.lease.identity.streamId, reason);
    return true;
  }

  // A command has no checkpoint and cannot pause mid-run; the request is recorded
  // by the store and the run still finishes or is cancelled.
  pauseProducer() {
    return false;
  }

  // Restart-paused command work with an attempt died with the process tree it
  // ran in (the store's restart proof), so Discard may confirm it once no actor
  // lifecycle or active turn remains. Anything else is not provable here.
  provePausedCleanup(work, { deletionHandle = null } = {}) {
    if (!work || !['pending', 'paused'].includes(work.status) || !work.attempt || work.checkpoint_ref
      || work.recovery?.kind !== 'restart_paused') return false;
    const actors = this.service.sessionTurnActors;
    const actorCleanupProven = deletionHandle
      ? actors?.provePausedRuntimeCleanup?.(work.session_id, deletionHandle) === true
      : actors?.hasActiveLifecycle?.(work.session_id) === false;
    return Boolean(actorCleanupProven && !this.service.sessionStore.getActiveTurn(work.session_id));
  }

  resolveRoute(work) {
    const stored = work?.input?.route;
    if (!stored || stableJson(stored) !== stableJson(COMMAND_ROUTE)) {
      throw codedError('runtime_provider_route_untrusted');
    }
    return COMMAND_ROUTE;
  }

  validateWork(work, route) {
    const context = this.contexts.get(work.work_id);
    if (!context) throw codedError('command_proposal_not_resumable');
    if (work.status !== 'running' && !context.lease) assertRuntimeTranscriptAdmission(this.service);
    if (context.sessionId !== work.session_id || context.turnId !== work.turn_id
      || context.authority.project_id !== work.project_id || context.route !== route) {
      throw new Error('session_runtime_context_unavailable');
    }
    if (context.awaitingAcknowledgement) {
      throw codedError('runtime_submission_acknowledgement_pending', { retryable: true });
    }
    if (context.cancelled) throw codedError('runtime_cancellation_requested');
    this.assertSubmissionSession(work.session_id);
    if (this.service.commandSandbox?.transition) throw codedError('command_sandbox_transition', { retryable: true });
    assertCommandAuthorityCurrent(context.trusted);
    assertChatTurnAdmissible(this.service, work.session_id, route);
    return true;
  }

  // No inference lease: the turn lane the scheduler already took is all a Run needs.
  prepareCanonical(work) {
    if (!this.contexts.get(work.work_id)) throw new Error('session_runtime_context_unavailable');
    return true;
  }

  claimCanonical(work, route) {
    const context = this.contexts.get(work.work_id);
    if (!context) throw new Error('session_runtime_context_unavailable');
    const registry = ensureSessionTurnActorRegistry(this.service);
    let lease;
    try {
      lease = registry.reserveStart({
        logicalTurnId: work.turn_id, sessionId: work.session_id, store: this.service.sessionStore,
        activeStreams: this.service.activeStreams, interactiveResponse: null, editedMessageId: '',
        deferEditValidation: false, prompt: context.visiblePrompt, path: 'managed',
      });
      const wireBinding = this.service.sessionExecutionAuthority.captureSession(work.session_id,
        { requestId: lease.identity.streamId, ...context.executionOptions });
      const wireTrusted = getTrustedExecutionBinding(wireBinding);
      if (!wireTrusted || !sameAuthority(context.authority, wireTrusted.authority)) {
        this.service.sessionExecutionAuthority.close(wireBinding);
        throw new Error('session_runtime_project_authority_changed');
      }
      this.service.sessionExecutionAuthority.close(context.binding);
      context.binding = wireBinding;
      context.trusted = wireTrusted;
    } catch (error) {
      const released = lease && registry.release(lease, { status: 'preflight_failed' });
      const notClaimed = (error?.claimState !== 'uncertain' && !lease)
        || (released?.released === true && !released.recoveryBlocked);
      if (notClaimed && error && typeof error === 'object') error.claimState = 'not_claimed';
      throw error;
    }
    context.lease = lease;
    const rollbackBeforeStart = () => {
      const result = registry.release(lease, { status: 'preflight_failed' });
      if (result?.released !== true || result.recoveryBlocked) return false;
      this.service.sessionExecutionAuthority.close(context.binding);
      if (context.cancelled) {
        this.contexts.delete(work.work_id);
        return true;
      }
      try {
        const replacement = this.service.sessionExecutionAuthority.captureSession(work.session_id,
          { requestId: work.work_id, ...context.executionOptions });
        const replacementTrusted = getTrustedExecutionBinding(replacement);
        if (!replacementTrusted || !sameAuthority(context.authority, replacementTrusted.authority)) {
          this.service.sessionExecutionAuthority.close(replacement);
          this.contexts.delete(work.work_id);
          return false;
        }
        context.binding = replacement;
        context.trusted = replacementTrusted;
        context.lease = null;
        return true;
      } catch (_error) {
        this.contexts.delete(work.work_id);
        return false;
      }
    };
    return {
      authorityRevision: context.trusted.authorityRevision,
      streamId: lease.identity.streamId,
      assertCurrent: () => { assertCommandAuthorityCurrent(context.trusted); },
      rollbackBeforeStart,
    };
  }

  createOperations(context, { assertCurrent, onSettled }) {
    return new RuntimeOperations({
      inference: {
        lanes: this.lanes, initialLease: null, fallbackRoutes: [], budget: null,
        assertRouteCurrent: () => {}, route: COMMAND_ROUTE, requestId: context.lease.identity.streamId,
        sessionId: context.sessionId, authorityRevision: context.trusted.authorityRevision, assertCurrent,
      },
      tools: {
        broker: this.resourceBroker, pathResolver: this.pathResolver,
        executionAuthority: this.service.sessionExecutionAuthority, binding: context.binding,
        sandboxCommands: this.service.commandSandbox?.enabled === true || this.service.hostMode === 'server',
        onSettled,
      },
    });
  }

  async startProducer({ work, assertCurrent, confirmLateSettlement } = {}) {
    const context = this.contexts.get(work.work_id);
    if (!context?.lease) throw new Error('session_runtime_canonical_claim_missing');
    let gateway;
    let controller;
    let managedStarted = false;
    let managedOutcome = null;
    let lateSettlementPromise = null;
    let turnSettledWithToolCleanupPending = false;
    const confirmLateIfReady = () => {
      if (!gateway) return;
      const inference = gateway.snapshot();
      if (!managedOutcome?.canonicalSettled || !TERMINAL_STATUSES.has(managedOutcome.status) || !inference.closed
        || inference.active !== 0 || inference.quarantined !== 0
        || lateSettlementPromise || typeof confirmLateSettlement !== 'function') return;
      if (turnSettledWithToolCleanupPending) {
        lateSettlementPromise = Promise.resolve(null);
        controller?._runtimeSettlementUnregister?.();
        return;
      }
      const outcome = { status: terminalStatus(managedOutcome.status), producerSettled: true, canonicalSettled: true };
      lateSettlementPromise = Promise.resolve(confirmLateSettlement(outcome)).then((result) => {
        if (result?.status === outcome.status) controller?._runtimeSettlementUnregister?.();
        return result;
      }, (error) => {
        this.service._emitServiceLog?.('ERROR', 'session_runtime.late_settlement_failed', {
          work_id: work.work_id, reason: String(error?.message || error).slice(0, 256) });
        return null;
      });
    };
    try {
      assertCurrent();
      gateway = this.createOperations(context, { assertCurrent, onSettled: () => confirmLateIfReady() });
      context.runtimeOperationGateway = gateway;
      const started = await startCommandProposalTurn(this.service, {
        work, proposal: context.proposal, turnLease: context.lease,
        runtimeAdmission: Object.freeze({ work_id: work.work_id, turn_id: work.turn_id, session_id: work.session_id,
          stream_id: context.lease.identity.streamId, user_message_id: context.lease.identity.userMessageId,
          idempotency_key: work.idempotency_key }),
        runtimeExecutionAuthority: context.binding, runtimeOperationGateway: gateway,
        runtimeAssertCurrent: assertCurrent, runtimeOnInferenceSettlement: confirmLateIfReady,
        approvalMode: context.executionOptions.approvalMode,
      });
      managedStarted = true;
      controller = this.service.activeStreams.get(started.streamId) || getManagedRuntimeController(started);
      if (!controller?._runtimeCompletion) throw new Error('session_runtime_completion_missing');
      const managed = await controller._runtimeCompletion;
      managedOutcome = managed;
      const beforeClose = gateway.snapshot();
      const providerSettled = managed.producerSettled === true && beforeClose.active === 0 && beforeClose.quarantined === 0;
      // A tool whose cleanup is unconfirmed stays fenced in the resource broker; it must not hold
      // the turn lane (same rule as a chat turn, dogfood HB-009).
      const turnSettled = managed.producerSettled === true && beforeClose.active === 0
        && (beforeClose.inference?.quarantined ?? beforeClose.quarantined) === 0;
      const toolCleanupPending = turnSettled && !providerSettled;
      gateway.close({ producerSettled: providerSettled });
      if (toolCleanupPending) {
        turnSettledWithToolCleanupPending = true;
        this.service._emitServiceLog?.('WARN', 'session_runtime.tool_cleanup_pending', {
          work_id: work.work_id, quarantined: beforeClose.tools?.quarantined ?? beforeClose.quarantined });
      }
      if (providerSettled && managed.canonicalSettled === true) controller._runtimeSettlementUnregister?.();
      else confirmLateIfReady();
      return { status: terminalStatus(managed.status), producerSettled: providerSettled || toolCleanupPending,
        canonicalSettled: managed.canonicalSettled === true };
    } catch (error) {
      if (managedStarted) {
        gateway.close({ producerSettled: false });
        throw error;
      }
      // The producer never began: nothing ran, and the one outcome the proposal needs says so.
      createOutcomeEmitter(this.service, eventIdentity(work, context.proposal))
        .outcome({ status: 'failed', exit_code: null, cleanup: null });
      gateway?.close({ producerSettled: true });
      const result = ensureSessionTurnActorRegistry(this.service).release(context.lease, { status: 'preflight_failed' });
      return { status: 'failed', producerSettled: true,
        canonicalSettled: result?.released === true && !result.recoveryBlocked };
    } finally {
      this.contexts.delete(work.work_id);
      this.service.sessionExecutionAuthority.close(context.binding);
    }
  }
}

module.exports = { CommandProposalRuntimeAdapter, COMMAND_ROUTE };
