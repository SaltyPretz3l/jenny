/* renderer/chat/renderer-turn-row-mermaid-fallback.js renders a
 * mermaid_generate result as a timeline diagram on its tool card, only as the
 * fallback when the settled turn's answer carries no matching ```mermaid
 * fence, plus the "Open in panel" affordance beside it. Loaded before
 * renderer-turn-row-tool-render-utils.js, which builds one renderer per row
 * renderer with its escapeHtml / normalizeId. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTurnRowMermaidFallback = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TERMINAL_TURN_PHASES = new Set([
    'done', 'review_artifact', 'error', 'cancelled', 'canceled', 'denied',
    'timeout', 'timed_out', 'interrupted', 'preempted',
  ]);
  const TERMINAL_TURN_STATUSES = new Set([
    'error', 'errored', 'failed', 'cancelled', 'canceled', 'denied',
    'timeout', 'timed_out', 'interrupted', 'preempted',
  ]);

  // WS3 ⤢ "Open in panel" affordance for the mermaid fallback block. Same
  // Tabler arrows-diagonal geometry as ICONS.expand in
  // renderer-artifact-card-utils.js; rendered through the inventory
  // actionButton primitive (emits nothing when the primitive is unavailable).
  const ARTIFACT_PANEL_EXPAND_SVG = '<svg class="icon-mirror-rtl" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2H10v2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 2L7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 10H2V7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 10l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  const inventoryActionButton = (function resolveInventoryActionButton() {
    if (typeof globalThis !== 'undefined' && globalThis.inventoryActionButton) {
      return globalThis.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try { return require('../inventory/action-button'); } catch (_error) { /* not available */ }
    }
    return null;
  })();
  function buildArtifactPanelAffordanceMarkup(artifactId) {
    const id = String(artifactId || '').trim();
    if (!id || typeof inventoryActionButton !== 'function') return '';
    return inventoryActionButton({
      plain: true,
      className: 'inv-artifact-action inv-artifact-panel',
      ariaLabel: jt('chat.toolRow.openInPanel', 'Open in panel'),
      title: jt('chat.toolRow.openInPanel', 'Open in panel'),
      trustedHtml: ARTIFACT_PANEL_EXPAND_SVG,
      dataset: {
        'inv-artifact-action': 'panel',
        'artifact-id': id,
      },
    });
  }

  function createMermaidFallbackRenderer(deps) {
    const { escapeHtml, normalizeId } = deps || {};
    if (typeof escapeHtml !== 'function' || typeof normalizeId !== 'function') {
      throw new TypeError('escapeHtml and normalizeId must be functions');
    }

    function resolveMarkdownUtils() {
      if (typeof globalThis !== 'undefined' && globalThis.markdownUtils) {
        return globalThis.markdownUtils;
      }
      if (typeof require === 'function') {
        try { return require('../shared/markdown-utils'); } catch (_error) { return null; }
      }
      return null;
    }

    function resolveResultMermaidSource(payload) {
      if (normalizeId(payload.tool_name) !== 'mermaid_generate') {
        return '';
      }
      if (payload.is_error === true || payload.result_is_error === true) {
        return '';
      }
      const outputText = String(payload.output_text || '').trim();
      if (!outputText.startsWith('{')) {
        return '';
      }
      let parsed;
      try { parsed = JSON.parse(outputText); } catch (_error) { return ''; }
      return parsed && typeof parsed === 'object' && typeof parsed.mermaid === 'string'
        ? parsed.mermaid.trim()
        : '';
    }

    // The fallback (and the dedup that suppresses it) only run once the turn
    // can no longer change: mid-turn the model may still be about to echo
    // the fence, and rendering the diagram early would flash it.
    //
    // The live projected path renders tool articles with NO turn phase and
    // isStreaming=false even mid-turn (per-message article buckets; the
    // active-turn flags derive from the streaming MESSAGE, which does not
    // exist in the gap between model calls). So when the turn's rows are
    // available, "settled" is derived from them directly: the turn must have
    // final assistant text or terminal error/cancellation evidence, and none
    // of its messages may be the session's currently-streaming one. Without
    // turnRows (hydrated/legacy contexts), an empty phase counts as settled.
    function isTurnSettledForRender(options) {
      const renderOptions = options || {};
      if (renderOptions.isStreaming === true) {
        return false;
      }
      const phase = normalizeId(renderOptions.turnPhase);
      if (phase && !TERMINAL_TURN_PHASES.has(phase)) {
        return false;
      }
      const turnRows = Array.isArray(renderOptions.turnRows) ? renderOptions.turnRows : null;
      if (!turnRows || !turnRows.length) {
        return true;
      }
      // Streaming message ids: the projection's activeStreamingMessageId
      // (canonical path) plus the stream handler's pending map values (the
      // live projected path, where the former stays empty).
      const streamingIds = [];
      const projectionStreamingId = normalizeId(
        renderOptions.projectionContext && renderOptions.projectionContext.activeStreamingMessageId
      );
      if (projectionStreamingId) {
        streamingIds.push(projectionStreamingId);
      }
      if (Array.isArray(renderOptions.pendingStreamMessageIds)) {
        for (const pendingId of renderOptions.pendingStreamMessageIds) {
          const normalizedPendingId = normalizeId(pendingId);
          if (normalizedPendingId) {
            streamingIds.push(normalizedPendingId);
          }
        }
      }
      if (streamingIds.length) {
        for (const candidate of turnRows) {
          const candidateId = normalizeId(candidate && candidate.primary_message_id);
          if (candidateId && streamingIds.indexOf(candidateId) >= 0) {
            return false;
          }
        }
      }
      let hasAssistantText = false;
      let hasTerminalEvidence = false;
      for (const candidate of turnRows) {
        const kind = normalizeId(candidate && candidate.kind).toLowerCase();
        const payload = candidate && candidate.payload && typeof candidate.payload === 'object'
          ? candidate.payload
          : {};
        if (kind === 'assistant_text' && String(payload.text || '').trim()) {
          hasAssistantText = true;
        }
        const subkind = normalizeId(payload.subkind).toLowerCase();
        const terminalStatus = normalizeId(
          payload.terminal_status || payload.terminalStatus || payload.recovery_class
        ).toLowerCase();
        if (kind === 'assistant_error'
          || (kind === 'system_notice' && subkind === 'assistant_error')
          || ((kind === 'system_notice' || kind === 'assistant_error')
            && TERMINAL_TURN_STATUSES.has(terminalStatus))) {
          hasTerminalEvidence = true;
        }
      }
      if (hasTerminalEvidence) {
        return true;
      }
      const lastRowKind = normalizeId(turnRows[turnRows.length - 1]?.kind).toLowerCase();
      return hasAssistantText && lastRowKind !== 'tool_call' && lastRowKind !== 'tool_result';
    }

    function answerHasMatchingMermaidFence(options, mermaidSource) {
      const markdownUtilsRef = resolveMarkdownUtils();
      if (!markdownUtilsRef
        || typeof markdownUtilsRef.extractMermaidFenceSources !== 'function'
        || typeof markdownUtilsRef.normalizeMermaidSource !== 'function') {
        return false;
      }
      const target = markdownUtilsRef.normalizeMermaidSource(mermaidSource);
      if (!target) {
        return false;
      }
      // turnRows spans the whole turn; siblingRows only this article's
      // bucket (one render message). The answer's assistant_text row lives
      // in a different bucket than the tool card, so prefer turnRows.
      const renderOptions = options || {};
      const candidateRows = Array.isArray(renderOptions.turnRows) && renderOptions.turnRows.length
        ? renderOptions.turnRows
        : (Array.isArray(renderOptions.siblingRows) ? renderOptions.siblingRows : []);
      for (const sibling of candidateRows) {
        if (normalizeId(sibling && sibling.kind) !== 'assistant_text') {
          continue;
        }
        const text = String((sibling.payload && sibling.payload.text) || '');
        if (!text) {
          continue;
        }
        const sources = markdownUtilsRef.extractMermaidFenceSources(text);
        for (const source of sources) {
          if (markdownUtilsRef.normalizeMermaidSource(source) === target) {
            return true;
          }
        }
      }
      return false;
    }

    // The assistant answer is the diagram's canonical home. The tool card
    // renders the mermaid_generate result as a chart only as a FALLBACK:
    // turn settled and no whitespace-equivalent fence in any of the turn's
    // assistant text. The emitted markdown-mermaid-block wrapper is what
    // renderInlineMermaidBlocks picks up, exactly like a fenced ```mermaid
    // block; the tool-result-body class keeps the markdown.css scoping and
    // the GUI smoke selector working.
    function buildMermaidFallbackBlockMarkup(resultPayload, domToken, options) {
      // The cheap tool-name check first: the settled-turn walk visits every row.
      const mermaidText = resultPayload ? resolveResultMermaidSource(resultPayload) : '';
      if (!mermaidText || !isTurnSettledForRender(options) || answerHasMatchingMermaidFence(options, mermaidText)) {
        return '';
      }
      const markdownUtilsRef = resolveMarkdownUtils();
      if (!markdownUtilsRef || typeof markdownUtilsRef.buildMermaidTimelineBlockMarkup !== 'function') {
        return '';
      }
      const blockMarkup = markdownUtilsRef.buildMermaidTimelineBlockMarkup(mermaidText, `tool-mermaid-${domToken}`);
      if (!blockMarkup) {
        return '';
      }
      // ⤢ affordance: only when a generated-artifact id resolves from the
      // paired result payload (no id -> no control). Unconditional since the
      // panel became the sole artifact surface (W1-5 flag retirement).
      const affordanceArtifacts = Array.isArray(resultPayload.generated_artifacts) ? resultPayload.generated_artifacts : [];
      const panelAffordanceMarkup = buildArtifactPanelAffordanceMarkup(String(affordanceArtifacts[0]?.artifact_id || '').trim());
      const rawCallId = String(resultPayload.tool_call_id || resultPayload.call_id || '');
      return `<div class="tool-result-body tool-result-diagram" data-tool-call-id="${escapeHtml(rawCallId)}">${blockMarkup}${panelAffordanceMarkup}</div>`;
    }

    return { buildMermaidFallbackBlockMarkup };
  }

  return { createMermaidFallbackRenderer };
});
