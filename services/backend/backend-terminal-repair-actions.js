'use strict';

const { validateTerminalIdentity } = require('./chat-lifecycle-contracts');
const {
  buildRepairActionResult,
  resolveTerminalRepairRequest,
} = require('./terminal-repair-service');
const { normalizeId } = require('../shared/normalize');

function resolveStores(service) {
  const rawStore = service?.sessionStore || service?.shadowStore;
  const conversationStore = rawStore?.conversationStore || service?.conversationStore || null;
  return { rawStore, conversationStore };
}

function activeIdentity(rawStore, artifact) {
  const sessionId = normalizeId(artifact?.session_id);
  const session = rawStore?.getSession?.(sessionId) || null;
  const activeTurn = rawStore?.getActiveTurn?.(sessionId) || null;
  if (!activeTurn) return { ok: false, reason: 'active_turn_not_found', activeTurn: null };
  const artifactIncarnation = normalizeId(artifact.session_incarnation);
  const generation = Number(artifact.turn_generation);
  const turnId = normalizeId(artifact.turn_id);
  const streamId = normalizeId(artifact.stream_id);
  const activeTurnId = normalizeId(activeTurn.turn_id || activeTurn.request_id);
  const activeRequestId = normalizeId(activeTurn.request_id || activeTurn.turn_id);
  if (
    normalizeId(session?.session_incarnation) !== artifactIncarnation
    || Number(session?.turn_generation) !== generation
    || normalizeId(activeTurn.session_incarnation) !== artifactIncarnation
    || Number(activeTurn.generation) !== generation
    || activeTurnId !== turnId
    || activeRequestId !== turnId
    || normalizeId(activeTurn.stream_id) !== streamId
  ) {
    return { ok: false, reason: 'active_turn_identity_mismatch', activeTurn };
  }
  const identity = validateTerminalIdentity({
    sessionId,
    sessionIncarnation: artifactIncarnation,
    generation,
    turnId,
    streamId,
    userMessageId: normalizeId(activeTurn.user_message_id),
    sessionRevision: null,
  });
  return identity.ok
    ? { ok: true, reason: null, activeTurn, identity: identity.identity }
    : { ok: false, reason: identity.reason, activeTurn };
}

function resolveActionContext(service, payload, { allowDiscarded = false } = {}) {
  const request = resolveTerminalRepairRequest(service, payload, { allowDiscarded });
  if (!request.ok) return request;
  const { rawStore, conversationStore } = resolveStores(service);
  const actorRegistry = service?.sessionTurnActors || service?.sessionTurnActorRegistry;
  const coordinator = service?.terminalCoordinator;
  if (
    !rawStore
    || !conversationStore?.commitTerminal
    || !actorRegistry?.adoptPendingTerminalRepair
    || !coordinator
  ) {
    return { ...request, ok: false, reason: 'terminal_repair_action_unavailable' };
  }
  const active = activeIdentity(rawStore, request.artifact);
  return {
    ...request,
    ...active,
    service,
    rawStore,
    conversationStore,
    actorRegistry,
    coordinator,
  };
}

function actionFailure(reason) {
  return buildRepairActionResult({ reason: reason || 'terminal_repair_action_failed' });
}

function adoptRepairLease(context, allowDiscarded) {
  return context.actorRegistry.adoptPendingTerminalRepair({
    identity: context.identity,
    store: context.rawStore,
    activeStreams: context.service?.activeStreams || new Map(),
    artifactId: context.artifactId,
    allowDiscarded,
  });
}

async function retryUnsavedReply(service, payload = {}) {
  let context;
  try {
    context = resolveActionContext(service, payload);
  } catch (_error) {
    return actionFailure('terminal_repair_resolution_failed');
  }
  if (!context.ok) return actionFailure(context.reason);
  let lease;
  try {
    lease = adoptRepairLease(context, false);
  } catch (error) {
    return actionFailure(error?.reason || error?.code);
  }
  let result;
  try {
    result = await context.coordinator.settlePendingRepair({
      lease,
      artifact: context.artifact,
      store: context.conversationStore,
    });
  } catch (_error) {
    return actionFailure('terminal_repair_retry_failed');
  }
  if (result?.ok !== true || result?.durableTerminal !== true) {
    return actionFailure(result?.reason);
  }
  const expectedMessages = Array.isArray(context.artifact?.terminal_snapshot?.messages)
    ? context.artifact.terminal_snapshot.messages
    : [];
  const expectsCanonicalMessage = expectedMessages.length > 0;
  const matches = expectsCanonicalMessage
    ? (context.conversationStore.getSessionMessages?.(context.sessionId) || [])
      .filter((message) => normalizeId(message?.id) === context.messageId)
    : [];
  if (expectsCanonicalMessage && matches.length !== 1) {
    return actionFailure(
      matches.length === 0
        ? 'terminal_repair_message_missing'
        : 'terminal_repair_message_ambiguous'
    );
  }
  return buildRepairActionResult({
    ok: true,
    durable: true,
    message: expectsCanonicalMessage ? matches[0] : null,
  });
}

async function ensureDiscarded(service, artifact) {
  const store = service?.terminalRepairStore;
  if (!store?.markDiscarded) return { ok: false, durable: false, reason: 'discard_unavailable' };
  try {
    return await store.markDiscarded(artifact.artifact_id, {
      session_id: artifact.session_id,
      session_incarnation: artifact.session_incarnation,
      turn_generation: artifact.turn_generation,
    });
  } catch (_error) {
    return { ok: false, durable: false, reason: 'discard_failed' };
  }
}

async function discardUnsavedReply(service, payload = {}) {
  let context;
  try {
    context = resolveActionContext(service, payload, { allowDiscarded: true });
  } catch (_error) {
    return actionFailure('terminal_repair_resolution_failed');
  }
  if (!context.ok && context.reason !== 'active_turn_not_found') {
    return actionFailure(context.reason);
  }
  if (!context.activeTurn) {
    const discarded = await ensureDiscarded(service, context.artifact);
    if (discarded?.ok !== true || discarded?.durable !== true) {
      return actionFailure(discarded?.reason || 'discard_durability_unproven');
    }
    return buildRepairActionResult({
      ok: true,
      durable: true,
      removedMessageId: context.messageId,
    });
  }
  let lease;
  try {
    lease = adoptRepairLease(context, true);
  } catch (error) {
    return actionFailure(error?.reason || error?.code);
  }
  let result;
  try {
    result = await context.coordinator.discardPendingRepair({
      lease,
      artifact: context.artifact,
      store: context.conversationStore,
    });
  } catch (_error) {
    return actionFailure('terminal_repair_discard_failed');
  }
  return buildRepairActionResult({
    ok: result?.ok === true && result?.durableTerminal === true,
    durable: result?.durableTerminal === true,
    reason: result?.durableTerminal === true ? null : result?.reason,
    removedMessageId: result?.durableTerminal === true ? context.messageId : '',
  });
}

module.exports = {
  discardUnsavedReply,
  retryUnsavedReply,
};
