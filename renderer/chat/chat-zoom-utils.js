(function exposeChatZoomUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.chatZoomUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatZoomUtilsFactory() {
  // Chat zoom is retired (type-scale rebase, 2026-09-28): the single Text size
  // setting (--font-scale) scales the chat like every other surface, and app
  // zoom owns whole-window magnification. The API survives as an inert shim so
  // existing callers and the persisted chatUi.zoomPercent value stay intact;
  // every value normalizes to 100 and nothing is written to the document.
  var DEFAULT_CHAT_ZOOM_PERCENT = 100;
  var MIN_CHAT_ZOOM_PERCENT = 100;
  var MAX_CHAT_ZOOM_PERCENT = 100;
  var CHAT_ZOOM_STEP = 5;

  function normalizeChatZoomPercent(_value) {
    return DEFAULT_CHAT_ZOOM_PERCENT;
  }

  function formatChatZoomFactor(percent) {
    var normalized = normalizeChatZoomPercent(percent);
    var rawFactor = normalized / 100;
    return rawFactor.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function resolveRootElement(docOrRoot) {
    if (!docOrRoot) {
      return null;
    }
    if (docOrRoot.documentElement) {
      return docOrRoot.documentElement;
    }
    if (docOrRoot.nodeType === 1) {
      return docOrRoot;
    }
    return null;
  }

  function applyChatZoomToDocument(docOrRoot, _percent) {
    var rootElement = resolveRootElement(docOrRoot);
    if (rootElement) {
      // Clear values a pre-retirement build may have left on the root.
      if (rootElement.style && typeof rootElement.style.removeProperty === 'function') {
        rootElement.style.removeProperty('--chat-zoom-percent');
        rootElement.style.removeProperty('--chat-zoom-factor');
      }
      if (rootElement.dataset) delete rootElement.dataset.chatZoom;
    }
    return DEFAULT_CHAT_ZOOM_PERCENT;
  }

  function getDefaultChatZoomPercent() {
    return DEFAULT_CHAT_ZOOM_PERCENT;
  }

  function getChatZoomOptions() {
    return [];
  }

  function stepChatZoomPercent(currentPercent, direction) {
    var current = normalizeChatZoomPercent(currentPercent);
    var normalizedDirection = Number(direction);
    if (!Number.isFinite(normalizedDirection) || normalizedDirection === 0) {
      return current;
    }
    return normalizeChatZoomPercent(current + (normalizedDirection > 0 ? CHAT_ZOOM_STEP : -CHAT_ZOOM_STEP));
  }

  function isDefaultChatZoomPercent(value) {
    return normalizeChatZoomPercent(value) === DEFAULT_CHAT_ZOOM_PERCENT;
  }

  return {
    CHAT_ZOOM_STEP: CHAT_ZOOM_STEP,
    DEFAULT_CHAT_ZOOM_PERCENT: DEFAULT_CHAT_ZOOM_PERCENT,
    MAX_CHAT_ZOOM_PERCENT: MAX_CHAT_ZOOM_PERCENT,
    MIN_CHAT_ZOOM_PERCENT: MIN_CHAT_ZOOM_PERCENT,
    applyChatZoomToDocument: applyChatZoomToDocument,
    getDefaultChatZoomPercent: getDefaultChatZoomPercent,
    getChatZoomOptions: getChatZoomOptions,
    isDefaultChatZoomPercent: isDefaultChatZoomPercent,
    normalizeChatZoomPercent: normalizeChatZoomPercent,
    stepChatZoomPercent: stepChatZoomPercent,
  };
});
