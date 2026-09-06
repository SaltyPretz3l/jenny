'use strict';

// Exclusive-GPU and session-type admission for chat-turn entry points.

const { sessionAllowsChatSend } = require('./session-type');
const { AI_ERROR_CODES } = require('./error-codes');

// H2a admission: refuse a ChatGPT turn once the credential is revoked, or once
// the running sidecar is holding a stale credential generation (sign-out landed
// but the reconfiguration that would drop the token has not been applied).
// Deliberately NOT keyed on getCachedAccessToken() === '': that also reports ''
// for a merely-stale-but-refreshable token, which is a normal signed-in state.
// `category: 'setup'` is load-bearing — chat-error-recovery.js maps it to the
// open_settings/open_diagnostics actions, so no new error code is needed.
function assertChatgptCredentialAdmissible(service) {
  if (String(service.currentEngineType || '').trim().toLowerCase() !== 'chatgpt') {
    return;
  }
  const auth = service.chatgptAuthService;
  if (!auth || typeof auth.hasCredential !== 'function') {
    // Not wired (older composition / test doubles) -> not our gate.
    return;
  }
  const revoked = !auth.hasCredential();
  const runtimeStale = typeof auth.getCredentialEpoch === 'function'
    && Number(service._chatgptRuntimeCredentialEpoch ?? -1) !== Number(auth.getCredentialEpoch());
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

function assertChatTurnAdmissible(service, sessionId) {
  const admission = service.exclusiveGpuCoordinator?.getState?.();
  if (admission && admission.state !== 'chat_resident') {
    const error = new Error('A privileged local workload is using the GPU. Wait for it to finish or cancel it.');
    error.code = 'gpu_busy_plugin';
    throw error;
  }
  const normalizedSessionId = String(sessionId || '').trim();
  const session = normalizedSessionId
    ? service.sessionStore?.getSession?.(normalizedSessionId)
    : null;
  if (session && !sessionAllowsChatSend(session)) {
    const error = new Error('This plugin session does not accept chat turns.');
    error.code = 'session_type_mismatch';
    throw error;
  }
  assertChatgptCredentialAdmissible(service);
}

module.exports = {
  assertChatTurnAdmissible,
  assertChatgptCredentialAdmissible,
};
