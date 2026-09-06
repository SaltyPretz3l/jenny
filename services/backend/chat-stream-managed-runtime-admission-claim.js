// F-01 / SP-19 containment helpers (extracted from
// chat-stream-managed-runtime.js to respect the 1000-line file cap).
//
// persistUserMessage() re-asserts admissibility synchronously immediately
// before claiming the active_turn slot (F-01: ports the external path's
// proven re-assert-before-claim pattern -- see chat-stream-admission.js and
// backend-chat-stream.js), then must fail the start BEFORE any provider
// invocation if either the active_turn claim itself is refused/CAS-rejected,
// or the user-message persist that follows it is refused (SP-19: the prior
// behavior let generation proceed on an unpersisted/unclaimed prompt and only
// warned at settle time). Both refusals are caught by the generic
// pre-provider error handling in startManagedSidecarChatStream's catch block,
// which surfaces a structured terminal error through the existing
// chat-stream 'error' event -- the same path every other pre-provider
// failure uses. This module only builds the structured "start refused"
// errors (+ logs why); the call sites in persistUserMessage own the actual
// claim/persist calls and the throw.

const {
  recordLifecycleDiagnostic,
} = require('./chat-lifecycle-diagnostics');

function logAndBuildActiveTurnClaimRefusedError(service, { sessionId, streamId, userMessageId }) {
  // Nothing to release here -- the claim itself never landed.
  service._emitServiceLog('WARN', 'chat.active_turn_claim_refused', {
    sessionId,
    streamId,
    userMessageId,
  });
  // L1 diagnostics (Chat Lifecycle v2 plan §4): this IS the managed-path
  // lease-conflict site -- a second concurrent send lost the active_turn CAS
  // race. See chat-lifecycle-diagnostics.js.
  recordLifecycleDiagnostic(
    (level, event, details) => service._emitServiceLog(level, event, details),
    'lease_conflict',
    { path: 'managed', sessionId, streamId }
  );
  return new Error('Chat could not start: the active-turn claim was refused by session storage.');
}

function logAndBuildUserMessagePersistRefusedError(service, { sessionId, streamId, userMessageId, reason }) {
  // The active_turn claim made just before this call still needs releasing;
  // the generic catch-block handling does that via the same clearActiveTurn
  // call every other pre-provider failure's persistFailureMessage() uses, so
  // no separate release call is needed here.
  service._emitServiceLog('WARN', 'chat.user_message_persist_failed', {
    sessionId,
    streamId,
    userMessageId,
    reason,
  });
  return new Error('Chat could not start: the user message could not be persisted.');
}

module.exports = {
  logAndBuildActiveTurnClaimRefusedError,
  logAndBuildUserMessagePersistRefusedError,
};
