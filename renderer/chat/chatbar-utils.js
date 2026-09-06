(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.chatbarUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function formatTokenUsageDisplay(usedTokens, limit, limitLabel) {
    const safeUsed = Math.max(Number(usedTokens || 0), 0);
    const numericLimit = Number(limit);
    const hasLimit = Number.isFinite(numericLimit) && numericLimit > 0;
    const safeLimit = hasLimit ? numericLimit : 0;
    const normalizedLimitLabel = hasLimit
      ? String(limitLabel || safeLimit.toLocaleString())
      : '-';
    const label = `Est. tokens: ${safeUsed.toLocaleString()} / ${normalizedLimitLabel}`;
    const ratio = hasLimit ? Math.min(safeUsed / safeLimit, 1) : 0;
    return {
      label,
      ratio,
      widthPercent: hasLimit ? Math.max(ratio * 100, 2) : 0,
      showProgress: hasLimit,
    };
  }

  function normalizeReasoningEffort(value) {
    const token = String(value || '').trim().toLowerCase();
    if (!token || token === 'default') {
      return 'default';
    }
    if (token === 'low' || token === 'medium' || token === 'high' || token === 'xhigh') {
      return token;
    }
    if (token === 'extra-high' || token === 'extra_high' || token === 'extra high') {
      return 'xhigh';
    }
    return 'default';
  }

  const ABSOLUTE_MIN_WIDTH = 48;

  /**
   * Computes the width of the model selector element so it fits the active
   * label without overflowing the composer on narrow viewports.
   *
   * @param {number} measuredLabelWidth - pixel width of the rendered label text
   * @param {number} viewportWidth      - current viewport width in px
   * @param {object} [options]
   * @param {number} [options.minWidth=96]            - default min select width
   * @param {number} [options.desktopMaxWidth=240]    - upper bound on wide viewports
   * @param {number} [options.narrowMaxWidth=184]     - upper bound on narrow viewports
   * @param {number} [options.narrowBreakpoint=900]   - viewport threshold for narrow mode
   * @param {number} [options.chromeWidth=34]          - padding/icon chrome around the label
   */
  function resolveComposerModelSelectWidth(measuredLabelWidth, viewportWidth, options) {
    const settings = options || {};
    const safeMeasured = Math.max(Number(measuredLabelWidth) || 0, 0);
    const safeViewport = Math.max(Number(viewportWidth) || 0, 0);
    const minWidth = Math.max(Number(settings.minWidth) || 96, ABSOLUTE_MIN_WIDTH);
    const desktopMaxWidth = Math.max(Number(settings.desktopMaxWidth) || 240, minWidth);
    const narrowMaxWidth = Math.max(Number(settings.narrowMaxWidth) || 184, minWidth);
    const narrowBreakpoint = Math.max(Number(settings.narrowBreakpoint) || 900, 0);
    const chromeWidth = Math.max(Number(settings.chromeWidth) || 34, 0);
    const maxWidth =
      safeViewport > 0 && safeViewport <= narrowBreakpoint
        ? narrowMaxWidth
        : desktopMaxWidth;

    return Math.round(Math.min(Math.max(safeMeasured + chromeWidth, minWidth), maxWidth));
  }

  return {
    formatTokenUsageDisplay,
    normalizeReasoningEffort,
    resolveComposerModelSelectWidth,
  };
});
