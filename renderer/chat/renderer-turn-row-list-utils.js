(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowListUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TIMELINE_V2_SUMMARY_ROW_KINDS = new Set([
    'reasoning',
    'tool_call',
    'tool_step',
    'tool_result',
    'approval_gap',
  ]);
  const TIMELINE_V2_SUMMARY_ATTR_MAX_LENGTH = 160;

  function compactTimelineV2SummaryText(value) {
    const text = String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
    if (!text || text.length <= TIMELINE_V2_SUMMARY_ATTR_MAX_LENGTH) {
      return text;
    }
    return `${text.slice(0, TIMELINE_V2_SUMMARY_ATTR_MAX_LENGTH - 3).trimEnd()}...`;
  }

  // Cheap string-level (no DOM parse) check for "this row would render with
  // nothing visible beside its node-dot". Strips HTML comments and any
  // visually-hidden wrapper (sr-only spans, aria-hidden="true" elements) —
  // e.g. buildAssistantTextRowMarkup's SR-only phase kicker for a blank
  // assistant segment — then checks whether any markup/text remains. This is
  // intentionally conservative (string surgery, not a real DOM walk): it only
  // needs to catch the two known orphan-dot shapes (fully blank bodyMarkup,
  // and SR-only-only bodyMarkup), not every conceivable case.
  const SR_ONLY_OR_ARIA_HIDDEN_ELEMENT_RE = /<([a-z][a-z0-9-]*)\b[^>]*\bclass="[^"]*\bsr-only\b[^"]*"[^>]*>[\s\S]*?<\/\1>|<[a-z][a-z0-9-]*\b[^>]*\baria-hidden="true"[^>]*>[\s\S]*?<\/[a-z][a-z0-9-]*>|<[a-z][a-z0-9-]*\b[^>]*\baria-hidden="true"[^>]*\/>/gi;
  function isBodyMarkupVisuallyEmpty(bodyMarkup) {
    const raw = String(bodyMarkup || '');
    if (!raw.trim()) {
      return true;
    }
    let stripped = raw.replace(/<!--[\s\S]*?-->/g, '');
    // Repeatedly strip sr-only / aria-hidden wrapper elements: nested
    // wrappers (e.g. an aria-hidden rule inside an sr-only span) need more
    // than one pass since the regex doesn't recurse.
    let previous;
    do {
      previous = stripped;
      stripped = stripped.replace(SR_ONLY_OR_ARIA_HIDDEN_ELEMENT_RE, '');
    } while (stripped !== previous && stripped.includes('<'));
    // Whatever remains after stripping sr-only/aria-hidden wrappers: a
    // self-closing or attribute-bearing element (img, svg icon, etc.) still
    // counts as visible content, so check for any remaining tag *or* text,
    // not just text. Only now-empty leaf wrappers (e.g. the emptied
    // <span class="chat-commentary-kicker"></span> left behind once its
    // sr-only child was stripped) and bare text nodes are evaluated here.
    const remainingTags = stripped.match(/<[a-z][a-z0-9-]*\b[^>]*\/?>/gi) || [];
    const hasNonEmptyLeafTag = remainingTags.some(function tagLooksVisible(tag) {
      return /\bsrc=|\bviewBox=|<img\b|<svg\b|<canvas\b|<video\b|<audio\b|<iframe\b/i.test(tag);
    });
    if (hasNonEmptyLeafTag) {
      return false;
    }
    const textOnly = stripped.replace(/<[^>]*>/g, '').trim();
    return !textOnly;
  }

  // Row-wrapper + turn-row-list assembly layer; per-kind row body builders stay
  // in renderer-turn-row-render-utils.js. Consumes the body dispatch (buildRowBodyMarkup), identity
  // (buildRowId), and streaming detection (isStreamingRow) as injected deps so
  // the body/wrapper/list layering stays a one-directional dependency chain.
  // Rows render as a flat sequence while turn_activity_envelope only controls upstream article coalescing.
  function createTurnRowListUtils(deps) {
    const settings = deps || {};
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : function fallbackEscapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      };
    const normalizeId = typeof settings.normalizeId === 'function'
      ? settings.normalizeId
      : function fallbackNormalizeId(value) { return String(value || '').trim(); };
    const buildTimelineV2Presentation = typeof settings.buildTimelineV2Presentation === 'function'
      ? settings.buildTimelineV2Presentation
      : null;
    const buildRowId = typeof settings.buildRowId === 'function'
      ? settings.buildRowId
      : function fallbackBuildRowId(row) {
        return `${normalizeId(row && row.turn_id)}:${normalizeId(row && row.kind)}:${normalizeId(row && row.row_id) || 'row'}`;
      };
    const isStreamingRow = typeof settings.isStreamingRow === 'function'
      ? settings.isStreamingRow
      : function fallbackIsStreamingRow() { return false; };
    const buildRowBodyMarkup = typeof settings.buildRowBodyMarkup === 'function'
      ? settings.buildRowBodyMarkup
      : function fallbackBuildRowBodyMarkup() { return ''; };
    const buildTimeDividerMarkup = typeof settings.buildTimeDividerMarkup === 'function'
      ? settings.buildTimeDividerMarkup
      : function fallbackBuildTimeDividerMarkup() { return ''; };

    function buildTimelineV2SummaryAttributes(row) {
      const rowKind = normalizeId(row && row.kind);
      if (!TIMELINE_V2_SUMMARY_ROW_KINDS.has(rowKind)) {
        return [];
      }
      let presentation = null;
      if (buildTimelineV2Presentation) {
        presentation = buildTimelineV2Presentation(row, { surface: 'transcript' });
      }
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const summary = compactTimelineV2SummaryText(presentation
        ? String(presentation.summary || '').trim()
        : String(payload.summary || payload.result_summary || payload.input_summary || payload.prompt || '').trim());
      if (!summary) {
        return [];
      }
      const tone = presentation?.tone || 'neutral';
      const state = presentation?.state || normalizeId(payload.state || payload.status);
      const targetKind = presentation?.target?.kind || 'none';
      const attrs = [
        `data-chat-row-v2-summary-kind="${escapeHtml(rowKind)}"`,
        `data-chat-row-v2-summary-text="${escapeHtml(summary)}"`,
        `data-chat-row-v2-kind="${escapeHtml(rowKind)}"`,
        `data-chat-row-v2-tone="${escapeHtml(tone)}"`,
        `data-chat-row-v2-target-kind="${escapeHtml(targetKind)}"`,
      ];
      if (state) {
        attrs.push(`data-chat-row-v2-state="${escapeHtml(state)}"`);
      }
      return attrs;
    }

    // Mirrors the former timelineStyleId resolution (renderOptions override +
    // document.documentElement.dataset fallback): the shared
    // response_loop_display_v2 flag is reflected onto the root dataset by the
    // renderer shell, but tests pass it explicitly via renderOptions.
    function resolveResponseLoopDisplayV2(renderOptions) {
      if (renderOptions && typeof renderOptions.responseLoopDisplayV2 === 'boolean') {
        return renderOptions.responseLoopDisplayV2;
      }
      return typeof document !== 'undefined'
        && !!document.documentElement
        && document.documentElement.dataset.responseLoopDisplay === 'true';
    }

    function buildRowWrapperMarkup(row, messages, options) {
      const renderOptions = options || {};
      const rowId = buildRowId(row);
      const streaming = isStreamingRow(row, renderOptions);
      const responseLoopDisplayV2 = resolveResponseLoopDisplayV2(renderOptions);
      const bodyMarkup = buildRowBodyMarkup(row, messages, {
        ...renderOptions,
        isStreaming: streaming,
        responseLoopDisplayV2,
      });
      if (!String(bodyMarkup || '').trim()) {
        return '';
      }
      const rowHasVisibleBody = !isBodyMarkupVisuallyEmpty(bodyMarkup);
      const attrs = [
        `data-row-id="${escapeHtml(rowId)}"`,
        `data-row-kind="${escapeHtml(String(row && row.kind || ''))}"`,
      ];
      const sourceMessageId = normalizeId(row && row.primary_message_id);
      if (sourceMessageId) {
        attrs.push(`data-source-message-id="${escapeHtml(sourceMessageId)}"`);
      }
      const renderMessageId = normalizeId(row && (row.render_message_id || row.primary_message_id));
      if (renderMessageId) {
        attrs.push(`data-render-message-id="${escapeHtml(renderMessageId)}"`);
      }
      const sourceMessageIds = [];
      if (Array.isArray(row && row.source_message_ids)) {
        for (const id of row.source_message_ids) {
          const normalizedId = normalizeId(id);
          if (normalizedId && !sourceMessageIds.includes(normalizedId)) {
            sourceMessageIds.push(normalizedId);
          }
        }
      }
      if (sourceMessageId && !sourceMessageIds.includes(sourceMessageId)) {
        sourceMessageIds.unshift(sourceMessageId);
      }
      if (renderMessageId && !sourceMessageIds.includes(renderMessageId)) {
        sourceMessageIds.push(renderMessageId);
      }
      if (sourceMessageIds.length) {
        attrs.push(`data-source-message-ids="${escapeHtml(sourceMessageIds.join(' '))}"`);
      }
      const toolCallId = normalizeId(row && (row.tool_call_id || row.payload && row.payload.tool_call_id));
      if ((String(row && row.kind || '') === 'tool_step' || String(row && row.kind || '') === 'tool_call' || String(row && row.kind || '') === 'tool_result' || String(row && row.kind || '') === 'approval_gap') && toolCallId) {
        attrs.push(`data-tool-call-id="${escapeHtml(toolCallId)}"`);
      }
      if (String(row && row.kind || '') === 'tool_step' || String(row && row.kind || '') === 'tool_call' || String(row && row.kind || '') === 'tool_result' || String(row && row.kind || '') === 'approval_gap') {
        const rowState = normalizeId(row && row.payload && row.payload.state);
        if (rowState) {
          attrs.push(`data-row-state="${escapeHtml(rowState)}"`);
        }
      }
      const wrapperRowKind = String(row && row.kind || '');
      if (streaming) {
        attrs.push('data-streaming-row="true"');
      }
      // Phase attribute drives the commentary/intermediate de-emphasis in
      // styles/chat-commentary-v2.css. Only emitted under the display flag, so
      // legacy/flag-off markup is byte-identical to today; final_answer carries
      // the attribute too so the CSS can target it explicitly (full emphasis).
      if (responseLoopDisplayV2 && wrapperRowKind === 'assistant_text') {
        const assistantPhase = normalizeId(row && row.assistant_phase);
        if (assistantPhase === 'commentary'
          || assistantPhase === 'intermediate'
          || assistantPhase === 'final_answer') {
          attrs.push(`data-assistant-phase="${escapeHtml(assistantPhase)}"`);
        }
      }
      attrs.push(...buildTimelineV2SummaryAttributes(row));
      if (!rowHasVisibleBody) {
        /* Rows whose body survived the blank check but carries no VISIBLE content (e.g. a blank
           assistant_text on a preempted turn emitting only its sr-only phase kicker) keep their
           accessible markup but flag themselves so CSS can collapse their box — otherwise each one
           contributes an empty padded band to the transcript (the "dead vertical gap" defect). */
        attrs.push('data-row-visually-empty="true"');
      }
      const nodeDotMarkup = rowHasVisibleBody ? '<span class="chat-row-node-dot" aria-hidden="true"></span>' : '';
      return `<div class="chat-row" ${attrs.join(' ')}>${nodeDotMarkup}${bodyMarkup}</div>`;
    }

    // One tool call = ONE timeline card (render-layer only; projector/reducer
    // row shapes are untouched). Pair each tool_call row with the bucket's
    // tool_result row that shares its tool_call_id: the call row renders the
    // combined card (result folded in via options.pairedToolResultRow) and the
    // consumed result row is skipped. Post-dedup a bucket holds at most one
    // tool_call and one tool_result per call id, so pairing is unambiguous.
    // Orphan results (no call row in the bucket) keep their standalone row.
    function pairToolResultRows(sourceRows, resultCandidates = sourceRows) {
      const pairedResultRowByCallRow = new Map();
      const consumedResultRows = new Set();
      const resultRowByCallId = new Map();
      for (const row of resultCandidates) {
        if (normalizeId(row && row.kind) !== 'tool_result') continue;
        const callId = normalizeId(row && (row.tool_call_id || (row.payload && row.payload.tool_call_id)));
        if (callId && !resultRowByCallId.has(callId)) {
          resultRowByCallId.set(callId, row);
        }
      }
      if (resultRowByCallId.size) {
        for (const row of sourceRows) {
          if (normalizeId(row && row.kind) !== 'tool_call') continue;
          const callId = normalizeId(row && (row.tool_call_id || (row.payload && row.payload.tool_call_id)));
          const resultRow = callId ? resultRowByCallId.get(callId) : null;
          if (resultRow && !consumedResultRows.has(resultRow)) {
            pairedResultRowByCallRow.set(row, resultRow);
            consumedResultRows.add(resultRow);
          }
        }
      }
      return { pairedResultRowByCallRow, consumedResultRows };
    }

    function buildTurnRowListMarkup(rows, messages, options) {
      const renderOptions = options || {};
      const sourceRows = Array.isArray(rows) ? rows : [];
      // Multi-turn dedup is now owned by indexRowsByRenderMessageId in
      // renderer-render-message-index-utils.js: when two turns claim the
      // same render_message_id, that helper picks one row per
      // (kind, primary_message_id[, phase_id]) using canonical > reconciled
      // > live precedence. This caller renders the bucket directly.
      const resultCandidates = Array.isArray(renderOptions.turnRows) && renderOptions.turnRows.length
        ? renderOptions.turnRows
        : sourceRows;
      const { pairedResultRowByCallRow, consumedResultRows } = pairToolResultRows(
        sourceRows,
        resultCandidates
      );
      const messageById = renderOptions.messageById && typeof renderOptions.messageById.get === 'function'
        ? renderOptions.messageById
        : new Map((Array.isArray(messages) ? messages : []).map((message) => [normalizeId(message && message.id), message]));

      const turnPhase = normalizeId(renderOptions.turnPhase);
      // Resolve the response_loop_display_v2 flag ONCE per turn-list and thread
      // it to every row, so buildRowWrapperMarkup's resolveResponseLoopDisplayV2
      // hits its boolean fast-path instead of re-reading
      // document.documentElement.dataset per row.
      const responseLoopDisplayV2 = resolveResponseLoopDisplayV2(renderOptions);
      const resumeTailMessageId = normalizeId(renderOptions.resumeTailMessageId);
      const resumeSendBusy = renderOptions.resumeSendBusy === true;
      const timelineDividerByMessageId = renderOptions.timelineDividerByMessageId instanceof Map
        ? renderOptions.timelineDividerByMessageId
        : null;
      const dividerHostMessageId = normalizeId(renderOptions.dividerHostMessageId);
      const emittedDividerMessageIds = new Set();

      const rowMarkup = sourceRows.map(function renderRow(row, rowIndex) {
        if (consumedResultRows.has(row)) {
          return '';
        }
        const markup = buildRowWrapperMarkup(row, messages, {
          ...renderOptions,
          responseLoopDisplayV2,
          resumeTailMessageId,
          resumeSendBusy,
          messageById,
          rowIndex,
          siblingRows: sourceRows,
          pairedToolResultRow: pairedResultRowByCallRow.get(row) || null,
        });
        if (!markup || !timelineDividerByMessageId) {
          return markup;
        }
        const rowMessageIds = [
          row && row.render_message_id,
          row && row.primary_message_id,
          ...(Array.isArray(row && row.source_message_ids) ? row.source_message_ids : []),
        ];
        let dividerMarkup = '';
        for (const candidateId of rowMessageIds) {
          const messageId = normalizeId(candidateId);
          if (
            !messageId
            || messageId === dividerHostMessageId
            || emittedDividerMessageIds.has(messageId)
            || !timelineDividerByMessageId.has(messageId)
          ) {
            continue;
          }
          emittedDividerMessageIds.add(messageId);
          dividerMarkup += buildTimeDividerMarkup(timelineDividerByMessageId.get(messageId), { escapeHtml });
        }
        return dividerMarkup + markup;
      }).join('');

      const turnPhaseAttr = turnPhase ? ` data-turn-phase="${escapeHtml(turnPhase)}"` : '';
      return `<div class="turn-row-list" data-turn-row-list="true"${turnPhaseAttr}>${rowMarkup}</div>`;
    }

    return {
      buildTimelineV2SummaryAttributes,
      buildRowWrapperMarkup,
      buildTurnRowListMarkup,
    };
  }

  return {
    createTurnRowListUtils,
  };
});
