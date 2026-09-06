const {
  CANCEL_REASON_SESSION_DELETE,
  CANCEL_REASON_USER,
  buildTerminalErrorPayload,
  createCancellationError,
  enrichTerminalErrorPayloadForEmit,
  resolveTerminalRouting,
  streamErrorDetailsFromAbortSignal,
} = require('./chat-stream-terminal-utils');
const { resolveModel } = require('./backend-chat-model-resolution');
const {
  buildCompactionSnapshotFromResult,
  fingerprintCompactionPrefix,
} = require('./session-compaction-snapshot');
const { buildCompactPayloadMessages } = require('./backend-compact-payload');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../tools/tool-permission-store');
const {
  assertSessionLockdownAllowsEngine,
  isSessionOfflineLockdownActive,
  openAiCompatibleUrlFromService,
} = require('./session-lockdown-gate');

function settlePendingUserQuestionsForStream(service, streamId) {
  const normalizedStreamId = String(streamId || '').trim();
  if (!normalizedStreamId || !(service?.pendingUserQuestions instanceof Map)) return;
  for (const [questionRef, pending] of service.pendingUserQuestions.entries()) {
    if (String(pending?.streamId || '').trim() === normalizedStreamId) {
      pending.resolve({ declined: true });
      service.pendingUserQuestions.delete(questionRef);
    }
  }
}

function handleChatStreamEnd(service, event) {
  if (event?.type !== 'complete' && event?.type !== 'error') return;
  settlePendingUserQuestionsForStream(service, event.streamId);
}

function cancelChatStream(service, streamId, reason = CANCEL_REASON_USER) {
  const controller = service.activeStreams.get(streamId);
  if (!controller) {
    return false;
  }
  const cancelError = createCancellationError(reason);
  controller.abort(cancelError);
  service.activeStreams.delete(streamId);
  for (const [callId, pending] of service.pendingToolApprovals.entries()) {
    if (pending.streamId === streamId) {
      pending.resolve(false, 'cancelled');
      service.pendingToolApprovals.delete(callId);
    }
  }
  settlePendingUserQuestionsForStream(service, streamId);
  if (service.toolExecutor) {
    service.toolExecutor.cancelPendingForStream(streamId);
  }
  if (typeof service._emitServiceLog === 'function') {
    service._emitServiceLog('INFO', 'chat.stream_abort_requested', {
      streamId,
      traceId: String(controller.traceId || '').trim(),
      cancelReason: cancelError.cancel_reason,
      cancel_reason: cancelError.cancel_reason,
    });
  }
  // The stream is already aborted via controller.abort(). The managed
  // sidecar's generator detects the interrupted read and cleans up.
  // A full restart is reserved for genuine failures (timeout, crash) —
  // not routine user cancellation.  If the sidecar becomes unresponsive
  // after cancel, the next chat.send or auto-reconnect will handle it.
  return true;
}

