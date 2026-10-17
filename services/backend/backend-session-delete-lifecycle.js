const { deleteSession } = require('./backend-sessions');
const { purgeSessionMemories } = require('./backend-memory');
const { purgeConversationIndex } = require('./conversation-index-pump');
const {
  CANCEL_REASON_SESSION_DELETE,
  createCancellationError,
} = require('./chat-stream-terminal-utils');

// Memory v2 (row 58): a deleted chat takes its chat-scope memories with it,
// once the delete has committed (a refused or retained delete keeps the live
// chat's memory). A missing sidecar or a failed request is logged (reason
// only); startup reconciliation retries a failed purge.
async function purgeChatMemories(service, sessionId) {
  let reason = '';
  try {
    const purged = await purgeSessionMemories(service, sessionId);
    if (purged?.ok !== true) reason = String(purged?.reason || 'purge_refused');
  } catch (error) {
    reason = String(error?.error_code || error?.category || 'sidecar_request_failed').slice(0, 80);
  }
  if (reason) {
    service._emitServiceLog(reason === 'sidecar_unavailable' ? 'INFO' : 'WARN',
      'lifecycle.session_memory_purge_skipped', { reason });
  }
}

async function deleteSessionWithQuiescence(service, sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const onlyIfIdle = options?.onlyIfIdle === true;
  const refused = (reason) => ({ object: 'session', id: normalizedSessionId, deleted: false, reason });
  if (onlyIfIdle) {
    const session = service.sessionStore.getSession(normalizedSessionId);
    if (!session) return refused('not_found');
    if (session.pending_question_batch || session.active_turn) return refused('session_busy');
    if (typeof options.expectedUpdatedAt !== 'string'
      || session.updated_at !== options.expectedUpdatedAt) return refused('activity_changed');
    if (service.sessionRuntime?.hasSessionWork?.(normalizedSessionId) === true) {
      return refused('runtime_work_active');
    }
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
    let runtimeQuiescence = { ok: true };
    let runtimeWait = null;
    if (!onlyIfIdle && service.sessionRuntime) {
      runtimeWait = typeof service.sessionRuntime.cancelSessionAndWait === 'function'
        ? service.sessionRuntime.cancelSessionAndWait(normalizedSessionId, {
          reason: 'session_deleted', timeoutMs: 5_000, deletionHandle: deletion,
        })
        : Promise.resolve({ ok: false, reason: 'runtime_cancellation_unavailable' });
    }
    const [quiescence, runtimeResult] = await Promise.all([
      service.sessionTurnActors.awaitQuiescence(deletion, { timeoutMs: 5_000 }),
      runtimeWait || Promise.resolve(runtimeQuiescence),
    ]);
    runtimeQuiescence = runtimeResult;
    if (runtimeQuiescence?.ok !== true) {
      service.sessionTurnActors.rollbackDeletion(deletion);
      service._emitServiceLog('WARN', 'lifecycle.session_runtime_delete_not_quiescent', {
        sessionId: normalizedSessionId,
        reason: runtimeQuiescence?.reason || 'runtime_not_quiescent',
        timedOut: runtimeQuiescence?.timedOut === true,
      });
      return refused(runtimeQuiescence?.reason || 'runtime_not_quiescent');
    }
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
        if (onlyIfIdle && service.sessionRuntime?.hasSessionWork?.(normalizedSessionId) === true) {
          return refused('runtime_work_active');
        }
        try { service.sessionRuntime?.retireSettledLineage?.(normalizedSessionId); }
        catch (_error) { return refused('runtime_lineage_retained'); }
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
    if (committed.result?.deleted !== false) {
      await purgeChatMemories(service, normalizedSessionId);
      // Row 58 W4: the derived conversation index; not awaited, never fails the delete.
      void purgeConversationIndex(service, normalizedSessionId);
    }
    return committed.result;
  } catch (error) {
    service.sessionTurnActors.rollbackDeletion(deletion);
    throw error;
  }
}

module.exports = { deleteSessionWithQuiescence };
