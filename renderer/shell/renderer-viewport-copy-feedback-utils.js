(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewportCopyFeedbackUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createViewportCopyFeedbackUtils(deps) {
    const settings = deps || {};
    const chatTimeline = settings.chatTimeline || null;
    // The chip is created here and appended inside chatTimeline, a host that
    // arrives through deps -- so build it in the document that owns that host,
    // not whatever ambient global happens to be set.
    const documentRef = (chatTimeline && chatTimeline.ownerDocument)
      || settings.documentRef
      || (typeof document !== 'undefined' ? document : null);
    const escapeSelectorValue = typeof settings.escapeSelectorValue === 'function'
      ? settings.escapeSelectorValue
      : (value) => String(value || '');
    const setTimeoutRef = typeof settings.setTimeoutRef === 'function'
      ? settings.setTimeoutRef
      : setTimeout;
    const clearTimeoutRef = typeof settings.clearTimeoutRef === 'function'
      ? settings.clearTimeoutRef
      : clearTimeout;
    const announce = typeof settings.announce === 'function'
      ? settings.announce
      : (message, options) => globalThis.window?.rendererLiveAnnouncerInstance?.announce?.(message, options);
    const copyFeedbackTimers = new Map();

    function clearCopyFeedback(messageId) {
      const key = String(messageId || '');
      const timer = copyFeedbackTimers.get(key);
      if (timer) {
        clearTimeoutRef(timer);
        copyFeedbackTimers.delete(key);
      }
      if (!chatTimeline) {
        return;
      }
      const existing = chatTimeline.querySelector(
        `.chat-copy-chip[data-message-id="${escapeSelectorValue(key)}"]`
      );
      existing?.remove();
    }

    function showCopyFeedback(messageId) {
      const key = String(messageId || '');
      if (!key || !chatTimeline || !documentRef) {
        return;
      }
      clearCopyFeedback(key);
      const container = chatTimeline.querySelector(
        `.chat-hover-row[data-message-id="${escapeSelectorValue(key)}"]`
      );
      const button = container?.querySelector('[data-message-action="copy"]') || null;
      if (!container || !button) {
        return;
      }

      const chip = documentRef.createElement('span');
      chip.className = 'chat-copy-chip';
      chip.dataset.messageId = key;
      chip.setAttribute('aria-hidden', 'true');
      chip.textContent = 'Copied!';
      container.appendChild(chip);
      announce('Message copied.', { key: `message-copy:${key}` });

      const buttonRect = button.getBoundingClientRect();
      const chipWidth = chip.offsetWidth;
      const gap = 6;
      const preferredLeft = button.offsetLeft + button.offsetWidth + gap;
      const maxLeft = Math.max(0, container.clientWidth - chipWidth);
      let left = preferredLeft;
      if (preferredLeft + chipWidth > container.clientWidth) {
        left = button.offsetLeft - chipWidth - gap;
      }
      chip.style.left = `${Math.max(0, Math.min(left, maxLeft))}px`;
      chip.style.top = `${button.offsetTop + Math.round((buttonRect.height - chip.offsetHeight) / 2)}px`;
      const timer = setTimeoutRef(() => {
        chip.remove();
        copyFeedbackTimers.delete(key);
      }, 1200);
      copyFeedbackTimers.set(key, timer);
    }

    function disposeCopyFeedback() {
      copyFeedbackTimers.forEach((timer, key) => {
        clearTimeoutRef(timer);
        copyFeedbackTimers.delete(key);
      });
    }

    return {
      copyFeedbackTimers,
      clearCopyFeedback,
      showCopyFeedback,
      disposeCopyFeedback,
    };
  }

  return {
    createViewportCopyFeedbackUtils,
  };
});
