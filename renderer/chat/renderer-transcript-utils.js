(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTranscriptUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveModule(globalName, requirePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      return require(requirePath);
    }
    return null;
  }

  function createTranscriptRenderer(deps) {
    const attachmentsUtils = resolveModule('rendererTranscriptAttachmentsUtils', './renderer-transcript-attachments');
    const thinkingUtils = resolveModule('rendererTranscriptThinkingUtils', './renderer-transcript-thinking');
    const interactionUtils = resolveModule('rendererTranscriptInteractionsUtils', './renderer-transcript-interactions');
    const toolCallUtils = resolveModule('rendererTranscriptToolCallUtils', './renderer-transcript-tool-calls');
    const actionUtils = resolveModule('rendererTranscriptActionsUtils', './renderer-transcript-actions');

    const attachmentsRenderer = attachmentsUtils?.createTranscriptAttachmentsRenderer?.(deps) || {};
    const thinkingRenderer = thinkingUtils?.createTranscriptThinkingRenderer?.(deps) || {};
    const interactionRenderer = interactionUtils?.createTranscriptInteractionRenderer?.(deps) || {};
    const toolCallRenderer = toolCallUtils?.createTranscriptToolCallRenderer?.(deps) || {};
    const actionRenderer = actionUtils?.createTranscriptActionRenderer?.(deps) || {};

    return {
      renderMessageAttachments: attachmentsRenderer.renderMessageAttachments || (() => ''),
      buildInteractiveRecapViewModel: interactionRenderer.buildInteractiveRecapViewModel || (() => null),
      renderInteractiveRoundRecap: interactionRenderer.renderInteractiveRoundRecap || (() => ''),
      renderProactiveSuggestionBlock: interactionRenderer.renderProactiveSuggestionBlock || (() => ''),
      renderSlashCommandOutput: actionRenderer.renderSlashCommandOutput || (() => ''),
      renderMessageHoverRow: actionRenderer.renderMessageHoverRow || (() => ''),
      renderAgentStatusWidget: thinkingRenderer.renderAgentStatusWidget || (() => ''),
      renderAssistantFailureNotice: thinkingRenderer.renderAssistantFailureNotice || (() => ''),
      renderContextCompactedNotice: thinkingRenderer.renderContextCompactedNotice || (() => ''),
      renderThinkingWidget: thinkingRenderer.renderThinkingWidget || (() => ''),
      renderToolCallBlock: toolCallRenderer.renderToolCallBlock || (() => ''),
      setToolCallExpansion: toolCallRenderer.setToolCallExpansion || (() => {}),
    };
  }

  return {
    createTranscriptRenderer,
  };
});
