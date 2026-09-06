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
const { INTERACTIVE_ERROR_CODES, PLUGIN_ERROR_CODES } = require('./error-codes');
const { validate: validatePluginContract } = require('../plugins/contracts/generated-plugin-contracts');
const LOCAL_INFERENCE_ENGINE_TYPES = new Set(['ollama', 'vllm']);
const SKILL_INVOCATION_ID_PATTERN = /^(bundled|user|project)\/[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*){0,7}$/;

function resolveSkillInvocation(service, invocation) {
  if (invocation == null) return null;
  const id = invocation && typeof invocation === 'object' && !Array.isArray(invocation)
    && typeof invocation.id === 'string' && SKILL_INVOCATION_ID_PATTERN.test(invocation.id)
    ? invocation.id : '';
  const state = id ? service.skillsService?.getState?.() : null;
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

async function startLocalEngineChatStream(service, {
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
  pluginCommandInvocation,
  skillInvocation,
  editedMessageId,
  failureRetry,
}) {
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
  let normalizedPluginCommandInvocation = null;
  if (pluginCommandInvocation) {
    const checked = validatePluginContract('PluginCommandInvocationV2', pluginCommandInvocation);
    if (!checked.ok) {
      const error = new Error('Plugin command invocation is invalid.');
      error.code = PLUGIN_ERROR_CODES.POLICY_BLOCKED;
      error.reason = 'plugin_command_invocation_invalid';
      error.retryable = false;
      throw error;
    }
    normalizedPluginCommandInvocation = checked.value;
  }
  const normalizedSkillInvocation = resolveSkillInvocation(service, skillInvocation);
  const normalizedContextPreferences = normalizeContextPreferences(
    typeof contextPreferences !== 'undefined'
      ? contextPreferences
      : service.sessionStore.getSession(sessionKey)?.context_preferences
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
  const actorRegistry = ensureSessionTurnActorRegistry(service);
  let turnLease = sessionKey
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

  try {
    if (
      service.offlineIntelligenceService
      && typeof service.offlineIntelligenceService.getState === 'function'
    ) {
      const offlineState = await service.offlineIntelligenceService.getState();
      if (offlineState.mode === 'local_only') {
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
        runtimePreferredModel = String(offlineState.preferredLocalModel || '').trim();
        const forcedEngineType = String(offlineState.selectedLocalEngineType || '').trim().toLowerCase();
        if (!LOCAL_INFERENCE_ENGINE_TYPES.has(forcedEngineType)) {
          throw new Error('Force local inference blocked a model without a verified local inference provider.');
        }
        runtimePreferredEngineType = forcedEngineType;
      }
    }

    return await service._startManagedSidecarChatStream({
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
      pluginCommandInvocation: normalizedPluginCommandInvocation,
      skillInvocation: normalizedSkillInvocation,
      editedMessageId,
      failureRetry,
      turnLease,
    });
  } catch (error) {
    if (turnLease) {
      actorRegistry.release(turnLease, { status: 'preflight_failed' });
    }
    throw error;
  }
}

module.exports = {
  startLocalEngineChatStream,
};
