/**
 * renderer/inventory/status-row.js
 *
 * Shared status row primitive for shell/runtime/settings notices (UMD).
 *
 * Renders a flat status line — one tone dot, then text — not a card. The dot
 * carries the tone so the message keeps full text contrast on every palette;
 * see renderer/inventory/inventory-status-row.css for the reasoning.
 *
 * The compatibility-named spinner option pulses the tone dot to signal work in progress.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./progress-bar'));
    return;
  }
  root.inventoryStatusRow = factory(root.inventoryProgressBar);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (progressBar) {
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
  };

  function resolveTone(value) {
    var tone = String(value || 'default').trim().toLowerCase();
    if (!ALLOWED_TONES[tone]) {
      return 'default';
    }
    return tone;
  }

  function buildProgressMarkup(progress, compact) {
    if (!progress || typeof progress !== 'object') {
      return '';
    }
    if (typeof progressBar === 'function') {
      return progressBar({
        value: progress.value,
        max: progress.max,
        label: progress.label,
        displayText: progress.displayText,
        warningThreshold: progress.warningThreshold,
        dangerThreshold: progress.dangerThreshold,
        className: compact ? 'inv-status-row-progress inv-status-row-progress--compact' : 'inv-status-row-progress',
      });
    }
    return '';
  }

  /**
   * Render a shared status row.
   * @param {Object} [opts]
   * @param {string} [opts.tone='default'] - 'default'|'pending'|'success'|'warning'|'danger'
   * @param {string} [opts.label] - Optional inline lead-in, rendered before an em dash
   * @param {string} [opts.message] - Main message body
   * @param {string} [opts.badgeText] - Optional trailing qualifier, rendered as muted text
   * @param {boolean} [opts.spinner=false] - Pulse the tone dot
   * @param {Object} [opts.progress] - Optional progress-bar options
   * @param {boolean} [opts.compact=false] - Render compact spacing
   * @param {string} [opts.ariaLive] - Optional aria-live politeness setting
   * @param {string} [opts.className] - Additional class names
   * @returns {string}
   */
  function statusRow(opts) {
    var o = opts || {};
    var tone = resolveTone(o.tone);
    var label = String(o.label || '').trim();
    var message = String(o.message || '').trim();
    var badgeText = String(o.badgeText || '').trim();
    var compact = o.compact === true;
    var showSpinner = o.spinner === true;
    var ariaLive = String(o.ariaLive || '').trim();
    var progress = o.progress && typeof o.progress === 'object' ? o.progress : null;
    var cls = ['inv-status-row'];

    if (tone !== 'default') {
      cls.push('inv-status-row--' + tone);
    }
    if (compact) {
      cls.push('inv-status-row--compact');
    }
    if (showSpinner) {
      cls.push('inv-status-row--with-spinner');
    }
    if (progress) {
      cls.push('inv-status-row--with-progress');
    }
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) {
      cls.push(extraClassName);
    }

    var attrs = 'class="' + cls.join(' ') + '" data-status-tone="' + escapeHtml(tone) + '"';
    if (ariaLive) {
      attrs += ' role="status" aria-live="' + escapeHtml(ariaLive) + '"';
    }

    return ''
      + '<div ' + attrs + '>'
      + '<span class="inv-status-row-leading" aria-hidden="true">'
      + '<span class="inv-status-row-dot"></span>'
      + '</span>'
      + '<div class="inv-status-row-main">'
      + '<div class="inv-status-row-message">'
      + (label ? '<span class="inv-status-row-label">' + escapeHtml(label) + '</span>' : '')
      + escapeHtml(message)
      + (badgeText ? '<span class="inv-status-row-badge">' + escapeHtml(badgeText) + '</span>' : '')
      + '</div>'
      + (progress ? '<div class="inv-status-row-progress-wrap">' + buildProgressMarkup(progress, compact) + '</div>' : '')
      + '</div>'
      + '</div>';
  }

  statusRow.escapeHtml = escapeHtml;
  statusRow.sanitizeClassName = sanitizeClassName;
  return statusRow;
});
