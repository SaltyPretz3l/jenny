'use strict';

/* services/backend/session-directory-tool-gate.js - which chats are offered the
 * session-directory tools (owner decision, 2026-10-20, row 69 Q6). Their schemas cost
 * a small local model real budget, so only the primary Jenny chat and chats with linked
 * relatives see them: a `spawned_from` parent, or another chat this one spawned. A
 * branch relation (`linked_session_ids`) is not linkage. Every other chat gets the
 * three names on its per-request `disabled_tools`; call-time scoping in the directory
 * service is unchanged. An unreadable session listing hides them (fail closed).
 *
 * Kill switches: `JENNY_ENABLE_SESSION_DIRECTORY_TOOL_GATE=0` offers them to every chat
 * again; with `tools_session_directory_enabled` off they are not registered at all, so
 * the request is left as it was.
 */

const { isPrimaryChatTurn } = require('./chat-send-optional-fields');
const { parentOf } = require('../session-directory-scope');

const DIRECTORY_TOOL_NAMES = Object.freeze(['sessions_list', 'session_status', 'session_transcript', 'session_stop']);

// Chats offered the tools because they spawned a child keep them for the process lifetime, so a
// deleted child does not drop ~870 tokens of schema and re-prefill the chat's whole prompt.
const offeredParents = new WeakMap();

// One pass over the raw session index (no sort, copy, clone or normalize); no transcript reads.
function hasSpawnedChild(service, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return false;
  const store = service?.sessionStore;
  const known = offeredParents.get(service);
  if (known?.has(sessionId)) return true;
  try {
    const isChild = (other) => other?.id !== sessionId && parentOf(other) === sessionId;
    const found = typeof store?.peekSessionSummary === 'function' && typeof store.getSessionIds === 'function'
      ? store.getSessionIds().some((id) => isChild(store.peekSessionSummary(id)))
      : (store?.listSessions?.() || []).some(isChild);
    if (found === true && service && typeof service === 'object') {
      if (known) known.add(sessionId);
      else offeredParents.set(service, new Set([sessionId]));
    }
    return found === true;
  } catch (_error) {
    return false;
  }
}

function directoryToolsOffered(service, { sessionId, session } = {}) {
  const flags = service?.featureFlags;
  if (flags?.session_directory_tool_gate === false || flags?.tools_session_directory_enabled === false) return true;
  return isPrimaryChatTurn(service, session) || parentOf(session) !== null
    || hasSpawnedChild(service, sessionId || session?.id);
}

// The turn's tool preferences with the directory tools denied when this chat is not offered them.
function withDirectoryToolGate(service, target, toolPreferences) {
  if (directoryToolsOffered(service, target)) return toolPreferences;
  const base = toolPreferences && typeof toolPreferences === 'object' && !Array.isArray(toolPreferences)
    ? toolPreferences : {};
  const denied = new Set([...(Array.isArray(base.disabled_tools) ? base.disabled_tools : []), ...DIRECTORY_TOOL_NAMES]);
  return { ...base, disabled_tools: [...denied].sort() };
}

module.exports = { DIRECTORY_TOOL_NAMES, directoryToolsOffered, withDirectoryToolGate };
