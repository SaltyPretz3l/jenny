'use strict';

const { isDeepStrictEqual } = require('node:util');
const {
  buildTerminalRepairOverlayMessage,
  overlayPendingTerminalRepairs,
} = require('./terminal-repair-overlay');

function normalizeId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function messageIntentMatches(canonical, intended) {
  if (!canonical || !intended || normalizeId(canonical.id) !== normalizeId(intended.id)) {
    return false;
  }
  return Object.entries(intended).every(([key, value]) => (
    key === 'durability' || isDeepStrictEqual(canonical[key], value)
  ));
}

function hasCanonicalRepairProof(messages, repair) {
  const intended = Array.isArray(repair?.terminal_snapshot?.messages)
    ? repair.terminal_snapshot.messages
    : [];
  if (!intended.length) return false;
  return intended.every((message) => {
    const matches = messages.filter((candidate) => (
      normalizeId(candidate?.id) === normalizeId(message?.id)
    ));
    return matches.length === 1 && messageIntentMatches(matches[0], message);
  });
}

function reconcileCanonicalTerminalRepairs(service, sessionId, messages, repairs) {
  const store = service?.terminalRepairStore;
  if (!store?.clearResolved) return repairs;
  const rawStore = service?.sessionStore || service?.shadowStore;
  if (rawStore?.getActiveTurn?.(sessionId)) return repairs;
  return repairs.filter((repair) => {
    if (!hasCanonicalRepairProof(messages, repair)) return true;
    try {
      const result = store.clearResolved(repair.artifact_id, {
        session_id: repair.session_id,
        session_incarnation: repair.session_incarnation,
        turn_generation: repair.turn_generation,
      });
      return result?.ok !== true || result?.durable !== true;
    } catch (_error) {
      return true;
    }
  });
}

function hydrateMessagesWithTerminalRepairs(service, sessionId, messages) {
  const normalizedSessionId = normalizeId(sessionId);
  if (!normalizedSessionId || !service?.terminalRepairStore?.listPending) {
    return Array.isArray(messages) ? messages : [];
  }
  const canonical = Array.isArray(messages) ? messages : [];
  const pending = service.terminalRepairStore.listPending(normalizedSessionId);
  return overlayPendingTerminalRepairs(
    canonical,
    reconcileCanonicalTerminalRepairs(service, normalizedSessionId, canonical, pending)
  );
}

function resolveTerminalRepairRequest(service, payload = {}, { allowDiscarded = false } = {}) {
  const sessionId = normalizeId(payload.sessionId);
  const messageId = normalizeId(payload.messageId);
  const artifactId = normalizeId(payload.artifactId);
  if (!sessionId || !artifactId) {
    return { ok: false, reason: 'invalid_request', sessionId, messageId, artifactId };
  }
  const artifact = service?.terminalRepairStore?.get?.(artifactId) || null;
  if (!artifact || (artifact.state !== 'pending' && !(allowDiscarded && artifact.state === 'discarded'))) {
    return { ok: false, reason: 'artifact_not_found', sessionId, messageId, artifactId };
  }
  const artifactMessageId = normalizeId(buildTerminalRepairOverlayMessage(artifact)?.id);
  if (
    artifact.session_id !== sessionId
    || artifactMessageId !== messageId
  ) {
    return { ok: false, reason: 'artifact_identity_conflict', sessionId, messageId, artifactId };
  }
  if (artifact.discard_requested === true && !allowDiscarded) {
    return { ok: false, reason: 'artifact_discard_pending', sessionId, messageId, artifactId };
  }
  return { ok: true, reason: null, sessionId, messageId, artifactId, artifact };
}

function buildRepairActionResult({
  ok = false,
  durable = false,
  reason = null,
  message = null,
  removedMessageId = '',
} = {}) {
  return {
    ok: ok === true,
    durable: durable === true,
    reason: reason ? String(reason) : null,
    ...(message ? { message } : {}),
    ...(normalizeId(removedMessageId) ? { removedMessageId: normalizeId(removedMessageId) } : {}),
  };
}

module.exports = {
  buildRepairActionResult,
  hydrateMessagesWithTerminalRepairs,
  resolveTerminalRepairRequest,
};