// Manual/on-demand compaction (Settings "Compact now"): forwards the
// session's canonical history to the sidecar's chat.compact RPC and, on a
// successful compaction, persists the returned replacement messages as the
// session's Electron-owned compaction snapshot (JCA-003) so the next
// chat.send substitutes them for the summarized prefix. Never throws, always
// resolves to a structured { status, ... } payload so the caller can render
// it inline.
async function compactContextNow(service, sessionId) {
  const normalizedSessionId = String(sessionId || '').trim();
  service._emitServiceLog('INFO', 'chat.compact_now_requested', {
    sessionId: normalizedSessionId,
  });
  // Guards live inside the try so the never-throws contract is structural,
  // not dependent on these accessors never throwing.
  try {
    if (!service.sidecarClient || service.sidecarManager?.getStatus()?.phase !== 'ready') {
      service._emitServiceLog('WARN', 'chat.compact_now_result', {
        sessionId: normalizedSessionId,
        reason: 'sidecar_unavailable',
      });
      return { status: 'error', reason: 'sidecar_unavailable' };
    }
    // Canonical history source (JCA-003): the SAME store chat.send assembles
    // its prompt from, so the persisted boundary (count + last message id)
    // addresses messages the next send will actually see.
    // A locked session's transcript must not be summarised by a remote engine;
    // the lockdown gate covers compaction as well as chat.send.
    try {
      assertSessionLockdownAllowsEngine({
        active: isSessionOfflineLockdownActive(service.featureFlags, service.sessionStore.getSession?.(normalizedSessionId)),
        engineType: service.currentEngineType,
        openAiCompatibleApiUrl: openAiCompatibleUrlFromService(service),
      });
    } catch (_lockdownError) {
      service._emitServiceLog('WARN', 'chat.compact_now_result', {
        sessionId: normalizedSessionId,
        reason: 'session_offline_lockdown',
      });
      return { status: 'error', reason: 'session_offline_lockdown' };
    }
    const rawMessages = service.sessionStore.getSessionMessages(normalizedSessionId);
    const canonicalMessages = Array.isArray(rawMessages) ? rawMessages : [];
    const boundaryMessage = canonicalMessages[canonicalMessages.length - 1] || null;
    const messages = buildCompactPayloadMessages(canonicalMessages);
    // The boundary (count, last-id) compatibility check cannot see an in-place
    // edit that preserves ids and count, so fingerprint the exact history sent
    // to the sidecar and refuse to persist if it changed mid-summarization.
    const historyFingerprint = fingerprintCompactionPrefix(canonicalMessages);
    const result = await service.sidecarClient.chatCompact(normalizedSessionId, messages);
    const resultStatus = String(result?.status || '').trim();
    let snapshotPersisted = false;
    if (resultStatus === 'ok' && result?.compacted === true) {
      const postCompactionMessages = service.sessionStore.getSessionMessages(normalizedSessionId);
      const prefixUnchanged = fingerprintCompactionPrefix(
        (Array.isArray(postCompactionMessages) ? postCompactionMessages : [])
          .slice(0, canonicalMessages.length)
      ) === historyFingerprint;
      const snapshot = prefixUnchanged
        ? buildCompactionSnapshotFromResult(result, {
          boundaryMessageId: String(boundaryMessage?.id || ''),
          boundaryMessageCount: canonicalMessages.length,
        })
        : null;
      snapshotPersisted = Boolean(
        snapshot
        && service.sessionStore.setCompactionSnapshot(normalizedSessionId, snapshot)
      );
      service._emitServiceLog(
        snapshotPersisted ? 'INFO' : 'WARN',
        'chat.compaction_snapshot_persisted',
        {
          sessionId: normalizedSessionId,
          persisted: snapshotPersisted,
          prefix_unchanged: prefixUnchanged,
          strategy: String(result?.strategy || '').trim(),
          boundary_message_count: canonicalMessages.length,
        }
      );
    }
    service._emitServiceLog(
      resultStatus === 'ok' ? 'INFO' : 'WARN',
      'chat.compact_now_result',
      {
        sessionId: normalizedSessionId,
        status: resultStatus,
        reason: String(result?.reason || '').trim(),
        snapshot_persisted: snapshotPersisted,
      }
    );
    if (!result || typeof result !== 'object') {
      return result;
    }
    // The compacted replacement history lives in the session store; the
    // renderer status line only needs the outcome, so keep `messages` off the
    // IPC payload and report whether future turns will actually use it.
    const { messages: _compactedMessages, ...renderableResult } = result;
    return resultStatus === 'ok'
      ? { ...renderableResult, snapshot_persisted: snapshotPersisted }
      : renderableResult;
  } catch (error) {
    service._emitServiceLog('WARN', 'chat.compact_now_result', {
      sessionId: normalizedSessionId,
      reason: 'compaction_failed',
      detail: String(error?.message || error || '').slice(0, 300),
    });
    return {
      status: 'error',
      reason: 'compaction_failed',
      detail: String(error?.message || error || '').slice(0, 300),
    };
  }
}

