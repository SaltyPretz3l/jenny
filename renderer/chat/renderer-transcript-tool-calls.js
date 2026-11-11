(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-turn-normalization-utils'),
      require('./renderer-transcript-tool-result-utils'),
      require('./renderer-subagent-monitor-view'),
      require('./renderer-tool-detail-body'),
      require('./renderer-transcript-tool-call-view-model')
    );
    return;
  }
  root.rendererTranscriptToolCallUtils = factory(
    root.rendererTurnNormalizationUtils || {},
    root.rendererTranscriptToolResultUtils || {},
    root.rendererSubagentMonitorView || {},
    root.rendererToolDetailBody || {},
    root.rendererTranscriptToolCallViewModel || {}
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnNormalizationUtils, transcriptToolResultUtils, subagentView, toolDetailBody, toolCallViewModel) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
  const { toolRowKeySessionPrefix } = typeof globalThis !== 'undefined' && globalThis.toolCallUtils
    ? globalThis.toolCallUtils
    : require('./tool-call-utils');
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
  if (typeof toolCallViewModel.createToolCallViewModelBuilder !== 'function') {
    throw new Error('renderer-transcript-tool-call-view-model must load before renderer/chat/renderer-transcript-tool-calls.js');
  }
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
  const _calendarChatBlock = typeof globalThis !== 'undefined' && globalThis.rendererCalendarChatBlock
    ? globalThis.rendererCalendarChatBlock
    : typeof require === 'function' ? require('./renderer-calendar-chat-block') : null;
  // Resolved per render: index.html loads the notes entry after this module.
  const _projectNotesEntry = () => (typeof globalThis !== 'undefined' && globalThis.rendererProjectNotesEntry)
    || (typeof require === 'function' ? require('../features/renderer-project-notes-entry') : null);
  const _reviewFindings = () => (typeof globalThis !== 'undefined' && globalThis.rendererReviewFindings)
    || (typeof require === 'function' ? require('./renderer-review-findings') : null);
  const _memoryChatEntry = () => (typeof globalThis !== 'undefined' && globalThis.rendererMemoryChatEntry)
    || (typeof require === 'function' ? require('../features/renderer-memory-chat-entry') : null);
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
    return purify.sanitize(String(html || ''), toolDetailBody.sanitizeConfig());
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
      clearSession(sessionId) {
        const normalized = normalizeId(sessionId);
        if (!normalized) return;
        const prefix = toolRowKeySessionPrefix(normalized);
        for (const key of Array.from(overrides.keys())) {
          if (key.startsWith(prefix)) overrides.delete(key);
        }
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

  // Transcript view switch: one session's overrides only (row keys carry the
  // session prefix from buildToolRowKey).
  function clearToolCallExpansionOverridesForSession(sessionId) {
    transcriptRendererRegistry.forEach((entry) => entry.clearToolCallExpansionOverridesForSession(sessionId));
  }

  function createTranscriptToolCallRenderer(deps) {
    const {
      escapeHtml,
      toolCallUtils,
      getApprovalCardState,
    } = deps || {};

    /* Per-renderer expansion store. Reads from the override before falling
     * back to the status-derived default in buildToolCallViewModelFromParts. */
    const expansionStore = createExpansionStore();
    let disposed = false;
    function setToolCallExpansion(rowKey, expanded) {
      if (disposed) return;
      expansionStore.set(rowKey, expanded);
    }
    function getToolCallExpansion(rowKey) {
      return expansionStore.get(rowKey);
    }
    function clearToolCallExpansionOverrides() {
      expansionStore.clear();
    }
    function clearToolCallExpansionOverridesForSession(sessionId) {
      expansionStore.clearSession(sessionId);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      transcriptRendererRegistry.delete(instance);
      expansionStore.clear();
      _artifactCardUtils?.releaseInlineImages?.();
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
    const { buildToolCallViewModel } = toolCallViewModel.createToolCallViewModelBuilder({
      toolCallUtils,
      getApprovalCardState,
      getToolCallExpansion,
      extractToolCallId,
      resultUtils: transcriptToolResultUtils,
      changeLedger: _jennyChangeLedger,
      normalizeString,
      normalizeId,
    });
    const detailBodyBuilder = toolDetailBody && typeof toolDetailBody.createToolDetailBody === 'function'
      ? toolDetailBody.createToolDetailBody({
          escapeHtml,
          sanitizeHtmlFragment,
          toolCallUtils,
        })
      : null;

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
        : '<div class="tool-call-empty">' + escapeHtml(jt('chat.toolDetail.noInputOrOutput', 'No input or output recorded.')) + '</div>';
      return renderToolDetailsShell(viewModel, body);
    }

    function renderToolApprovalBlock(viewModel) {
      if (!viewModel.isPending) return '';
      if (!_renderApprovalBlock) return '';
      const approvalLabel = toolCallUtils.getApprovalLabel
        ? toolCallUtils.getApprovalLabel(viewModel.toolName, viewModel.input)
        : jt('chat.toolCalls.approveTool', 'Approve {tool}?', { tool: viewModel.displayToolName || viewModel.toolName || jt('chat.toolCalls.thisTool', 'this tool') });
      return _renderApprovalBlock({
        cardState: viewModel.approvalCard.state,
        resumeKey: viewModel.approvalCard.resumeKey,
        alwaysAllowScope: viewModel.approvalCard.alwaysAllowScope,
        rememberOffer: viewModel.approvalCard.rememberOffer,
        toolCallId: viewModel.callId,
        approvalId: viewModel.approvalId,
        toolName: viewModel.toolName,
        displayToolName: viewModel.displayToolName,
        prompt: approvalLabel,
        policyScope: viewModel.policyScope,
        policyConsequence: viewModel.policyConsequence,
        reason: viewModel.reason,
        oneOffOnly: viewModel.oneOffOnly,
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
      return `
        <div class="tool-call-block${fileOperationClass}" data-call-id="${escapeHtml(viewModel.callId)}" data-tool-row-key="${escapeHtml(viewModel.rowKey)}" data-tool-status="${escapeHtml(viewModel.status)}" data-tool-details-materialized="${viewModel.detailsMaterialized ? 'true' : 'false'}">
          ${contentHtml}
          ${extraHtml || ''}
          ${renderToolApprovalBlock(viewModel)}
        </div>
      `;
    }

    function collectLiveDelegationSteps(allMessages, callId) {
      const key = normalizeString(callId);
      if (!key || !Array.isArray(allMessages)) return [];
      return allMessages.flatMap((entry) => (Array.isArray(entry?.agent_status_steps) ? entry.agent_status_steps : []))
        .filter((step) => normalizeString(step?.toolCallId || step?.tool_call_id) === key);
    }

    function renderToolCallBlock(message, allMessages, options) {
      const viewModel = buildToolCallViewModel(message, allMessages, options);
      if (toolCallUtils.hasPlanDocumentForTool?.(viewModel.toolName, viewModel.callId, allMessages)) return '';
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
        // Still running: the call's own row carries the live summary (the turn's
        // agent_status steps sit on another message that renders no widget here).
        const liveSteps = collectLiveDelegationSteps(allMessages, viewModel.callId);
        const liveMarkup = liveSteps.length && typeof subagentView.renderLiveSummary === 'function'
          ? subagentView.renderLiveSummary(liveSteps, { key: viewModel.callId })
          : '';
        if (liveMarkup) return liveMarkup;
      }
      // Persisted tool_call rows ask for the subagent summary alone and keep
      // their own row markup when the call carries no terminal report.
      if (options && options.subagentSummaryOnly === true) return '';
      const artifactCards = viewModel.generatedArtifacts.length && _artifactCardUtils?.renderArtifactCards
        ? _artifactCardUtils.renderArtifactCards(viewModel.generatedArtifacts, viewModel.callId, { seed: viewModel.metadata?.provenance?.seed, prompt: viewModel.metadata?.provenance?.image_prompt, negativePrompt: viewModel.metadata?.provenance?.image_negative_prompt, promptSource: viewModel.metadata?.provenance?.prompt_source, sessionId: viewModel.sessionId })
        : '';
      const pendingFigure = viewModel.toolName === 'image_generate' && viewModel.isRunning && !viewModel.generatedArtifacts.length
        ? (_artifactCardUtils?.renderImagePendingFigure?.(viewModel.callId, viewModel.input) || '') : '';
      const calendarMarkup = Object.keys(viewModel.metadata).length && _calendarChatBlock
        && typeof _calendarChatBlock.buildHomeResultBlockMarkup === 'function'
        ? _calendarChatBlock.buildHomeResultBlockMarkup(viewModel.metadata, {
          escapeHtml,
          hasLiveJournalEntry: globalThis.rendererCalendarChatBindings?.hasLiveJournalEntry,
        }) : '';
      const notesMarkup = viewModel.metadata?.result_kind === 'project_notes'
        ? _projectNotesEntry()?.buildProjectNotesResultBlockMarkup?.(viewModel.metadata, { escapeHtml }) || ''
        : viewModel.metadata?.result_kind === 'memory' // the memory chip shares the notes row slot
          ? _memoryChatEntry()?.buildMemoryResultBlockMarkup?.(viewModel.metadata, { escapeHtml, sessionId: viewModel.sessionId }) || '' : '';
      const findings = viewModel.toolName === 'report_findings' && !viewModel.isError ? _reviewFindings() : null;
      const findingsMarkup = findings
        ? findings.buildReviewFindingsBlockMarkup(findings.parseReviewFindings(viewModel.outputText), { escapeHtml, toolCallId: viewModel.callId, sessionId: viewModel.sessionId })
        : '';
      if (!viewModel.detailsMaterialized) {
        return renderToolDisclosureShell(
          viewModel,
          `${renderToolHeader(viewModel)}${renderDeferredToolDetails(viewModel)}`,
          calendarMarkup + notesMarkup + findingsMarkup + artifactCards + pendingFigure
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
        calendarMarkup + notesMarkup + findingsMarkup + artifactCards + pendingFigure
      );
    }

    const instance = {
      dispose,
      buildToolCallViewModel,
      renderToolCallBlock,
      setToolCallExpansion,
      getToolCallExpansion,
      clearToolCallExpansionOverrides,
      clearToolCallExpansionOverridesForSession,
    };
    transcriptRendererRegistry.add(instance);
    return instance;
  }

  return {
    createTranscriptToolCallRenderer,
    setToolCallExpansion,
    getToolCallExpansion,
    clearToolCallExpansionOverrides,
    clearToolCallExpansionOverridesForSession,
  };
});
