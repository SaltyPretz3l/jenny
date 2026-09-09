const { deleteSession } = require('./backend-sessions');
const {
  CANCEL_REASON_SESSION_DELETE,
  createCancellationError,
} = require('./chat-stream-terminal-utils');

async function deleteSessionWithQuiescence(service, sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const onlyIfIdle = options?.onlyIfIdle === true;
  const refused = (reason) => ({ object: 'session', id: normalizedSessionId, deleted: false, reason });
  if (onlyIfIdle) {
    const session = service.sessionStore.getSession(normalizedSessionId);
    if (!session) return refused('not_found');
    if (session.pending_question_batch || session.active_turn) return refused('session_busy');
    // Plugin work has its own supervisor: bulk deletion fails closed rather
    // than stopping it as a side effect of cleanup.
    if (session.session_type === 'plugin' || session.plugin_session) return refused('plugin_session');
    if (typeof options.expectedUpdatedAt !== 'string'
      || session.updated_at !== options.expectedUpdatedAt) return refused('activity_changed');
  }
  const deletion = service.sessionTurnActors.beginDeletion(normalizedSessionId, {
    onlyIfIdle,
    cancel: (streamId, controller) => {
      const cancelled = service.cancelChatStream(streamId, CANCEL_REASON_SESSION_DELETE);
      if (!cancelled && controller && !controller.signal?.aborted) {
        controller.abort(createCancellationError(
          CANCEL_REASON_SESSION_DELETE,
          'Session deleted during stream.'
        ));
      }
      return cancelled;
    },
  });
  if (!deletion) return refused('session_busy');
  try {
    if (service._pluginSessionProviderBroker?.prepareSessionDeletion) {
      const pluginQuiescence = await service._pluginSessionProviderBroker
        .prepareSessionDeletion(normalizedSessionId);
      if (!pluginQuiescence?.ok) {
        service.sessionTurnActors.rollbackDeletion(deletion);
        service._emitServiceLog('WARN', 'lifecycle.plugin_session_delete_not_quiescent', {
          sessionId: normalizedSessionId,
          reason: pluginQuiescence?.reason || 'plugin_cleanup_unproven',
        });
        return {
          object: 'session', id: normalizedSessionId, deleted: false,
          reason: pluginQuiescence?.reason || 'plugin_cleanup_unproven',
        };
      }
    }
    const quiescence = await service.sessionTurnActors.awaitQuiescence(
      deletion, { timeoutMs: 5_000 }
    );
    if (!quiescence.ok) {
      service.sessionTurnActors.rollbackDeletion(deletion);
      service._emitServiceLog('WARN', 'lifecycle.session_delete_not_quiescent', {
        sessionId: normalizedSessionId,
        reason: quiescence.reason,
        timedOut: quiescence.timedOut === true,
      });
      return {
        object: 'session', id: normalizedSessionId, deleted: false,
        reason: quiescence.reason || 'not_quiescent',
      };
    }
    const committed = await service.sessionTurnActors.commitDeletion(
      deletion,
      () => {
        if (onlyIfIdle && service.sessionStore.getSession(normalizedSessionId)?.updated_at !== options.expectedUpdatedAt) {
          return refused('activity_changed');
        }
        return deleteSession(service, normalizedSessionId);
      }
    );
    if (!committed.ok) {
      service.sessionTurnActors.rollbackDeletion(deletion);
      return committed.result || {
        object: 'session', id: normalizedSessionId, deleted: false,
        reason: committed.reason || 'delete_refused',
      };
    }
    return committed.result;
  } catch (error) {
    service.sessionTurnActors.rollbackDeletion(deletion);
    throw error;
  } finally {
    service._pluginSessionProviderBroker?.finishSessionDeletion?.(normalizedSessionId);
  }
}

module.exports = { deleteSessionWithQuiescence };
