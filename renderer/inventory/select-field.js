/**
 * renderer/inventory/select-field.js
 *
 * Inventory select-field primitive — labeled <select> (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventorySelectField = factory();
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

  /**
   * Render just the <option> list. Split out so a caller that repopulates a
   * LIVE select in place (rather than rebuilding the whole field) produces
   * byte-identical markup to the initial render.
   * @param {Array<{value:string,label:string,disabled?:boolean}>} options
   * @param {string} current - The selected value
   * @returns {string} HTML string
   */
  function optionsMarkup(options, current) {
    var list = Array.isArray(options) ? options : [];
    var selected = String(current == null ? '' : current);
    var rendered = '';
    for (var j = 0; j < list.length; j += 1) {
      var opt = list[j] || {};
      var optValue = String(opt.value == null ? '' : opt.value);
      var optLabel = String(opt.label == null ? optValue : opt.label);
      rendered += '<option'
        + ' value="' + escapeHtml(optValue) + '"'
        + (optValue === selected ? ' selected' : '')
        + (opt.disabled === true ? ' disabled' : '')
        + '>'
        + escapeHtml(optLabel)
        + '</option>';
    }
    return rendered;
  }

  /**
   * Render a labeled select field.
   * @param {Object} opts
   * @param {string} opts.id
   * @param {string} [opts.label]
   * @param {string} [opts.tooltip] - Optional tooltip on the labeled control
   * @param {string} [opts.value] - Currently selected value
   * @param {Array<{value:string,label:string,disabled?:boolean}>} [opts.options]
   * @param {boolean} [opts.disabled]
   * @param {string} [opts.hint]
   * @param {string} [opts.ariaLabel]
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset]
   * @returns {string} HTML string
   */
  function selectField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var label = String(o.label || '').trim();
    var tooltip = typeof o.tooltip === 'string' ? escapeHtml(o.tooltip) : null;
    var hint = String(o.hint || '').trim();
    var ariaLabel = String(o.ariaLabel || label || 'Select');
    var current = String(o.value == null ? '' : o.value);
    var options = Array.isArray(o.options) ? o.options : [];
    var cls = 'inv-select-field';
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
    var rendered = optionsMarkup(options, current);
    var control = '<select'
      + (id ? ' id="' + id + '"' : '')
      + ' class="inv-select-field-control"'
      + ' aria-label="' + escapeHtml(ariaLabel) + '"'
      + (o.disabled === true ? ' disabled' : '')
      + dataset
      + '>'
      + rendered
      + '</select>';
    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '')
      + (tooltip != null ? ' title="' + tooltip + '"' : '') + '>'
      + (label ? '<span class="inv-select-field-label">' + escapeHtml(label) + '</span>' : '')
      + control
      + (hint ? '<span class="inv-select-field-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</label>';
  }

  selectField.optionsMarkup = optionsMarkup;
  selectField.escapeHtml = escapeHtml;
  selectField.sanitizeToken = sanitizeToken;
  selectField.sanitizeClassName = sanitizeClassName;
  return selectField;
});
