(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTranscriptToolCallViewModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };

  /*
   * Tool-call view model for renderer-transcript-tool-calls.js: folds a tool_use message, its
   * result and (optionally) a projected tool row into the one record the transcript renderer
   * draws from. Pure derivation; the per-renderer expansion lookup and approval-card state are
   * injected so the record stays identical to the one built inline before the split.
   */
  function createToolCallViewModelBuilder(deps) {
    const {
      toolCallUtils,
      getApprovalCardState,
      getToolCallExpansion,
      extractToolCallId,
      resultUtils,
      changeLedger: _jennyChangeLedger,
      normalizeString,
      normalizeId,
    } = deps;
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
    } = resultUtils;

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

    function shouldAutoExpandToolDetails(status, options) {
      return typeof toolCallUtils.shouldAutoExpandToolDetails === 'function'
        ? toolCallUtils.shouldAutoExpandToolDetails(status, options)
        : false;
    }

    function buildToolSecondaryMeta(viewModel) {
      if (viewModel.status === 'awaiting_approval') {
        return jt('chat.toolCalls.actionNeeded', 'Action needed');
      }
      if (viewModel.status === 'errored') {
        return jt('chat.toolCalls.reviewFailureDetails', 'Review failure details');
      }
      if (viewModel.status === 'denied') {
        return jt('chat.toolCalls.requestBlocked', 'Request blocked');
      }
      if (viewModel.status === 'timed_out') {
        return jt('chat.toolCalls.executionTimedOut', 'Execution timed out');
      }
      if (viewModel.status === 'cancelled') {
        return jt('chat.toolCalls.requestCancelled', 'Request cancelled');
      }
      if (viewModel.status === 'interrupted') {
        return jt('chat.toolCalls.waitingToResume', 'Waiting to resume');
      }
      if (viewModel.status === 'abandoned') {
        return jt('chat.toolCalls.noResultRecorded', 'No result recorded');
      }
      if (viewModel.status === 'approved') {
        return jt('chat.toolCalls.queuedToRun', 'Queued to run');
      }
      const artifactCount = Array.isArray(viewModel.generatedArtifacts) ? viewModel.generatedArtifacts.length : 0;
      if (artifactCount > 0) {
        return jtn('chat.toolCalls.artifactsGenerated', artifactCount, { count: artifactCount }, '1 artifact generated', '{count} artifacts generated');
      }
      return '';
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
      // A4: a pending approval the runtime no longer waits on reads Paused or
      // Withdrawn, not "Action needed" (display only; the status stays).
      const approvalCard = (status === 'awaiting_approval' && typeof getApprovalCardState === 'function'
        && getApprovalCardState({ sessionId: source.sessionId, turnId: source.turnId, callId: source.callId })) || {};
      const approvalCardLabel = { paused: jt('approval.block.paused', 'Paused'), inactive: jt('chat.toolCall.withdrawn', 'Withdrawn') }[approvalCard.state];
      const resultMeta = source.resultMeta && typeof source.resultMeta === 'object' ? source.resultMeta : null;
      // A command that exited non-zero reads "exit N" (the result carries the code).
      const statusLabel = approvalCardLabel
        || (resultMeta && toolCallUtils.getResultStatusLabel ? toolCallUtils.getResultStatusLabel(status, resultMeta)
          : (toolCallUtils.getStatusLabel ? toolCallUtils.getStatusLabel(status) : status));
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
      const trustedAttachmentImages = typeof toolCallUtils.getTrustedToolResultImages === 'function'
        ? toolCallUtils.getTrustedToolResultImages(resultMeta)
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
        : toolCallUtils.formatToolDurationMs(durationMs);
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
      const statusAutoExpand = shouldAutoExpandToolDetails(status, { transcriptView: source.transcriptView });
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
        sessionId: normalizeId(source.sessionId),
        rowKey,
        domToken,
        approvalId: normalizeId(source.approvalId),
        policyScope: source.policyScope,
        policyConsequence: source.policyConsequence,
        reason: source.reason,
        oneOffOnly: source.oneOffOnly === true,
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
        approvalCard,
        durationLabel,
        summary: dedupedSummary,
        lineCounts: toolCallUtils.getToolLineCounts(toolName, metadata, status, isError),
        secondaryMeta: (approvalCardLabel ? '' : buildToolSecondaryMeta({ status, generatedArtifacts }))
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
        trustedAttachmentImages,
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
        oneOffOnly: tc.one_off_only === true,
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
        transcriptView: renderOptions.transcriptView,
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
      if (!metadata || (!hasSingularDiff && !hasPluralDiffs && !metadata.suggested_change)) return null;
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
      if (!_jennyChangeLedger || typeof _jennyChangeLedger.resolveReviewableChange !== 'function') {
        return null;
      }
      const turnId = normalizeId(
        renderOptions && renderOptions.turnId
        || projectedToolRow && projectedToolRow.turn_id
      );
      if (!turnId) return null;
      const toolCallForLedger = canonical || buildToolCallShapeFromRow(projectedToolRow);
      if (!toolCallForLedger) return null;
      // Propose mode (row 35): a recorded suggestion opens the suggested changes, not a diff of written files.
      if (normalizeId(toolCallForLedger.toolName) === 'propose_change') {
        const recorded = toolCallForLedger.resultIsError !== true && toolCallForLedger.resultMetadata
          && toolCallForLedger.resultMetadata.suggested_change;
        return recorded ? { scope: 'suggested', turnId, toolCallId: normalizeId(toolCallForLedger.toolCallId) } : null;
      }
      return _jennyChangeLedger.resolveReviewableChange(toolCallForLedger, { turnId });
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
        oneOffOnly: payload.one_off_only === true || toolUse.one_off_only === true,
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
        transcriptView: renderOptions.transcriptView,
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

    return { buildToolCallViewModel };
  }

  return { createToolCallViewModelBuilder };
});
