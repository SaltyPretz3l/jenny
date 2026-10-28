function buildToolworkOnlyFallback({ successfulCount, failedCount }) {
  if (failedCount > 0) {
    return [
      `Tool work finished with ${successfulCount} successful and ${failedCount} failed tool result(s),`,
      'but the model did not return a visible final answer. Review the tool results above.',
    ].join(' ');
  }
  return [
    'Tool work completed successfully, but the model did not return a visible final answer.',
    'Review the tool results above.',
  ].join(' ');
}

function logThinkingOnlyCompletion(ctx) {
  ctx.service._emitServiceLog('WARN', 'chat.thinking_only_completion', {
    sessionId: ctx.resolvedSessionId,
    streamId: ctx.streamId,
    model: ctx.model,
    reasoningEntryCount: ctx.reasoningEntries.length,
    fallback: 'error',
    errorCode: ctx.sidecarErrorCode || ctx.reasoningOnlyErrorCode,
  });
}

function recoverToolworkOnlyCompletion(ctx) {
  return applyAuthoritativeTerminalText(
    ctx,
    buildToolworkOnlyFallback({
      successfulCount: ctx.toolResultCounts.successful,
      failedCount: ctx.toolResultCounts.failed,
    }),
    'deterministic_tool_fallback',
    'electron_toolwork_fallback'
  );
}

function applyAuthoritativeTerminalText(
  ctx,
  content,
  completionSource,
  authoritySource
) {
  const authoritativeText = String(content || '');
  if (!authoritativeText.trim()) {
    return false;
  }
  const normalizedAuthority = String(authoritySource || '').trim() || 'terminal';
  if (
    normalizedAuthority === 'rpc_result'
    && ctx.terminalTextAuthoritySource === 'chat_done'
  ) {
    return false;
  }
  const priorText = String(ctx.assistantText || '');
  // The terminal text covers the current generation only. After a
  // tool-boundary persist that no stream_reset followed (the approval-resume
  // path) assistantText still carries the persisted segments -- the
  // renderer's aggregate cursor needs it cumulative -- so the comparison
  // basis is the live slice: the unpersisted tail in currentSegmentText,
  // identical to assistantText on every other path.
  const streamedTail = String(ctx.currentSegmentText || '');
  const normalizedCompletionSource = String(completionSource || '').trim();
  // A turn-ending tool (propose_session, complete_session_handoff) runs no later generation, so
  // chat.done repeats the preamble its tool boundary already persisted as a segment. Nothing is
  // left to show; applying it again stored the same text twice (2026-10-27).
  if (!streamedTail && ctx.hasPersistedSegments && authoritativeText === priorText) {
    ctx.terminalTextAuthoritySource = normalizedAuthority;
    ctx.terminalTextAlreadyPersisted = true;
    ctx.service._emitServiceLog?.('INFO', 'chat.terminal_response_text_already_persisted', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, responseTextLength: authoritativeText.length,
    });
    return true;
  }
  const textChanged = streamedTail !== authoritativeText;
  if (
    priorText
    && textChanged
    && typeof ctx.service._emitServiceLog === 'function'
  ) {
    ctx.service._emitServiceLog('WARN', 'chat.terminal_response_text_mismatch', {
      sessionId: ctx.resolvedSessionId,
      streamId: ctx.streamId,
      model: ctx.model,
      authoritySource: normalizedAuthority,
      priorTextLength: priorText.length,
      streamedTailLength: streamedTail.length,
      responseTextLength: authoritativeText.length,
      completionSource: normalizedCompletionSource,
    });
  }
  ctx.terminalTextAuthoritySource = normalizedAuthority;
  if (
    normalizedCompletionSource === 'deterministic_tool_fallback'
    && priorText.trim()
  ) {
    return false;
  }
  ctx.assistantText = authoritativeText;
  ctx.currentSegmentText = authoritativeText;
  ctx.streamSawText = true;
  if (
    textChanged
    && typeof ctx.transcriptCollector?.replaceVisibleText === 'function'
  ) {
    ctx.transcriptCollector.replaceVisibleText(authoritativeText);
  } else if (ctx.transcriptCollector?.slice?.visibleSegments?.length) {
    ctx.transcriptCollector.turnHasVisibleText = true;
  } else if (typeof ctx.transcriptCollector?.appendText === 'function') {
    ctx.transcriptCollector.appendText(authoritativeText, {});
  }
  return true;
}

// The renderer writes the complete event's content into the bubble after the last tool boundary,
// so text the boundary already persisted (and painted) is not sent again; observers that read
// onVisibleCompletion still get the whole reply.
function rendererCompleteContent(ctx) {
  return ctx.terminalTextAlreadyPersisted === true ? '' : ctx.assistantText;
}

function emitDeterministicCompletion(ctx, content) {
  const normalizedContent = String(content || '').trim();
  if (!normalizedContent) {
    return false;
  }
  ctx.assistantText = normalizedContent;
  ctx.refusedTextSegments = [];
  return ctx.beginVisibleCompletionFinalization();
}

module.exports = {
  applyAuthoritativeTerminalText,
  emitDeterministicCompletion,
  logThinkingOnlyCompletion,
  recoverToolworkOnlyCompletion,
  rendererCompleteContent,
};
