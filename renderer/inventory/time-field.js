/**
 * renderer/inventory/time-field.js
 *
 * Inventory time-field primitive — labeled <input type="time"> (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryTimeField = factory();
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

  function sanitizeToken(value, fallback) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : fallback;
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

  /* Only well-formed HH:MM values reach the control; anything else renders
   * as an empty field instead of leaking junk into the value attribute. */
  function sanitizeTimeValue(value) {
    var normalized = String(value == null ? '' : value).trim();
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(normalized) ? normalized : '';
  }

  /**
   * Render a labeled time field.
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} [opts.label]
   * @param {string} [opts.value] HH:MM
   * @param {string} [opts.step] seconds granularity (e.g. "300" = 5 min)
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.hint]
   * @param {string} [opts.ariaLabel]
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset]
   * @returns {string} HTML string
   */
  function timeField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var label = String(o.label || '').trim();
    var value = sanitizeTimeValue(o.value);
    var step = String(o.step || '').trim();
    var hint = String(o.hint || '').trim();
    var ariaLabel = String(o.ariaLabel || label || 'Time input');
    var cls = 'inv-time-field';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;
    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var keys = Object.keys(o.dataset);
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        if (!/^[a-z][a-z0-9-]*$/.test(rawKey)) continue;
        dataset += ' data-' + rawKey + '="' + escapeHtml(o.dataset[rawKey]) + '"';
      }
    }
    var control = '<input'
      + (id ? ' id="' + id + '"' : '')
      + ' type="time"'
      + ' class="inv-time-field-control"'
      + (value ? ' value="' + value + '"' : '')
      + ' aria-label="' + escapeHtml(ariaLabel) + '"'
      + (/^\d+$/.test(step) ? ' step="' + step + '"' : '')
      + (o.disabled === true ? ' disabled' : '')
      + dataset
      + '>';
    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '') + '>'
      + (label ? '<span class="inv-time-field-label">' + escapeHtml(label) + '</span>' : '')
      + control
      + (hint ? '<span class="inv-time-field-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</label>';
  }

  timeField.escapeHtml = escapeHtml;
  timeField.sanitizeToken = sanitizeToken;
  timeField.sanitizeTimeValue = sanitizeTimeValue;
  return timeField;
});
