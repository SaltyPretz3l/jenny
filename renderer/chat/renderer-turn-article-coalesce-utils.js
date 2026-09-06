(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnArticleCoalesceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // turn_activity_envelope: coalesce ALL of a turn's projected rows into ONE
  // turn-article. The per-bucket dispatch in
  // renderer-render-pipeline-article-markup.js renders one article per
  // assistant render-message (each holding only that message's rows), so a
  // multi-iteration turn fragments into N sibling cards with N avatars and
  // the step grouping never sees a full iteration run. These helpers pick a
  // single deterministic anchor message for the turn and assemble the
  // full-turn row list, preserving BOTH the canonical row order (rowsByTurnId
  // order, so a mis-anchored reasoning phase cannot drag the final answer
  // upward) and the multi-turn dedup already applied by
  // indexRowsByRenderMessageId (a row renders only if it survived into its
  // render bucket).

  function normalizeId(value) {
    return String(value == null ? '' : value).trim();
  }

  function rowRenderMessageId(row) {
    return normalizeId(row && (row.render_message_id || row.primary_message_id));
  }

  function readContext(projectionContext) {
    const context = projectionContext && typeof projectionContext === 'object' ? projectionContext : {};
    return {
      turnIdByMessageId: context.turnIdByMessageId instanceof Map ? context.turnIdByMessageId : null,
      rowsByRenderMessageId: context.rowsByRenderMessageId instanceof Map ? context.rowsByRenderMessageId : null,
      messageById: context.messageById instanceof Map ? context.messageById : null,
    };
  }

  /**
   * Full-turn row list for the coalesced article: the turn's rows in
   * canonical order, restricted to rows that (a) belong to a render message
   * this turn owns (turnIdByMessageId parity with the per-bucket dispatch:
   * a bucket owned by another turn keeps rendering at that turn's article)
   * and (b) survived dedup into their render bucket. Returns [] when the
   * projection context is too sparse to make that call safely.
   */
  function collectTurnRenderRows(turnId, rows, projectionContext) {
    const normalizedTurnId = normalizeId(turnId);
    const sourceRows = Array.isArray(rows) ? rows : [];
    const { turnIdByMessageId, rowsByRenderMessageId } = readContext(projectionContext);
    if (!normalizedTurnId || !turnIdByMessageId || !rowsByRenderMessageId) {
      return [];
    }
    const bucketSetByRenderId = new Map();
    function bucketSet(renderId) {
      if (!bucketSetByRenderId.has(renderId)) {
        const bucket = rowsByRenderMessageId.get(renderId);
        bucketSetByRenderId.set(renderId, new Set(Array.isArray(bucket) ? bucket : []));
      }
      return bucketSetByRenderId.get(renderId);
    }
    const collected = [];
    for (const row of sourceRows) {
      if (!row || normalizeId(row.kind) === 'user_bubble') {
        continue;
      }
      const renderId = rowRenderMessageId(row);
      if (!renderId || normalizeId(turnIdByMessageId.get(renderId)) !== normalizedTurnId) {
        continue;
      }
      if (!bucketSet(renderId).has(row)) {
        continue;
      }
      collected.push(row);
    }
    return collected;
  }

  /**
   * Deterministic anchor for the turn's single article: the render message of
   * the first coalesced row whose message exists, is assistant-role, and is
   * not a tool_result (tool_result messages compat-anchor before the turn
   * dispatch can run). Derivable identically from any message of the turn, so
   * full renders and single-message re-renders agree on which message hosts
   * the article. Empty string = no safe anchor; caller falls back to the
   * per-bucket dispatch.
   */
  function deriveTurnArticleAnchorMessageId(turnId, rows, projectionContext) {
    const { messageById } = readContext(projectionContext);
    if (!messageById) {
      return '';
    }
    const seenRenderIds = new Set();
    for (const row of collectTurnRenderRows(turnId, rows, projectionContext)) {
      const renderId = rowRenderMessageId(row);
      if (seenRenderIds.has(renderId)) {
        continue;
      }
      seenRenderIds.add(renderId);
      const message = messageById.get(renderId) || null;
      if (!message) {
        continue;
      }
      if (normalizeId(message.kind) === 'tool_result') {
        continue;
      }
      if (normalizeId(message.role).toLowerCase() !== 'assistant') {
        continue;
      }
      return renderId;
    }
    return '';
  }

  return {
    collectTurnRenderRows,
    deriveTurnArticleAnchorMessageId,
  };
});
