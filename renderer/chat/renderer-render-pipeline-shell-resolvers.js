(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineShellResolvers = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createShellResolvers(deps) {
    const { escapeHtml, escapeSelectorValue, turnShellUtils, turnShellRenderer, turnRowRenderer, fallbackMarkupPipelineUtils } = deps || {};

    const resolveVisibleMessageDomTarget = typeof turnShellUtils?.resolveVisibleMessageDomTarget === 'function'
      ? turnShellUtils.resolveVisibleMessageDomTarget
      : function fallbackResolveVisibleMessageDomTarget(container, messageId) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!container || !normalizedMessageId || typeof container.querySelector !== 'function') {
          return null;
        }
        return container.querySelector(
          `[data-message-id="${escapeSelectorValue(normalizedMessageId)}"]`
        );
      };
    const resolveTurnArticleMessageId = typeof turnShellUtils?.resolveTurnArticleMessageId === 'function'
      ? turnShellUtils.resolveTurnArticleMessageId
      : function fallbackResolveTurnArticleMessageId(messageId, projectionContext) {
        const normalizedMessageId = String(messageId || '').trim();
        if (!normalizedMessageId || !projectionContext || typeof projectionContext !== 'object') {
          return normalizedMessageId;
        }
        const turnId = String(projectionContext.turnIdByMessageId?.get?.(normalizedMessageId) || '').trim();
        if (!turnId) {
          return normalizedMessageId;
        }
        const turn = projectionContext.turnById?.get?.(turnId) || null;
        return String(turn?.primary_assistant_message_id || normalizedMessageId).trim() || normalizedMessageId;
      };
    // Template-string fallbacks used when turnShellRenderer or turnRowRenderer cannot provide their primary builders.
    const fallbackMarkupPipeline = fallbackMarkupPipelineUtils.createFallbackMarkupPipeline({
      callbacks: { escapeHtml },
    });
    const {
      buildFallbackSyntheticRowId,
      buildFallbackSyntheticRowMarkup,
      buildFallbackTurnRowListMarkup,
    } = fallbackMarkupPipeline;
    const buildMessageBodyShell = typeof turnShellRenderer?.buildMessageBodyShell === 'function'
      ? turnShellRenderer.buildMessageBodyShell
      : function fallbackBuildMessageBodyShell(messageId, innerHtml, options) {
        return buildFallbackTurnRowListMarkup(buildFallbackSyntheticRowMarkup(messageId, innerHtml, options));
      };
    const buildAssistantContentShell = typeof turnShellRenderer?.buildAssistantContentShell === 'function'
      ? turnShellRenderer.buildAssistantContentShell
      : function fallbackBuildAssistantContentShell(messageId, innerHtml, options) {
        return `
          <div class="chat-message-content">
            ${buildMessageBodyShell(messageId, innerHtml, options)}
          </div>
        `;
      };
    const buildMessageShellArticle = typeof turnShellRenderer?.buildMessageShellArticle === 'function'
      ? turnShellRenderer.buildMessageShellArticle
      : function fallbackBuildMessageShellArticle(options) {
        const shellOptions = options || {};
        const predictedHeight = Number(shellOptions.predictedHeight) || 0;
        const layoutAttributes = predictedHeight > 0
          ? `
            data-predicted-height="${escapeHtml(String(predictedHeight))}"
            style="min-height: ${escapeHtml(String(predictedHeight))}px"
          `
          : '';
        const fallbackAriaLabel = typeof turnShellUtils?.describeMessageRole === 'function'
          ? turnShellUtils.describeMessageRole(shellOptions.messageRole)
          : 'Message';
        // F4/F5/F6: surface selection state on the fallback shell too.
        const fallbackSelectionMode = shellOptions.selectionMode === true;
        const fallbackSelectedAttr = fallbackSelectionMode
          ? ` data-selected="${shellOptions.selected === true ? 'true' : 'false'}"`
          : '';
        return `
          <article
            class="chat-entry message-shell${shellOptions.className ? ` ${escapeHtml(shellOptions.className)}` : ''}"
            data-message-id="${escapeHtml(shellOptions.messageId || '')}"
            data-message-role="${escapeHtml(shellOptions.messageRole || '')}"
            data-message-status="${escapeHtml(shellOptions.messageStatus || '')}"
            data-finalized-at="${escapeHtml(shellOptions.finalizedAt || '')}"${fallbackSelectedAttr}
            tabindex="-1"
            aria-label="${escapeHtml(fallbackAriaLabel)}"
            ${shellOptions.extraAttributes ? String(shellOptions.extraAttributes) : ''}
            ${layoutAttributes}
          >
            ${shellOptions.innerHtml || ''}
          </article>
        `;
      };

    const buildTurnRowId = typeof turnRowRenderer?.buildRowId === 'function'
      ? turnRowRenderer.buildRowId
      : function fallbackBuildTurnRowId(row) {
        return `turn:${String(row?.turn_id || '').trim()}:row:${String(row?.row_id || '').trim()}`;
      };
    const buildTurnRowListMarkup = typeof turnRowRenderer?.buildTurnRowListMarkup === 'function'
      ? turnRowRenderer.buildTurnRowListMarkup
      : function fallbackBuildTurnRowListMarkup(rows, _messages, _options) {
        return buildFallbackTurnRowListMarkup(
          (Array.isArray(rows) ? rows : []).map(function renderRow(row) {
            return buildFallbackSyntheticRowMarkup(
              row?.primary_message_id || row?.row_id || '',
              '',
              {
                rowId: buildTurnRowId(row),
                sourceMessageId: row?.primary_message_id,
              }
            );
          }).join('')
        );
      };

    return {
      resolveVisibleMessageDomTarget,
      resolveTurnArticleMessageId,
      buildMessageBodyShell,
      buildAssistantContentShell,
      buildMessageShellArticle,
      buildTurnRowId,
      buildTurnRowListMarkup,
    };
  }

  return { createShellResolvers };
});
