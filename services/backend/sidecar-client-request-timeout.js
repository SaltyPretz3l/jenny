'use strict';

// Transport-level per-request timeout: (re-)arming, plus the human-wait
// suspend/resume idiom that extends a pending chat.send's deadline by exactly
// a human-wait duration (ask_user answers, tool approvals). Without this,
// Electron's RPC timeout is a fixed setTimeout armed at send time, so a long
// human wait can abort the transport mid-wait even though the sidecar credits
// that wait against its own deadline (sidecar/ai/routing/
// tool_execution_ask_user_wait.py, request_dispatch_chat._credit_approval_wait).
// A plan-build approval also renews the budget, mirroring the sidecar's
// _fresh_build_budget (dogfood HB-026). Pulled out of sidecar-client.js to keep
// it under its line-count ratchet.

const { CANCEL_REASON_TIMEOUT } = require('./chat-stream-terminal-utils');
const { SIDECAR_TERMINAL_SUBCODES } = require('./error-codes');

const MCP_INSPECT_METHOD = 'mcp.inspect';
const CHAT_SEND_METHOD = 'chat.send';

// Best-effort chat.cancel for a pending chat.send, shared by the abort-signal
// path and the transport timeout: once Electron gives up on the request, the
// sidecar must stop generating instead of keeping the GPU busy on a turn the
// UI already failed.
function sendPendingChatCancel(client, pending, cancelReason) {
  if (pending.method !== CHAT_SEND_METHOD || !pending.requestKey || !client._batch4TransportEnabled()) {
    return;
  }
  client._recordCancelledRequestKey(pending.requestKey);
  client._sendBestEffortChatCancel({
    requestId: pending.requestKey,
    traceId: pending.traceId || pending.requestKey,
    sessionId: pending.sessionId,
    cancelReason,
  });
}

// A chat.send transport deadline is the turn's working-time budget plus a
// settlement margin (the idle watchdog owns hang detection), so its expiry is
// a working-time exhaustion, not a broken sidecar connection.
function createPendingTimeoutError(client, pending) {
  const error = client._createTimeoutError(pending.method, pending.timeoutMs);
  if (pending.method === CHAT_SEND_METHOD) {
    error.terminal_subcode = SIDECAR_TERMINAL_SUBCODES.TURN_TIMEOUT;
  }
  return error;
}

// (Re-)arms `pending`'s timeout for delayMs; the fired error always reports
// the original pending.timeoutMs, not a shorter resumed leftover.
function armPendingTimeout(client, pending, delayMs) {
  pending.timeoutArmedAt = Date.now();
  pending.timeoutRemainingMs = delayMs;
  pending.timer = setTimeout(() => {
    if (pending.method === MCP_INSPECT_METHOD && pending.frameWritten) {
      client._sendBestEffortRequestCancel(pending.id);
    }
    if (pending.frameWritten) {
      sendPendingChatCancel(client, pending, CANCEL_REASON_TIMEOUT);
    }
    client._finalizePendingRequest(pending.id, {
      type: 'reject',
      error: createPendingTimeoutError(client, pending),
    });
  }, delayMs);
  if (typeof pending.timer.unref === 'function') {
    pending.timer.unref();
  }
}

function findPendingByRequestKey(client, requestKey) {
  const normalizedKey = String(requestKey || '').trim();
  const target = normalizedKey
    ? [...client.pendingRequests.values()].find((entry) => entry.requestKey === normalizedKey)
    : null;
  return target && target.timeoutMs != null ? target : null;
}

// Pauses the transport timeout for the pending request keyed by `requestKey`
// (chat.send's request_id) so a human wait (ask_user, tool approval) doesn't
// race Electron's RPC deadline against the sidecar's credited extension.
// Returns an idempotent, depth-counted resume; unknown/timerless keys no-op.
// resume({ freshBudget: true }) renews the leftover to at least the full
// original budget (never shortens it), for a plan-build approval.
function suspendRequestTimeout(client, requestKey) {
  const target = findPendingByRequestKey(client, requestKey);
  if (!target) {
    return () => {};
  }
  if (target.timeoutSuspendDepth === 0) {
    if (target.timer) {
      clearTimeout(target.timer);
      target.timer = null;
    }
    target.timeoutRemainingMs = Math.max(
      target.timeoutRemainingMs - Math.max(Date.now() - target.timeoutArmedAt, 0), 0
    );
  }
  target.timeoutSuspendDepth += 1;
  let resumed = false;
  return ({ freshBudget = false } = {}) => {
    if (resumed) return;
    resumed = true;
    if (freshBudget === true) {
      target.timeoutRemainingMs = Math.max(target.timeoutRemainingMs, target.timeoutMs);
    }
    if (target.timeoutSuspendDepth > 0) target.timeoutSuspendDepth -= 1;
    // Re-arm only once every suspend has resumed, and only if the request
    // hasn't already settled some other way (e.g. a transport failure).
    if (target.timeoutSuspendDepth > 0 || !client.pendingRequests.has(target.id)) {
      return;
    }
    armPendingTimeout(client, target, Math.max(target.timeoutRemainingMs, 1));
  };
}

module.exports = { armPendingTimeout, sendPendingChatCancel, suspendRequestTimeout };
