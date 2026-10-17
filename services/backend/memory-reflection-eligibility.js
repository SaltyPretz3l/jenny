'use strict';

// Who may be reflected on (agentic memory v2, row 58 W2). The global switches
// are the memory_v2 flag, Settings "Jenny takes notes" (memory.takeNotes,
// default on) and a capture policy other than off; a chat must also be a plain,
// non-locked, non-child root chat the user has not opted out of, and the engine
// that would read it must be local.

const { buildMemoryPolicy, readMemorySettings } = require('./backend-memory');
const {
  isLocalEngine,
  isSessionOfflineLockdownActive,
  openAiCompatibleUrlFromService,
} = require('./session-lockdown-gate');
const { captureSessionRuntimeProviderRoute } = require('./session-runtime-provider-route');
const { readSessionType, CHAT_SESSION_TYPE } = require('./session-type');
const { CHILD_WORK_PURPOSE } = require('./runtime-child-publication');

function reflectionGloballyEnabled(service) {
  if (service?.featureFlags?.memory_v2_enabled !== true) return false;
  if (readMemorySettings(service).takeNotes !== true) return false;
  return buildMemoryPolicy(service, { includeMemory: true, memoryOptOut: false, projectId: null }).capture !== 'off';
}

// Whether this engine keeps a chat's text on the machine. The lane route calls
// every OpenAI-compatible endpoint "local" (a resource class, not a place), so
// the endpoint must also be loopback, the rule offline lockdown uses.
function isOnMachineEngine(service, engineType) {
  const route = captureSessionRuntimeProviderRoute(service, { engineType });
  return route.resource_class === 'local'
    && isLocalEngine(route.engine_type, openAiCompatibleUrlFromService(service));
}

// The current engine when it is on this machine, else null (cloud, a remote
// endpoint, unknown or invalid).
function localReflectionEngine(service) {
  try {
    const engineType = String(service?.currentEngineType || '').trim().toLowerCase();
    return isOnMachineEngine(service, engineType) ? engineType : null;
  } catch (_error) {
    return null;
  }
}

function lineageChildSessionIds(lineageStore) {
  if (!lineageStore) return [];
  // No root records means no children: skip the inventory read (it runs per send).
  // A read-only (unreadable) store falls through and throws.
  const state = lineageStore.snapshot?.();
  if (state && state.read_only !== true && state.root_record_count === 0) return [];
  const snapshot = lineageStore.exportPortableSnapshot();
  return (snapshot?.records || []).flatMap(({ document }) => (document?.children || [])
    .map(child => child?.session_id));
}

// Deleting a root retires its lineage record, so a child is also known from
// its own runtime work record: kind child_chat, kept through terminal
// compaction as original_kind, and never removed by session deletion. Only
// records with the application-set child purpose are read; the set is reused
// while the store revision is unchanged.
const runtimeChildCache = new WeakMap();
function runtimeChildSessionIds(store) {
  if (!store || typeof store.listSummaries !== 'function' || typeof store.get !== 'function') return new Set();
  const status = store.getStatus?.();
  if (status?.read_only === true) throw new Error('runtime_store_read_only');
  const cached = runtimeChildCache.get(store);
  if (cached && Number.isSafeInteger(status?.revision) && cached.revision === status.revision) return cached.ids;
  const ids = new Set();
  let cursor = null;
  do {
    const page = store.listSummaries({ limit: 100, cursor });
    for (const summary of page.items) {
      if (summary.purpose !== CHILD_WORK_PURPOSE || ids.has(summary.session_id)) continue;
      const input = store.get(summary.work_id)?.input;
      if (input?.kind === 'child_chat' || input?.original_kind === 'child_chat') ids.add(summary.session_id);
    }
    cursor = page.next_cursor;
  } while (cursor);
  if (Number.isSafeInteger(status?.revision)) runtimeChildCache.set(store, { revision: status.revision, ids });
  return ids;
}

// Child sessions are spawned work, not the user's own conversation. The
// runtime stores are read only here; an unreadable one fails closed.
function childSessionIds(service) {
  const runtime = service?.sessionRuntime;
  const ids = new Set(runtimeChildSessionIds(runtime?.store));
  for (const id of lineageChildSessionIds(runtime?.lineageStore)) ids.add(id);
  return ids;
}

function isChildSession(service, sessionId) {
  return childSessionIds(service).has(sessionId);
}

// Row 58 W3: which chats another chat may see (recap lines, conversations_*).
// The same rules as reflection minus the active-turn gate; the runtime stores
// are read once, and an unreadable one hides every chat (fails closed).
function visibleChatPredicate(service) {
  let children;
  try {
    children = childSessionIds(service);
  } catch (_error) {
    return () => false;
  }
  return session => Boolean(session && typeof session === 'object')
    && session.context_preferences?.memory_opt_out !== true
    && session.lockdown !== true
    && !isSessionOfflineLockdownActive(service?.featureFlags, session)
    && readSessionType(session) === CHAT_SESSION_TYPE
    && !session.diagnostic_mode
    && !children.has(session.id);
}

// The reason a chat may not be reflected on now, or null when it may.
function sessionIneligibility(service, session) {
  if (!session || typeof session !== 'object') return 'session_missing';
  if (session.context_preferences?.memory_opt_out === true) return 'memory_opt_out';
  // A stored marker counts with the lockdown feature off, as in visibleChatPredicate.
  if (session.lockdown === true || isSessionOfflineLockdownActive(service?.featureFlags, session)) return 'lockdown';
  if (readSessionType(session) !== CHAT_SESSION_TYPE) return 'plugin_session';
  if (session.diagnostic_mode) return 'diagnostic_session';
  if (session.active_turn) return 'turn_active';
  try {
    if (isChildSession(service, session.id)) return 'child_session';
  } catch (_error) {
    return 'lineage_unavailable';
  }
  return null;
}

module.exports = {
  localReflectionEngine,
  reflectionGloballyEnabled,
  sessionIneligibility,
  visibleChatPredicate,
};
