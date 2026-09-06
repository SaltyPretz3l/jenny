/**
 * renderer/inventory/progress-bar.js
 *
 * Horizontal progress bar with threshold tone shift (UMD).
 * Returns HTML strings. Uses --progress CSS custom property.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryProgressBar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function sanitizeClassName(value) {
    return String(value || '')
      .trim()
      .split(/\s+/)
      .filter(function (token) {
        return /^[A-Za-z0-9_-]+$/.test(token);
      })
      .join(' ');
  }

  /**
   * Render a progress bar.
   * @param {Object} opts
   * @param {number} opts.value - Current value
   * @param {number} opts.max - Maximum value
   * @param {string} [opts.label] - Accessible label
   * @param {string} [opts.displayText] - Visible text (e.g. "85,000 / 100,000")
   * @param {number} [opts.warningThreshold=0.8] - Fraction at which tone shifts to warning
   * @param {number} [opts.dangerThreshold=0.95] - Fraction at which tone shifts to danger
   * @param {string} [opts.className] - Additional class names
   * @returns {string} HTML string
   */
  function progressBar(opts) {
    var o = opts || {};
    var value = Number(o.value) || 0;
    var max = Number(o.max) || 1;
    var fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
    var percent = Math.round(fraction * 100);
    var label = o.label || percent + '% used';
    var displayText = o.displayText || '';
    var warningThreshold = typeof o.warningThreshold === 'number' ? o.warningThreshold : 0.8;
    var dangerThreshold = typeof o.dangerThreshold === 'number' ? o.dangerThreshold : 0.95;

    var tone = 'default';
    if (fraction >= dangerThreshold) tone = 'danger';
    else if (fraction >= warningThreshold) tone = 'warning';

    var cls = 'inv-progress';
    if (tone !== 'default') cls += ' inv-progress--' + tone;
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    return '<div class="' + cls + '"'
      + ' role="progressbar"'
      + ' aria-valuenow="' + value + '"'
      + ' aria-valuemin="0"'
      + ' aria-valuemax="' + max + '"'
      + ' aria-label="' + escapeHtml(label) + '"'
      + ' style="--progress: ' + percent + '%">'
      + '<div class="inv-progress-track">'
      + '<div class="inv-progress-fill"></div>'
      + '</div>'
      + (displayText
        ? '<span class="inv-progress-text">' + escapeHtml(displayText) + '</span>'
        : '')
      + '</div>';
  }

  progressBar.sanitizeClassName = sanitizeClassName;
  return progressBar;
});
