/**
 * renderer/chat/renderer-turn-row-error-dedupe-utils.js
 *
 * Same-turn assistant-error rows dedupe to one terminal card; suppressed
 * summaries and tool errors fold into its details. This module owns that logic.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowErrorDedupeUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeIdFallback(value) {
    return String(value == null ? '' : value).trim();
  }

  /**
   * Does this row look like a turn-level assistant error notice
   * (system_notice / subkind assistant_error)? These are the rows that
   * buildErrorCodeNoticeMarkup renders into a `.chat-error-card`.
   */
  function isAssistantErrorNoticeRow(row, normalizeId) {
    const norm = typeof normalizeId === 'function' ? normalizeId : normalizeIdFallback;
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    if (norm(row && row.kind).toLowerCase() !== 'system_notice') {
      return false;
    }
    return norm(payload.subkind).toLowerCase() === 'assistant_error';
  }

  /**
   * Extract a {code, message} tool-level error entry from a tool-shaped row
   * (tool_step / tool_call / tool_result), or null when the row carries no
   * error. Reads only already-projected payload fields — invents nothing.
   */
  function extractToolErrorEntry(row, normalizeId) {
    const norm = typeof normalizeId === 'function' ? normalizeId : normalizeIdFallback;
    const kind = norm(row && row.kind).toLowerCase();
    if (kind !== 'tool_step' && kind !== 'tool_call' && kind !== 'tool_result') {
      return null;
    }
    const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
    const resultPayload = payload.result && typeof payload.result === 'object' ? payload.result : null;
    const isError = payload.is_error === true
      || payload.result_is_error === true
      || (resultPayload && (resultPayload.is_error === true || resultPayload.result_is_error === true));
    if (!isError) {
      return null;
    }
    const code = norm(payload.error_code || (resultPayload && resultPayload.error_code));
    const toolName = norm(payload.tool_name || (resultPayload && resultPayload.tool_name));
    const rawMessage = norm(
      payload.result_summary
      || payload.summary
      || (resultPayload && (resultPayload.result_summary || resultPayload.summary))
      || ''
    );
    const message = rawMessage || (toolName ? `Tool "${toolName}" failed` : 'Tool failed');
    return { code, message };
  }

  /**
   * Two-pass same-turn error dedupe.
   *
   * Pass 1: scan every sibling row that shares row.turn_id with the current
   * row, collecting (a) all tool-level error entries on the turn and (b) all
   * assistant_error system_notice rows on the turn (order-independent — rows
   * are not guaranteed to arrive in any particular order).
   *
   * Pass 2: decide what THIS row should do:
   *   - If this row is not an assistant_error notice row at all, dedupe does
   *     not apply (the caller only invokes this for that row shape).
   *   - If there is more than one assistant_error notice row on the turn,
   *     only the terminal one renders: the LAST row carrying a stream_error
   *     (the turn-level failure the projector emits from the errored
   *     assistant message), falling back to the last error row in stable
   *     row-array order. Every other one is suppressed.
   *   - The terminal row absorbs the turn's tool-level error entries AND the
   *     suppressed assistant_error siblings' {code, message} as
   *     `suppressedErrors` so they still surface (folded into the
   *     surviving card's details block) instead of silently vanishing.
   *   - A lone tool-level error with no assistant_error notice on the turn is
   *     untouched by this function — the caller never routes tool rows
   *     through it, and there is nothing to suppress.
   *
   * @param {Object} row - current row (must be an assistant_error notice row)
   * @param {Object} options - render options; reads options.siblingRows
   * @param {function} [normalizeId]
   * @returns {{ suppress: boolean, suppressedErrors: Array<{code:string,message:string}> }}
   */
  function resolveTurnErrorDedupe(row, options, normalizeId) {
    const norm = typeof normalizeId === 'function' ? normalizeId : normalizeIdFallback;
    const siblingRows = (options && Array.isArray(options.siblingRows)) ? options.siblingRows : [];
    const turnId = norm(row && row.turn_id);

    if (!turnId || !siblingRows.length) {
      return { suppress: false, suppressedErrors: [] };
    }

    const toolErrorEntries = [];
    const assistantErrorRows = [];
    for (let i = 0; i < siblingRows.length; i += 1) {
      const candidate = siblingRows[i];
      if (!candidate || norm(candidate.turn_id) !== turnId) {
        continue;
      }
      if (isAssistantErrorNoticeRow(candidate, norm)) {
        assistantErrorRows.push(candidate);
        continue;
      }
      const toolEntry = extractToolErrorEntry(candidate, norm);
      if (toolEntry) {
        toolErrorEntries.push(toolEntry);
      }
    }

    if (assistantErrorRows.length === 0) {
      /* Should not happen — the caller only calls this for an
       * assistant_error notice row, so `row` itself should have matched
       * into assistantErrorRows above. Defensive fallback: no suppression. */
      return { suppress: false, suppressedErrors: [] };
    }

    /* Terminal pick: the last assistant_error row carrying a stream_error is
     * the turn-level failure (projector emits it from the errored assistant
     * message, after any mid-turn tool-level error notices). Fall back to
     * the last error row so either projection order dedupes to one card. */
    let terminalRow = assistantErrorRows[assistantErrorRows.length - 1];
    for (let i = assistantErrorRows.length - 1; i >= 0; i -= 1) {
      const candidatePayload = assistantErrorRows[i].payload && typeof assistantErrorRows[i].payload === 'object'
        ? assistantErrorRows[i].payload
        : {};
      if (String(candidatePayload.stream_error || '').trim()) {
        terminalRow = assistantErrorRows[i];
        break;
      }
    }

    if (terminalRow !== row) {
      /* Another assistant_error row for the same turn owns the card —
       * suppress this one; the terminal render folds its summary in. */
      return { suppress: true, suppressedErrors: [] };
    }

    /* The terminal card absorbs the suppressed assistant_error siblings as
     * one-line entries, then any tool-level error entries. Never invents a
     * card for a lone tool-level error (tool rows never call this). */
    const suppressedErrors = [];
    for (let i = 0; i < assistantErrorRows.length; i += 1) {
      const sibling = assistantErrorRows[i];
      if (sibling === terminalRow) {
        continue;
      }
      const payload = sibling.payload && typeof sibling.payload === 'object' ? sibling.payload : {};
      const code = norm(payload.error_code);
      const message = String(
        payload.stream_error
        || payload.message
        || payload.summary
        || payload.content
        || ''
      ).trim().slice(0, 200);
      if (code || message) {
        suppressedErrors.push({ code, message });
      }
    }
    return { suppress: false, suppressedErrors: suppressedErrors.concat(toolErrorEntries) };
  }

  /**
   * Resolve the errored assistant message behind the turn's terminal
   * assistant_error notice row, or null when the turn carries none. Used by
   * the turn-article footer: a turn that ended in a terminal error keeps its
   * last contentful text segment as the copy/regenerate action target, but
   * the footer label must reflect the terminal outcome ("Failed"), which
   * lives on the (possibly empty) errored message the notice row points at.
   */
  function findTerminalAssistantErrorMessage(rows, resolveMessage, normalizeId) {
    const norm = typeof normalizeId === 'function' ? normalizeId : normalizeIdFallback;
    const sourceRows = Array.isArray(rows) ? rows : [];
    if (typeof resolveMessage !== 'function') {
      return null;
    }
    /* Same terminal preference as resolveTurnErrorDedupe, so the footer never
     * disagrees with which row owns the turn's error card: a resolving
     * stream_error-bearing assistant_error row wins outright; otherwise the
     * last error row whose message resolves to an errored status. */
    let fallback = null;
    for (let index = sourceRows.length - 1; index >= 0; index -= 1) {
      const row = sourceRows[index];
      if (!isAssistantErrorNoticeRow(row, norm)) {
        continue;
      }
      const messageId = norm(row.primary_message_id);
      const message = messageId ? resolveMessage(messageId) : null;
      if (!message || norm(message.status).toLowerCase() !== 'error') {
        continue;
      }
      const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
      if (String(payload.stream_error || '').trim()) {
        return message;
      }
      if (fallback === null) {
        fallback = message;
      }
    }
    return fallback;
  }

  return {
    isAssistantErrorNoticeRow,
    extractToolErrorEntry,
    resolveTurnErrorDedupe,
    findTerminalAssistantErrorMessage,
  };
});
