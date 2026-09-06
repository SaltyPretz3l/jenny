// SP-20 containment (extracted from chat-stream-managed-runtime.js to respect
// the 1000-line file cap): settling an explicit tool-approval denial as a
// real terminal.
//
// chat-stream-terminal-utils.js's resolveTerminalRouting (shared with the
// external path) deliberately treats `denied` as a silent status
// (emitErrorEvent/persistAssistantFailure both false), so a plain throw from
// settleTerminalResult would still fall through the generic catch-block
// routing in managed-sidecar-chat.js as silent. Denial must still reach the
// renderer as exactly one terminal and release the durable claim, so this
// handles both directly -- mirroring the SAME event shape
// (buildTerminalErrorPayload + enrichTerminalErrorPayloadForEmit) the catch
// block uses for every other terminal error (cancellation included), without
// altering the shared routing module's silent classification of `denied`
// itself.
const {
  buildTerminalErrorPayload,
  enrichTerminalErrorPayloadForEmit,
  TERMINAL_STATUS_DENIED,
} = require('./chat-stream-terminal-utils');

// Caller (chat-stream-managed-runtime.js) is responsible for the
// once-per-turn idempotency guard (a duplicate denial settlement must not
// clear/emit twice); this function performs the release + emit unconditionally
// when invoked.
function settleDeniedTerminal({
  clearActiveTurn,
  adapter,
  streamId,
  sidecarError,
  sidecarErrorCode,
  emitChatStream,
  eventBase,
}) {
  // Compare-and-clear: matched by this turn's own request_id/stream_id, so a
  // second (duplicate) call from a caller that failed to guard is still a
  // harmless no-op at the store layer.
  clearActiveTurn(adapter, {
    requestId: streamId,
    streamId,
  });
  const deniedErrorPayload = buildTerminalErrorPayload(
    {
      message: sidecarError || 'The request was denied.',
      error_code: sidecarErrorCode,
      category: 'denied',
      status: TERMINAL_STATUS_DENIED,
      retryable: false,
    },
    'denied'
  );
  emitChatStream({
    type: 'error',
    ...enrichTerminalErrorPayloadForEmit(deniedErrorPayload, {
      terminalStatus: TERMINAL_STATUS_DENIED,
      terminalSubcode: deniedErrorPayload.terminal_subcode,
    }),
    ...eventBase,
  }, { channel: 'control', phase: null });
}

module.exports = {
  settleDeniedTerminal,
};
