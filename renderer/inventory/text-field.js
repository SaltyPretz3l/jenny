/**
 * renderer/inventory/text-field.js
 *
 * Inventory text-field primitive — labeled <input type="text"> or <textarea> (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryTextField = factory();
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
   * Render a labeled text field.
   * @param {Object} opts
   * @param {string} opts.id - DOM id (sanitized token)
   * @param {string} [opts.label] - Visible label text
   * @param {string} [opts.value] - Current value
   * @param {string} [opts.placeholder] - Placeholder text
   * @param {boolean} [opts.multiline] - Render as <textarea> when true
   * @param {number} [opts.rows=3] - textarea rows. The AUTOSIZE FLOOR, not a
   *   ceiling: callers that grow the field from one line pass 1 so it never
   *   flashes a three-row box before their autosize runs. Ignored for <input>.
   * @param {boolean} [opts.spellcheck] - Emit an explicit spellcheck attribute.
   *   Omitted entirely when not a boolean, which leaves the platform default.
   * @param {string} [opts.type] - Input type: 'text' (default) or 'password'. Any
   *   other value (or multiline:true) falls back to 'text'. Ignored for textarea.
   * @param {number} [opts.maxLength] - maxlength attribute
   * @param {boolean} [opts.disabled] - Disabled state
   * @param {boolean} [opts.readonly] - Read-only state
   * @param {string} [opts.hint] - Help text rendered below the field
   * @param {string} [opts.ariaLabel] - Optional aria-label override
   * @param {string} [opts.className] - Extra class names
   * @param {Object<string,string>} [opts.dataset] - Extra data-* attrs
   * @returns {string} HTML string
   */
  function textField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    var label = String(o.label || '').trim();
    var value = String(o.value == null ? '' : o.value);
    var placeholder = String(o.placeholder || '');
    var hint = String(o.hint || '').trim();
    var inputType = o.type === 'password' ? 'password' : 'text';
    var maxLength = Number.isFinite(Number(o.maxLength)) && Number(o.maxLength) > 0
      ? Math.floor(Number(o.maxLength))
      : null;
    var ariaLabel = String(o.ariaLabel || label || 'Text input');
    var rows = Number.isFinite(Number(o.rows)) && Number(o.rows) >= 1
      ? Math.floor(Number(o.rows))
      : 3;
    var spellcheck = typeof o.spellcheck === 'boolean'
      ? ' spellcheck="' + (o.spellcheck ? 'true' : 'false') + '"'
      : '';
    var cls = 'inv-text-field';
    if (o.multiline) cls += ' inv-text-field--multiline';
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

    var control;
    if (o.multiline) {
      control = '<textarea'
        + (id ? ' id="' + id + '"' : '')
        + ' class="inv-text-field-control"'
        + ' aria-label="' + escapeHtml(ariaLabel) + '"'
        + (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '')
        + (maxLength ? ' maxlength="' + maxLength + '"' : '')
        + (o.disabled === true ? ' disabled' : '')
        + (o.readonly === true ? ' readonly' : '')
        + spellcheck
        + ' rows="' + rows + '"'
        + dataset
        + '>'
        + escapeHtml(value)
        + '</textarea>';
    } else {
      control = '<input'
        + (id ? ' id="' + id + '"' : '')
        + ' type="' + inputType + '"'
        + ' class="inv-text-field-control"'
        + ' value="' + escapeHtml(value) + '"'
        + ' aria-label="' + escapeHtml(ariaLabel) + '"'
        + (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '')
        + (maxLength ? ' maxlength="' + maxLength + '"' : '')
        + (o.disabled === true ? ' disabled' : '')
        + (o.readonly === true ? ' readonly' : '')
        + spellcheck
        + dataset
        + '>';
    }

    return '<label class="' + cls + '"' + (id ? ' for="' + id + '"' : '') + '>'
      + (label ? '<span class="inv-text-field-label">' + escapeHtml(label) + '</span>' : '')
      + control
      + (hint ? '<span class="inv-text-field-hint">' + escapeHtml(hint) + '</span>' : '')
      + '</label>';
  }

  textField.escapeHtml = escapeHtml;
  textField.sanitizeToken = sanitizeToken;
  textField.sanitizeClassName = sanitizeClassName;
  return textField;
});
