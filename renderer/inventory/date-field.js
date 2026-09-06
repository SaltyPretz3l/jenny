/**
 * renderer/inventory/date-field.js
 *
 * Inventory date-field primitive — labeled <input type="date"> (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryDateField = factory();
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

  /* Only well-formed YYYY-MM-DD values reach the control. */
  function sanitizeDateValue(value) {
    var normalized = String(value == null ? '' : value).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : '';
  }

  /**
   * Render a labeled date field.
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} [opts.label]
   * @param {string} [opts.value] YYYY-MM-DD
   * @param {string} [opts.min] YYYY-MM-DD
   * @param {string} [opts.max] YYYY-MM-DD
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.hint]
   * @param {string} [opts.ariaLabel]
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset]
   * @returns {string} HTML string
   */
  function dateField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var label = String(o.label || '').trim();
    var value = sanitizeDateValue(o.value);
    var min = sanitizeDateValue(o.min);
    var max = sanitizeDateValue(o.max);
    var hint = String(o.hint || '').trim();
    var ariaLabel = String(o.ariaLabel || label || 'Date input');
    var cls = 'inv-date-field';
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
      + ' type="date"'
      + ' class="inv-date-field-control"'
      + (value ? ' value="' + value + '"' : '')
      + ' aria-label="' + escapeHtml(ariaLabel) + '"'
      + (min ? ' min="' + min + '"' : '')
      + (max ? ' max="' + max + '"' : '')
      + (o.disabled === true ? ' disabled' : '')
      + dataset
      + '>';
    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '') + '>'
      + (label ? '<span class="inv-date-field-label">' + escapeHtml(label) + '</span>' : '')
      + control
      + (hint ? '<span class="inv-date-field-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</label>';
  }

  dateField.escapeHtml = escapeHtml;
  dateField.sanitizeToken = sanitizeToken;
  dateField.sanitizeDateValue = sanitizeDateValue;
  return dateField;
});
