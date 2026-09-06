'use strict';

// Transport-level per-request timeout: (re-)arming, plus the ask_user-driven
// suspend/resume idiom that extends a pending chat.send's deadline by exactly
// a human-wait duration. Without this, Electron's RPC timeout is a fixed
// setTimeout armed at send time, so a long ask_user answer can abort the
// transport mid-wait even though the sidecar credits that wait against its
// own deadline (sidecar/ai/routing/tool_execution_ask_user_wait.py). Pulled
// out of sidecar-client.js to keep it under its line-count ratchet.

const MCP_INSPECT_METHOD = 'mcp.inspect';

// (Re-)arms `pending`'s timeout for delayMs; the fired error always reports
// the original pending.timeoutMs, not a shorter resumed leftover.
function armPendingTimeout(client, pending, delayMs) {
  pending.timeoutArmedAt = Date.now();
  pending.timer = setTimeout(() => {
    if (pending.method === MCP_INSPECT_METHOD && pending.frameWritten) {
      client._sendBestEffortRequestCancel(pending.id);
    }
    client._finalizePendingRequest(pending.id, {
      type: 'reject',
      error: client._createTimeoutError(pending.method, pending.timeoutMs),
    });
  }, delayMs);
  if (typeof pending.timer.unref === 'function') {
    pending.timer.unref();
  }
}

// Pauses the transport timeout for the pending request keyed by `requestKey`
// (chat.send's request_id) so a human-wait tool (ask_user) doesn't race
// Electron's RPC deadline against the sidecar's credited extension. Returns
// an idempotent, depth-counted resume; unknown/timerless keys no-op.
function suspendRequestTimeout(client, requestKey) {
  const normalizedKey = String(requestKey || '').trim();
  const target = normalizedKey
    ? [...client.pendingRequests.values()].find((entry) => entry.requestKey === normalizedKey)
    : null;
  if (!target || target.timeoutMs == null) {
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
  return () => {
    if (resumed) return;
    resumed = true;
    if (target.timeoutSuspendDepth > 0) target.timeoutSuspendDepth -= 1;
    // Re-arm only once every suspend has resumed, and only if the request
    // hasn't already settled some other way (e.g. a transport failure).
    if (target.timeoutSuspendDepth > 0 || !client.pendingRequests.has(target.id)) {
      return;
    }
    armPendingTimeout(client, target, Math.max(target.timeoutRemainingMs, 1));
  };
}

module.exports = { armPendingTimeout, suspendRequestTimeout };
