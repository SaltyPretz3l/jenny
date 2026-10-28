/* renderer/chat/renderer-manual-compaction-divider.js - the persisted "Context compacted" divider of a manual compaction (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererManualCompactionDivider = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* An automatic compaction is a turn event, so its divider is a projected
     system_notice row. A manual one (/compact, the meter's Compact now) has no
     turn: the session summary's compaction_context (the saved snapshot) is its
     only record. Hydration appends the same system_notice row, rendered by
     renderContextCompactedNotice, to the turn that ends at the snapshot's
     boundary message, so the divider sits where the compaction ran, survives a
     reload, and leaves when the snapshot is replaced or invalidated. */

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  // The divider for this session, or null when its snapshot is not manual.
  function resolveManualCompaction(state, sessionId) {
    const id = normalizeId(sessionId);
    const sessions = Array.isArray(state && state.sessions) ? state.sessions : [];
    const summary = id ? sessions.find((session) => normalizeId(session && session.id) === id) : null;
    const context = summary && summary.compaction_context;
    if (!context || typeof context !== 'object' || normalizeId(context.origin) !== 'manual') return null;
    const boundaryMessageId = normalizeId(context.boundary_message_id);
    if (!boundaryMessageId) return null;
    const createdAt = normalizeId(context.created_at);
    const tokensBefore = Math.max(0, Number(context.tokens_before) || 0);
    const tokensAfter = Math.max(0, Number(context.tokens_after) || 0);
    return Object.freeze({
      key: ['manual', boundaryMessageId, createdAt, tokensBefore, tokensAfter].join('|'),
      boundaryMessageId,
      contextCompacted: Object.freeze({
        strategy: normalizeId(context.strategy) || 'full',
        phase: 'manual',
        tokensBefore,
        tokensAfter,
        summaryStatus: 'created',
        summaryPersisted: true,
        occurredAt: createdAt,
      }),
    });
  }

  // `rows` with the divider appended when `turn` holds the boundary message; the
  // same array otherwise. Never mutates `rows` (the per-turn cache shares them).
  function appendManualCompactionRow(rows, turn, divider) {
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (!divider) return sourceRows;
    const sourceMessageIds = Array.isArray(turn && turn.source_message_ids) ? turn.source_message_ids : [];
    if (!sourceMessageIds.some((messageId) => normalizeId(messageId) === divider.boundaryMessageId)) return sourceRows;
    // A trailing row joins the article of the turn's last rendered message.
    let renderMessageId = '';
    for (let index = sourceRows.length - 1; index >= 0 && !renderMessageId; index -= 1) {
      const row = sourceRows[index];
      if (row && normalizeId(row.kind) !== 'user_bubble') renderMessageId = normalizeId(row.render_message_id);
    }
    if (!renderMessageId) return sourceRows;
    const turnId = normalizeId(turn && turn.turn_id);
    // A synthetic primary id: a real one would resolve the auto notice's message
    // and share its expand-toggle id.
    const primaryMessageId = `manual-compaction:${divider.boundaryMessageId}`;
    return [...sourceRows, {
      row_id: `row:${primaryMessageId}`,
      turn_id: turnId,
      kind: 'system_notice',
      primary_message_id: primaryMessageId,
      render_message_id: renderMessageId,
      source_message_ids: [primaryMessageId],
      first_event_sort_key: [Number.MAX_SAFE_INTEGER, 0, 0],
      source_events: [],
      projection_fingerprint: divider.key,
      payload: { subkind: 'context_compacted', context_compacted: { ...divider.contextCompacted } },
    }];
  }

  return { resolveManualCompaction, appendManualCompactionRow };
});
