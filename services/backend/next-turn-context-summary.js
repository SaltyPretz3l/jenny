'use strict';

const { normalizeContextPreferences } = require('./context-preferences');
const { buildPreparedContextHistory } = require('./chat-stream-reasoning');
const { normalizeCompactionSnapshot } = require('./session-compaction-snapshot');

const MAX_ATTACHMENT_COUNT = 64;

function normalizeDraftMetadata(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const count = Number(source.attachment_count ?? source.attachmentCount);
  return {
    attachment_count: Number.isSafeInteger(count) && count > 0
      ? Math.min(count, MAX_ATTACHMENT_COUNT)
      : 0,
    has_active_file: source.has_active_file === true || source.hasActiveFile === true,
    has_mentions: source.has_mentions === true || source.hasMentions === true,
  };
}

function buildNextTurnContextSummary(sessionStore, sessionId, draftMetadata = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (!normalizedSessionId || !sessionStore || typeof sessionStore.getSession !== 'function') {
    return { status: 'unavailable', reason: 'session_unavailable' };
  }
  let session;
  try {
    session = sessionStore.getSession(normalizedSessionId);
  } catch (_error) {
    return { status: 'unavailable', reason: 'session_read_failed' };
  }
  if (!session) return { status: 'unavailable', reason: 'session_not_found' };
  try {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const preferences = normalizeContextPreferences(session.context_preferences);
    const selectedHistory = buildPreparedContextHistory(messages, preferences);
    const availableHistory = buildPreparedContextHistory(messages, {
      ...preferences,
      history_scope: 'session',
    });
    const draft = normalizeDraftMetadata(draftMetadata);
    const narrowed = selectedHistory.length < availableHistory.length;
    return {
      status: 'estimated',
      history_scope: preferences.history_scope,
      history_message_count: selectedHistory.length,
      available_history_message_count: availableHistory.length,
      automatic_narrowing: narrowed,
      narrowing_reason: narrowed ? `history_scope_${preferences.history_scope}` : '',
      compaction_snapshot_present: Boolean(normalizeCompactionSnapshot(session.compaction_snapshot)),
      linked_session_count: Math.min(
        Array.isArray(session.linked_session_ids) ? session.linked_session_ids.length : 0,
        64
      ),
      context_categories: {
        personality: preferences.include_personality === true,
        approved_memory: preferences.include_memory === true,
        git: preferences.include_git_context === true,
        codebase: preferences.include_codebase_context === true,
        active_file: preferences.include_active_file_context === true && draft.has_active_file,
        mentions: draft.has_mentions,
        attachments: draft.attachment_count,
      },
    };
  } catch (_error) {
    return { status: 'unavailable', reason: 'history_shaping_failed' };
  }
}

module.exports = {
  MAX_ATTACHMENT_COUNT,
  buildNextTurnContextSummary,
  normalizeDraftMetadata,
};
