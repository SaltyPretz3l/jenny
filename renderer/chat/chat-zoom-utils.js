(function exposeChatZoomUtils(globalScope, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  if (globalScope && typeof globalScope === 'object') {
    globalScope.chatZoomUtils = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function chatZoomUtilsFactory() {
  var DEFAULT_CHAT_ZOOM_PERCENT = 100;
  var MIN_CHAT_ZOOM_PERCENT = 85;
  var MAX_CHAT_ZOOM_PERCENT = 135;
  var CHAT_ZOOM_STEP = 5;

  function normalizeChatZoomPercent(value) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_CHAT_ZOOM_PERCENT;
    }
    var clamped = Math.min(MAX_CHAT_ZOOM_PERCENT, Math.max(MIN_CHAT_ZOOM_PERCENT, parsed));
    var stepped = Math.round(clamped / CHAT_ZOOM_STEP) * CHAT_ZOOM_STEP;
    return Math.min(MAX_CHAT_ZOOM_PERCENT, Math.max(MIN_CHAT_ZOOM_PERCENT, stepped));
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

  function applyChatZoomToDocument(docOrRoot, percent) {
    var normalized = normalizeChatZoomPercent(percent);
    var rootElement = resolveRootElement(docOrRoot);
    if (!rootElement) {
      return normalized;
    }
    rootElement.style.setProperty('--chat-zoom-percent', String(normalized));
    rootElement.style.setProperty('--chat-zoom-factor', formatChatZoomFactor(normalized));
    rootElement.dataset.chatZoom = String(normalized);
    return normalized;
  }

  function getDefaultChatZoomPercent() {
    return DEFAULT_CHAT_ZOOM_PERCENT;
  }

  function getChatZoomOptions() {
    var options = [];
    for (var percent = MIN_CHAT_ZOOM_PERCENT; percent <= MAX_CHAT_ZOOM_PERCENT; percent += CHAT_ZOOM_STEP) {
      options.push({
        id: String(percent),
        value: percent,
        label: percent + '%',
      });
    }
    return options;
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
