'use strict';

const { hasDurableProof } = require('../backend/conversation-store-port');

function isFutureSchema(store) {
  return typeof store?.hasNewerSchema === 'function' && store.hasNewerSchema() === true;
}

function usablePort(store) {
  const port = store?.conversationStore;
  return port
    && typeof port.getSession === 'function'
    && typeof port.getRollbackSnapshot === 'function'
    && typeof port.restoreSnapshot === 'function'
    && typeof port.updateSession === 'function'
    ? port
    : null;
}

function removeCreatedShadow(shadowStore, sessionId) {
  if (!shadowStore?.getSession?.(sessionId)) return true;
  if (shadowStore.deleteSession?.(sessionId) !== true) return false;
  try {
    shadowStore.flush?.();
  } catch (_error) {
    return false;
  }
  return !shadowStore.getSession?.(sessionId)
    && shadowStore.hasPendingWrites?.() !== true;
}

function restoreSnapshot(port, sessionId, snapshot) {
  if (!snapshot) return true;
  try {
    return hasDurableProof(port.restoreSnapshot(sessionId, snapshot));
  } catch (_error) {
    return false;
  }
}

function failedAssignment(reason, failureStore, {
  canonicalRestored = true,
  shadowRestored = true,
} = {}) {
  return {
    ok: false,
    reason,
    repair: {
      failure_store: failureStore,
      canonical_restored: canonicalRestored,
      shadow_restored: shadowRestored,
      repair_required: !canonicalRestored || !shadowRestored,
    },
  };
}

function assignSessionProjectDurably({
  sessionStore,
  shadowStore = null,
  sessionId,
  projectId,
  updatedAt,
} = {}) {
  const canonicalPort = usablePort(sessionStore);
  const shadowPort = shadowStore && shadowStore !== sessionStore
    ? usablePort(shadowStore)
    : null;
  if (!canonicalPort || (shadowStore && shadowStore !== sessionStore && !shadowPort)) {
    return failedAssignment('session_store_unavailable', 'preflight');
  }
  if (isFutureSchema(sessionStore)) {
    return failedAssignment('session_store_future_schema', 'canonical');
  }
  if (shadowPort && isFutureSchema(shadowStore)) {
    return failedAssignment('session_store_future_schema', 'shadow');
  }

  const canonicalSnapshot = canonicalPort.getRollbackSnapshot(sessionId);
  if (!canonicalSnapshot) return failedAssignment('session_not_found', 'canonical');
  const shadowSnapshot = shadowPort?.getRollbackSnapshot(sessionId) || null;
  const patch = {
    project_id: projectId,
    ...(updatedAt ? { updated_at: updatedAt } : {}),
  };

  let canonicalCommit;
  try {
    canonicalCommit = canonicalPort.updateSession(sessionId, patch, { durable: true });
  } catch (_error) {
    canonicalCommit = null;
  }
  if (!hasDurableProof(canonicalCommit)) {
    const canonicalRestored = restoreSnapshot(canonicalPort, sessionId, canonicalSnapshot);
    return failedAssignment('session_update_failed', 'canonical', { canonicalRestored });
  }

  if (!shadowPort) {
    return { ok: true, session: sessionStore.getSessionSummary(sessionId) };
  }

  let shadowCommit;
  try {
    shadowCommit = shadowSnapshot
      ? shadowPort.updateSession(sessionId, patch, { durable: true })
      : shadowPort.createSession(sessionId, canonicalPort.getSession(sessionId), { durable: true });
  } catch (_error) {
    shadowCommit = null;
  }
  if (hasDurableProof(shadowCommit)) {
    return { ok: true, session: sessionStore.getSessionSummary(sessionId) };
  }

  const shadowRestored = shadowSnapshot
    ? restoreSnapshot(shadowPort, sessionId, shadowSnapshot)
    : removeCreatedShadow(shadowStore, sessionId);
  const canonicalRestored = restoreSnapshot(canonicalPort, sessionId, canonicalSnapshot);
  return failedAssignment('session_update_failed', 'shadow', {
    canonicalRestored,
    shadowRestored,
  });
}

module.exports = { assignSessionProjectDurably };
