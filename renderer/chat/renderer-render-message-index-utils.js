/* renderer/chat/renderer-render-message-index-utils.js — UMD
 *
 * Pure builder for the `rowsByRenderMessageId` index consumed by the chat
 * render pipeline. Buckets rows from all turns by `render_message_id` and
 * deduplicates within each bucket by `(kind, primary_message_id[, phase_id])`,
 * preferring canonical projections over reconciled overlays over live
 * overlays.
 *
 * Cross-turn `render_message_id` collisions are deduplicated here so stale
 * streaming overlays cannot win. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderMessageIndexUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // Canonical (untagged) > reconciled > live. Untagged rows come from the
  // hydrated `turn_events[]` projection and represent settled state.
  const SOURCE_RANK = Object.freeze({ canonical: 3, reconciled: 2, live: 1 });

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function rowDedupSourceRank(row) {
    if (!row || typeof row !== 'object') {
      return 0;
    }
    const tag = typeof row._dedup_source === 'string' ? row._dedup_source : '';
    if (!tag) {
      return SOURCE_RANK.canonical;
    }
    return Object.prototype.hasOwnProperty.call(SOURCE_RANK, tag) ? SOURCE_RANK[tag] : 0;
  }

  function rowDedupKey(row) {
    if (!row || typeof row !== 'object') {
      return '';
    }
    const kind = normalizeId(row.kind);
    if (kind === 'assistant_text') {
      const messageId = normalizeId(row.primary_message_id);
      return messageId ? `assistant_text|${messageId}` : '';
    }
    if (kind === 'reasoning') {
      const messageId = normalizeId(row.primary_message_id);
      const phaseId = normalizeId(row.phase_id || (row.payload && row.payload.phase_id));
      return messageId && phaseId ? `reasoning|${messageId}|${phaseId}` : '';
    }
    if (kind === 'plan_document') {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const anchor = normalizeId(payload.plan_id) || normalizeId(payload.tool_call_id || row.tool_call_id);
      return anchor ? `plan_document|${anchor}` : '';
    }
    if (kind === 'tool_step' || kind === 'tool_call' || kind === 'tool_result') {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCall = row.tool_call && typeof row.tool_call === 'object' ? row.tool_call : {};
      const toolResult = row.tool_result && typeof row.tool_result === 'object' ? row.tool_result : {};
      const payloadToolCall = payload.tool_call && typeof payload.tool_call === 'object' ? payload.tool_call : {};
      const payloadToolResult = payload.tool_result && typeof payload.tool_result === 'object' ? payload.tool_result : {};
      const callId = normalizeId(
        row.tool_call_id
        || row.toolCallId
        || row.call_id
        || row.callId
        || payload.tool_call_id
        || payload.toolCallId
        || payload.call_id
        || payload.callId
        || toolCall.call_id
        || toolCall.callId
        || toolCall.id
        || toolResult.call_id
        || toolResult.callId
        || toolResult.id
        || payloadToolCall.call_id
        || payloadToolCall.callId
        || payloadToolCall.id
        || payloadToolResult.call_id
        || payloadToolResult.callId
        || payloadToolResult.id
      );
      return callId ? `${kind}|${callId}` : '';
    }
    if (kind === 'approval_gap') {
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      const approvalId = normalizeId(
        row.approval_id
        || row.approvalId
        || row.tool_call_id
        || row.toolCallId
        || row.call_id
        || row.callId
        || payload.approval_id
        || payload.approvalId
        || payload.tool_call_id
        || payload.toolCallId
        || payload.call_id
        || payload.callId
      );
      return approvalId ? `approval_gap|${approvalId}` : '';
    }
    return '';
  }

  const TOOL_ROW_KINDS = new Set(['tool_step', 'tool_call', 'tool_result']);

  function rowToolState(row) {
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    return normalizeId(payload.state || payload.status).toLowerCase();
  }

  function pickBetterRow(currentRow, candidateRow) {
    if (!currentRow) {
      return candidateRow;
    }
    const currentRank = rowDedupSourceRank(currentRow);
    const candidateRank = rowDedupSourceRank(candidateRow);
    // 'interrupted' is a settled-replay verdict: the trace projector marks a
    // tool that was executing with no recorded result, which is correct after
    // an app reload but wrong WHILE the tool is still running — the
    // messages-derived canonical projection of the active turn produces it on
    // every streaming render. When a live/reconciled overlay row carries a
    // concrete non-interrupted lifecycle state for the same tool, the overlay
    // knows better than the canonical 'interrupted' guess, so it wins this
    // one matchup despite its lower source rank.
    if (TOOL_ROW_KINDS.has(normalizeId(currentRow && currentRow.kind))) {
      const currentState = rowToolState(currentRow);
      const candidateState = rowToolState(candidateRow);
      if (
        currentState === 'interrupted'
        && candidateState
        && candidateState !== 'interrupted'
        && candidateRank > 0
        && candidateRank < currentRank
      ) {
        return candidateRow;
      }
      if (
        candidateState === 'interrupted'
        && currentState
        && currentState !== 'interrupted'
        && currentRank > 0
        && currentRank < candidateRank
      ) {
        return currentRow;
      }
    }
    if (candidateRank > currentRank) {
      return candidateRow;
    }
    return currentRow;
  }

  function indexRowsByRenderMessageId(rowsByTurnId) {
    const rowsByRenderMessageId = new Map();
    if (!rowsByTurnId || typeof rowsByTurnId.forEach !== 'function') {
      return rowsByRenderMessageId;
    }
    // First pass: bucket every row by render_message_id, with per-bucket
    // dedup state captured in `dedupStateByBucket`. Buckets retain the
    // original turn order so non-dedupable rows keep stable ordering.
    const dedupStateByBucket = new Map();
    rowsByTurnId.forEach(function indexTurnRows(rows) {
      const sourceRows = Array.isArray(rows) ? rows : [];
      // tool_result rows must render inside their paired call's article: the
      // article layer suppresses standalone tool_result articles (thread
      // anchor only — see buildMessageArticleMarkup), so a result row
      // bucketed under its own tool_result message id can never reach the
      // DOM. Remap each result row to its call row's render id (same turn,
      // same tool_call_id) so the result — output details, the inline
      // mermaid chart, and artifact teasers — lands directly below the call
      // card. Orphan results (no call row in the turn) keep today's bucket.
      const callRowRenderIdByCallId = new Map();
      for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
        const row = sourceRows[rowIndex];
        const kind = normalizeId(row && row.kind);
        if (kind !== 'tool_call' && kind !== 'tool_step') {
          continue;
        }
        const callId = normalizeId(row && (row.tool_call_id || (row.payload && row.payload.tool_call_id)));
        const callRenderId = normalizeId(row && (row.render_message_id || row.primary_message_id));
        if (callId && callRenderId && !callRowRenderIdByCallId.has(callId)) {
          callRowRenderIdByCallId.set(callId, callRenderId);
        }
      }
      for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
        const row = sourceRows[rowIndex];
        let renderMessageId = normalizeId(row && (row.render_message_id || row.primary_message_id));
        const rowKind = normalizeId(row && row.kind);
        const rowPayload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
        // source_citations rows are collector-derived from a tool_result event,
        // so they inherit that event's primary_message_id (the tool_result
        // message) even though their own row kind is system_notice — the same
        // "anchored to a suppressed tool_result message" trap as the tool_result
        // remap above. Without this, the chip row lands in a bucket that never
        // renders (buildMessageArticleMarkup returns '' for tool_result
        // messages) and silently vanishes. Remap it beside its paired call, same
        // as the result it was derived from.
        if (rowKind === 'tool_result' || (rowKind === 'system_notice' && normalizeId(rowPayload.subkind) === 'source_citations')) {
          const callId = normalizeId(row && (row.tool_call_id || rowPayload.tool_call_id));
          const pairedRenderId = callId ? normalizeId(callRowRenderIdByCallId.get(callId)) : '';
          if (pairedRenderId) {
            renderMessageId = pairedRenderId;
          }
        }
        if (!renderMessageId) {
          continue;
        }
        const bucket = rowsByRenderMessageId.get(renderMessageId) || [];
        const dedupKey = rowDedupKey(row);
        if (!dedupKey) {
          bucket.push(row);
          rowsByRenderMessageId.set(renderMessageId, bucket);
          continue;
        }
        let bucketState = dedupStateByBucket.get(renderMessageId);
        if (!bucketState) {
          bucketState = new Map();
          dedupStateByBucket.set(renderMessageId, bucketState);
        }
        const existing = bucketState.get(dedupKey);
        if (!existing) {
          // First sighting — reserve a slot at the current insertion point.
          const slotIndex = bucket.length;
          bucket.push(row);
          rowsByRenderMessageId.set(renderMessageId, bucket);
          bucketState.set(dedupKey, { row, slotIndex });
          continue;
        }
        const better = pickBetterRow(existing.row, row);
        if (better !== existing.row) {
          // Newer candidate outranked the slot holder; replace in place to
          // preserve the bucket's original positional order.
          bucket[existing.slotIndex] = better;
          existing.row = better;
        }
      }
    });
    return rowsByRenderMessageId;
  }

  return {
    indexRowsByRenderMessageId,
    // Exported for unit tests; internal-use otherwise.
    _rowDedupKey: rowDedupKey,
    _SOURCE_RANK: SOURCE_RANK,
  };
});
