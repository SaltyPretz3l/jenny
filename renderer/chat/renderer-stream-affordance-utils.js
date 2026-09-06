(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamAffordanceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const domPatchUtils = (function resolveDomPatchUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererStreamDomPatchUtils) {
      return globalThis.rendererStreamDomPatchUtils;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-stream-dom-patch-utils'); } catch (_error) { /* not available */ }
    }
    return {};
  })();
  const queryAllSafe = typeof domPatchUtils.queryAllSafe === 'function'
    ? domPatchUtils.queryAllSafe
    : function noopQueryAllSafe() { return []; };
  const collectSelfAndDescendants = typeof domPatchUtils.collectSelfAndDescendants === 'function'
    ? domPatchUtils.collectSelfAndDescendants
    : function noopCollectSelfAndDescendants() { return []; };

  const STREAM_AFFORDANCE_MARKER_SELECTOR = [
    '.chat-bubble-streaming',
    '[data-streaming-bubble]',
    '[data-streaming-row]',
    '[data-streaming-message-id]',
    '.is-streaming-tail',
  ].join(',');

  function removeClass(element, className) {
    if (!element?.classList?.contains?.(className)) return false;
    element.classList.remove(className);
    return true;
  }

  function removeAttr(element, attr) {
    if (!element?.hasAttribute?.(attr)) return false;
    element.removeAttribute(attr);
    return true;
  }

  function addAffordanceRoot(targets, element) {
    if (!element || element.nodeType !== 1) return;
    targets.add(element.closest?.('article.chat-entry, [data-thread-message-id], [data-message-id]') || element);
  }

  function settleVisibleStreamAffordances(options = {}) {
    const chatTimeline = options.chatTimeline || null;
    if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') {
      return { cleared: false, roots: 0 };
    }
    const escapeSelectorValue = typeof options.escapeSelectorValue === 'function'
      ? options.escapeSelectorValue
      : (value) => String(value || '');
    const ids = [
      String(options.messageId || '').trim(),
      String(options.streamId || '').trim() ? `assistant_${String(options.streamId).trim()}` : '',
    ].filter(Boolean);
    const roots = new Set();
    for (const id of ids) {
      const escaped = escapeSelectorValue(id);
      queryAllSafe(chatTimeline, [
        `[data-message-id="${escaped}"]`,
        `[data-thread-message-id="${escaped}"]`,
        `[data-source-message-id="${escaped}"]`,
        `[data-streaming-message-id="${escaped}"]`,
      ].join(',')).forEach((match) => addAffordanceRoot(roots, match));
    }
    if (!roots.size && ids.length) {
      return { cleared: false, roots: 0 };
    }
    if (!roots.size) {
      queryAllSafe(chatTimeline, STREAM_AFFORDANCE_MARKER_SELECTOR)
        .forEach((match) => addAffordanceRoot(roots, match));
    }
    let cleared = false;
    for (const rootNode of roots) {
      cleared = removeClass(rootNode, 'pending') || cleared;
      cleared = removeClass(rootNode, 'stream-reveal-entry') || cleared;
      cleared = removeAttr(rootNode, 'data-streaming-message-id') || cleared;
      collectSelfAndDescendants(rootNode, '[data-streaming-row], [data-streaming-message-id]').forEach((node) => {
        cleared = removeAttr(node, 'data-streaming-row') || cleared;
        cleared = removeAttr(node, 'data-streaming-message-id') || cleared;
      });
      collectSelfAndDescendants(rootNode, '.chat-stream-unit').forEach((unit) => {
        cleared = removeClass(unit, 'is-streaming-tail') || cleared;
        cleared = removeClass(unit, 'is-revealed') || cleared;
        cleared = removeAttr(unit, 'data-stream-unit-index') || cleared;
      });
      // Reasoning soft-landing units: strip the live reveal marker + stagger so a
      // settled or re-opened turn never re-animates.
      collectSelfAndDescendants(rootNode, '.reasoning-stream-unit').forEach((unit) => {
        cleared = removeClass(unit, 'is-revealed') || cleared;
        cleared = removeAttr(unit, 'data-stream-unit-index') || cleared;
        if (unit.style && unit.style.animationDelay) {
          unit.style.animationDelay = '';
          cleared = true;
        }
      });
      collectSelfAndDescendants(rootNode, '.chat-bubble-streaming, [data-streaming-bubble]').forEach((bubble) => {
        cleared = removeClass(bubble, 'chat-bubble-streaming') || cleared;
        cleared = removeAttr(bubble, 'data-streaming-bubble') || cleared;
        if (String(bubble.getAttribute?.('role') || '').trim() === 'status') {
          cleared = removeAttr(bubble, 'role') || cleared;
        }
        cleared = removeAttr(bubble, 'aria-live') || cleared;
        cleared = removeAttr(bubble, 'aria-atomic') || cleared;
        if (/streaming/i.test(String(bubble.getAttribute?.('aria-label') || ''))) {
          cleared = removeAttr(bubble, 'aria-label') || cleared;
        }
      });
    }
    if (!chatTimeline.querySelector('.chat-bubble-streaming, [data-streaming-bubble="true"]')) {
      if (chatTimeline.getAttribute('aria-busy') !== 'false') {
        chatTimeline.setAttribute('aria-busy', 'false');
        cleared = true;
      }
    }
    return { cleared, roots: roots.size };
  }

  return {
    settleVisibleStreamAffordances,
  };
});
