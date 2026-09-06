(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-elapsed-clock'));
    return;
  }
  root.rendererTurnRowToolRenderUtils = factory(root.rendererTurnElapsedClock || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnElapsedClockUtils) {
  'use strict';

  const formatElapsedLabel = turnElapsedClockUtils.formatElapsedLabel;
  const TERMINAL_TURN_PHASES = new Set([
    'done', 'review_artifact', 'error', 'cancelled', 'canceled', 'denied',
    'timeout', 'timed_out', 'interrupted', 'preempted',
  ]);
  const TERMINAL_TURN_STATUSES = new Set([
    'error', 'errored', 'failed', 'cancelled', 'canceled', 'denied',
    'timeout', 'timed_out', 'interrupted', 'preempted',
  ]);

  function fallbackEscapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fallbackNormalizeId(value) {
    return String(value || '').trim();
  }

  function fallbackFormatDurationMs() {
    return '';
  }

  // WS3 ⤢ "Open in panel" affordance for the mermaid fallback block. Same
  // Tabler arrows-diagonal geometry as ICONS.expand in
  // renderer-artifact-card-utils.js; rendered through the inventory
  // actionButton primitive (emits nothing when the primitive is unavailable).
  const ARTIFACT_PANEL_EXPAND_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2H10v2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 2L7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 10H2V7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 10l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
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
      ariaLabel: 'Open in panel',
      title: 'Open in panel',
      trustedHtml: ARTIFACT_PANEL_EXPAND_SVG,
      dataset: {
        'inv-artifact-action': 'panel',
        'artifact-id': id,
      },
    });
  }

  function getToolStatusLabel(status, normalizeId) {
    const normalize = typeof normalizeId === 'function' ? normalizeId : fallbackNormalizeId;
    const normalizedStatus = normalize(status).toLowerCase();
    // Canonical labels come from tool-call-utils.getStatusLabel so trace-row and block-family labels cannot diverge.
    const toolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
      || (typeof require === 'function' ? require('./tool-call-utils') : null);
    if (toolCallUtils && typeof toolCallUtils.getStatusLabel === 'function') {
      return toolCallUtils.getStatusLabel(normalizedStatus);
    }
    return String(status || '').trim();
  }

  const toolDetailBody = (typeof globalThis !== 'undefined' && globalThis.rendererToolDetailBody)
    || (typeof require === 'function' ? require('./renderer-tool-detail-body') : null);
  const taskSpawnChip = (typeof globalThis !== 'undefined' && globalThis.rendererTaskSpawnChip)
    || (typeof require === 'function' ? require('./renderer-task-spawn-chip') : null);

  function getToolStatusSeverity(status, normalizeId) {
    const toolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
      || (typeof require === 'function' ? require('./tool-call-utils') : null);
    if (toolCallUtils && typeof toolCallUtils.getToolStatusSeverity === 'function') {
      return toolCallUtils.getToolStatusSeverity(status);
    }
    const normalize = typeof normalizeId === 'function' ? normalizeId : fallbackNormalizeId;
    return normalize(status).toLowerCase() === 'errored' ? 'danger' : '';
  }

  const OUTCOME_SEVERITY = Object.freeze({
    failure: 'danger',
    interrupted: 'caution',
    stopped: 'calm',
  });

  // Classify an errored tool result into one of three outcomes from its
  // error_code + status, so denied/cancelled don't read as crashes.
  function classifyToolResultOutcome(payload) {
    const toolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
      || (typeof require === 'function' ? require('./tool-call-utils') : null);
    if (toolCallUtils && typeof toolCallUtils.classifyToolResultOutcome === 'function') {
      return toolCallUtils.classifyToolResultOutcome(payload);
    }
    return 'failure';
  }

  // The granular call status to use when a paired/standalone result is an
  // error: prefer an explicit terminal verdict, else derive from the outcome
  // so getToolStatusLabel/Severity produce the right badge + rail (a denied
  // tool reads "Denied"/calm, not "Errored"/danger).
  function erroredStatusForResult(payload) {
    const toolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
      || (typeof require === 'function' ? require('./tool-call-utils') : null);
    if (toolCallUtils && typeof toolCallUtils.statusForToolResult === 'function') {
      return toolCallUtils.statusForToolResult(payload);
    }
    return 'errored';
  }

  // Statuses that open the minimal tool row's detail body by default: the
  // user needs to see what went wrong / what is being asked without a click.
  const TOOL_ROW_TERMINAL_VERDICTS = new Set([
    'denied', 'cancelled', 'blocked', 'timed_out', 'abandoned',
  ]);

  // User expand/collapse overrides per composite tool-row key, module-scoped so they
  // survive the per-delta full re-renders of the streaming pipeline (same
  // pattern as the legacy transcript tool-call store). Bounded FIFO so a
  // long session cannot grow it without bound.
  const TOOL_ROW_EXPANSION_CAP = 500;
  const _toolRowExpansionOverrides = new Map();
  const _toolDetailContexts = new Map();

  function registerToolDetailContext(rowKey, detailBodyBuilder, detailModel) {
    const key = fallbackNormalizeId(rowKey);
    if (!key || !detailBodyBuilder || typeof detailBodyBuilder.buildDetailBodyMarkup !== 'function') return;
    if (_toolDetailContexts.has(key)) _toolDetailContexts.delete(key);
    _toolDetailContexts.set(key, { detailBodyBuilder, detailModel });
    while (_toolDetailContexts.size > TOOL_ROW_EXPANSION_CAP) {
      _toolDetailContexts.delete(_toolDetailContexts.keys().next().value);
    }
  }

  function materializeToolRowDetails(rowKey) {
    const key = fallbackNormalizeId(rowKey);
    const context = _toolDetailContexts.get(key);
    if (!context) return { ok: false, reason: 'missing_render_context', markup: '' };
    try {
      const markup = context.detailBodyBuilder.buildDetailBodyMarkup({
        ...context.detailModel,
        expandFileDiffsByDefault: getToolRowExpansion(key) === true,
      });
      _toolDetailContexts.delete(key);
      return {
        ok: true,
        reason: '',
        markup,
      };
    } catch (_error) {
      return { ok: false, reason: 'detail_build_failed', markup: '' };
    }
  }

  function setToolRowExpansion(rowKey, expanded) {
    const key = fallbackNormalizeId(rowKey);
    if (!key) {
      return;
    }
    if (_toolRowExpansionOverrides.has(key)) {
      _toolRowExpansionOverrides.delete(key);
    }
    _toolRowExpansionOverrides.set(key, expanded === true);
    while (_toolRowExpansionOverrides.size > TOOL_ROW_EXPANSION_CAP) {
      const oldestKey = _toolRowExpansionOverrides.keys().next().value;
      _toolRowExpansionOverrides.delete(oldestKey);
    }
  }

  function getToolRowExpansion(rowKey) {
    const key = fallbackNormalizeId(rowKey);
    return _toolRowExpansionOverrides.has(key)
      ? _toolRowExpansionOverrides.get(key)
      : undefined;
  }

  function clearToolRowExpansionOverrides() {
    _toolRowExpansionOverrides.clear();
    _toolDetailContexts.clear();
  }

  function createTurnRowToolRenderUtils(deps) {
    const settings = deps || {};
    const toolCallUtils = (typeof globalThis !== 'undefined' && globalThis.toolCallUtils)
      || (typeof require === 'function' ? require('./tool-call-utils') : null);
    function resolveProjectedRowCallId(row) {
      if (toolCallUtils && typeof toolCallUtils.resolveProjectedRowCallId === 'function') {
        return toolCallUtils.resolveProjectedRowCallId(row);
      }
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      return fallbackNormalizeId(payload.tool_call_id || (row && row.tool_call_id));
    }
    const escapeHtml = typeof settings.escapeHtml === 'function'
      ? settings.escapeHtml
      : fallbackEscapeHtml;
    const detailBodyBuilder = toolDetailBody && typeof toolDetailBody.createToolDetailBody === 'function'
      ? toolDetailBody.createToolDetailBody({
          escapeHtml,
          sanitizeHtmlFragment: settings.sanitizeHtmlFragment,
          toolCallUtils,
        })
      : null;
    const normalizeId = typeof settings.normalizeId === 'function'
      ? settings.normalizeId
      : fallbackNormalizeId;
    const formatDurationMs = typeof settings.formatDurationMs === 'function'
      ? settings.formatDurationMs
      : fallbackFormatDurationMs;
    const renderArtifactTeaser = typeof settings.renderArtifactTeaser === 'function'
      ? settings.renderArtifactTeaser
      : function noopRenderArtifactTeaser() { return ''; };
    const buildToolMarkerBannerMarkup = typeof settings.buildToolMarkerBannerMarkup === 'function'
      ? settings.buildToolMarkerBannerMarkup
      : function noopBuildToolMarkerBannerMarkup() { return ''; };
    const renderApprovalBlock = typeof settings.renderApprovalBlock === 'function'
      ? settings.renderApprovalBlock
      : null;
    // Injectable clock for the running row's seed elapsed label (tests pass a
    // fixed now; production uses wall clock — the same anchor family as the
    // reducer's running_started_at_ms stamp).
    const getNow = typeof settings.getNow === 'function'
      ? settings.getNow
      : function defaultGetNow() { return Date.now(); };

    // One tool call = one minimal single-row header sharing the block family's
    // status dot, name, summary, status, duration, and disclosure anatomy. Its
    // flat detail body stays collapsed while compact artifact
    // teasers remain available beside it
    // (inert) until the user expands it or the status demands attention
    // (the canonical tool-call-utils rule). When the row list pairs this call row
    // with its tool_result row (options.pairedToolResultRow, same
    // tool_call_id), the status badge flips to the terminal state in place.
    // The mermaid_generate result diagram renders OUTSIDE the collapsed body
    // only in the fallback case — see buildMermaidFallbackBlockMarkup.
    // W1-4: render the summary's path portion as an inline open-in-IDE chip.
    // The chip carries the forward-slash-normalized path (what the IDE and
    // workspace-fs speak) while displaying the summary's original text; when
    // the summary doesn't literally contain the path (e.g. truncated), the
    // summary renders unchipped — the row-level data-chat-path context menu
    // still covers those.
    function buildSummaryParts(rowSummary, primaryPath, chipPath) {
      const summary = String(rowSummary || '');
      const path = String(primaryPath || '');
      if (!path || !chipPath) {
        return { summaryMarkup: escapeHtml(summary), pathMarkup: '' };
      }
      const index = summary.indexOf(path);
      if (index === -1) {
        return { summaryMarkup: escapeHtml(summary), pathMarkup: '' };
      }
      const surroundingSummary = `${summary.slice(0, index)} ${summary.slice(index + path.length)}`
        .replace(/\s+/g, ' ')
        .trim();
      return {
        summaryMarkup: escapeHtml(surroundingSummary),
        pathMarkup: `<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="${escapeHtml(chipPath)}" title="Open ${escapeHtml(chipPath)} in the IDE">${escapeHtml(path)}</span>`,
      };
    }

    function buildToolCallRowMarkup(row, messages, options) {
      const renderOptions = options || {};
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCallId = resolveProjectedRowCallId(row);
      const rowKey = toolCallUtils && typeof toolCallUtils.buildToolRowKey === 'function'
        ? toolCallUtils.buildToolRowKey({
            sessionId: renderOptions.sessionId,
            turnId: row && row.turn_id,
            rowId: row && row.row_id,
            messageId: row && row.primary_message_id,
            callId: toolCallId,
          })
        : (normalizeId(row && row.row_id) || toolCallId);
      const domToken = toolCallUtils && typeof toolCallUtils.buildToolRowDomToken === 'function'
        ? toolCallUtils.buildToolRowDomToken(rowKey)
        : encodeURIComponent(rowKey || toolCallId || 'unknown');
      let status = normalizeId(payload.state || payload.status || 'requested');
      const pairedResultRow = renderOptions.pairedToolResultRow && typeof renderOptions.pairedToolResultRow === 'object'
        ? renderOptions.pairedToolResultRow
        : null;
      const resultPayload = pairedResultRow && pairedResultRow.payload && typeof pairedResultRow.payload === 'object'
        ? pairedResultRow.payload
        : null;
      const resultMessageId = normalizeId(pairedResultRow && pairedResultRow.primary_message_id);
      const resultMessage = resultMessageId
        ? (renderOptions.messageById?.get?.(resultMessageId)
          || (Array.isArray(messages) ? messages.find((message) => normalizeId(message?.id) === resultMessageId) : null))
        : null;
      const canonicalResult = resultMessage?.tool_result && typeof resultMessage.tool_result === 'object'
        ? resultMessage.tool_result
        : null;
      const toolName = String(payload.tool_name || 'Tool call');
      let summaryInput = payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
        ? payload.input
        : null;
      if (!summaryInput) {
        const inputJson = String(payload.input_json || '').trim();
        if (inputJson.startsWith('{')) {
          try { summaryInput = JSON.parse(inputJson); } catch (_error) { summaryInput = null; }
        }
      }
      const rowSummary = toolCallUtils && typeof toolCallUtils.formatToolCallSummary === 'function'
        ? toolCallUtils.formatToolCallSummary(toolName, summaryInput)
        : toolName;
      // W1-4 clickable paths: file-target tools stamp their path on the row
      // (context-menu hook) and render the path portion of the summary as a
      // chip that dispatches ide:open-file-at-line (renderer-chat-path-open).
      const primaryPath = toolCallUtils && typeof toolCallUtils.getToolPrimaryPath === 'function'
        ? String(toolCallUtils.getToolPrimaryPath(toolName, summaryInput) || '')
        : '';
      const chipPath = primaryPath.replace(/\\/g, '/');
      const chatPathAttr = chipPath ? ` data-chat-path="${escapeHtml(chipPath)}"` : '';
      const summaryParts = buildSummaryParts(rowSummary, primaryPath, chipPath);
      let markerBannerMarkup = '';
      let resultBodyIsError = false;
      let durationLabel = '';
      if (resultPayload) {
        const resultIsError = resultPayload.is_error === true || resultPayload.result_is_error === true;
        resultBodyIsError = resultIsError;
        const callState = normalizeId(payload.state || payload.status).toLowerCase();
        const resultStatus = toolCallUtils && typeof toolCallUtils.statusForToolResult === 'function'
          ? toolCallUtils.statusForToolResult(resultPayload)
          : (resultIsError ? erroredStatusForResult(resultPayload) : 'completed');
        status = resultStatus === 'completed' && TOOL_ROW_TERMINAL_VERDICTS.has(callState) ? callState : resultStatus;
        durationLabel = formatDurationMs(resultPayload.duration_ms);
        markerBannerMarkup = buildToolMarkerBannerMarkup(resultPayload);
      }
      const statusKey = String(status || '').toLowerCase();
      const statusAutoExpand = toolCallUtils && typeof toolCallUtils.shouldAutoExpandToolDetails === 'function'
        ? toolCallUtils.shouldAutoExpandToolDetails(statusKey)
        : false;
      const userOverride = getToolRowExpansion(rowKey);
      const expanded = userOverride === undefined ? statusAutoExpand : userOverride === true;
      const detailsMaterialized = expanded || renderOptions.forceMaterializeToolDetails === true;
      const bodyId = `${domToken}-body`;
      const ariaBusy = status === 'running' ? ' aria-busy="true"' : '';
      const hasResultAttr = resultPayload ? ' data-has-result="true"' : '';
      const severity = getToolStatusSeverity(status, normalizeId);
      const severityAttr = severity ? ` data-tool-severity="${severity}"` : '';
      // Live per-tool elapsed: while the call is executing (and no result has
      // settled it), the duration slot becomes an elapsed node the transcript
      // clock ticks in place via its data-elapsed-started-at anchor
      // (renderer-turn-elapsed-clock scans [data-turn-elapsed]).
      // patchStatus strips the attributes when the call settles so the clock
      // stops touching the node mid-turn.
      const runningStartedAtMs = Number(payload.running_started_at_ms);
      const showLiveElapsed = !resultPayload
        && (statusKey === 'running' || statusKey === 'executing')
        && Number.isFinite(runningStartedAtMs)
        && runningStartedAtMs > 0;
      const liveElapsedSeedLabel = showLiveElapsed
        ? formatElapsedLabel(Math.max(0, getNow() - runningStartedAtMs))
        : '';
      const liveElapsedAttrs = showLiveElapsed
        ? ` data-turn-elapsed="true" data-elapsed-started-at="${runningStartedAtMs}" data-elapsed-running="true"`
        : '';
      const inputPresent = Object.prototype.hasOwnProperty.call(payload, 'input')
        || Object.prototype.hasOwnProperty.call(payload, 'input_json');
      const structuredInputUsable = payload.input && typeof payload.input === 'object'
        && !Array.isArray(payload.input) && Object.keys(payload.input).length > 0;
      let inputJsonUsable = false;
      if (!structuredInputUsable && typeof payload.input_json === 'string' && payload.input_json.trim()) {
        try {
          const parsedInputJson = JSON.parse(payload.input_json);
          inputJsonUsable = parsedInputJson && typeof parsedInputJson === 'object'
            && !Array.isArray(parsedInputJson) && Object.keys(parsedInputJson).length > 0;
        } catch (_error) { inputJsonUsable = false; }
      }
      const detailModel = {
        toolName,
        toolKind: toolCallUtils && typeof toolCallUtils.normalizeToolKind === 'function'
          ? toolCallUtils.normalizeToolKind(toolName)
          : toolName,
        status,
        callId: toolCallId,
        isError: resultBodyIsError,
        input: payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input)
          ? payload.input
          : null,
        inputJson: String(payload.input_json || ''),
        inputExpected: inputPresent,
        inputRecorded: structuredInputUsable || inputJsonUsable,
        outputText: String(resultPayload && resultPayload.output_text || ''),
        metadata: (() => {
          const source = resultPayload?.metadata || canonicalResult?.metadata;
          return source && typeof source === 'object' && !Array.isArray(source) ? source : {};
        })(),
        errorCode: String(resultPayload && resultPayload.error_code || ''),
        /* row.turn_id IS the stream id (projector derivation) — it makes the
         * error-code chip a deep link into the Logs Activity view. */
        streamId: String((row && row.turn_id) || ''),
        resultSummary: String(resultPayload && (resultPayload.result_summary || resultPayload.summary) || ''),
        domToken,
        expandFileDiffsByDefault: userOverride === true,
        artifacts: resultPayload && Array.isArray(resultPayload.generated_artifacts)
          ? resultPayload.generated_artifacts
          : [],
        trustedAttachmentImageUrls: toolCallUtils
          && typeof toolCallUtils.getTrustedToolResultImageUrls === 'function'
          ? toolCallUtils.getTrustedToolResultImageUrls(resultPayload)
          : [],
        retryMessageId: renderOptions.retryMessageId,
        sessionId: String(renderOptions.sessionId || ''),
      };
      if (!detailsMaterialized) {
        registerToolDetailContext(rowKey, detailBodyBuilder, detailModel);
      }
      const detailBodyMarkup = detailsMaterialized && detailBodyBuilder
        ? detailBodyBuilder.buildDetailBodyMarkup(detailModel)
        : '';
      const mermaidFallbackMarkup = resultPayload
        ? buildMermaidFallbackBlockMarkup(resultPayload, domToken, renderOptions)
        : '';
      const artifactTeasersMarkup = resultPayload
        ? (Array.isArray(resultPayload.generated_artifacts) ? resultPayload.generated_artifacts : [])
            .map((artifact) => renderArtifactTeaser(artifact))
            .join('')
        : '';
      const taskSpawnChipMarkup = taskSpawnChip?.renderTaskSpawnChipStrip?.(detailModel, {
        escapeHtml,
        getLinkedSessionId: taskSpawnChip.getLinkedSessionId,
      }) || '';
      const displayToolName = toolCallUtils && typeof toolCallUtils.getToolDisplayName === 'function'
        ? toolCallUtils.getToolDisplayName(toolName, payload.tool_display_name)
        : toolName;
      const isFileOperation = /^(Write|Edit|Move)$/.test(detailModel.toolKind);
      const isRunning = statusKey === 'running' || statusKey === 'executing';
      const fileOperationClass = isFileOperation
        ? ` tool-call-file-operation${isRunning ? ' tool-call-file-composing' : (toolCallUtils.isFileOperationSettledStatus(status) ? ' tool-call-file-settled' : '')}`
        : '';
      const headerInner = toolCallUtils && typeof toolCallUtils.buildToolHeaderInner === 'function'
        ? toolCallUtils.buildToolHeaderInner({
            displayToolName,
            summary: rowSummary === displayToolName ? '' : rowSummary,
            status,
            isRunning,
            isFileOperation,
            icon: toolCallUtils.getToolIcon(toolName),
            statusLabel: getToolStatusLabel(status, normalizeId),
            // R2-12: a failed row stays collapsed, so its own failure text
            // rides in the header as one bounded line.
            failureSummary: resultBodyIsError && toolCallUtils
              && typeof toolCallUtils.summarizeToolFailure === 'function'
              ? toolCallUtils.summarizeToolFailure({
                  isError: true,
                  status,
                  errorCode: detailModel.errorCode,
                  outputText: detailModel.outputText,
                  resultSummary: detailModel.resultSummary,
                })
              : '',
            durationLabel: liveElapsedAttrs ? liveElapsedSeedLabel : durationLabel,
            secondaryMeta: toolCallUtils && typeof toolCallUtils.formatToolResultMeta === 'function'
              ? toolCallUtils.formatToolResultMeta(toolName, detailModel.metadata)
              : '',
          }, {
            escapeHtml,
            renderIcon(icon, model) {
              return model.isFileOperation && icon
                ? `<span class="tool-call-file-icon" aria-hidden="true">${icon}</span>` : '';
            },
            renderSummary: function renderSummary() {
              return `<span class="tool-call-summary tool-call-row-summary">${summaryParts.summaryMarkup}</span>`;
            },
            renderDuration: function renderDuration(label) {
              return label
                ? ` <span class="tool-result-duration"${liveElapsedAttrs}>${escapeHtml(label)}</span>`
                : '';
            },
          })
        : `<span class="tool-call-row-summary">${summaryParts.summaryMarkup}</span>`;
      return `
        ${markerBannerMarkup}
        <div class="tool-call-row tool-call-row--minimal${fileOperationClass}" data-tool-call-id="${escapeHtml(toolCallId)}" data-tool-row-key="${escapeHtml(rowKey)}" data-tool-status="${escapeHtml(status)}" data-is-error="${resultBodyIsError ? 'true' : 'false'}"${severityAttr}${chatPathAttr} data-expanded="${expanded ? 'true' : 'false'}" data-tool-details-materialized="${detailsMaterialized ? 'true' : 'false'}"${ariaBusy}${hasResultAttr}>
          <div class="tool-call-row-header">
          <div
            class="tool-call-row-toggle"
            role="button"
            tabindex="0"
            data-tool-row-toggle="true"
            data-tool-call-id="${escapeHtml(toolCallId)}"
            data-tool-row-key="${escapeHtml(rowKey)}"
            aria-expanded="${expanded ? 'true' : 'false'}"
            aria-controls="${escapeHtml(bodyId)}"
          >
            ${headerInner}
          </div>
          ${summaryParts.pathMarkup}
          </div>
          ${taskSpawnChipMarkup}
          ${mermaidFallbackMarkup}
          ${artifactTeasersMarkup}
          <div class="tool-call-row-body" id="${escapeHtml(bodyId)}"${expanded ? '' : ' inert'}>
            ${detailBodyMarkup}
          </div>
        </div>
      `;
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
      if (!resultPayload || !isTurnSettledForRender(options)) {
        return '';
      }
      const mermaidText = resolveResultMermaidSource(resultPayload);
      if (!mermaidText || answerHasMatchingMermaidFence(options, mermaidText)) {
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

    // Standalone result row — only reached for ORPHAN results (no tool_call
    // row with the same call id in the bucket). Paired results render inside
    // the call card via buildToolCallRowMarkup(options.pairedToolResultRow).
    function buildToolResultRowMarkup(row, _messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCallId = resolveProjectedRowCallId(row);
      const durationLabel = formatDurationMs(payload.duration_ms);
      const isError = payload.is_error === true || payload.result_is_error === true;
      const resultOutcome = isError ? classifyToolResultOutcome(payload) : '';
      const resultSeverity = resultOutcome ? (OUTCOME_SEVERITY[resultOutcome] || '') : '';
      const severityAttr = resultSeverity ? ` data-tool-severity="${resultSeverity}"` : '';
      const resultIconLabel = isError
        ? (resultOutcome === 'stopped' ? 'OFF' : resultOutcome === 'interrupted' ? 'END' : 'ERR')
        : 'OK';
      const markerBannerMarkup = buildToolMarkerBannerMarkup(payload);
      const rowKey = toolCallUtils && typeof toolCallUtils.buildToolRowKey === 'function'
        ? toolCallUtils.buildToolRowKey({
            sessionId: options && options.sessionId,
            turnId: row && row.turn_id,
            rowId: row && row.row_id,
            messageId: row && row.primary_message_id,
            callId: toolCallId,
          })
        : (normalizeId(row && row.row_id) || toolCallId);
      const domToken = toolCallUtils && typeof toolCallUtils.buildToolRowDomToken === 'function'
        ? toolCallUtils.buildToolRowDomToken(rowKey)
        : encodeURIComponent(rowKey || toolCallId || 'unknown');
      const detailModel = {
        toolName: String(payload.tool_name || 'Result'),
        toolKind: toolCallUtils && typeof toolCallUtils.normalizeToolKind === 'function'
          ? toolCallUtils.normalizeToolKind(payload.tool_name)
          : String(payload.tool_name || ''),
        status: isError ? 'errored' : 'completed',
        callId: toolCallId,
        isError,
        input: null,
        inputJson: '',
        inputExpected: false,
        inputRecorded: false,
        outputText: String(payload.output_text || ''),
        metadata: payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
          ? payload.metadata
          : {},
        errorCode: String(payload.error_code || ''),
        streamId: String((row && row.turn_id) || ''),
        resultSummary: String(payload.result_summary || payload.summary || ''),
        domToken,
        artifacts: Array.isArray(payload.generated_artifacts) ? payload.generated_artifacts : [],
        trustedAttachmentImageUrls: toolCallUtils
          && typeof toolCallUtils.getTrustedToolResultImageUrls === 'function'
          ? toolCallUtils.getTrustedToolResultImageUrls(payload)
          : [],
        retryMessageId: options && options.retryMessageId,
      };
      const resultBodyMarkup = detailBodyBuilder
        ? detailBodyBuilder.buildDetailBodyMarkup(detailModel)
        : '';
      const artifactsMarkup = detailModel.artifacts.map((artifact) => renderArtifactTeaser(artifact)).join('');
      return `
        ${markerBannerMarkup}
        <div class="tool-result-row" data-tool-call-id="${escapeHtml(toolCallId)}" data-is-error="${isError ? 'true' : 'false'}"${severityAttr}>
          <div class="tool-result-header">
            <span class="tool-result-icon" aria-hidden="true">${escapeHtml(resultIconLabel)}</span>
            <span class="tool-result-label">${escapeHtml(String(payload.tool_name || 'Result'))}</span>
            ${durationLabel ? `<span class="tool-result-duration">${escapeHtml(durationLabel)}</span>` : ''}
          </div>
          ${buildMermaidFallbackBlockMarkup(payload, domToken, options)}
          ${resultBodyMarkup}
          ${artifactsMarkup}
        </div>
      `;
    }

    function buildApprovalGapMarkup(row) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCallId = resolveProjectedRowCallId(row);
      const toolName = String(payload.tool_name || '').trim();
      // Same precedence as the tool row this card sits above (F16).
      const displayToolName = toolCallUtils && typeof toolCallUtils.getToolDisplayName === 'function'
        ? toolCallUtils.getToolDisplayName(toolName, payload.tool_display_name)
        : (String(payload.tool_display_name || '').trim() || toolName);
      const prompt = String(payload.prompt || '').trim();
      if (!renderApprovalBlock) {
        return '';
      }
      // Quote the exact command/args being approved (bounded by the block's
      // own preview cap). The `input` object is the full sanitized payload;
      // `input_json` is a capped serialization that collapses to a
      // {truncated, preview} stub past the cap, so it is only the fallback
      // and its stub is never previewed as if it were the arguments.
      // Absent/unparsable input degrades to prompt-only.
      let commandText = '';
      let approvalInput = payload.input && typeof payload.input === 'object'
        && !Array.isArray(payload.input) && Object.keys(payload.input).length ? payload.input : null;
      const approvalInputJson = String(payload.input_json || '').trim();
      if (!approvalInput && approvalInputJson.startsWith('{')) {
        try {
          approvalInput = JSON.parse(approvalInputJson);
        } catch (_error) {
          approvalInput = null;
        }
      }
      if (approvalInput && approvalInput.truncated === true && typeof approvalInput.preview === 'string') {
        approvalInput = null;
      }
      if (approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalCommandPreview === 'function') {
        commandText = toolCallUtils.getApprovalCommandPreview(toolName, approvalInput);
      }
      return renderApprovalBlock({
        toolCallId,
        approvalId: normalizeId(payload.approval_id || payload.approvalId),
        toolName,
        displayToolName,
        prompt,
        policyScope: payload.policy_scope,
        policyConsequence: payload.policy_consequence,
        reason: payload.reason,
        purpose: approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalPurpose === 'function'
          ? toolCallUtils.getApprovalPurpose(approvalInput) : '',
        facts: approvalInput && toolCallUtils && typeof toolCallUtils.getApprovalFacts === 'function'
          ? toolCallUtils.getApprovalFacts(toolName, approvalInput) : [],
        commandText,
        mode: 'inline',
        variant: normalizeId(payload.approval_variant),
      }, { escapeHtml });
    }

    return {
      buildApprovalGapMarkup,
      buildToolCallRowMarkup,
      buildToolResultRowMarkup,
    };
  }

  return {
    createTurnRowToolRenderUtils,
    getToolStatusLabel,
    getToolStatusSeverity,
    setToolRowExpansion,
    getToolRowExpansion,
    clearToolRowExpansionOverrides,
    materializeToolRowDetails,
  };
});
