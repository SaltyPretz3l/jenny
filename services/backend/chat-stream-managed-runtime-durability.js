// Durability helpers receive the runtime ctx so they mutate the same closure bindings.

const {
  recordLifecycleDiagnostic,
} = require('./chat-lifecycle-diagnostics');

// Best-effort diagnosis of WHY a persist was refused, in the CTL-002
// normalized reason vocabulary: a vanished session, a future-schema write
// freeze, or a plain write failure. Read-only probes; never throws.
function derivePersistRefusalReason(ctx) {
  try {
    const sessionStore = ctx.service?.sessionStore;
    if (sessionStore && typeof sessionStore.getSession === 'function'
      && !sessionStore.getSession(ctx.resolvedSessionId)) {
      return 'unknown_session';
    }
    if (sessionStore && typeof sessionStore.hasNewerSchema === 'function'
      && sessionStore.hasNewerSchema()) {
      return 'future_schema';
    }
  } catch {
    // Diagnosis must never mask the refusal itself.
  }
  return 'write_failed';
}

// The turn's single bounded "this reply is not durable" surface: a
// message_updated emission (the settled-message reconciliation channel, which
// passes the renderer's absorbing-terminal gate) carrying a durability patch,
// plus a structured service log. Emitted at most once per turn, always AFTER
// the visible `complete` — durability tracking never delays paint (I5).
function emitDurabilityWarning(ctx, { scope, reason }) {
  if (ctx.durabilityWarningEmitted) {
    return;
  }
  ctx.durabilityWarningEmitted = true;
  ctx.service._emitServiceLog('WARN', 'chat.turn_durability_refused', {
    sessionId: ctx.resolvedSessionId,
    streamId: ctx.streamId,
    model: ctx.model,
    scope,
    reason,
  });
  // L1 diagnostics (Chat Lifecycle v2 plan §4): a durability warning is one
  // of the two backend durability_degrade sites this wave wires up.
  recordLifecycleDiagnostic(
    (level, event, details) => ctx.service._emitServiceLog(level, event, details),
    'durability_degrade',
    { scope, reason, sessionId: ctx.resolvedSessionId, streamId: ctx.streamId }
  );
  ctx.emitChatStream({
    type: 'message_updated',
    messageId: ctx.visibleAssistantMessageId,
    patch: {
      durability: { state: 'unsaved', reason, scope },
    },
    ...ctx.eventBase,
  }, { channel: 'control' });
}

module.exports = {
  derivePersistRefusalReason,
  emitDurabilityWarning,
};
