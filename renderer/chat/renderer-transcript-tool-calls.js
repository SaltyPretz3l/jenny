(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-normalization-utils'),
      require('./renderer-transcript-tool-result-utils'),
      require('./renderer-subagent-monitor-view'),
      require('./renderer-tool-detail-body')
    );
    return;
  }
  root.rendererTranscriptToolCallUtils = factory(
    root.rendererTurnNormalizationUtils || {},
    root.rendererTranscriptToolResultUtils || {},
    root.rendererSubagentMonitorView || {},
    root.rendererToolDetailBody || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils, transcriptToolResultUtils, subagentView, toolDetailBody) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const windowRef = globalRef.window || null;
  const _stringUtils = typeof globalThis !== 'undefined' && typeof globalThis.stringUtils !== 'undefined'
    ? globalThis.stringUtils
    : typeof require === 'function' ? require('../shared/string-utils')
    : {
      normalizeString: function normalizeString(value) {
        return String(value || '').trim();
      },
      normalizeId: function normalizeId(value) {
        return String(value || '').trim();
      },
    };
  const { normalizeString, normalizeId } = _stringUtils;
  const extractToolCallId = typeof turnNormalizationUtils.extractToolCallId === 'function'
    ? turnNormalizationUtils.extractToolCallId
    : function fallbackExtractToolCallId(payload) {
      return normalizeId(
        payload && (
          payload.callId
          || payload.call_id
          || payload.toolCallId
          || payload.tool_call_id
          || payload.tool_call && payload.tool_call.call_id
        )
      );
    };
  const {
    NON_TERMINAL_RENDER_STATES,
    buildSyntheticToolResultMeta,
    collectProjectedToolMessages,
    findToolResultForCallId,
    isPlainObject,
    isToolResultError,
    normalizeToolRenderStatus,
    readToolResultDurationMs,
    readToolResultGeneratedArtifacts,
    readToolResultOutputText,
  } = transcriptToolResultUtils;
  const _diffHunksRender = typeof globalThis !== 'undefined' && globalThis.rendererDiffHunksRender
    ? globalThis.rendererDiffHunksRender
    : typeof require === 'function'
      ? require('./renderer-diff-hunks-render')
      : null;
  const _jennyChangeLedger = typeof globalThis !== 'undefined' && globalThis.rendererJennyChangeLedger
    ? globalThis.rendererJennyChangeLedger
    : typeof require === 'function'
      ? require('./renderer-jenny-change-ledger')
      : null;
  const _codeReviewAffordance = typeof globalThis !== 'undefined' && globalThis.rendererCodeReviewAffordance
    ? globalThis.rendererCodeReviewAffordance
    : typeof require === 'function'
      ? require('./renderer-code-review-affordance')
      : null;
  const _taskSpawnChip = typeof globalThis !== 'undefined' && globalThis.rendererTaskSpawnChip
    ? globalThis.rendererTaskSpawnChip
    : typeof require === 'function'
      ? require('./renderer-task-spawn-chip')
      : null;
  const _monitorToolUtils = typeof globalThis !== 'undefined' && globalThis.rendererMonitorToolUtils
    ? globalThis.rendererMonitorToolUtils
    : typeof require === 'function'
      ? require('./renderer-monitor-tool-utils')
      : null;
  let cachedDOMPurify = undefined;

  function resolveDOMPurify() {
    if (cachedDOMPurify !== undefined) {
      return cachedDOMPurify;
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.DOMPurify !== 'undefined') {
      cachedDOMPurify = globalThis.DOMPurify;
      return cachedDOMPurify;
    }
    try {
      const createDOMPurify = require('dompurify');
      if (windowRef) {
        cachedDOMPurify = createDOMPurify(windowRef);
        return cachedDOMPurify;
      }
      cachedDOMPurify = null;
      return cachedDOMPurify;
    } catch (_error) {
      cachedDOMPurify = null;
      return cachedDOMPurify;
    }
  }

  function sanitizeHtmlFragment(html) {
    const purify = resolveDOMPurify();
    if (!purify || typeof purify.sanitize !== 'function') {
      return '';
    }
    return purify.sanitize(String(html || ''), {
      ALLOWED_TAGS: ['div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption'],
      ALLOWED_ATTR: ['class'],
      ALLOW_DATA_ATTR: false,
    });
  }

  /*
   * Per-instance expansion store keyed by the renderer's session/turn/row
   * composite identity. Tool call ids
   * are only turn-scoped and cannot safely own DOM or preference state. The Map is
   * bounded with FIFO eviction so a long-running session that scrolls
   * past thousands of tool calls cannot grow the store without limit;
   * entries that fall out simply revert to their status-derived default,
   * which is harmless because nothing is interacting with them anymore.
   */
  const TOOL_CALL_EXPANSION_MAX_ENTRIES = 500;

  function createExpansionStore() {
    const overrides = new Map();
    return {
      set(callId, expanded) {
        const key = normalizeId(callId);
        if (!key) return;
        /* Re-insert preserves recency for the FIFO sweep below. */
        if (overrides.has(key)) {
          overrides.delete(key);
        }
        overrides.set(key, Boolean(expanded));
        if (overrides.size > TOOL_CALL_EXPANSION_MAX_ENTRIES) {
          const oldestKey = overrides.keys().next().value;
          if (oldestKey !== undefined) {
            overrides.delete(oldestKey);
          }
        }
      },
      get(callId) {
        const key = normalizeId(callId);
        if (!key) return undefined;
        return overrides.get(key);
      },
      clear() {
        overrides.clear();
      },
    };
  }

  /*
   * Module-level registry + facade. renderer-chat-search-overlay.js reaches in
   * via rendererTranscriptToolCallUtils.setToolCallExpansion to transiently
   * expand classic .tool-call-block rows around a search jump, so this surface
   * must stay exported even though the chat event handler receives the
   * per-instance setter by injection. Forwards to the most recently created
   * renderer; clear broadcasts to every registered instance.
   */
  const transcriptRendererRegistry = new Set();

  function getPrimaryRenderer() {
    if (transcriptRendererRegistry.size === 0) return null;
    let last = null;
    transcriptRendererRegistry.forEach((entry) => { last = entry; });
    return last;
  }

  function setToolCallExpansion(rowKey, expanded) {
    const renderer = getPrimaryRenderer();
    if (renderer) renderer.setToolCallExpansion(rowKey, expanded);
  }

  function getToolCallExpansion(rowKey) {
    const renderer = getPrimaryRenderer();
    return renderer ? renderer.getToolCallExpansion(rowKey) : undefined;
  }

  function clearToolCallExpansionOverrides() {
    transcriptRendererRegistry.forEach((entry) => entry.clearToolCallExpansionOverrides());
  }

  function createTranscriptToolCallRenderer(deps) {
    const {
      escapeHtml,
      toolCallUtils,
    } = deps || {};

    /* Per-renderer expansion store. Reads from the override before falling
     * back to the status-derived default in buildToolCallViewModelFromParts. */
    const expansionStore = createExpansionStore();
    function setToolCallExpansion(rowKey, expanded) {
      expansionStore.set(rowKey, expanded);
    }
    function getToolCallExpansion(rowKey) {
      return expansionStore.get(rowKey);
    }
    function clearToolCallExpansionOverrides() {
      expansionStore.clear();
    }

    const _toolShellUtils = typeof globalThis !== 'undefined' && globalThis.toolShellUtils
      ? globalThis.toolShellUtils
      : typeof require === 'function'
        ? require('./renderer-tool-shell-utils')
        : null;
    const _artifactCardUtils = typeof globalThis !== 'undefined' && globalThis.rendererArtifactCardUtils
      ? globalThis.rendererArtifactCardUtils
      : typeof require === 'function'
        ? require('./renderer-artifact-card-utils')
        : null;
    const _approvalBlockModule = typeof globalThis !== 'undefined' && globalThis.rendererApprovalBlock
      ? globalThis.rendererApprovalBlock
      : typeof require === 'function'
        ? require('./renderer-approval-block')
        : null;
    const _renderApprovalBlock = _approvalBlockModule && typeof _approvalBlockModule.renderApprovalBlock === 'function'
      ? _approvalBlockModule.renderApprovalBlock
      : null;
    let _toolShellRenderer = undefined;
    const detailBodyBuilder = toolDetailBody && typeof toolDetailBody.createToolDetailBody === 'function'
      ? toolDetailBody.createToolDetailBody({
          escapeHtml,
          sanitizeHtmlFragment,
          toolCallUtils,
        })
      : null;

    function getToolKind(toolName) {
      if (toolCallUtils.normalizeToolKind) {
        return toolCallUtils.normalizeToolKind(toolName);
      }
      return normalizeString(toolName);
    }

    function getToolDisplayName(toolName, catalogDisplayName) {
      if (toolCallUtils.getToolDisplayName) {
        return toolCallUtils.getToolDisplayName(toolName, catalogDisplayName);
      }
      return normalizeString(catalogDisplayName) || getToolKind(toolName) || 'Tool';
    }

    function shouldAutoExpandToolDetails(status) {
      return typeof toolCallUtils.shouldAutoExpandToolDetails === 'function'
        ? toolCallUtils.shouldAutoExpandToolDetails(status)
        : false;
    }

    function buildToolSecondaryMeta(viewModel) {
      if (viewModel.status === 'awaiting_approval') {
        return 'Action needed';
      }
      if (viewModel.status === 'errored') {
        return 'Review failure details';
      }
      if (viewModel.status === 'denied') {
        return 'Request blocked';
      }
      if (viewModel.status === 'timed_out') {
        return 'Execution timed out';
      }
      if (viewModel.status === 'cancelled') {
        return 'Request cancelled';
      }
      if (viewModel.status === 'interrupted') {
        return 'Waiting to resume';
      }
      if (viewModel.status === 'abandoned') {
        return 'No result recorded';
      }
      if (viewModel.status === 'approved') {
        return 'Queued to run';
      }
      const artifactCount = Array.isArray(viewModel.generatedArtifacts) ? viewModel.generatedArtifacts.length : 0;
      if (artifactCount > 0) {
        return artifactCount === 1 ? '1 artifact generated' : `${artifactCount} artifacts generated`;
      }
      return '';
    }

    function renderToolDetailsShell(viewModel, innerHtml) {
      return `
          <div
            class="tool-call-details${viewModel.defaultExpanded ? ' expanded' : ''}"
            id="tool-details-${escapeHtml(viewModel.domToken)}"
            ${viewModel.defaultExpanded ? '' : 'hidden'}
          >
            ${innerHtml}
          </div>`;
    }

    function renderDeferredToolDetails(viewModel) {
      return `
          <div
            class="tool-call-details"
            id="tool-details-${escapeHtml(viewModel.domToken)}"
            hidden
          ></div>`;
    }

    function renderDiffHunks(hunks) {
      if (_diffHunksRender && typeof _diffHunksRender.renderDiffHunks === 'function') {
        return _diffHunksRender.renderDiffHunks(hunks, escapeHtml);
      }
      return '';
    }

    function getToolShellRenderer() {
      if (_toolShellRenderer !== undefined) return _toolShellRenderer;
      if (!_toolShellUtils) {
        _toolShellRenderer = null;
        return null;
      }
      _toolShellRenderer = _toolShellUtils.createToolShellRenderer({
        escapeHtml,
        toolCallUtils,
        renderDiffHunks,
        sanitizeHtmlFragment,
      });
      return _toolShellRenderer;
    }

    function renderReviewChangesAffordance(reviewableChange) {
      if (!_codeReviewAffordance || typeof _codeReviewAffordance.renderReviewChangesAffordance !== 'function') {
        return '';
      }
      return _codeReviewAffordance.renderReviewChangesAffordance(reviewableChange, { escapeHtml });
    }

    function renderToolHeader(viewModel) {
      // Quiet one-liner grammar: the inner anatomy ([dot] [name] [summary]
      // … [meta] [status] [caret]) comes from the shared builder so this
      // generic fallback header and the shell-path header can never drift.
      // Only the wrapper differs: a manual div here (transcript bindings own
      // the toggle) vs the shell's Collapsible trigger.
      const inner = toolCallUtils.buildToolHeaderInner(viewModel, {
        escapeHtml,
        renderReviewChangesAffordance,
        renderIcon(icon, model) {
          return model.isFileOperation && icon
            ? `<span class="tool-call-file-icon" aria-hidden="true">${icon}</span>`
            : '';
        },
        renderSummary(summary, model) {
          if (model.isFileOperation && model.isRunning && model.fileTargetPath) {
            return `<span class="tool-call-summary tool-call-file-target" title="${escapeHtml(model.fileTargetPath)}">${escapeHtml(model.fileTargetLabel)}</span>`;
          }
          return `<span class="tool-call-summary">${escapeHtml(summary)}</span>`;
        },
        renderDuration(label, model) {
          if (!label) return '';
          const elapsedAttrs = model.isFileOperation && model.isRunning && model.runningStartedAtMs > 0
            ? ` data-turn-elapsed="true" data-elapsed-started-at="${model.runningStartedAtMs}" data-elapsed-running="true"`
            : '';
          return ` <span class="tool-call-duration tool-result-duration"${elapsedAttrs}>${escapeHtml(label)}</span>`;
        },
      });
      return `
          <div
            class="tool-call-header"
            role="button"
            tabindex="0"
            aria-expanded="${viewModel.defaultExpanded ? 'true' : 'false'}"
            aria-controls="tool-details-${escapeHtml(viewModel.domToken)}"
            data-call-id="${escapeHtml(viewModel.callId)}"
            data-tool-row-key="${escapeHtml(viewModel.rowKey)}"
          >${inner}</div>`;
    }

    function renderToolDetails(viewModel) {
      const body = detailBodyBuilder && typeof detailBodyBuilder.buildDetailBodyMarkup === 'function'
        ? detailBodyBuilder.buildDetailBodyMarkup(viewModel)
        : '<div class="tool-call-empty">No input or output recorded.</div>';
      return renderToolDetailsShell(viewModel, body);
    }

    function renderToolApprovalBlock(viewModel) {
      if (!viewModel.isPending) return '';
      if (!_renderApprovalBlock) return '';
      const approvalLabel = toolCallUtils.getApprovalLabel
        ? toolCallUtils.getApprovalLabel(viewModel.toolName, viewModel.input)
        : `Approve ${viewModel.displayToolName || viewModel.toolName || 'this tool'}?`;
      return _renderApprovalBlock({
        toolCallId: viewModel.callId,
        approvalId: viewModel.approvalId,
        toolName: viewModel.toolName,
        displayToolName: viewModel.displayToolName,
        prompt: approvalLabel,
        policyScope: viewModel.policyScope,
        policyConsequence: viewModel.policyConsequence,
        reason: viewModel.reason,
        purpose: toolCallUtils.getApprovalPurpose
          ? toolCallUtils.getApprovalPurpose(viewModel.input) : '',
        facts: toolCallUtils.getApprovalFacts
          ? toolCallUtils.getApprovalFacts(viewModel.toolName, viewModel.input) : [],
        commandText: toolCallUtils.getApprovalCommandPreview
          ? toolCallUtils.getApprovalCommandPreview(viewModel.toolName, viewModel.input)
          : '',
        mode: 'card',
      }, { escapeHtml });
    }

    function renderToolDisclosureShell(viewModel, contentHtml, extraHtml) {
      const fileOperationClass = viewModel.isFileOperation
        ? ` tool-call-file-operation${viewModel.isRunning ? ' tool-call-file-composing' : (viewModel.isSettled ? ' tool-call-file-settled' : '')}`
        : '';
      const taskSpawnChipMarkup = _taskSpawnChip?.renderTaskSpawnChipStrip?.(viewModel, {
        escapeHtml,
        getLinkedSessionId: _taskSpawnChip.getLinkedSessionId,
      }) || '';
      return `
        <div class="tool-call-block${fileOperationClass}" data-call-id="${escapeHtml(viewModel.callId)}" data-tool-row-key="${escapeHtml(viewModel.rowKey)}" data-tool-status="${escapeHtml(viewModel.status)}" data-tool-details-materialized="${viewModel.detailsMaterialized ? 'true' : 'false'}">
          ${contentHtml}
          ${taskSpawnChipMarkup}
          ${extraHtml || ''}
          ${renderToolApprovalBlock(viewModel)}
        </div>
      `;
    }

    function buildToolCallViewModelFromParts(parts) {
      const source = parts || {};
      const toolName = normalizeString(source.toolName);
      const toolKind = getToolKind(toolName);
      // F16: one precedence for the label (renderer alias > catalog name > title case).
      const displayToolName = getToolDisplayName(toolName, source.displayToolName);
      const status = typeof toolCallUtils.normalizeToolStatus === 'function'
        ? toolCallUtils.normalizeToolStatus(source.status)
        : normalizeToolRenderStatus(source.status);
      // Preserve the canonical raw substatus so consumers can distinguish preempted, cancelled, and timeout outcomes without re-deriving state.
      const rawTerminal = normalizeString(source.rawTerminal).toLowerCase();
      const icon = toolCallUtils.getToolIcon(toolName);
      const statusLabel = toolCallUtils.getStatusLabel ? toolCallUtils.getStatusLabel(status) : status;
      const resultMeta = source.resultMeta && typeof source.resultMeta === 'object' ? source.resultMeta : null;
      const input = source.input && typeof source.input === 'object' && !Array.isArray(source.input)
        ? source.input
        : {};
      const hasStructuredInput = Object.keys(input).length > 0;
      const computedSummary = normalizeString(
        toolCallUtils.formatToolCallSummary(toolName, input, resultMeta) || displayToolName
      );
      const summary = normalizeString(
        hasStructuredInput
          ? computedSummary
          : (source.summary || computedSummary || displayToolName)
      );
      const dedupedSummary = summary === displayToolName ? '' : summary;
      const inputJson = source.inputJson || (hasStructuredInput ? JSON.stringify(input, null, 2) : '');
      let inputJsonUsable = false;
      if (!hasStructuredInput && typeof inputJson === 'string' && inputJson.trim()) {
        try {
          const parsedInputJson = JSON.parse(inputJson);
          inputJsonUsable = parsedInputJson && typeof parsedInputJson === 'object'
            && !Array.isArray(parsedInputJson) && Object.keys(parsedInputJson).length > 0;
        } catch (_error) { inputJsonUsable = false; }
      }
      const inputExpected = source.inputExpected === true || source.inputRecorded === true;
      const outputText = readToolResultOutputText(resultMeta);
      const isError = isToolResultError(resultMeta);
      const resultSummary = normalizeString(resultMeta && (resultMeta.summary || resultMeta.result_summary));
      const errorCode = normalizeString(resultMeta && (resultMeta.error_code || resultMeta.errorCode));
      const metadata = resultMeta && resultMeta.metadata && typeof resultMeta.metadata === 'object' && !Array.isArray(resultMeta.metadata)
        ? resultMeta.metadata
        : {};
      const generatedArtifacts = readToolResultGeneratedArtifacts(resultMeta);
      const trustedAttachmentImageUrls = typeof toolCallUtils.getTrustedToolResultImageUrls === 'function'
        ? toolCallUtils.getTrustedToolResultImageUrls(resultMeta)
        : [];
      const durationMs = readToolResultDurationMs(resultMeta, source.durationMs || 0);
      const runningStartedAtMs = Number(source.runningStartedAtMs);
      const isRunning = status === 'running' || status === 'executing';
      const isSettled = typeof toolCallUtils.isFileOperationSettledStatus === 'function'
        && toolCallUtils.isFileOperationSettledStatus(status);
      const isFileOperation = /^(Write|Edit|Move)$/.test(toolKind);
      const fileTargetPath = isFileOperation && typeof toolCallUtils.getToolPrimaryPath === 'function'
        ? toolCallUtils.getToolPrimaryPath(toolName, input)
        : '';
      const fileTargetLabel = isFileOperation && typeof toolCallUtils.getToolTargetBasename === 'function'
        ? toolCallUtils.getToolTargetBasename(toolName, input)
        : '';
      const durationLabel = isFileOperation && isRunning && runningStartedAtMs > 0
        ? (typeof toolCallUtils.formatToolElapsedLabel === 'function'
            ? toolCallUtils.formatToolElapsedLabel(Date.now() - runningStartedAtMs)
            : '')
        : (durationMs > 0 ? `${(durationMs / 1000).toFixed(1)}s` : '');
      const callId = normalizeId(source.callId);
      const rowKey = typeof toolCallUtils.buildToolRowKey === 'function'
        ? toolCallUtils.buildToolRowKey({
            sessionId: source.sessionId,
            turnId: source.turnId,
            rowId: source.rowId,
            messageId: source.messageId,
            callId,
          })
        : (normalizeId(source.rowId || source.messageId) || callId);
      const domToken = typeof toolCallUtils.buildToolRowDomToken === 'function'
        ? toolCallUtils.buildToolRowDomToken(rowKey)
        : encodeURIComponent(rowKey || callId || 'unknown');
      /* Status-derived auto-expand wins for action-required states
       * (errored, awaiting_approval, etc.) UNLESS the user has explicitly
       * collapsed this row in the current session. */
      const statusAutoExpand = shouldAutoExpandToolDetails(status);
      const userOverride = getToolCallExpansion(rowKey);
      const defaultExpanded = userOverride === undefined ? statusAutoExpand : userOverride;
      // Status-driven attention rows retain their existing nested-diff default;
      // only an explicit parent expansion opts untouched diffs into opening.
      const expandFileDiffsByDefault = userOverride === true;
      // Mermaid's rendered chart is a primary, always-visible sibling of the
      // disclosure. Its shell must therefore materialize once a result exists
      // even while the source/details remain collapsed.
      const detailsMaterialized = defaultExpanded
        || source.forceMaterializeToolDetails === true
        || ((toolKind === 'mermaid_generate' || toolKind === 'Mermaid') && Boolean(resultMeta));
      const reviewableChange = source.reviewableChange && typeof source.reviewableChange === 'object'
        ? source.reviewableChange
        : null;
      return {
        callId,
        rowKey,
        domToken,
        approvalId: normalizeId(source.approvalId),
        policyScope: source.policyScope,
        policyConsequence: source.policyConsequence,
        reason: source.reason,
        toolName,
        toolKind,
        displayToolName,
        status,
        rawTerminal,
        icon,
        statusLabel,
        isRunning,
        isSettled,
        isFileOperation,
        fileTargetPath,
        fileTargetLabel,
        runningStartedAtMs,
        isPending: status === 'awaiting_approval',
        durationLabel,
        summary: dedupedSummary,
        secondaryMeta: buildToolSecondaryMeta({ status, generatedArtifacts })
          || (typeof toolCallUtils.formatToolResultMeta === 'function' ? toolCallUtils.formatToolResultMeta(toolName, metadata) : ''),
        defaultExpanded,
        expandFileDiffsByDefault,
        detailsMaterialized,
        input,
        inputJson,
        inputExpected,
        inputRecorded: inputExpected && (hasStructuredInput || inputJsonUsable),
        outputText,
        isError,
        resultSummary,
        errorCode,
        // R2-12: the header's one-line failure text for a collapsed failed row.
        failureSummary: typeof toolCallUtils.summarizeToolFailure === 'function'
          ? toolCallUtils.summarizeToolFailure({ isError, status, errorCode, outputText, resultSummary })
          : '',
        retryMessageId: normalizeId(source.retryMessageId),
        metadata,
        generatedArtifacts,
        trustedAttachmentImageUrls,
        reviewableChange,
      };
    }

    function buildLegacyToolCallViewModel(message, allMessages, options) {
      const renderOptions = options || {};
      const tc = message && message.tool_call && typeof message.tool_call === 'object'
        ? message.tool_call
        : {};
      const resultMsg = findToolResultForCallId(allMessages, normalizeId(tc.call_id), {
        ownerMessage: message,
        turnId: renderOptions.turnId,
        turnIdByMessageId: renderOptions.turnIdByMessageId,
      });
      const resultMeta = resultMsg && resultMsg.tool_result ? resultMsg.tool_result : null;
      let status = normalizeToolRenderStatus(tc.status || 'completed');
      if (resultMeta) {
        status = typeof toolCallUtils.statusForToolResult === 'function'
          ? toolCallUtils.statusForToolResult(resultMeta)
          : (isToolResultError(resultMeta) ? 'errored' : 'completed');
      }
      return buildToolCallViewModelFromParts({
        sessionId: renderOptions.sessionId,
        turnId: renderOptions.turnId || message && (message.turn_id || message.turnId),
        rowId: renderOptions.rowId,
        messageId: message && message.id,
        callId: tc.call_id,
        approvalId: tc.approval_id,
        policyScope: tc.policy_scope,
        policyConsequence: tc.policy_consequence,
        reason: tc.reason,
        toolName: tc.tool_name,
        status,
        input: tc.input,
        inputJson: tc.input_json,
        inputExpected: Object.prototype.hasOwnProperty.call(tc, 'input')
          || Object.prototype.hasOwnProperty.call(tc, 'input_json'),
        inputRecorded: Object.prototype.hasOwnProperty.call(tc, 'input')
          || Object.prototype.hasOwnProperty.call(tc, 'input_json'),
        summary: tc.summary,
        resultMeta,
        durationMs: tc.duration_ms,
        runningStartedAtMs: tc.running_started_at_ms,
        retryMessageId: renderOptions.retryMessageId,
        forceMaterializeToolDetails: renderOptions.forceMaterializeToolDetails === true,
      });
    }

    function buildToolCallShapeFromRow(projectedToolRow) {
      const payload = projectedToolRow && typeof projectedToolRow.payload === 'object' && projectedToolRow.payload
        ? projectedToolRow.payload
        : null;
      if (!payload) return null;
      const metadata = payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
        ? payload.metadata
        : null;
      const hasSingularDiff = Boolean(metadata && metadata.diff);
      const hasPluralDiffs = Boolean(metadata && Array.isArray(metadata.diffs) && metadata.diffs.length);
      if (!metadata || (!hasSingularDiff && !hasPluralDiffs)) return null;
      return {
        toolCallId: payload.tool_call_id || projectedToolRow.tool_call_id || '',
        toolName: payload.tool_name || '',
        state: payload.state || 'completed',
        resultIsError: payload.result_is_error === true,
        resultMetadata: metadata,
        input: payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input : {},
        sourceMessageIds: Array.isArray(projectedToolRow.source_message_ids) ? projectedToolRow.source_message_ids : [],
        primaryMessageId: projectedToolRow.primary_message_id || '',
      };
    }

    function resolveReviewableChangeForRow(canonical, projectedToolRow, renderOptions) {
      if (!_jennyChangeLedger || typeof _jennyChangeLedger.normalizeJennyChangeFromToolCall !== 'function') {
        return null;
      }
      const turnId = normalizeId(
        renderOptions && renderOptions.turnId
        || projectedToolRow && projectedToolRow.turn_id
      );
      if (!turnId) return null;
      const toolCallForLedger = canonical || buildToolCallShapeFromRow(projectedToolRow);
      if (!toolCallForLedger) return null;
      if (typeof _jennyChangeLedger.normalizeJennyChangesFromToolCall === 'function') {
        const pluralResult = _jennyChangeLedger.normalizeJennyChangesFromToolCall(toolCallForLedger, { turnId });
        const changes = Array.isArray(pluralResult && pluralResult.changes) ? pluralResult.changes : [];
        if (changes.length > 1) {
          return {
            scope: 'turn',
            turnId,
            changeCount: changes.length,
            toolCallId: normalizeId(toolCallForLedger.toolCallId),
            toolName: normalizeId(toolCallForLedger.toolName),
          };
        }
        if (changes.length === 1) {
          return changes[0];
        }
      }
      const result = _jennyChangeLedger.normalizeJennyChangeFromToolCall(toolCallForLedger, { turnId });
      return result && result.change ? result.change : null;
    }

    function buildToolCallViewModelFromRow(message, allMessages, projectedToolRow, options) {
      const renderOptions = options || {};
      const sourceMessages = collectProjectedToolMessages(
        projectedToolRow,
        allMessages,
        renderOptions.messageById,
        message
      );
      const toolUseMessage = sourceMessages.find((candidate) => candidate && candidate.kind === 'tool_use') || message || {};
      const toolResultMessage = sourceMessages.find((candidate) => candidate && candidate.kind === 'tool_result') || null;
      const toolUse = toolUseMessage.tool_call && typeof toolUseMessage.tool_call === 'object'
        ? toolUseMessage.tool_call
        : {};
      const payload = projectedToolRow && projectedToolRow.payload && typeof projectedToolRow.payload === 'object'
        ? projectedToolRow.payload
        : {};
      const canonical = renderOptions.canonicalToolCall && typeof renderOptions.canonicalToolCall === 'object'
        ? renderOptions.canonicalToolCall
        : null;
      const callId = extractToolCallId({
        toolCallId: canonical && canonical.toolCallId,
        tool_call_id: payload.tool_call_id || projectedToolRow && projectedToolRow.tool_call_id,
        tool_call: toolUse,
      });
      const payloadInput = isPlainObject(payload.input) ? payload.input : null;
      const fallbackToolResultMessage = toolResultMessage || findToolResultForCallId(allMessages, callId, {
        ownerMessage: toolUseMessage,
        turnId: projectedToolRow && projectedToolRow.turn_id,
        turnIdByMessageId: renderOptions.turnIdByMessageId,
      });
      // Prefer canonical state and raw substatus when available so the shell and projector share one authority.
      const canonicalStatus = canonical ? canonical.state : '';
      const canonicalRawTerminal = canonical ? canonical.rawTerminal : '';
      const canonicalResultMetadata = canonical && canonical.resultMetadata && typeof canonical.resultMetadata === 'object' && !Array.isArray(canonical.resultMetadata)
        ? canonical.resultMetadata
        : null;
      const canonicalResultMeta = canonical && canonical.hasResult === true && canonicalResultMetadata
        ? {
            call_id: callId,
            tool_name: (canonical && canonical.toolName) || payload.tool_name || toolUse.tool_name,
            output_text: String(canonical.outputText || payload.output_text || ''),
            summary: String(canonical.resultSummary || payload.result_summary || ''),
            is_error: canonical.resultIsError === true || payload.result_is_error === true,
            error_code: normalizeString(canonical.errorCode || payload.error_code),
            duration_ms: (canonical && canonical.durationMs) || toolUse.duration_ms || 0,
            generated_artifacts: Array.isArray(canonical.generatedArtifacts)
              ? canonical.generatedArtifacts
              : [],
            metadata: { ...canonicalResultMetadata },
          }
        : null;
      const reviewableChange = resolveReviewableChangeForRow(canonical, projectedToolRow, renderOptions);
      const resultMeta = fallbackToolResultMessage && fallbackToolResultMessage.tool_result
        ? fallbackToolResultMessage.tool_result
        : (canonicalResultMeta || buildSyntheticToolResultMeta(projectedToolRow));
      // Defense in depth (mirrors buildLegacyToolCallViewModel): an unmatched
      // projected row can leak a non-terminal status even though a real result
      // exists, so settle it from the result. Resultless tools yield a null
      // resultMeta and are left untouched (a genuine live/interrupted call).
      let resolvedStatus = canonicalStatus || payload.state || toolUse.status;
      if (resultMeta && NON_TERMINAL_RENDER_STATES.has(normalizeToolRenderStatus(resolvedStatus))) {
        resolvedStatus = typeof toolCallUtils.statusForToolResult === 'function'
          ? toolCallUtils.statusForToolResult(resultMeta)
          : (isToolResultError(resultMeta) ? 'errored' : 'completed');
      }
      return buildToolCallViewModelFromParts({
        sessionId: renderOptions.sessionId,
        turnId: projectedToolRow && projectedToolRow.turn_id,
        rowId: projectedToolRow && projectedToolRow.row_id,
        messageId: projectedToolRow && projectedToolRow.primary_message_id || toolUseMessage && toolUseMessage.id,
        callId,
        approvalId: (canonical && canonical.approvalId) || payload.approval_id || payload.approvalId || toolUse.approval_id,
        policyScope: payload.policy_scope || toolUse.policy_scope,
        policyConsequence: payload.policy_consequence || toolUse.policy_consequence,
        reason: payload.reason || toolUse.reason,
        toolName: (canonical && canonical.toolName) || payload.tool_name || toolUse.tool_name,
        displayToolName: canonical ? canonical.toolDisplayName : '',
        status: resolvedStatus,
        rawTerminal: canonicalRawTerminal || normalizeString(payload.raw_terminal),
        input: canonical && canonical.input && Object.keys(canonical.input).length
          ? canonical.input
          : (payloadInput && Object.keys(payloadInput).length ? payloadInput : toolUse.input),
        inputJson: (canonical && canonical.inputJson) || payload.input_json || toolUse.input_json,
        inputExpected: Object.prototype.hasOwnProperty.call(payload, 'input')
          || Object.prototype.hasOwnProperty.call(payload, 'input_json')
          || Object.prototype.hasOwnProperty.call(toolUse, 'input')
          || Object.prototype.hasOwnProperty.call(toolUse, 'input_json'),
        inputRecorded: Object.prototype.hasOwnProperty.call(payload, 'input')
          || Object.prototype.hasOwnProperty.call(payload, 'input_json')
          || Object.prototype.hasOwnProperty.call(toolUse, 'input')
          || Object.prototype.hasOwnProperty.call(toolUse, 'input_json'),
        summary: (canonical && canonical.summary) || payload.summary || toolUse.summary,
        resultMeta,
        durationMs: (canonical && canonical.durationMs) || toolUse.duration_ms,
        runningStartedAtMs: payload.running_started_at_ms || toolUse.running_started_at_ms,
        reviewableChange,
        retryMessageId: renderOptions.retryMessageId,
        forceMaterializeToolDetails: renderOptions.forceMaterializeToolDetails === true,
      });
    }

    function buildToolCallViewModel(message, allMessages, options) {
      const renderOptions = options || {};
      const viewModel = renderOptions.projectedToolRow
        ? buildToolCallViewModelFromRow(
          message,
          allMessages,
          renderOptions.projectedToolRow,
          renderOptions
        )
        : buildLegacyToolCallViewModel(message, allMessages, renderOptions);
      return viewModel;
    }

    function renderToolCallBlock(message, allMessages, options) {
      const viewModel = buildToolCallViewModel(message, allMessages, options);
      if (/^(delegate|subagent_(run|batch))$/.test(viewModel.toolName)
        && typeof subagentView.renderTerminalSummary === 'function') {
        const messageIndex = Array.isArray(allMessages) ? allMessages.indexOf(message) : -1;
        const parentResponding = messageIndex >= 0 && allMessages.slice(messageIndex + 1).some((entry) => (
          String(entry?.role || '').toLowerCase() === 'assistant'
          && Boolean(String(entry?.content || '').trim())
        ));
        const monitorMarkup = subagentView.renderTerminalSummary(viewModel.metadata, {
          key: viewModel.callId,
          toolCallId: viewModel.callId,
          parentResponding,
        });
        if (monitorMarkup) return monitorMarkup;
      }
      const artifactCards = viewModel.generatedArtifacts.length && _artifactCardUtils?.renderArtifactCards
        ? _artifactCardUtils.renderArtifactCards(viewModel.generatedArtifacts, viewModel.callId)
        : '';
      if (!viewModel.detailsMaterialized) {
        return renderToolDisclosureShell(
          viewModel,
          `${renderToolHeader(viewModel)}${renderDeferredToolDetails(viewModel)}`,
          artifactCards
        );
      }
      // Mermaid's asynchronous preview requires its specialized shell; ordinary detail bodies use renderer-tool-detail-body.
      const shellRenderer = /^(mermaid_generate|Mermaid)$/.test(viewModel.toolKind)
        ? getToolShellRenderer()
        : null;
      if (shellRenderer) {
        const shellHtml = shellRenderer.renderToolShell(viewModel);
        if (shellHtml) {
          return renderToolDisclosureShell(viewModel, shellHtml);
        }
      }
      return renderToolDisclosureShell(
        viewModel,
        `${renderToolHeader(viewModel)}${renderToolDetails(viewModel)}`,
        artifactCards
      );
    }

    const instance = {
      buildToolCallViewModel,
      renderToolCallBlock,
      setToolCallExpansion,
      getToolCallExpansion,
      clearToolCallExpansionOverrides,
    };
    transcriptRendererRegistry.add(instance);
    return instance;
  }

  return {
    createTranscriptToolCallRenderer,
    setToolCallExpansion,
    getToolCallExpansion,
    clearToolCallExpansionOverrides,
  };
});