function resolvePendingApprovalEntry(service, approvalRef) {
  const normalizedRef = String(approvalRef || '').trim();
  if (!normalizedRef || !(service?.pendingToolApprovals instanceof Map)) {
    return null;
  }
  const exact = service.pendingToolApprovals.get(normalizedRef);
  if (exact) {
    return { key: normalizedRef, pending: exact };
  }
  const matches = [];
  for (const [key, pending] of service.pendingToolApprovals.entries()) {
    if (
      String(pending?.approvalId || '').trim() === normalizedRef
      || String(pending?.callId || '').trim() === normalizedRef
    ) {
      matches.push({ key, pending });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function maybeApplyAlwaysAllowPolicy(service, pending, options = {}) {
  if (options?.alwaysAllow !== true) {
    return;
  }
  const toolName = String(pending?.toolName || '').trim();
  if (!toolName || NEVER_PERSIST_ALWAYS_ALLOW.has(toolName)) {
    return;
  }
  const permissionStore = service?.toolPermissionStore || service?.toolExecutor?._permissionStore || null;
  let policyUpdated = false;
  if (permissionStore && (
    typeof permissionStore.grantAlwaysAllow === 'function'
    || typeof permissionStore.setPolicy === 'function'
  )) {
    try {
      // Path-bearing calls persist an exact path-prefix grant for this tool.
      // Calls without a declared path target retain the whole-tool policy.
      if (typeof permissionStore.grantAlwaysAllow === 'function') {
        const grant = permissionStore.grantAlwaysAllow(toolName, pending?.toolInput);
        if (grant?.scope === 'path' && typeof service?._emitServiceLog === 'function') {
          service._emitServiceLog('INFO', 'tool_permission.always_allow_scoped', {
            toolName,
            pathPrefix: grant.pathPrefix,
            ruleId: grant.ruleId,
          });
        }
      } else {
        permissionStore.setPolicy(toolName, 'auto');
      }
      policyUpdated = true;
    } catch (error) {
      if (typeof service?._emitServiceLog === 'function') {
        service._emitServiceLog('WARN', 'tool_permission.always_allow_update_failed', {
          toolName,
          message: String(error?.message || error || '').slice(0, 500),
        });
      }
    }
  }
  if (policyUpdated && typeof service?.refreshManagedConfig === 'function') {
    Promise.resolve(service.refreshManagedConfig('tool_permission_updated')).catch(() => null);
  }
}

function approveToolCall(service, approvalRef, options = {}) {
  const entry = resolvePendingApprovalEntry(service, approvalRef);
  if (!entry) {
    return false;
  }
  // Settle the waiter FIRST: alwaysAllow is a side effect of this specific
  // approval, not a precondition for it. Applying the global policy before
  // resolve() meant a settlement throw left the policy permanently flipped
  // even though the waiter itself hung forever (SP-13). Reordering means the
  // policy write can never outlive/outrun the decision it is attached to, and
  // a policy-write failure only logs — it never affects the settlement above.
  const requestedDecision = String(options?.decision || 'approved').trim();
  const decision = ['approved', 'approved_auto', 'rejected'].includes(requestedDecision)
    ? requestedDecision
    : 'approved';
  const feedback = String(options?.feedback || '').trim().slice(0, 800);
  entry.pending.resolve(true, decision, feedback, options?.plan);
  service.pendingToolApprovals.delete(entry.key);
  try {
    maybeApplyAlwaysAllowPolicy(service, entry.pending, options);
  } catch (error) {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', 'tool_permission.always_allow_apply_failed', {
        approvalId: String(entry?.pending?.approvalId || approvalRef || ''),
        toolName: String(entry?.pending?.toolName || ''),
        message: String(error?.message || error || ''),
      });
    }
  }
  return true;
}

function denyToolCall(service, approvalRef) {
  const entry = resolvePendingApprovalEntry(service, approvalRef);
  if (!entry) {
    return false;
  }
  entry.pending.resolve(false, 'denied');
  service.pendingToolApprovals.delete(entry.key);
  return true;
}

function resolvePendingQuestionEntry(service, questionRef) {
  const normalizedRef = String(questionRef || '').trim();
  if (!normalizedRef || !(service?.pendingUserQuestions instanceof Map)) {
    return null;
  }
  const exact = service.pendingUserQuestions.get(normalizedRef);
  if (exact) return { key: normalizedRef, pending: exact };
  const matches = [];
  for (const [key, pending] of service.pendingUserQuestions.entries()) {
    if (
      String(pending?.questionRef || '').trim() === normalizedRef
      || String(pending?.questionId || '').trim() === normalizedRef
      || String(pending?.callId || '').trim() === normalizedRef
    ) {
      matches.push({ key, pending });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function hasPendingUserQuestions(service, questionRef) {
  return Boolean(resolvePendingQuestionEntry(service, questionRef));
}

function answerUserQuestions(service, questionRef, payload = {}) {
  const entry = resolvePendingQuestionEntry(service, questionRef);
  if (!entry) return false;
  const resolution = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload
    : {};
  entry.pending.resolve(resolution);
  service.pendingUserQuestions.delete(entry.key);
  return true;
}

function declineUserQuestions(service, questionRef) {
  const entry = resolvePendingQuestionEntry(service, questionRef);
  if (!entry) return false;
  entry.pending.resolve({ declined: true });
  service.pendingUserQuestions.delete(entry.key);
  return true;
}

module.exports = {
  resolveModel,
  cancelChatStream,
  compactContextNow,
  approveToolCall,
  denyToolCall,
  handleChatStreamEnd,
  hasPendingUserQuestions,
  answerUserQuestions,
  declineUserQuestions,
};
