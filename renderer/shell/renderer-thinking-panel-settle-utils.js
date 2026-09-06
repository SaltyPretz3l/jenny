/*
 * renderer/shell/renderer-thinking-panel-settle-utils.js
 *
 * Expanded panels settle after max-height transitionend and drop the inline
 * pin so CSS max-height:none governs. Callers clear the class before collapse.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererThinkingPanelSettleUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const SETTLED_CLASS = 'reasoning-row-panel--settled';

  function settleThinkingPanelNow(panel, reducedMotion) {
    if (!panel || reducedMotion) {
      return;
    }
    panel.classList.add(SETTLED_CLASS);
    if (panel.style) panel.style.maxHeight = '';
  }

  function clearThinkingPanelSettle(panel) {
    if (!panel) {
      return;
    }
    panel.classList.remove(SETTLED_CLASS);
  }

  // options: { skip, ifLive(fn), transitionMs, onSettled }
  function armThinkingPanelSettle(panel, options) {
    const opts = options || {};
    if (!panel || opts.skip) {
      return null;
    }
    const ifLive = typeof opts.ifLive === 'function' ? opts.ifLive : (fn) => fn;
    const onCleanup = typeof opts.onCleanup === 'function' ? opts.onCleanup : null;
    const onSettled = typeof opts.onSettled === 'function' ? opts.onSettled : null;
    const transitionMs = Math.max(Number(opts.transitionMs) || 0, 0);
    let settled = false;
    let cleaned = false;
    let timeoutHandle = 0;
    let onEnd = null;
    const win = (panel.ownerDocument && panel.ownerDocument.defaultView)
      || (typeof window !== 'undefined' ? window : null);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (onEnd && typeof panel.removeEventListener === 'function') {
        panel.removeEventListener('transitionend', onEnd);
      }
      if (timeoutHandle && win && typeof win.clearTimeout === 'function') {
        win.clearTimeout(timeoutHandle);
      }
      timeoutHandle = 0;
      onCleanup?.();
    };
    const finish = ifLive(() => {
      if (settled || cleaned) return;
      settled = true;
      if (panel.classList.contains('expanded')) {
        panel.classList.add(SETTLED_CLASS);
        if (panel.style) panel.style.maxHeight = '';
      }
      try { onSettled?.(); } finally { cleanup(); }
    });
    if (typeof panel.addEventListener === 'function') {
      onEnd = (event) => {
        if (event.target !== panel || event.propertyName !== 'max-height') return;
        finish();
      };
      panel.addEventListener('transitionend', onEnd);
    }
    if (win && typeof win.setTimeout === 'function') {
      timeoutHandle = win.setTimeout(finish, transitionMs);
    }
    return cleanup;
  }

  return {
    SETTLED_CLASS,
    settleThinkingPanelNow,
    clearThinkingPanelSettle,
    armThinkingPanelSettle,
  };
});
