'use strict';

// Exclusive-GPU and session-type admission for chat-turn entry points.

const { sessionAllowsChatSend } = require('./session-type');
const { AI_ERROR_CODES } = require('./error-codes');
const { isRuntimeRoute } = require('../session-runtime/lanes');
const { chatgptModelsEnabled } = require('./chatgpt-models-enabled');
const { assertApiProviderAdmissible } = require('./api-provider-runtime');
const { APPLICATION_TURN_HANDOFF_PREPARATION } = require('./session-handoff-context');
const { normalizeRequestApplicationTurn } = require('./application-turns');

// H2a admission: refuse a ChatGPT turn once the credential is revoked, or once
// the running sidecar is holding a stale credential generation (sign-out landed
// but the reconfiguration that would drop the token has not been applied).
// Deliberately NOT keyed on getCachedAccessToken() === '': that also reports ''
// for a merely-stale-but-refreshable token, which is a normal signed-in state.
// `category: 'setup'` is load-bearing — chat-error-recovery.js maps it to the
// open_settings/open_diagnostics actions, so no new error code is needed.
function assertChatgptCredentialAdmissible(service, route = null) {
  const engineType = route
    ? String(route.engine_type || '').trim().toLowerCase()
    : String(service.currentEngineType || '').trim().toLowerCase();
  if (engineType !== 'chatgpt') {
    return;
  }
  if (!chatgptModelsEnabled(service.configService)) {
    const error = new Error('ChatGPT models are turned off. Turn them on in Settings > Models.');
    error.code = 'chatgpt_models_disabled';
    error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
    error.category = 'setup';
    error.retryable = false;
    throw error;
  }
  const auth = service.chatgptAuthService;
  if (!auth || typeof auth.hasCredential !== 'function') {
    // Preserve legacy test-double/composition behavior only when no captured
    // runtime route asks for a credential-bearing provider explicitly.
    if (!route) return;
  }
  const revoked = !auth || typeof auth.hasCredential !== 'function' || !auth.hasCredential();
  const credentialEpoch = auth?.getCredentialEpoch?.();
  const runtimeStale = route
    ? !Number.isSafeInteger(credentialEpoch)
      || !Number.isSafeInteger(service._chatgptRuntimeCredentialEpoch)
      || service._chatgptRuntimeCredentialEpoch !== credentialEpoch
    : typeof auth?.getCredentialEpoch === 'function'
      && Number(service._chatgptRuntimeCredentialEpoch ?? -1) !== Number(credentialEpoch);
  if (!revoked && !runtimeStale) {
    return;
  }
  const error = new Error('Sign in with ChatGPT again before starting a new chat.');
  error.code = 'chatgpt_signed_out';
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'setup';
  error.retryable = false;
  throw error;
}

function assertCodexCliCredentialAdmissible(service, route) {
  if (String(route?.engine_type || '').trim().toLowerCase() !== 'codex-cli') return;
  const state = service.codexCliRuntimeService?.getState?.();
  const credentialEpoch = service.codexCliAuthService?.getCredentialEpoch?.();
  const authType = String(state?.authType || state?.auth_type || '').trim().toLowerCase();
  if (state?.status === 'ready' && authType === 'chatgpt'
    && Number.isSafeInteger(credentialEpoch)) return;
  const error = new Error('Sign in with ChatGPT through Codex CLI before starting a new chat.');
  error.code = 'codex_cli_auth_required';
  error.error_code = AI_ERROR_CODES.ENGINE_CONNECTION;
  error.category = 'setup';
  error.retryable = false;
  throw error;
}

function assertChatTurnAdmissible(service, sessionId, route = null) {
  if (route && !isRuntimeRoute(route)) {
    throw new TypeError('runtime_provider_route_untrusted');
  }
  const admission = service.exclusiveGpuCoordinator?.getState?.();
  const requiresGpu = route ? route.requires_gpu : true;
  if (requiresGpu && admission && admission.state !== 'chat_resident') {
    const error = new Error('A privileged local workload is using the GPU. Wait for it to finish or cancel it.');
    error.code = 'gpu_busy_plugin';
    if (route) error.retryable = true;
    throw error;
  }
  const normalizedSessionId = String(sessionId || '').trim();
  // Admission runs before a waiting turn owns a lane. Session type is already
  // canonical summary metadata; do not hydrate its transcript just to inspect it.
  const store = service.sessionStore;
  const session = normalizedSessionId
    ? (typeof store?.getSessionSummary === 'function'
      ? store.getSessionSummary(normalizedSessionId)
      : store?.getSession?.(normalizedSessionId))
    : null;
  if (session && !sessionAllowsChatSend(session)) {
    const error = new Error('This plugin session does not accept chat turns.');
    error.code = 'session_type_mismatch';
    throw error;
  }
  assertChatgptCredentialAdmissible(service, route);
  assertApiProviderAdmissible(service, route);
  if (route) assertCodexCliCredentialAdmissible(service, route);
}

// Row 59 linked chats: a child created but not yet admitted starts no other turn until its handoff
// first turn is admitted or the proposal is cancelled. The first turn passes with its own runtime key.
function assertLinkedFirstTurnAdmissible(service, sessionId, idempotencyKey = null) {
  const reason = service.chatProposals?.linkedFirstTurnBlock?.(String(sessionId || '').trim(), idempotencyKey);
  if (!reason) return;
  throw Object.assign(new Error('This chat is waiting for its first turn to start.'), {
    code: reason, retryable: false, submissionOutcome: 'rejected',
  });
}

// A Retry or Edit reuses its anchor user message as an ordinary prompt. An app-started turn's anchor
// is only an app label: only the proposal card can run a New session preparation turn again, and a
// wake or auto-resume turn continues with the person's next message.
function assertRegenerateAnchorAdmissible(service, sessionId, editedMessageId) {
  const messages = service.sessionStore?.getSession?.(String(sessionId || '').trim())?.messages;
  const anchor = Array.isArray(messages) ? messages.find((message) => message?.id === editedMessageId) : null;
  if (anchor?.application_turn === APPLICATION_TURN_HANDOFF_PREPARATION) {
    throw Object.assign(new Error('Retry this from the New session card.'), {
      code: 'handoff_preparation_retry_refused', retryable: false, submissionOutcome: 'rejected',
    });
  }
  if (!normalizeRequestApplicationTurn(anchor?.application_turn)) return;
  throw Object.assign(new Error('Send a message to continue.'), {
    code: 'application_turn_retry_refused', retryable: false, submissionOutcome: 'rejected',
  });
}

function assertRuntimeTranscriptAdmission(service) {
  const inspect = service.sessionStore?.getTranscriptCachePressure;
  if (typeof inspect !== 'function') return;
  let pressure;
  try { pressure = inspect.call(service.sessionStore); } catch (_error) { pressure = null; }
  if (!pressure || pressure.backpressured !== false) {
    throw Object.assign(new Error('runtime_transcript_cache_pressure'), {
      code: 'runtime_transcript_cache_pressure', retryable: true,
    });
  }
}

module.exports = {
  assertRuntimeTranscriptAdmission,
  assertChatTurnAdmissible,
  assertLinkedFirstTurnAdmissible,
  assertChatgptCredentialAdmissible,
  assertRegenerateAnchorAdmissible,
};
