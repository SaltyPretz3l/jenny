'use strict';

/* The sidecar `command.execute_proposal` call (row 59 checkpoint 3, the
 * exact-command Run). It is a chat-shaped turn, so it registers the same four
 * per-request_id reverse-RPC handler maps `chatSend` does: notifications, tool
 * approvals, Electron tool execution (the Docker path) and runtime.operation
 * admission. Reverse RPC is routed by request_id only, so those maps serve this
 * method unchanged. Abort sends the ordinary `chat.cancel {request_id}` (the
 * sidecar registers the worker's turn by request_id; there is no separate cancel
 * method). Kept out of sidecar-client.js, which is at its line cap.
 *
 * A caller abort sends `chat.cancel` at once but keeps the request open for a
 * bounded drain, so the sidecar's own answer (cancelled before dispatch, or
 * cancelled with proven cleanup) still reaches the card instead of an unknown.
 */

const COMMAND_EXECUTE_PROPOSAL_METHOD = 'command.execute_proposal';
const CANCEL_DRAIN_MS = 10_000;

async function commandExecuteProposal(client, params, {
  onNotification,
  onApprovalRequest,
  onElectronToolRequest,
  onRuntimeOperation,
  timeoutMs,
  signal,
  drainMs = CANCEL_DRAIN_MS,
} = {}) {
  const requestId = String(params && params.request_id || '').trim();
  if (!requestId) {
    throw new Error('command.execute_proposal requires a non-empty request_id.');
  }
  const registrations = [
    [client.notificationHandlers, onNotification],
    [client.approvalHandlers, onApprovalRequest],
    [client.electronToolHandlers, onElectronToolRequest],
    [client.runtimeOperationHandlers, onRuntimeOperation],
  ].map(([handlers, callback]) => {
    // Unique identities also fence reused callbacks and unavailable handlers.
    const handler = typeof callback === 'function' ? (...args) => callback(...args) : {};
    handlers.set(requestId, handler);
    return [handlers, handler];
  });
  const retire = () => {
    for (const [handlers, handler] of registrations) {
      if (handlers.get(requestId) === handler) handlers.delete(requestId);
    }
  };
  const inner = new AbortController();
  let drainTimer = null;
  const onOuterAbort = () => {
    if (drainTimer || inner.signal.aborted) return;
    if (!client._batch4TransportEnabled()) {
      inner.abort(signal.reason);
      return;
    }
    // A recorded key also refuses any approval request that arrives after the stop.
    client._recordCancelledRequestKey(requestId);
    client._sendBestEffortChatCancel({
      requestId,
      traceId: String(params.trace_id || '').trim() || requestId,
      sessionId: String(params.session_id || '').trim(),
      cancelReason: client._cancelReasonFromSignal(signal),
    });
    drainTimer = setTimeout(expireDrain, drainMs);
  };
  // The drain ran out: reject exactly as an abort would, without a second chat.cancel.
  const expireDrain = () => {
    for (const [id, pending] of client.pendingRequests) {
      if (pending.requestKey === requestId && pending.method === COMMAND_EXECUTE_PROPOSAL_METHOD) {
        client._finalizePendingRequest(id, { type: 'reject', error: client._createAbortError(COMMAND_EXECUTE_PROPOSAL_METHOD, signal) });
        return;
      }
    }
    inner.abort(signal.reason);
  };
  if (signal?.aborted) onOuterAbort();
  else signal?.addEventListener?.('abort', onOuterAbort, { once: true });
  try {
    return await client.request(COMMAND_EXECUTE_PROPOSAL_METHOD, { ...params }, {
      timeoutMs,
      signal: inner.signal,
      requestKey: requestId,
      onCleanup: retire,
    });
  } finally {
    if (drainTimer) clearTimeout(drainTimer);
    signal?.removeEventListener?.('abort', onOuterAbort);
    retire();
  }
}

module.exports = { CANCEL_DRAIN_MS, COMMAND_EXECUTE_PROPOSAL_METHOD, commandExecuteProposal };
