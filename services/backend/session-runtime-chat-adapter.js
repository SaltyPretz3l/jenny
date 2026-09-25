'use strict';

const { releaseRuntimeMutation } = require('./runtime-mutation-release');
const { prepareLocalEngineChatRequest } = require('./local-engine-requests');
const { prepareManagedSession } = require('./managed-sidecar-session-preflight');
const { ensureSessionTurnActorRegistry } = require('./session-turn-actor');
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { inferEngineTypeFromModel, normalizeManagedToolPreferences } = require('./backend-service-utils');
const { resolveSessionLockdownRequest } = require('./session-lockdown-gate');
const { assertChatTurnAdmissible, assertRuntimeTranscriptAdmission } = require('./chat-turn-admission');
const {
  assertSessionRuntimeProviderRouteCurrent,
  captureSessionRuntimeProviderRoute,
  captureSessionRuntimeProviderSelection,
  restoreSessionRuntimeProviderRoute,
} = require('./session-runtime-provider-route');
const { assertRuntimeWork } = require('../session-runtime/runtime-work-authority');
const { createRuntimeChatOperations, executionOptionsFor } = require('./session-runtime-chat-operations');
const { buildAdmittedContinuationContext } = require('../session-runtime/continuation-context');
const { hydrateRuntimeContinuation, pausedOutcome } = require('./runtime-continuation-resume');
const { getManagedRuntimeController } = require('./chat-lifecycle-contracts');

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sameAuthority(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameAttempt(left, right) {
  return Boolean(left && right && ['attempt_id', 'stream_id', 'incarnation', 'authority_revision']
    .every(key => left[key] === right[key]));
}

function selectedEngine(service, request) {
  const forced = String(request.runtimePreferredEngineType || '').trim().toLowerCase();
  if (forced) return forced;
  const model = String(request.runtimePreferredModel || '').trim();
  const hinted = model ? String(service._modelEngineHints?.get?.(model) || '').trim().toLowerCase() : '';
  const current = String(service.currentEngineType || '').trim().toLowerCase();
  const inferred = inferEngineTypeFromModel(model);
  // Cloud IDs identify their provider even while startup is on a fallback.
  // Ambiguous local model names retain the selected runtime and catalog hints.
  return hinted || (['chatgpt', 'codex-cli'].includes(inferred) ? inferred : current);
}

function terminalStatus(value) {
  return TERMINAL_STATUSES.has(value) ? value : 'failed';
}

function createStartedBarrier(observeRejection = false) {
  const started = {};
  started.promise = new Promise((resolve, reject) => Object.assign(started, { resolve, reject }));
  if (observeRejection) started.promise.catch(() => {});
  return started;
}

function clearResumePreparation(context) {
  if (context?.kind !== 'checkpoint_resume') return;
  context.resumeHydration = null;
  context.checkpointResume = null;
}

class SessionRuntimeChatAdapter {
  constructor(service, { lanes, resourceBroker, pathResolver,
    checkpointStore = null, conversationStore = null, budgetStore = null } = {}) {
    if (!service?.sessionStore || !service?.sessionExecutionAuthority || !lanes
      || !resourceBroker || !pathResolver) {
      throw new TypeError('session_runtime_chat_adapter_dependencies_invalid');
    }
    this.service = service;
    this.lanes = lanes;
    this.resourceBroker = resourceBroker;
    this.pathResolver = pathResolver;
    this.budgetStore = budgetStore;
    this.checkpointStore = checkpointStore;
    this.conversationStore = conversationStore;
    this.contexts = new Map();
  }

  async prepareImmediate(request, options, { workId, turnId } = {}) {
    if (!request || typeof request !== 'object' || !workId || !turnId) {
      throw new TypeError('session_runtime_immediate_request_invalid');
    }
    if (this.service.commandSandbox?.transition) {
      const error = new Error('Command sandbox configuration is changing; retry the message.');
      error.code = 'command_sandbox_transition';
      error.retryable = true;
      throw error;
    }
    const copy = { ...request };
    const attachments = Array.isArray(copy.attachments) ? copy.attachments.map(entry => ({ ...entry })) : [];
    const preparedSession = prepareManagedSession(this.service, { ...copy, attachments });
    const sessionId = preparedSession.resolvedSessionId;
    const images = preparedSession.imageAttachments;
    copy.sessionId = sessionId;
    copy.attachments = attachments;
    const engineType = selectedEngine(this.service, copy);
    const route = captureSessionRuntimeProviderRoute(this.service, { engineType });
    const session = typeof this.service.sessionStore.getSessionSummary === 'function'
      ? this.service.sessionStore.getSessionSummary(sessionId)
      : this.service.sessionStore.getSession(sessionId);
    const lockdown = resolveSessionLockdownRequest(
      this.service,
      session,
      { requestedEngine: route.engine_type, requestedModel: copy.runtimePreferredModel },
      normalizeManagedToolPreferences(copy.toolPreferences)
    );
    copy.toolPreferences = lockdown.toolPreferences;
    copy.runtimePreferredEngineType = route.engine_type;
    const cancellation = options?.cancellation || null;
    const executionOptions = executionOptionsFor(this.service, copy, images, cancellation);
    const binding = this.service.sessionExecutionAuthority.captureSession(sessionId,
      { requestId: workId, ...executionOptions });
    const trusted = getTrustedExecutionBinding(binding);
    if (!trusted) {
      this.service.sessionExecutionAuthority.close(binding);
      throw new Error('session_runtime_execution_authority_invalid');
    }
    const durableRequest = cloneJson(copy);
    durableRequest.attachments = attachments.map((entry) => {
      const saved = { ...entry };
      delete saved.bytes;
      return saved;
    });
    return {
      authority: trusted.authority,
      binding,
      cancellation,
      checkpointStore: this.checkpointStore,
      conversationStore: this.conversationStore,
      getCurrentWork: typeof options?.getCurrentWork === 'function' ? options.getCurrentWork : null,
      input: { schema_version: 1, kind: 'immediate_chat', route: cloneJson(route), request: durableRequest },
      kind: 'immediate_chat',
      request: copy,
      route,
      sessionId,
      started: createStartedBarrier(),
      trusted,
      executionOptions,
      turnId,
      workId,
    };
  }

  async prepareSubmission(request, options, identity) {
    if (!request?.sessionId || typeof request.prompt !== 'string'
      || request.interactiveResponse != null || request.editedMessageId
      || request.failureRetry === true) throw new TypeError('runtime_new_send_required');
    this.assertSubmissionSession(request.sessionId);
    const authority = this.service.projectAuthority.captureSession(request.sessionId);
    const selected = selectedEngine(this.service, { runtimePreferredModel: request.preferredModel });
    const bindSelection = captureSessionRuntimeProviderSelection(this.service, selected);
    const normalized = await prepareLocalEngineChatRequest(this.service, cloneJson(request), options);
    normalized.runtimePreferredEngineType ||= selected;
    const selectedRoute = bindSelection(normalized.runtimePreferredEngineType);
    this.service.projectAuthority.requireCurrent(authority);
    this.assertSubmissionSession(request.sessionId);
    const prepared = await this.prepareImmediate(normalized, options, identity);
    prepared.durableSubmission = true;
    prepared.started.promise.catch(() => {});
    try { assertSessionRuntimeProviderRouteCurrent(this.service, selectedRoute); }
    catch (error) { this.discard(prepared); throw error; }
    if (!sameAuthority(authority, prepared.authority)) {
      this.discard(prepared);
      throw new Error('session_runtime_project_authority_changed');
    }
    return prepared;
  }

  assertSubmissionSession(sessionId) {
    if (!this.service.sessionStore.getSessionSummary(sessionId)) {
      throw new Error('runtime_session_unavailable');
    }
    const actors = this.service.sessionTurnActors || this.service.sessionTurnActorRegistry;
    const blocked = actors?.getQueuedSubmissionBlock(sessionId);
    if (blocked) throw new Error(blocked);
  }

  validateSubmission(prepared) {
    this.assertSubmissionSession(prepared.sessionId);
    if (this.service.commandSandbox?.transition) throw new Error('command_sandbox_transition');
    assertSessionRuntimeProviderRouteCurrent(this.service, prepared.route);
    prepared.trusted.assertCurrent();
    assertChatTurnAdmissible(this.service, prepared.sessionId, prepared.route);
    if (prepared.cancellation?.signal?.aborted) throw new Error('chat_start_cancelled');
    return true;
  }

  prepareResume(work, options = {}) {
    const input = work?.input;
    const request = input?.request;
    const getCurrentWork = options.getCurrentWork;
    const checkpointStore = options.checkpointStore || this.checkpointStore;
    const conversationStore = options.conversationStore || this.conversationStore;
    if (!work || work.status !== 'paused' || input?.schema_version !== 1
      || !['immediate_chat', 'root_chat', 'child_chat'].includes(input?.kind) || !request || typeof request !== 'object'
      || Array.isArray(request) || typeof request.prompt !== 'string'
      || request.sessionId !== work.session_id || typeof getCurrentWork !== 'function') {
      throw new TypeError('session_runtime_resume_request_invalid');
    }
    if (this.contexts.has(work.work_id)) throw new Error('session_runtime_context_conflict');
    if (this.service.commandSandbox?.transition) {
      const error = new Error('Command sandbox configuration is changing; retry the message.');
      error.code = 'command_sandbox_transition';
      error.retryable = true;
      throw error;
    }
    // A resume validates existing root state; it never creates a replacement budget.
    const route = restoreSessionRuntimeProviderRoute(this.service, input.route);
    assertSessionRuntimeProviderRouteCurrent(this.service, route);
    assertChatTurnAdmissible(this.service, work.session_id, route);
    const copy = cloneJson(request);
    copy.sessionId = work.session_id;
    copy.runtimePreferredEngineType = route.engine_type;
    copy.normalizedInteractiveResponse = null;
    copy.editedMessageId = '';
    copy.failureRetry = false;
    const attachments = Array.isArray(copy.attachments) ? copy.attachments : [];
    const images = attachments.filter(entry => entry?.kind === 'image');
    const cancellation = options.cancellation || null;
    const executionOptions = executionOptionsFor(this.service, copy, images, cancellation);
    const binding = this.service.sessionExecutionAuthority.captureSession(work.session_id,
      { requestId: work.work_id, ...executionOptions });
    const trusted = getTrustedExecutionBinding(binding);
    if (!trusted || !sameAuthority(work.authority, trusted.authority)) {
      this.service.sessionExecutionAuthority.close(binding);
      throw new Error('session_runtime_project_authority_changed');
    }
    try { assertRuntimeWork(this.budgetStore, this.service, work, { binding, trusted, request: copy, route }); }
    catch (error) { this.service.sessionExecutionAuthority.close(binding); throw error; }
    return {
      authority: trusted.authority,
      binding,
      cancellation,
      checkpointStore,
      conversationStore,
      executionOptions,
      getCurrentWork,
      input,
      kind: work.attempt ? 'checkpoint_resume' : 'immediate_chat',
      durableSubmission: true,
      request: copy,
      checkpointResume: null,
      resumeHydration: null,
      route,
      sessionId: work.session_id,
      started: createStartedBarrier(true),
      trusted,
      turnId: work.turn_id,
      workId: work.work_id,
    };
  }

  register(workId, prepared) {
    if (this.contexts.has(workId)) throw new Error('session_runtime_context_conflict');
    this.contexts.set(workId, prepared);
  }

  discard(prepared) {
    if (!prepared) return false;
    this.releaseInitialInference(prepared);
    if (this.contexts.get(prepared.workId) === prepared) this.contexts.delete(prepared.workId);
    this.service.sessionExecutionAuthority.close(prepared.binding);
    return true;
  }

  discardPending(work) {
    const context = this.contexts.get(work?.work_id);
    if (!context || context.lease) return false;
    this.releaseInitialInference(context);
    clearResumePreparation(context);
    this.contexts.delete(work.work_id);
    this.service.sessionExecutionAuthority.close(context.binding);
    return true;
  }

  cancelProducer(work, reason = 'user', { abort = true } = {}) {
    const context = this.contexts.get(work?.work_id);
    if (!context) return false;
    context.cancelled = true;
    clearResumePreparation(context);
    context.runtimeOperationGateway?.close({ producerSettled: false });
    this.service.sessionExecutionAuthority.close(context.binding);
    if (!context.lease) {
      this.contexts.delete(work.work_id);
      return true;
    }
    if (abort === true) {
      this.service.cancelChatStream?.(context.lease.identity.streamId, reason);
    }
    return true;
  }

  provePausedCleanup(work, { deletionHandle = null } = {}) {
    const assertCleanup = () => {
      const actors = this.service.sessionTurnActors;
      const actorCleanupProven = deletionHandle
        ? actors?.provePausedRuntimeCleanup?.(work?.session_id, deletionHandle) === true
        : actors?.hasActiveLifecycle?.(work?.session_id) === false;
      return Boolean(work && ['pending', 'paused'].includes(work.status) && work.attempt
        && sameAttempt(work.attempt, work.checkpoint_ref?.source_attempt)
        && this.checkpointStore?.validate?.(work, work.checkpoint_ref) === true
        && actorCleanupProven && !this.service.sessionStore.getActiveTurn(work.session_id));
    };
    if (!assertCleanup()) return false;
    const checkpoint = this.checkpointStore.read(work.checkpoint_ref, work);
    return checkpoint.mutation_ref
      ? releaseRuntimeMutation(this.service, work, checkpoint, assertCleanup) : true;
  }

  waitForStart(prepared) {
    return prepared.started.promise;
  }

  resolveRoute(work) {
    const context = this.contexts.get(work.work_id);
    return context?.route || restoreSessionRuntimeProviderRoute(this.service, work.input?.route);
  }

  validateWork(work, route) {
    const context = this.contexts.get(work.work_id);
    if (work.status !== 'running' && !context?.lease) assertRuntimeTranscriptAdmission(this.service);
    if (!context || context.sessionId !== work.session_id || context.turnId !== work.turn_id
      || context.authority.project_id !== work.project_id || context.route !== route) {
      throw new Error('session_runtime_context_unavailable');
    }
    if (context.awaitingAcknowledgement) {
      throw Object.assign(new Error('runtime_submission_acknowledgement_pending'), {
        code: 'runtime_submission_acknowledgement_pending', retryable: true,
      });
    }
    if (context.cancelled) {
      const error = new Error('runtime_cancellation_requested');
      error.code = 'runtime_cancellation_requested';
      throw error;
    }
    assertRuntimeWork(this.budgetStore, this.service, work, context);
    this.assertSubmissionSession(work.session_id);
    assertSessionRuntimeProviderRouteCurrent(this.service, route);
    context.trusted.assertCurrent();
    assertChatTurnAdmissible(this.service, work.session_id, route);
    if (context.cancellation?.signal?.aborted) {
      const error = new Error('chat_start_cancelled');
      error.code = 'chat_start_cancelled';
      throw error;
    }
    return true;
  }

  prepareCanonical(work, route) {
    const context = this.contexts.get(work.work_id);
    if (!context) throw new Error('session_runtime_context_unavailable');
    if (context.kind !== 'checkpoint_resume') {
      const reserved = this.lanes.tryAcquireInference({ ownerId: work.work_id, route,
        signal: context.cancellation?.signal });
      if (reserved.status !== 'granted') throw Object.assign(new Error(reserved.reason), {
        code: reserved.reason, retryable: reserved.status === 'waiting',
      });
      context.initialInferenceLease = reserved.lease;
      return true;
    }
    if (context.resumeHydration || context.checkpointResume) {
      throw new Error('session_runtime_resume_preparation_conflict');
    }
    this.validateWork(work, route);
    const assertSourceAvailable = () => {
      const current = context.getCurrentWork();
      return Boolean(current && current.work_id === work.work_id);
    };
    const resumeHydration = hydrateRuntimeContinuation({ work, dependencyRuntime: this.service.sessionRuntime,
      checkpointStore: context.checkpointStore, conversationStore: context.conversationStore,
      assertCurrent: assertSourceAvailable });
    if (resumeHydration.planModeExited && context.request.normalizedPreferences?.plan_mode === true
      && this.service.sessionStore.getSessionSummary(work.session_id)?.plan_mode === false) {
      context.request.normalizedPreferences.plan_mode = false;
      context.request.approvalMode = 'prompt';
      context.executionOptions = executionOptionsFor(this.service, context.request,
        context.request.attachments || [], context.cancellation);
    }
    const checkpointResume = resumeHydration.reserveIdentity(work);
    context.resumeHydration = resumeHydration;
    context.checkpointResume = checkpointResume;
    return true;
  }

  releaseInitialInference(context) {
    const lease = context.initialInferenceLease;
    context.initialInferenceLease = null;
    if (lease) this.lanes.release(lease, { producerSettled: true });
  }

  claimCanonical(work, route) {
    const context = this.contexts.get(work.work_id);
    if (!context) throw new Error('session_runtime_context_unavailable');
    const registry = ensureSessionTurnActorRegistry(this.service);
    const resume = context.kind === 'checkpoint_resume';
    if (resume && (!context.resumeHydration || !context.checkpointResume)) {
      throw new Error('session_runtime_resume_not_prepared');
    }
    let lease;
    try {
      lease = registry.reserveStart(resume ? {
        sessionId: work.session_id,
        store: this.service.sessionStore,
        activeStreams: this.service.activeStreams,
        checkpointResume: context.checkpointResume,
        prompt: typeof context.request.visiblePrompt === 'string'
          ? context.request.visiblePrompt : context.request.prompt,
        path: 'managed',
        traceId: context.request.traceId,
      } : {
        logicalTurnId: work.turn_id,
        sessionId: work.session_id,
        store: this.service.sessionStore,
        activeStreams: this.service.activeStreams,
        interactiveResponse: context.request.normalizedInteractiveResponse,
        editedMessageId: context.request.editedMessageId,
        deferEditValidation: false,
        prompt: typeof context.request.visiblePrompt === 'string'
          ? context.request.visiblePrompt : context.request.prompt,
        path: 'managed',
        traceId: context.request.traceId,
      });
      const wireBinding = this.service.sessionExecutionAuthority.captureSession(
        work.session_id,
        { requestId: lease.identity.streamId, ...context.executionOptions }
      );
      const wireTrusted = getTrustedExecutionBinding(wireBinding);
      if (!wireTrusted || !sameAuthority(context.authority, wireTrusted.authority)) {
        this.service.sessionExecutionAuthority.close(wireBinding);
        throw new Error('session_runtime_project_authority_changed');
      }
      this.service.sessionExecutionAuthority.close(context.binding);
      context.binding = wireBinding;
      context.trusted = wireTrusted;
    } catch (error) {
      this.releaseInitialInference(context);
      const released = lease && registry.release(lease, { status: 'preflight_failed' });
      const notClaimed = (error?.claimState !== 'uncertain' && !lease) || (released?.released === true && !released.recoveryBlocked);
      if (notClaimed) clearResumePreparation(context);
      if (notClaimed && error && typeof error === 'object') error.claimState = 'not_claimed';
      throw error;
    }
    context.lease = lease;
    context.cancellation?.bindStream?.(lease.identity.streamId);
    const rollbackBeforeStart = () => {
      this.releaseInitialInference(context);
      const result = registry.release(lease, { status: 'preflight_failed' });
      if (result?.released !== true || result.recoveryBlocked) return false;
      clearResumePreparation(context);
      this.service.sessionExecutionAuthority.close(context.binding);
      if (context.cancelled) {
        this.contexts.delete(work.work_id);
        return true;
      }
      try {
        const replacement = this.service.sessionExecutionAuthority.captureSession(
          work.session_id, { requestId: work.work_id, ...context.executionOptions }
        );
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
      assertCurrent: () => {
        context.trusted.assertCurrent();
        assertSessionRuntimeProviderRouteCurrent(this.service, route);
      },
      rollbackBeforeStart,
    };
  }

  async startProducer({ work, route, assertCurrent, assertSettlementCurrent,
    confirmLateSettlement } = {}) {
    const context = this.contexts.get(work.work_id);
    if (!context?.lease) throw new Error('session_runtime_canonical_claim_missing');
    let gateway;
    const continuationEnabled = context.kind === 'checkpoint_resume'
      || (this.service.featureFlags?.session_runtime === true
        && context.checkpointStore && context.conversationStore
        && typeof context.getCurrentWork === 'function');
    const settlementCurrent = typeof assertSettlementCurrent === 'function'
      ? assertSettlementCurrent : assertCurrent;
    let controller;
    let managedStarted = false;
    let managedOutcome = null;
    let lateSettlementPromise = null;
    const confirmLateIfReady = () => {
      if (!gateway) return;
      const inference = gateway.snapshot();
      if (!managedOutcome?.canonicalSettled || !TERMINAL_STATUSES.has(managedOutcome.status) || !inference.closed
        || inference.active !== 0 || inference.quarantined !== 0
        || lateSettlementPromise || typeof confirmLateSettlement !== 'function') return;
      const outcome = { status: terminalStatus(managedOutcome.status),
        producerSettled: true, canonicalSettled: true };
      lateSettlementPromise = Promise.resolve(confirmLateSettlement(outcome)).then((result) => {
        if (result?.status === outcome.status) controller?._runtimeSettlementUnregister?.();
        return result;
      }, (error) => {
        this.service._emitServiceLog?.('ERROR', 'session_runtime.late_settlement_failed', {
          work_id: work.work_id, reason: String(error?.message || error).slice(0, 256),
        });
        return null;
      });
    };
    try {
      assertCurrent();
      gateway = createRuntimeChatOperations(this, { work, route, context, assertCurrent,
        onSettled: () => confirmLateIfReady() });
      context.initialInferenceLease = null;
      context.runtimeOperationGateway = gateway;

      const continuationContext = continuationEnabled
        ? buildAdmittedContinuationContext({ work, attempt: work.attempt, route,
            executionContext: this.service.sessionExecutionAuthority.toExecutionContext(context.binding) })
        : null;
      const runtimeContinuation = continuationContext ? {
        context: continuationContext,
        checkpointStore: context.checkpointStore,
        conversationStore: context.conversationStore,
        getCurrentWork: context.getCurrentWork,
        assertCurrent: () => { assertCurrent(); return true; },
        assertSettlementCurrent: () => { settlementCurrent(); return true; },
        ...(context.resumeHydration ? { resumeHydration: context.resumeHydration } : {}),
      } : null;
      const started = await this.service._startManagedSidecarChatStream({
        ...context.request,
        turnLease: context.lease,
        runtimeAdmission: context.durableSubmission ? Object.freeze({ work_id: work.work_id, turn_id: work.turn_id,
          session_id: work.session_id, stream_id: context.lease.identity.streamId,
          user_message_id: context.lease.identity.userMessageId, idempotency_key: work.idempotency_key }) : null,
        runtimeExecutionAuthority: context.binding,
        runtimeOperationGateway: gateway,
        runtimeRoute: route,
        runtimeAssertCurrent: assertCurrent,
        runtimeOnInferenceSettlement: confirmLateIfReady,
        ...(runtimeContinuation ? { runtimeContinuation } : {}),
      });
      managedStarted = true;
      context.started.resolve(started);
      controller = this.service.activeStreams.get(started.streamId)
        || getManagedRuntimeController(started);
      if (!controller?._runtimeCompletion) throw new Error('session_runtime_completion_missing');
      const managed = await controller._runtimeCompletion;
      managedOutcome = managed;
      const beforeClose = gateway.snapshot();
      const providerSettled = managed.producerSettled === true
        && beforeClose.active === 0 && beforeClose.quarantined === 0;
      gateway.close({ producerSettled: providerSettled });
      if (providerSettled && managed.canonicalSettled === true) {
        controller._runtimeSettlementUnregister?.();
      } else {
        confirmLateIfReady();
      }
      return pausedOutcome(managed, providerSettled) || {
        status: terminalStatus(managed.status),
        producerSettled: providerSettled,
        canonicalSettled: managed.canonicalSettled === true,
      };
    } catch (error) {
      if (managedStarted) {
        gateway.close({ producerSettled: false });
        throw error;
      }
      context.started.reject(error);
      gateway?.close({ producerSettled: true });
      const result = ensureSessionTurnActorRegistry(this.service).release(
        context.lease,
        { status: 'preflight_failed' }
      );
      return {
        status: 'failed', producerSettled: true,
        canonicalSettled: result?.released === true && !result.recoveryBlocked,
      };
    } finally {
      this.releaseInitialInference(context);
      this.contexts.delete(work.work_id);
      this.service.sessionExecutionAuthority.close(context.binding);
    }
  }
}

module.exports = { SessionRuntimeChatAdapter };
