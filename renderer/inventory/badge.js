/**
 * renderer/inventory/badge.js
 *
 * Inline badge primitive — tone variants and sizes (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryBadge = factory();
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

  var ALLOWED_TONES = {
    default: true,
    pending: true,
    success: true,
    warning: true,
    danger: true,
    muted: true,
  };

  /**
   * Render a badge element.
   * @param {Object} opts
   * @param {string} [opts.tone='default'] - 'default'|'pending'|'success'|'warning'|'danger'|'muted'
   * @param {string} [opts.size='md'] - 'sm'|'md'
   * @param {string} [opts.text] - Badge text (escaped)
   * @param {string} [opts.className] - Additional class names
   * @returns {string} HTML string
   */
  function badge(opts) {
    var o = opts || {};
    var tone = String(o.tone || 'default');
    if (!ALLOWED_TONES[tone]) tone = 'default';
    var size = o.size || 'md';
    var cls = ['inv-badge'];
    if (tone !== 'default') cls.push('inv-badge--' + tone);
    if (size === 'sm') cls.push('inv-badge--sm');
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls.push(extraClassName);
    var inner = escapeHtml(o.text || '');
    return '<span class="' + cls.join(' ') + '">' + inner + '</span>';
  }

  badge.escapeHtml = escapeHtml;
  badge.sanitizeClassName = sanitizeClassName;
  return badge;
});
