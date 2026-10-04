'use strict';

// Settles a plugin session whose operation was interrupted (app closed or
// crashed mid-operation). The record still carries `plugin_session.active_operation`
// and a "Working..." assistant message; nothing else will ever finish them, so a
// read settles them once per session per backend. Mirrors
// settleStalePlanDocumentsOnRead: no schema bump, no migration step.

const { normalizePluginOperationMetadata } = require('./session-type');

const PLUGIN_OPERATION_AUDITS = new WeakMap();
const INTERRUPTED_CONTENT = 'The plugin operation was interrupted before it finished.';

function settleInterruptedPluginOperation(session) {
  const active = session?.session_type === 'plugin'
    ? session.plugin_session?.active_operation : null;
  if (!active) return { changed: false, session };
  const assistantId = active.assistant_message_id;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return {
    changed: true,
    session: {
      ...session,
      plugin_session: { ...session.plugin_session, active_operation: null },
      messages: assistantId ? messages.map((message) => (message?.id === assistantId ? {
        ...message,
        content: INTERRUPTED_CONTENT,
        status: 'runtime_error',
        plugin_operation: normalizePluginOperationMetadata({
          ...active, status: 'interrupted', reason_code: 'app_restarted',
        }),
      } : message)) : messages,
    },
  };
}

function settleInterruptedPluginOperationOnRead({
  backend, logger, sessionId, session, normalizeSession,
}) {
  const auditSessionIds = PLUGIN_OPERATION_AUDITS.get(backend) || new Set();
  PLUGIN_OPERATION_AUDITS.set(backend, auditSessionIds);
  if (!session || auditSessionIds.has(sessionId)) return session;
  auditSessionIds.add(sessionId);
  try {
    const settled = settleInterruptedPluginOperation(session);
    if (!settled.changed || backend.hasNewerSchema()) return session;
    const normalized = normalizeSession(sessionId, settled.session);
    if (backend.upsertSession(sessionId, normalized, { persist: true, alreadyNormalized: true })) {
      return normalized;
    }
  } catch (error) {
    logger?.('WARN', 'session_store.plugin_operation_settlement_failed', {
      sessionId, message: String(error?.message || error || '').slice(0, 240),
    });
  }
  auditSessionIds.delete(sessionId);
  return session;
}

module.exports = {
  settleInterruptedPluginOperation,
  settleInterruptedPluginOperationOnRead,
};
