// Projects and bounds the inbound chat.send transport frame so a long-lived
// session degrades gracefully instead of permanently bricking at the 10 MiB
// framing wall.
//
// Background. chat.send used to ship canonical_session_messages as the FULL
// persisted transcript (electron-session-store.getSessionMessages returns the
// whole [...session.messages] array, uncapped). That array carries the heavy
// per-message tool_result.metadata (read_file snapshots, structured tool output)
// that the compact provider `messages` array drops via summarizeHistoricalToolResult,
// so it was the dominant term in the frame. Once the encoded frame exceeds
// MAX_OUTBOUND_FRAME_BODY_BYTES, sidecar-client._writeFrame rejects the request
// non-retryably (FrameTooLargeError -> CMP-SIDECAR), and because every later send
// re-ships the same oversized history the session can NEVER send again. The
// sidecar's 40-message semantic compaction (MAX_SEMANTIC_MESSAGES) runs AFTER
// receipt and does not bound the transport frame.
//
// First defence: projection. Electron keeps the full transcript locally for
// recall, compaction, transcript queries, and telemetry, but Python reads only
// tool-shaped entries out of canonical_session_messages, so the wire copy drops
// prose, reasoning, and ordinary tool output bodies before encoding. Every
// derivation stays in Python; this only removes bytes nobody reads.
//
// Second defence: trim the OLDEST projected entries until the frame fits a
// conservative budget below the cap. The sidecar consumers all tolerate
// oldest-drop:
//   - rebuild_read_snapshot_cache (tool_execution_snapshots.py) keeps
//     only the LATEST snapshot per path, so recent messages dominate;
//   - count_session_tool_results (tool_quotas.py) is a soft
//     quota governor - a mild undercount only loosens limits; and
//   - scan_history_for_undeferrals (tool_search.py) falls
//     back to the provider `messages` array, and recent tool usage dominates.
// Every consumer guards `or []` / isinstance(..., list), so an empty canonical
// array is safe -- but a non-empty input that projects to NO entries carries a
// placeholder, because chat_decision.py:774 tests list truthiness and would
// otherwise switch to the provider-history fallback. The compact provider
// `messages` array is intentionally left untouched - trimming it would break
// tool_use/tool_result pairing.
//
// Trade-off: a write_file/edit_file targeting a file whose only read was in a
// dropped (very old) message loses its auto-injected expected_read_snapshot
// staleness guard. That guard would already be stale after hundreds of turns,
// and the alternative is a hard-failed turn, so this is the proportionate
// graceful degradation.

const {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
} = require('./sidecar-client-transport-codec');

// Headroom below the hard cap absorbs the JSON-RPC envelope keys (jsonrpc/id/
// method/accept_version added by SidecarClient.request/chatSend) plus encoding
// variance. The realistic frame is 100-500 KB, so this only ever engages for a
// pathologically large session.
const FRAME_BUDGET_RESERVE_BYTES = 512 * 1024;
const CHAT_SEND_FRAME_BUDGET_BYTES =
  MAX_OUTBOUND_FRAME_BODY_BYTES - FRAME_BUDGET_RESERVE_BYTES;

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isNonArrayObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyPresent(target, source, key) {
  if (Object.prototype.hasOwnProperty.call(source, key)) {
    target[key] = source[key];
  }
}

function projectToolResultForSend(message, toolResult) {
  const projected = {};
  copyPresent(projected, toolResult, 'tool_name');
  copyPresent(projected, toolResult, 'is_error');
  const metadata = toolResult.metadata;
  if (metadata !== undefined && metadata !== null) {
    projected.metadata = metadata;
  }
  if (
    message.role === 'tool'
    && toolResult.tool_name === 'tool_search'
    && (metadata === undefined || metadata === null)
    && Object.prototype.hasOwnProperty.call(toolResult, 'output')
  ) {
    // tool_search.py:411 skips this legacy output parser when metadata is not None.
    projected.output = toolResult.output;
  }
  return projected;
}

function projectCanonicalSessionMessagesForSend(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }
  const projected = [];
  for (const message of messages) {
    if (!isNonArrayObject(message)) {
      continue;
    }
    const toolResult = isNonArrayObject(message.tool_result) ? message.tool_result : null;
    if (
      message.kind !== 'tool_result'
      && message.kind !== 'tool_search_result'
      && message.role !== 'tool'
      && toolResult === null
    ) {
      continue;
    }
    const kept = {};
    copyPresent(kept, message, 'id');
    copyPresent(kept, message, 'kind');
    copyPresent(kept, message, 'role');
    if (
      message.kind === 'tool_search_result'
      && Object.prototype.hasOwnProperty.call(message, 'content')
    ) {
      kept.content = message.content;
    }
    if (toolResult !== null) {
      kept.tool_result = projectToolResultForSend(message, toolResult);
    }
    projected.push(kept);
  }
  if (projected.length === 0 && messages.length > 0) {
    const placeholder = {};
    const lastMessage = messages[messages.length - 1];
    if (isNonArrayObject(lastMessage)) {
      copyPresent(placeholder, lastMessage, 'id');
    }
    // chat_decision.py:774 uses list truthiness to decide whether to scan provider messages.
    placeholder.kind = 'projected_placeholder';
    projected.push(placeholder);
  }
  return projected;
}

