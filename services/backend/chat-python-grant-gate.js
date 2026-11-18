'use strict';

// Session review 2026-11-17, owner decision D1: "Always" on a Python card allows Python for the rest of
// that chat, in the same project root. The sidecar still asks for every Python run
// (sidecar/ai/routing/tool_execution.py, "Python execution always requires approval"); this is consent
// held by Electron answering that request without a card, the way Full auto and an allowed edit round do.
//
// The grant lives in memory only: never written to the permission store, never project-wide. It ends when
// the chat is deleted or reset, or when the app restarts. It never applies on a team or hosted server, in
// paranoid safety mode (or one that cannot be read), or to a request that must be approved once by a person.
// Every call it answers still writes its own requested/resolved approval events, with scope `chat_python`.
const { getTrustedExecutionBinding } = require('./session-execution-authority');
const { isPrimarySession } = require('./primary-session');

const CHAT_PYTHON_SCOPE = 'chat_python';
// Rides the existing alwaysAllowScope field to the card, which then reads "Always for this chat".
const CHAT_ALWAYS_ALLOW_SCOPE = Object.freeze({ kind: 'chat' });
const CHAT_GRANT_SAFETY_MODES = new Set(['normal', 'strict']);
const MAX_GRANT_SESSIONS = 256;

// Mirrors runs_python in sidecar/ai/routing/tool_execution_admission.py: python_execute, or a
// run_temp_script whose language is exactly "python".
function isPythonRequest(toolName, input) {
  const name = String(toolName || '').trim();
  if (name === 'python_execute') return true;
  return name === 'run_temp_script' && Boolean(input) && typeof input === 'object' && input.language === 'python';
}

// The root the grant is bound to: the binding's trusted authority (root id + revision; no root is its own key).
function grantRootKey(executionAuthority) {
  const authority = getTrustedExecutionBinding(executionAuthority)?.authority;
  if (!authority || typeof authority !== 'object') return '';
  const revision = Number.isSafeInteger(authority.root_revision) ? authority.root_revision : -1;
  return `${authority.root_id === null || authority.root_id === undefined ? 'no-root' : String(authority.root_id)}:${revision}`;
}

function createChatPythonGrants({ maxSessions = MAX_GRANT_SESSIONS } = {}) {
  const bySession = new Map();
  return {
    note(sessionId, rootKey) {
      const id = String(sessionId || '').trim();
      if (!id || !rootKey) return false;
      const roots = bySession.get(id) || new Set();
      roots.add(rootKey);
      bySession.delete(id);
      bySession.set(id, roots);
      while (bySession.size > maxSessions) bySession.delete(bySession.keys().next().value);
      return true;
    },
    has(sessionId, rootKey) {
      return Boolean(rootKey) && bySession.get(String(sessionId || '').trim())?.has(rootKey) === true;
    },
    clearSession(sessionId) {
      bySession.delete(String(sessionId || '').trim());
    },
  };
}

// Whether a grant could apply to this request at all; a card that cannot be honoured never offers it.
function chatPythonGrantEligible(service, { toolName, input, oneOffOnly = false } = {}) {
  if (oneOffOnly === true || service?.hostMode === 'server' || !isPythonRequest(toolName, input)) return false;
  try {
    return CHAT_GRANT_SAFETY_MODES.has(service.configService?.getChatUiState?.()?.safetyMode);
  } catch {
    return false;
  }
}

// An idle (unattended) pause or a stopped turn always reaches a person, as with an allowed edit round. In
// the Jenny chat a grant answers only in an Auto turn: a scheduled check or digest there runs unwatched.
function chatPythonGrantApproves(service, {
  toolName, input, sessionId, executionAuthority, oneOffOnly, controller = null,
} = {}) {
  if (!chatPythonGrantEligible(service, { toolName, input, oneOffOnly })) return false;
  if (controller?.unattendedPauseRequested === true || controller?.signal?.aborted === true) return false;
  if (isPrimarySession(service?.sessionStore, sessionId)
    && getTrustedExecutionBinding(executionAuthority)?.capturedAutoRun !== true) return false;
  return service?.chatPythonGrants?.has?.(sessionId, grantRootKey(executionAuthority)) === true;
}

// A person pressed "Always for this chat" on a Python card. Returns true when the grant was recorded.
function noteChatPythonGrant(service, { toolName, input, sessionId, executionAuthority, oneOffOnly } = {}) {
  if (!chatPythonGrantEligible(service, { toolName, input, oneOffOnly })) return false;
  return service?.chatPythonGrants?.note?.(sessionId, grantRootKey(executionAuthority)) === true;
}

module.exports = {
  CHAT_ALWAYS_ALLOW_SCOPE,
  CHAT_PYTHON_SCOPE,
  chatPythonGrantApproves,
  chatPythonGrantEligible,
  createChatPythonGrants,
  isPythonRequest,
  noteChatPythonGrant,
};
