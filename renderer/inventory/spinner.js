/**
 * renderer/inventory/spinner.js
 *
 * Accessible CSS spinner primitive (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventorySpinner = factory();
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
   * Render a spinner element.
   * @param {Object} [opts]
   * @param {string} [opts.label='Loading'] - Accessible label
   * @param {string} [opts.size] - 'sm' for small variant
   * @param {string} [opts.className] - Additional class names
   * @returns {string} HTML string
   */
  function spinner(opts) {
    var o = opts || {};
    var label = o.label || 'Loading';
    var cls = 'inv-spinner';
    if (o.size === 'sm') cls += ' inv-spinner--sm';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    return '<span class="' + cls + '" role="status" aria-label="'
      + escapeHtml(label) + '"></span>';
  }

  spinner.sanitizeClassName = sanitizeClassName;
  return spinner;
});