// Returns { params, trim }. `trim` is null when the frame already fits (no copy,
// the original params object is returned unchanged). Otherwise canonical history
// is trimmed oldest-first and `trim` reports what happened for telemetry.
function boundCanonicalSessionMessagesForFrame(params, options = {}) {
  const budgetBytes = Number.isFinite(options.budgetBytes)
    ? Math.max(0, Math.floor(options.budgetBytes))
    : CHAT_SEND_FRAME_BUDGET_BYTES;
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    return { params, trim: null };
  }
  const originalBytes = byteLength(params);
  if (originalBytes <= budgetBytes) {
    return { params, trim: null };
  }

  const canonical = Array.isArray(params.canonical_session_messages)
    ? params.canonical_session_messages
    : [];
  // Frame bytes with the canonical array emptied: the irreducible floor that
  // trimming this field alone can reach. Re-keying an existing property via
  // spread preserves its position, so the byte accounting stays exact.
  const baseBytes = byteLength({ ...params, canonical_session_messages: [] });
  const sizes = canonical.map((message) => byteLength(message));

  // Keep as many of the NEWEST messages as fit. The populated array contributes
  // exactly sum(keptSizes) + (keptCount - 1) comma bytes more than the empty
  // array already counted in baseBytes, so frame bytes = baseBytes + acc.
  let acc = 0;
  let keptCount = 0;
  for (let i = canonical.length - 1; i >= 0; i -= 1) {
    const commaBytes = keptCount > 0 ? 1 : 0;
    const tentative = acc + sizes[i] + commaBytes;
    if (baseBytes + tentative > budgetBytes) {
      break;
    }
    acc = tentative;
    keptCount += 1;
  }

  const kept = keptCount > 0 ? canonical.slice(canonical.length - keptCount) : [];
  const boundedParams = { ...params, canonical_session_messages: kept };
  const finalBytes = byteLength(boundedParams);
  return {
    params: boundedParams,
    trim: {
      droppedCount: canonical.length - kept.length,
      keptCount: kept.length,
      canonicalOriginalCount: canonical.length,
      originalBytes,
      finalBytes,
      budgetBytes,
      capBytes: MAX_OUTBOUND_FRAME_BODY_BYTES,
      // False when even an empty canonical array exceeds the budget, i.e. some
      // OTHER frame field is the offender (e.g. an outsized attachment set). The
      // existing oversized-frame guard still protects the pipe; this flag makes
      // the residual visible in the WARN telemetry.
      fitsBudget: finalBytes <= budgetBytes,
    },
  };
}

// Last-resort escalation, ordered narrowest-last. Only reached when emptying
// canonical_session_messages entirely still leaves the frame over budget, i.e.
// the compact provider `messages` array is itself the offender.
//
// These scopes are safe where a byte-wise trim of `messages` is NOT: 'recent'
// routes through selectRecentTurnGroups, which slices WHOLE user-anchored turn
// groups, and 'fresh' empties the history. Neither can leave a tool_use whose
// matching tool_result was dropped (or vice versa) — the split pair that most
// providers hard-reject. That is why this narrows by scope instead of teaching
// the byte trimmer to walk the provider array.
const HISTORY_SCOPE_FALLBACKS = ['recent', 'fresh'];

// Bound the chat.send frame, escalating from canonical trimming to a narrower
// provider history scope only if canonical trimming alone cannot fit. Returns
// the params to send and performs the telemetry itself, so callers stay a
// single expression.
//
// `rebuildMessages(historyScope)` must return the provider `messages` array for
// that scope; omit it to keep the canonical-only behaviour. `log(level, event,
// payload)` receives one record describing the final outcome.
function fitChatSendParamsToFrameBudgetWithOutcome(params, options = {}) {
  const { rebuildMessages, log } = options;
  const bindOptions = Number.isFinite(options.budgetBytes)
    ? { budgetBytes: options.budgetBytes }
    : {};
  const first = boundCanonicalSessionMessagesForFrame(params, bindOptions);
  if (!first.trim) {
    return { params: first.params, outcome: { fitsBudget: true, historyScopeFallback: null, trim: null } };
  }

  let best = first;
  let historyScopeFallback = null;
  if (!first.trim.fitsBudget && typeof rebuildMessages === 'function') {
    for (const historyScope of HISTORY_SCOPE_FALLBACKS) {
      const messages = rebuildMessages(historyScope);
      if (!Array.isArray(messages)) {
        break;
      }
      // Re-run the canonical trimmer against the narrower base: a smaller
      // `messages` array frees budget that canonical history can reclaim.
      best = boundCanonicalSessionMessagesForFrame({ ...params, messages }, bindOptions);
      historyScopeFallback = historyScope;
      if (!best.trim || best.trim.fitsBudget) {
        break;
      }
    }
  }

  // best.trim === null means the narrowed frame fits with the canonical array
  // fully intact, so there is no trim record to report — it still fits.
  const fitsBudget = best.trim ? best.trim.fitsBudget : true;
  if (typeof log === 'function') {
    log(fitsBudget ? 'WARN' : 'ERROR', 'chat.canonical_session_frame_trimmed', {
      ...first.trim,
      ...(best.trim || {}),
      // Recomputed rather than taken from a trim record, which may be absent or
      // describe a superseded attempt.
      finalBytes: byteLength(best.params),
      fitsBudget,
      ...(historyScopeFallback ? { historyScopeFallback } : {}),
    });
  }
  return {
    params: best.params,
    outcome: { fitsBudget, historyScopeFallback, trim: best.trim || first.trim },
  };
}

module.exports = {
  CHAT_SEND_FRAME_BUDGET_BYTES,
  FRAME_BUDGET_RESERVE_BYTES,
  HISTORY_SCOPE_FALLBACKS,
  boundCanonicalSessionMessagesForFrame,
  fitChatSendParamsToFrameBudgetWithOutcome,
  projectCanonicalSessionMessagesForSend,
};
