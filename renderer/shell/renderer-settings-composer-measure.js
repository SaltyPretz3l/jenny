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
      updateComposerSafeOffset,
    } = deps || {};

    // The predicted height when text prediction is on and can answer, else null.
    function predictedInputHeight() {
      const _pretextUtils = typeof rendererPretextUtils !== 'undefined' ? rendererPretextUtils : null;
      if (!_pretextUtils || !_pretextUtils.isEnabled(state)) return null;
      const pretextFont = _pretextUtils.resolveFontString(chatInput);
      const pretextWidth = chatInput.clientWidth;
      if (!pretextFont || !(pretextWidth > 0)) return null;
      const predicted = _pretextUtils.predictTextHeight(
        'composer', chatInput.value, pretextFont, pretextWidth, 15 * 1.55,
        { whiteSpace: 'pre-wrap' }
      );
      return predicted ? Math.ceil(predicted.height) : null;
    }

    function syncComposerInputHeight() {
      if (!chatInput) {
        return;
      }
      const minHeight = 28;
      const maxHeight = 144;
      // CSS can cap the dock below maxHeight, and text predictions can be low.
      // Let the browser decide when the rendered box needs a scrollbar.
      chatInput.style.overflowY = 'auto';
      let height = predictedInputHeight();
      if (height === null) {
        // Measure while collapsed so deleting text can shrink the composer.
        chatInput.style.height = '0px';
        height = chatInput.scrollHeight;
      }
      chatInput.style.height = `${Math.min(Math.max(height, minHeight), maxHeight)}px`;
      if (typeof updateComposerSafeOffset === 'function') {
        updateComposerSafeOffset({ force: true, syncViewport: true });
      }
    }

    function measureInlineTextWidth(element, text) {
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

    return {
      syncComposerInputHeight,
      measureInlineTextWidth,
    };
  }

  return { createComposerMeasure };
});
