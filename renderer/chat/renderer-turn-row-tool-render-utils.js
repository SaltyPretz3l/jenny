(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-turn-elapsed-clock'));
    return;
  }
  root.rendererTurnRowToolRenderUtils = factory(root.rendererTurnElapsedClock || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (turnElapsedClockUtils) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const formatElapsedLabel = turnElapsedClockUtils.formatElapsedLabel;

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  // Split out of this module; index.html loads each just before it.
  const mermaidFallback = (typeof globalThis !== 'undefined' && globalThis.rendererTurnRowMermaidFallback)
    || (typeof require === 'function' ? require('./renderer-turn-row-mermaid-fallback') : null);
  const approvalGapMarkup = (typeof globalThis !== 'undefined' && globalThis.rendererTurnRowApprovalGapMarkup)
    || (typeof require === 'function' ? require('./renderer-turn-row-approval-gap-markup') : null);
  const toolRowExpansionState = (typeof globalThis !== 'undefined' && globalThis.rendererToolRowExpansionState)
    || (typeof require === 'function' ? require('./renderer-tool-row-expansion-state') : null);

  function fallbackNormalizeId(value) {
    return String(value || '').trim();
  }

  function fallbackFormatDurationMs() {
    return '';
  }

  // Resolved per call: tests install a global after this module loads; in the
  // app tool-call-utils is always loaded first (index.html order).
  function sharedToolCallUtils() {
    return (typeof globalThis !== 'undefined' && globalThis.toolCallUtils) || require('./tool-call-utils');
  }

  // Canonical labels come from tool-call-utils so trace-row and block-family
  // labels cannot diverge; a command that exited non-zero reads "exit N".
  function getToolStatusLabel(status, normalizeId, result) {
    const normalize = typeof normalizeId === 'function' ? normalizeId : fallbackNormalizeId;
    const normalizedStatus = normalize(status).toLowerCase();
    const toolCallUtils = sharedToolCallUtils();
    return result
      ? toolCallUtils.getResultStatusLabel(normalizedStatus, result)
      : toolCallUtils.getStatusLabel(normalizedStatus);
  }

  const toolDetailBody = (typeof globalThis !== 'undefined' && globalThis.rendererToolDetailBody)
    || (typeof require === 'function' ? require('./renderer-tool-detail-body') : null);
  const calendarChatBlock = (typeof globalThis !== 'undefined' && globalThis.rendererCalendarChatBlock)
    || (typeof require === 'function' ? require('./renderer-calendar-chat-block') : null);
  // Resolved per render: index.html loads the notes entry after this module.
  const projectNotesEntry = () => (typeof globalThis !== 'undefined' && globalThis.rendererProjectNotesEntry)
    || (typeof require === 'function' ? require('../features/renderer-project-notes-entry') : null);
  const memoryChatEntry = () => (typeof globalThis !== 'undefined' && globalThis.rendererMemoryChatEntry)
    || (typeof require === 'function' ? require('../features/renderer-memory-chat-entry') : null);
  const reviewFindingsModule = () => (typeof globalThis !== 'undefined' && globalThis.rendererReviewFindings)
    || (typeof require === 'function' ? require('./renderer-review-findings') : null);
  const messageStrip = () => (typeof globalThis !== 'undefined' && globalThis.rendererComposerMessageStrip)
    || (typeof require === 'function' ? require('./renderer-composer-message-strip') : null);
  const testSummary = () => (typeof globalThis !== 'undefined' && globalThis.rendererToolTestSummary)
    || (typeof require === 'function' ? require('./renderer-tool-test-summary') : null);

  function getToolStatusSeverity(status) {
    return sharedToolCallUtils().getToolStatusSeverity(status);
  }

  const OUTCOME_SEVERITY = Object.freeze({
    failure: 'danger',
    interrupted: 'caution',
    stopped: 'calm',
  });

  // Classify an errored tool result into one of three outcomes from its
  // error_code + status, so denied/cancelled don't read as crashes.
  function classifyToolResultOutcome(payload) {
    return sharedToolCallUtils().classifyToolResultOutcome(payload);
  }

  // The granular call status to use when a paired/standalone result is an
  // error: prefer an explicit terminal verdict, else derive from the outcome
  // so getToolStatusLabel/Severity produce the right badge + rail (a denied
  // tool reads "Denied"/calm, not "Errored"/danger).
  function erroredStatusForResult(payload) {
    return sharedToolCallUtils().statusForToolResult(payload);
  }

  // Statuses that open the minimal tool row's detail body by default: the
  // user needs to see what went wrong / what is being asked without a click.
  const TOOL_ROW_TERMINAL_VERDICTS = new Set([
    'denied', 'cancelled', 'blocked', 'timed_out', 'abandoned',
  ]);

  // User expand/collapse overrides and lazy detail contexts, module-scoped so
  // they survive the streaming pipeline's per-delta full re-renders.
  const {
    registerToolDetailContext,
    materializeToolRowDetails,
    setToolRowExpansion,
    getToolRowExpansion,
    clearToolRowExpansionOverrides,
    clearToolRowExpansionOverridesForSession,
  } = toolRowExpansionState.createToolRowExpansionState();

  function createTurnRowToolRenderUtils(deps) {
    const settings = deps || {};
    const toolCallUtils = sharedToolCallUtils();
    const resolveProjectedRowCallId = toolCallUtils.resolveProjectedRowCallId;
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
    const { buildMermaidFallbackBlockMarkup } = mermaidFallback.createMermaidFallbackRenderer({ escapeHtml, normalizeId });
    const { buildApprovalGapMarkup, readApprovalCardState } = approvalGapMarkup.createApprovalGapMarkup({
      settings, toolCallUtils, normalizeId, escapeHtml, renderApprovalBlock, resolveProjectedRowCallId,
    });

    // W1-4: render the summary's path portion as an inline open-in-IDE chip.
    // The chip carries the forward-slash-normalized path (what the IDE and
    // workspace-fs speak) while displaying the summary's original text; when
    // the summary doesn't literally contain the path (e.g. truncated), the
    // summary renders unchipped — the row-level data-chat-path context menu
    // still covers those.
    function buildSummaryParts(rowSummary, primaryPath, chipPath, pathTarget) {
      const summary = String(rowSummary || '');
      const path = String(primaryPath || '');
      const kindAttr = pathTarget && pathTarget.kind ? ` data-chat-path-kind="${escapeHtml(pathTarget.kind)}"` : '';
      const chipMarkup = `<span class="tool-path-chip" role="link" tabindex="0" data-chat-path-open="${escapeHtml(chipPath)}"${kindAttr} title="${escapeHtml(jt('chat.toolRow.openInIde', 'Open {path} in the IDE', { path: chipPath }))}">${escapeHtml(path)}</span>`;
      if (!path || !chipPath) {
        return { summaryText: summary, summaryMarkup: escapeHtml(summary), pathMarkup: '' };
      }
      const index = summary.indexOf(path);
      if (index === -1) {
        // Glob/grep summaries name the pattern, not the directory: the chip follows the summary.
        return { summaryText: summary, summaryMarkup: escapeHtml(summary), pathMarkup: pathTarget && pathTarget.appendChip ? chipMarkup : '' };
      }
      const surroundingSummary = `${summary.slice(0, index)} ${summary.slice(index + path.length)}`
        .replace(/\s+/g, ' ')
        .trim();
      return {
        summaryText: surroundingSummary,
        summaryMarkup: escapeHtml(surroundingSummary),
        pathMarkup: chipMarkup,
      };
    }

    // The row's "Review changes" target through the change ledger; null when
    // the ledger is not loaded or the call changed nothing reviewable.
    function resolveReviewableChange(toolCall, turnId) {
      const ledger = (typeof globalThis !== 'undefined' && globalThis.rendererJennyChangeLedger)
        || (typeof require === 'function' ? require('./renderer-jenny-change-ledger') : null);
      return ledger && typeof ledger.resolveReviewableChange === 'function'
        ? ledger.resolveReviewableChange(toolCall, { turnId }) : null;
    }

    // Generated images render as the inline figure (open / save / copy /
    // reveal) the classic tool shell shows; settled rows take this minimal
    // path, so without it an image never shows in the timeline (GIP-1).
    // Other artifacts keep their teaser card. Resolved per call: the card
    // utils may load after this module.
    function resolveArtifactCardUtils() {
      if (settings.artifactCardUtils && typeof settings.artifactCardUtils.renderArtifactCards === 'function') {
        return settings.artifactCardUtils;
      }
      if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactCardUtils) {
        return globalThis.rendererArtifactCardUtils;
      }
      if (typeof require === 'function') {
        try { return require('./renderer-artifact-card-utils'); } catch (_error) { /* not available */ }
      }
      return null;
    }

    function buildResultArtifactsMarkup(artifacts, callId, figureOptions) {
      const list = Array.isArray(artifacts) ? artifacts : [];
      const isImage = (artifact) => String(artifact?.artifact_kind || '').trim().toLowerCase() === 'image';
      const images = list.filter(isImage);
      const cardUtils = images.length ? resolveArtifactCardUtils() : null;
      const figuresMarkup = cardUtils && typeof cardUtils.renderArtifactCards === 'function'
        ? cardUtils.renderArtifactCards(images, callId, figureOptions)
        : '';
      const teasers = figuresMarkup ? list.filter((artifact) => !isImage(artifact)) : list;
      return figuresMarkup + teasers.map((artifact) => renderArtifactTeaser(artifact)).join('');
    }

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
      const toolName = String(payload.tool_name || jt('chat.toolRow.toolCall', 'Tool call'));
      if (toolCallUtils?.hasPlanDocumentForTool(toolName, toolCallId, messages)) return '';
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
      const pathTarget = toolCallUtils && typeof toolCallUtils.getToolPathTarget === 'function'
        ? toolCallUtils.getToolPathTarget(toolName, summaryInput)
        : null;
      const primaryPath = pathTarget ? String(pathTarget.path || '') : '';
      const chipPath = primaryPath.replace(/\\/g, '/');
      // data-chat-path-kind="dir" is the interface with renderer-chat-path-open (omitted when the kind is unknown).
      const chatPathAttr = chipPath ? ` data-chat-path="${escapeHtml(chipPath)}"${pathTarget.kind ? ` data-chat-path-kind="${escapeHtml(pathTarget.kind)}"` : ''}` : '';
      const summaryParts = buildSummaryParts(rowSummary, primaryPath, chipPath, pathTarget);
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
      // A4: the header says Paused or Withdrawn, muted, when the runtime no
      // longer waits on the approval (display only; the row keeps its status).
      const approvalCardState = statusKey === 'awaiting_approval' || statusKey === 'pending_approval'
        ? readApprovalCardState(row, toolCallId, renderOptions) : null;
      const headerStatus = { paused: 'paused', inactive: 'withdrawn' }[approvalCardState && approvalCardState.state] || status;
      const statusAutoExpand = toolCallUtils && typeof toolCallUtils.shouldAutoExpandToolDetails === 'function'
        ? toolCallUtils.shouldAutoExpandToolDetails(statusKey, { transcriptView: renderOptions.transcriptView })
        : false;
      const userOverride = getToolRowExpansion(rowKey);
      const expanded = userOverride === undefined ? statusAutoExpand : userOverride === true;
      const detailsMaterialized = expanded || renderOptions.forceMaterializeToolDetails === true;
      // The component preservation registry keys a row's expansion state by
      // this view: a view switch renders new defaults that must not be
      // overwritten by the old row's state when the morph restores it.
      const transcriptViewAttr = renderOptions.transcriptView
        ? ` data-transcript-view="${escapeHtml(String(renderOptions.transcriptView))}"` : '';
      const bodyId = `${domToken}-body`;
      const ariaBusy = status === 'running' ? ' aria-busy="true"' : '';
      const hasResultAttr = resultPayload ? ' data-has-result="true"' : '';
      const severity = getToolStatusSeverity(status);
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
        // The stored result message holds the full metadata; the projected row
        // keeps a bounded subset, so it refines the message's, never shadows it.
        metadata: (() => {
          const isPlain = (value) => value && typeof value === 'object' && !Array.isArray(value);
          const rowMetadata = isPlain(resultPayload?.metadata) ? resultPayload.metadata : null;
          const messageMetadata = isPlain(canonicalResult?.metadata) ? canonicalResult.metadata : null;
          if (!rowMetadata || !messageMetadata) return rowMetadata || messageMetadata || {};
          return { ...messageMetadata, ...rowMetadata };
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
        trustedAttachmentImages: toolCallUtils
          && typeof toolCallUtils.getTrustedToolResultImages === 'function'
          ? toolCallUtils.getTrustedToolResultImages(resultPayload)
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
        ? buildResultArtifactsMarkup(resultPayload.generated_artifacts, toolCallId, {
          seed: detailModel.metadata?.provenance?.seed,
          prompt: detailModel.metadata?.provenance?.image_prompt,
          negativePrompt: detailModel.metadata?.provenance?.image_negative_prompt,
          promptSource: detailModel.metadata?.provenance?.prompt_source,
          sessionId: detailModel.sessionId,
        })
        : '';
      const calendarBlockMarkup = resultPayload && calendarChatBlock
        && typeof calendarChatBlock.buildHomeResultBlockMarkup === 'function'
        ? calendarChatBlock.buildHomeResultBlockMarkup(resultPayload.metadata, {
          escapeHtml,
          // Resolved per render: the bindings module owns the live-journal set.
          hasLiveJournalEntry: globalThis.rendererCalendarChatBindings?.hasLiveJournalEntry,
        }) : '';
      const notesBlockMarkup = !resultPayload ? ''
        : detailModel.metadata.result_kind === 'project_notes'
          ? projectNotesEntry()?.buildProjectNotesResultBlockMarkup?.(detailModel.metadata, { escapeHtml }) || ''
          : detailModel.metadata.result_kind === 'memory' // the memory chip shares the notes row slot
            ? memoryChatEntry()?.buildMemoryResultBlockMarkup?.(detailModel.metadata, { escapeHtml, sessionId: detailModel.sessionId }) || ''
            // Option C: a sent message's receipt lives on its own row (the strip paints it live).
            : detailModel.metadata.result_kind === 'session_message'
              ? messageStrip()?.conversationReceiptMarkup?.(detailModel.metadata, { escapeHtml }) || '' : '';
      // Row 64: a report_findings result renders its findings list beside the header.
      const reviewFindings = resultPayload && !resultBodyIsError && normalizeId(toolName) === 'report_findings' ? reviewFindingsModule() : null;
      const reviewFindingsMarkup = reviewFindings
        ? reviewFindings.buildReviewFindingsBlockMarkup(reviewFindings.parseReviewFindings(detailModel.outputText), {
          escapeHtml, toolCallId, sessionId: detailModel.sessionId, domToken,
        }) : '';
      const displayToolName = toolCallUtils && typeof toolCallUtils.getToolDisplayName === 'function'
        ? toolCallUtils.getToolDisplayName(toolName, payload.tool_display_name)
        : toolName;
      const isFileOperation = /^(Write|Edit|Move)$/.test(detailModel.toolKind);
      const isRunning = statusKey === 'running' || statusKey === 'executing';
      // F30: a running image render shows its developing figure (with Stop)
      // beside the header, outside the inert body; the result render replaces
      // it with the real figure.
      const pendingImageFigureMarkup = isRunning && !resultPayload && normalizeId(toolName) === 'image_generate'
        ? (resolveArtifactCardUtils()?.renderImagePendingFigure?.(toolCallId, summaryInput) || '')
        : '';
      // Row 96: a finished test command keeps its record (skipped, the folded grid, failures) beside the header.
      const testSummaryMarkup = resultPayload ? (testSummary()?.renderFinished?.(toolName, detailModel.metadata) || '') : '';
      const fileOperationClass = isFileOperation
        ? ` tool-call-file-operation${isRunning ? ' tool-call-file-composing' : (toolCallUtils.isFileOperationSettledStatus(status) ? ' tool-call-file-settled' : '')}`
        : '';
      // A settled non-specialized row (a suggestion, a script, a move) renders
      // here, not in the tool shell, so it carries its own review affordance.
      const reviewTurnId = normalizeId(row && row.turn_id);
      const reviewableChange = normalizeId(toolName) === 'propose_change'
        ? (resultPayload && !resultBodyIsError && detailModel.metadata.suggested_change && reviewTurnId && toolCallId
          ? { scope: 'suggested', turnId: reviewTurnId, toolCallId } : null)
        : resolveReviewableChange({ toolCallId, toolName, state: status, resultIsError: resultBodyIsError,
          resultMetadata: detailModel.metadata, input: summaryInput }, reviewTurnId);
      const headerInner = toolCallUtils.buildToolHeaderInner({
        displayToolName,
        reviewableChange,
        lineCounts: toolCallUtils.getToolLineCounts(toolName, detailModel.metadata, status, resultBodyIsError),
        summary: rowSummary === displayToolName ? '' : rowSummary,
        status: headerStatus,
        isRunning,
        isFileOperation,
        icon: toolCallUtils.getToolIcon(toolName),
        statusLabel: headerStatus === 'paused' ? jt('approval.block.paused', 'Paused')
          : (headerStatus === 'withdrawn' ? jt('chat.toolCall.withdrawn', 'Withdrawn')
            : getToolStatusLabel(status, normalizeId, { exit_code: resultPayload?.exit_code, metadata: detailModel.metadata })),
        // R2-12: a failed row stays collapsed, so its own failure text
        // rides in the header as one bounded line.
        failureSummary: resultBodyIsError
          ? toolCallUtils.summarizeToolFailure({
              isError: true,
              status,
              errorCode: detailModel.errorCode,
              outputText: detailModel.outputText,
              resultSummary: detailModel.resultSummary,
              metadata: detailModel.metadata,
            })
          : '',
        durationLabel: liveElapsedAttrs ? liveElapsedSeedLabel : durationLabel,
        secondaryMeta: testSummary()?.headerMeta?.(toolName, detailModel.metadata) || toolCallUtils.formatToolResultMeta(toolName, detailModel.metadata),
      }, {
        escapeHtml,
        renderReviewChangesAffordance(change) {
          const affordance = globalThis.rendererCodeReviewAffordance
            || (typeof require === 'function' ? require('./renderer-code-review-affordance') : null);
          return change && affordance?.renderReviewChangesAffordance?.(change, { escapeHtml }) || '';
        },
        renderIcon(icon, model) {
          return model.isFileOperation && icon
            ? `<span class="tool-call-file-icon" aria-hidden="true">${icon}</span>` : '';
        },
        // An empty summary is the header's dedupe (it equalled the tool name).
        renderSummary: function renderSummary(summary) {
          if (!summary) return '';
          // Once the path moves into its chip, "Edit test.py" leaves "Edit",
          // which read "Edit Edit" beside the name. The span stays (empty) as
          // the live tool patcher's target for the result summary.
          const summaryMarkup = summaryParts.summaryText === displayToolName ? '' : summaryParts.summaryMarkup;
          return `<span class="tool-call-summary tool-call-row-summary">${summaryMarkup}</span>`;
        },
        renderDuration: function renderDuration(label) {
          return label
            ? ` <span class="tool-result-duration"${liveElapsedAttrs}>${escapeHtml(label)}</span>`
            : '';
        },
      });
      // CMP-TOOL-0047 (PDF reading add-on missing): one quiet link, a sibling of
      // the header so it stays visible on the collapsed row. The transcript's
      // data-inv-error-action delegate opens Settings > Tools at the add-on.
      const pdfAddonLinkMarkup = resultBodyIsError && detailModel.errorCode === 'CMP-TOOL-0047'
        ? `<div class="tool-call-row-action"><span class="tool-call-row-link" role="link" tabindex="0" data-inv-error-action="open_pdf_addon_settings">${escapeHtml(jt('chat.toolRow.setUpPdfReading', 'Set up PDF reading'))}</span></div>`
        : '';
      // TR-008: the turn's first per-chat budget block (the sidecar flags one
      // per turn) offers the existing start_new_session recovery action.
      const sessionBudgetLinkMarkup = resultBodyIsError
        && detailModel.metadata.session_budget_notice === true
        && typeof toolCallUtils?.isSessionToolBudgetBlock === 'function'
        && toolCallUtils.isSessionToolBudgetBlock(detailModel)
        ? `<div class="tool-call-row-action"><span class="tool-call-row-link" role="link" tabindex="0" data-inv-error-action="start_new_session">${escapeHtml(jt('chat.errorRecovery.startNewSession', 'Start new session'))}</span></div>`
        : '';
      // A row that shows content beside its header (banner, action link, chip,
      // calendar block, diagram, artifact) never folds into an Answers tool run.
      const runFoldableAttr = renderOptions.transcriptView === 'answers' && [markerBannerMarkup, pdfAddonLinkMarkup, sessionBudgetLinkMarkup,
        calendarBlockMarkup, notesBlockMarkup, reviewFindingsMarkup, mermaidFallbackMarkup, artifactTeasersMarkup, pendingImageFigureMarkup, testSummaryMarkup].some((part) => String(part || '').trim())
        ? ' data-run-foldable="false"' : '';
      return `
        ${markerBannerMarkup}
        <div class="tool-call-row tool-call-row--minimal${fileOperationClass}" data-tool-call-id="${escapeHtml(toolCallId)}" data-tool-row-key="${escapeHtml(rowKey)}" data-tool-status="${escapeHtml(status)}" data-is-error="${resultBodyIsError ? 'true' : 'false'}"${severityAttr}${chatPathAttr}${transcriptViewAttr}${runFoldableAttr} data-expanded="${expanded ? 'true' : 'false'}" data-tool-details-materialized="${detailsMaterialized ? 'true' : 'false'}"${ariaBusy}${hasResultAttr}>
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
          ${pdfAddonLinkMarkup}${sessionBudgetLinkMarkup}${calendarBlockMarkup}${notesBlockMarkup}${reviewFindingsMarkup}
          ${mermaidFallbackMarkup}
          ${artifactTeasersMarkup}${pendingImageFigureMarkup}${testSummaryMarkup}
          <div class="tool-call-row-body" id="${escapeHtml(bodyId)}"${expanded ? '' : ' inert'}>
            ${detailBodyMarkup}
          </div>
        </div>
      `;
    }

    // Standalone result row — only reached for ORPHAN results (no tool_call
    // row with the same call id in the bucket). Paired results render inside
    // the call card via buildToolCallRowMarkup(options.pairedToolResultRow).
    function buildToolResultRowMarkup(row, _messages, options) {
      const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
      const toolCallId = resolveProjectedRowCallId(row);
      if (toolCallUtils?.hasPlanDocumentForTool(payload.tool_name, toolCallId, _messages)) return '';
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
        trustedAttachmentImages: toolCallUtils
          && typeof toolCallUtils.getTrustedToolResultImages === 'function'
          ? toolCallUtils.getTrustedToolResultImages(payload)
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
    clearToolRowExpansionOverridesForSession,
    materializeToolRowDetails,
  };
});
