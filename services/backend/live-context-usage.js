'use strict';

// How full a chat's context window is, for jenny_status `budgets.context`.
//
// A model in a long agentic turn had no figure to check and stopped a seven-wave plan on a
// "close to the context limit" guess while it sat at 57% of a 256K window with automatic
// compaction already running. The sidecar's mid-turn `context.usage` notification carries
// the same reading the composer ring shows; the latest one per session is kept here (bounded,
// in memory, never persisted) and falls back to the session record's last terminal reading.

const { buildSessionContextUsageRecord } = require('./session-context-usage');

const MAX_LIVE_SESSIONS = 32;

function liveMap(service) {
  if (!service || typeof service !== 'object') return null;
  if (!(service._liveContextUsage instanceof Map)) service._liveContextUsage = new Map();
  return service._liveContextUsage;
}

// `usage` is a rebuilt chat.done-shaped usage block (chat-stream-usage.rebuildChatDoneUsage).
function noteLiveContextUsage(service, sessionId, usage) {
  const id = String(sessionId || '').trim();
  const record = id ? buildSessionContextUsageRecord(usage) : null;
  const map = record ? liveMap(service) : null;
  if (!map) return;
  map.delete(id);
  map.set(id, record);
  while (map.size > MAX_LIVE_SESSIONS) map.delete(map.keys().next().value);
}

function contextBudgetFor(service, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) return null;
  const live = liveMap(service)?.get(id) || null;
  let record = live;
  if (!record) {
    try {
      record = service?.sessionStore?.getSessionSummary?.(id)?.context_usage || null;
    } catch {
      record = null;
    }
  }
  const used = Number(record?.used_tokens) || 0;
  if (used <= 0) return null;
  const window = Number(record.context_window) || 0;
  const threshold = Number(record.compact_threshold_tokens) || 0;
  return {
    used_tokens: used,
    context_window: window || null,
    used_percent: window > 0 ? Math.round((used / window) * 100) : null,
    compact_threshold_tokens: threshold || null,
    reading: live ? 'this_turn' : 'last_turn',
    updated_at: record.updated_at || null,
    note: 'Older context is compacted automatically at the threshold, so a long task can keep '
      + 'going; cite this figure when giving context as a reason to stop.',
  };
}

module.exports = { MAX_LIVE_SESSIONS, contextBudgetFor, noteLiveContextUsage };
