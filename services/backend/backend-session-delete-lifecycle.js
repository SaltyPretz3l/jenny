const { deleteSession } = require('./backend-sessions');
const {
  CANCEL_REASON_SESSION_DELETE,
  createCancellationError,
} = require('./chat-stream-terminal-utils');

async function deleteSessionWithQuiescence(service, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  const deletion = service.sessionTurnActors.beginDeletion(normalizedSessionId, {
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
      () => deleteSession(service, normalizedSessionId)
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
