(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelineFallbackMarkupUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createFallbackMarkupPipeline(deps) {
    const { callbacks = {} } = deps || {};
    const { escapeHtml = (value) => String(value || '') } = callbacks;

    function buildFallbackSyntheticRowId(messageId) {
      return `shell:${String(messageId || '').trim()}`;
    }

    function buildFallbackSyntheticRowMarkup(messageId, innerHtml, options) {
      const rowOptions = options || {};
      const rowClassName = String(rowOptions.rowClassName || '').trim();
      const sourceMessageId = String(rowOptions.sourceMessageId || messageId || '').trim();
      const rowId = String(rowOptions.rowId || buildFallbackSyntheticRowId(messageId)).trim();
      return `
        <div
          class="chat-row${rowClassName ? ` ${escapeHtml(rowClassName)}` : ''}"
          data-row-id="${escapeHtml(rowId)}"
          data-source-message-id="${escapeHtml(sourceMessageId)}"
        >
          ${innerHtml}
        </div>
      `;
    }

    function buildFallbackTurnRowListMarkup(rowMarkup) {
      return `
        <div class="turn-row-list" data-turn-row-list="true">
          ${rowMarkup}
        </div>
      `;
    }

    return {
      buildFallbackSyntheticRowId,
      buildFallbackSyntheticRowMarkup,
      buildFallbackTurnRowListMarkup,
    };
  }

  return { createFallbackMarkupPipeline };
});
