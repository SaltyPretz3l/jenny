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
  const normalizedCompletionSource = String(completionSource || '').trim();
  const textChanged = priorText !== authoritativeText;
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
};
