const {
  normalizeContextPreferences,
} = require('./context-preferences');
const {
  INTERACTIVE_SEQUENCE_IDLE,
  MAX_INTERACTIVE_ROUNDS,
  normalizeInteractiveResponse,
} = require('./interactive-session-utils');
const {
  normalizeInteractiveRoundCount,
} = require('./session-shadow-store');
const {
  isImageAttachment,
} = require('../attachment-service');
const {
  normalizeReasoningEffort,
} = require('../../reasoning-effort-profiles');
const {
  ensureSessionTurnActorRegistry,
} = require('./session-turn-actor');
const { INTERACTIVE_ERROR_CODES } = require('./error-codes');
const { resolveSkillsAuthority } = require('../skills-project-scope');
const { normalizeHandoffPreparation, normalizeSessionHandoff } = require('./session-handoff-context');
const { normalizeRequestApplicationTurn } = require('./application-turns');
const { resolveDefaultChatModel } = require('./backend-chat-model-resolution');
const LOCAL_INFERENCE_ENGINE_TYPES = new Set(['ollama', 'vllm']);
const SKILL_INVOCATION_ID_PATTERN = /^(bundled|user|project)\/[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$/;

// Proposal decision correlation (row 59 checkpoint 3, D8): a closed record the
// application attaches to a continuation turn it authored itself. It rides only
// in the durable work input, never on the persisted user message; anything that
// is not exactly this shape is dropped.
const PROPOSAL_DECISION_CHOICES = new Set(['commit', 'test_first', 'do_it_here']);
function normalizeProposalDecision(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { proposal_id: proposalId, decision_id: decisionId, accepted_revision: revision, choice } = value;
  if (Object.keys(value).length !== 4 || !/^proposal_[0-9a-f]{64}$/u.test(String(proposalId))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(String(decisionId))
    || !Number.isSafeInteger(revision) || revision < 1 || !PROPOSAL_DECISION_CHOICES.has(choice)) return undefined;
  return { proposal_id: proposalId, decision_id: decisionId, accepted_revision: revision, choice };
}

// Linked-chat handoff fields (row 59 checkpoint 5a): both are application-authored, ride only in
// the durable work input, and are never reachable from the renderer submission contract. A
// present but malformed value is refused (not dropped): dropping the preparation field would
// run an ordinary full-tool turn, and dropping the handoff would run the child without its Background.
function normalizeInternalHandoffFields({ sessionHandoffPreparation, sessionHandoff }) {
  const refuse = (field) => Object.assign(new Error(`The ${field} request field is malformed.`),
    { code: 'session_handoff_invalid', retryable: false });
  const preparation = sessionHandoffPreparation == null ? null : normalizeHandoffPreparation(sessionHandoffPreparation);
  if (sessionHandoffPreparation != null && !preparation) throw refuse('sessionHandoffPreparation');
  const handoff = sessionHandoff == null ? null : normalizeSessionHandoff(sessionHandoff);
  if (sessionHandoff != null && !handoff) throw refuse('sessionHandoff');
  if (preparation && handoff) throw refuse('sessionHandoff');
  return {
    ...(preparation ? { sessionHandoffPreparation: preparation } : {}),
    ...(handoff ? { sessionHandoff: handoff } : {}),
  };
}

function getSessionSummary(store, sessionId) {
  if (typeof store?.getSessionSummary === 'function') {
    return store.getSessionSummary(sessionId);
  }
  return store?.getSession?.(sessionId) || null;
}

// The catalog the sidecar will see for this chat: its bound project's skills,
// never the open Workspace's (hosts without project authority keep the
// legacy unscoped catalog).
function sessionSkillsState(service, sessionKey) {
  if (typeof service.projectAuthority?.captureSession !== 'function') {
    return service.skillsService?.getState?.();
  }
  return service.skillsService?.getState?.({
    authority: resolveSkillsAuthority(service.projectAuthority, { sessionId: sessionKey }),
  });
}

function resolveSkillInvocation(service, invocation, sessionKey = '') {
  if (invocation == null) return null;
  const id = invocation && typeof invocation === 'object' && !Array.isArray(invocation)
    && typeof invocation.id === 'string' && SKILL_INVOCATION_ID_PATTERN.test(invocation.id)
    ? invocation.id : '';
  const state = id ? sessionSkillsState(service, sessionKey) : null;
  const scope = state?.scopes?.find((candidate) => candidate?.scope === id.split('/')[0]);
  const entry = state?.entries?.find((candidate) => candidate?.id === id)
    || scope?.entries?.find((candidate) => candidate?.id === id);
  let reason = '';
  if (!id) reason = 'skill_unknown';
  else if (state?.featureEnabled !== true) reason = 'skills_feature_disabled';
  else if (!scope) reason = 'skill_unknown';
  else if (scope.enabled !== true) reason = 'skill_scope_disabled';
  else if (!entry) reason = 'skill_unknown';
  else if (entry.enabled !== true) reason = 'skill_disabled';
  if (reason) {
    const error = new Error('Skill invocation is not available.');
    error.code = 'SKILL_NOT_AVAILABLE';
    error.reason = reason;
    error.retryable = false;
    throw error;
  }
  return { id, name: String(entry.name), scope: String(entry.scope), command: String(entry.command) };
}

// Force local inference: the model and engine every inference for a chat must
// use instead of the chat's own pick, or null when the mode is off. Throws the
// user-facing reason when the forced route is not usable.
async function resolveForcedLocalRoute(service, { hasImageAttachments = false } = {}) {
  const offlineIntelligence = service.offlineIntelligenceService;
  // getState() lists the local model catalog (a sidecar models.list round trip,
  // ~400 ms of every warm turn in the P3-PERF-A baseline). Only force-local
  // reads that state, so check the configured mode first.
  if (
    !offlineIntelligence
    || typeof offlineIntelligence.getState !== 'function'
    || (typeof offlineIntelligence.getMode === 'function' && offlineIntelligence.getMode() !== 'local_only')
  ) {
    return null;
  }
  const offlineState = await offlineIntelligence.getState();
  if (offlineState.mode !== 'local_only') return null;
  if (!offlineState.preferredLocalModel) {
    throw new Error('Force local inference requires a model selected in Model Library.');
  }
  if (offlineState.localCatalog?.available !== true || !offlineState.localChatReady) {
    throw new Error(
      String(offlineState.unavailableReason || 'Forced local inference is unavailable right now.')
    );
  }
  if (hasImageAttachments && !offlineState.localVisionReady) {
    throw new Error(
      String(
        offlineState.visionUnavailableReason
        || 'Offline local vision is unavailable for the selected local model.'
      )
    );
  }
  const engineType = String(offlineState.selectedLocalEngineType || '').trim().toLowerCase();
  if (!LOCAL_INFERENCE_ENGINE_TYPES.has(engineType)) {
    throw new Error('Force local inference blocked a model without a verified local inference provider.');
  }
  return { model: String(offlineState.preferredLocalModel || '').trim(), engineType };
}

async function prepareLocalEngineChatRequest(service, {
  sessionId,
  prompt,
  visiblePrompt,
  traceId,
  preferredModel,
  reasoningEffort,
  attachments,
  interactiveResponse,
  interactiveRoundCount,
  planMode,
  contextPreferences,
  activeFileContext,
  mentionContents,
  toolPreferences,
  approvalMode,
  debugOptions,
  clientTiming,
  skillInvocation,
  editedMessageId,
  failureRetry,
  proposalDecision,
  sessionHandoffPreparation,
  sessionHandoff,
  applicationTurn,
}, options = {}) {
  const cancellation = options?.cancellation;
  const throwIfStartCancelled = () => {
    if (!cancellation?.signal?.aborted) return;
    const error = new Error('chat_start_cancelled');
    error.code = 'chat_start_cancelled';
    error.retryable = false;
    throw error;
  };
  const hasImageAttachments = (Array.isArray(attachments) ? attachments : []).some((entry) => isImageAttachment(entry));
  const normalizedInteractiveResponse = normalizeInteractiveResponse(interactiveResponse);
  if (interactiveResponse != null && !normalizedInteractiveResponse) {
    const error = new Error('Interactive continuation is malformed or incomplete.');
    error.code = INTERACTIVE_ERROR_CODES.INVALID_CONTINUATION;
    error.retryable = false;
    throw error;
  }
  const normalizedInteractiveRoundCount = Math.min(
    normalizeInteractiveRoundCount(interactiveRoundCount),
    MAX_INTERACTIVE_ROUNDS
  );
  const sessionKey = String(sessionId || '').trim();
  const normalizedProposalDecision = normalizeProposalDecision(proposalDecision);
  const handoffFields = normalizeInternalHandoffFields({ sessionHandoffPreparation, sessionHandoff });
  const normalizedApplicationTurn = normalizeRequestApplicationTurn(applicationTurn);
  const normalizedSkillInvocation = resolveSkillInvocation(service, skillInvocation, sessionKey);
  const normalizedContextPreferences = normalizeContextPreferences(
    typeof contextPreferences !== 'undefined'
      ? contextPreferences
      : getSessionSummary(service.sessionStore, sessionKey)?.context_preferences
  );
  const normalizedPreferences = {
    preferred_model: String(preferredModel || '').trim(),
    reasoning_effort: normalizeReasoningEffort(reasoningEffort),
    /* Unified mode: conversation_mode persists as an inert 'chat' literal for
     * session-store shape stability; nothing branches on it anymore. */
    conversation_mode: 'chat',
    ...(normalizedInteractiveResponse
      ? {}
      : {
          pending_question_batch: null,
          pending_plan_proposal: null,
          interactive_sequence_state: INTERACTIVE_SEQUENCE_IDLE,
        }),
    interactive_round_count: normalizedInteractiveRoundCount,
    plan_mode: planMode === true,
    context_preferences: normalizedContextPreferences,
  };
  let runtimePreferredModel = normalizedPreferences.preferred_model;
  let runtimePreferredEngineType = '';
  throwIfStartCancelled();
  const forcedLocal = await resolveForcedLocalRoute(service, { hasImageAttachments });
  if (forcedLocal) {
    runtimePreferredModel = forcedLocal.model;
    runtimePreferredEngineType = forcedLocal.engineType;
  } else if (!runtimePreferredModel) {
    // The persisted pick stays '' (Default); only this turn's route is pinned.
    runtimePreferredModel = resolveDefaultChatModel(service);
  }

  throwIfStartCancelled();
  return {
    sessionId,
    prompt,
    visiblePrompt,
    traceId,
    attachments,
    runtimePreferredModel,
    runtimePreferredEngineType,
    normalizedInteractiveResponse,
    normalizedPreferences,
    activeFileContext,
    mentionContents,
    toolPreferences,
    approvalMode,
    debugOptions,
    clientTiming,
    skillInvocation: normalizedSkillInvocation,
    editedMessageId,
    failureRetry,
    ...(normalizedProposalDecision ? { proposalDecision: normalizedProposalDecision } : {}),
    ...handoffFields,
    ...(normalizedApplicationTurn ? { applicationTurn: normalizedApplicationTurn } : {}),
  };
}

async function startLocalEngineChatStream(service, request, options = {}) {
  const managedRequest = await prepareLocalEngineChatRequest(service, request, options);
  const { sessionId, normalizedInteractiveResponse, editedMessageId, visiblePrompt, prompt, traceId } = managedRequest;
  const sessionKey = String(sessionId || '').trim();
  const cancellation = options?.cancellation;
  if (cancellation?.signal?.aborted) {
    throw Object.assign(new Error('chat_start_cancelled'), { code: 'chat_start_cancelled', retryable: false });
  }
  let actorRegistry = null;
  let turnLease = null;
  try {
    if (service.sessionRuntime) {
      return await service.sessionRuntime.startImmediate(managedRequest, { cancellation });
    }
    actorRegistry = ensureSessionTurnActorRegistry(service);
    turnLease = sessionKey
      ? actorRegistry.reserveStart({
          sessionId: sessionKey,
          store: service.sessionStore,
          activeStreams: service.activeStreams,
          interactiveResponse: normalizedInteractiveResponse,
          editedMessageId,
          deferEditValidation: false,
          prompt: typeof visiblePrompt === 'string' ? visiblePrompt : prompt,
          path: 'managed',
          traceId,
        })
      : null;
    if (turnLease?.identity?.streamId) cancellation?.bindStream?.(turnLease.identity.streamId);
    return await service._startManagedSidecarChatStream({
      ...managedRequest,
      turnLease,
    });
  } catch (error) {
    if (turnLease && actorRegistry) {
      actorRegistry.release(turnLease, { status: 'preflight_failed' });
    }
    throw error;
  }
}

module.exports = {
  prepareLocalEngineChatRequest,
  resolveForcedLocalRoute,
  startLocalEngineChatStream,
};
