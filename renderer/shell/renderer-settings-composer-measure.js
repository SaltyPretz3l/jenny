/* renderer/shell/renderer-settings-composer-measure.js - Composer input-height + model-select width measurement, extracted from renderer-settings-utils.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsComposerMeasure = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createComposerMeasure(deps) {
    const {
      state,
      composerLayoutRuntime,
      chatInput,
      composerModelSelect,
      updateComposerSafeOffset,
    } = deps || {};

    function syncComposerInputHeight() {
      if (!chatInput) {
        return;
      }
      const minHeight = 28;
      const maxHeight = 144;
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (_pretextUtils && _pretextUtils.isEnabled(state)) {
        const pretextFont = _pretextUtils.resolveFontString(chatInput);
        const pretextWidth = chatInput.clientWidth;
        if (pretextFont && pretextWidth > 0) {
          const predicted = _pretextUtils.predictTextHeight(
            'composer', chatInput.value, pretextFont, pretextWidth, 15 * 1.55,
            { whiteSpace: 'pre-wrap' }
          );
          if (predicted) {
            const predictedHeight = Math.min(Math.max(Math.ceil(predicted.height), minHeight), maxHeight);
            chatInput.style.height = predictedHeight + 'px';
            chatInput.style.overflowY = predicted.height > maxHeight ? 'auto' : 'hidden';
            if (typeof updateComposerSafeOffset === 'function') {
              updateComposerSafeOffset({ force: true, syncViewport: true });
            }
            return;
          }
        }
      }
      chatInput.style.height = '0px';
      // Capture the raw content height while the box is collapsed; basing the
      // overflow decision on this pre-clamp measurement avoids relying on
      // scrollHeight after the height has been pinned to maxHeight.
      const rawHeight = chatInput.scrollHeight;
      const nextHeight = Math.min(Math.max(rawHeight, minHeight), maxHeight);
      chatInput.style.height = `${nextHeight}px`;
      chatInput.style.overflowY = rawHeight > maxHeight ? 'auto' : 'hidden';
      if (typeof updateComposerSafeOffset === 'function') {
        updateComposerSafeOffset({
          force: true,
          syncViewport: true,
        });
      }
    }

    function doMeasureInlineTextWidth(element, text) {
      if (!element) return 0;
      const label = String(text || '').trim();
      if (!label) return 0;
      if (!composerLayoutRuntime.measureCanvas) {
        composerLayoutRuntime.measureCanvas = document.createElement('canvas');
        composerLayoutRuntime.measureContext = composerLayoutRuntime.measureCanvas.getContext('2d');
      }
      const context = composerLayoutRuntime.measureContext;
      if (!context) return label.length * 8;
      const computedStyle = window.getComputedStyle(element);
      const fontStyle = computedStyle.fontStyle || 'normal';
      const fontVariant = computedStyle.fontVariant || 'normal';
      const fontWeight = computedStyle.fontWeight || '400';
      const fontSize = computedStyle.fontSize || '13px';
      const fontFamily = computedStyle.fontFamily || 'sans-serif';
      context.font = `${fontStyle} ${fontVariant} ${fontWeight} ${fontSize} ${fontFamily}`;
      return context.measureText(label).width;
    }

    function doSyncComposerModelSelectWidth() {
      if (!composerModelSelect) return;
      /* The model picker owns the pill label; keep this caller-facing shim. */
      globalThis.rendererComposerModelPicker?.instance?.syncPill?.();
    }

    return {
      syncComposerInputHeight,
      measureInlineTextWidth: doMeasureInlineTextWidth,
      syncComposerModelSelectWidth: doSyncComposerModelSelectWidth,
    };
  }

  return { createComposerMeasure };
});
