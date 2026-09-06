/**
 * renderer/inventory/settings-field.js
 *
 * Shared `.settings-field` row builder (UMD).
 *
 * Anatomy (must match the CSS contract exactly):
 *   <div class="settings-field settings-field--<variant>" data-settings-field="<id>">
 *     <div class="settings-field-text">
 *       <span class="settings-field-title">Label</span>
 *       <p class="settings-field-help">Optional helper.</p>
 *     </div>
 *     <div class="settings-field-control"><!-- trusted controlHtml --></div>
 *     <p class="settings-field-error" hidden>Error message</p>
 *   </div>
 *
 * data-settings-field="<id>" is the settings-search fallback when a hit has no
 * [data-inv-toggle] and no matching element id.
 *
 * Standalone module: no requires of other inventory primitives or shell modules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventorySettingsField = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VALID_VARIANTS = { inline: true, stacked: true, toggle: true, row: true };

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
   * Render a settings field row.
   * @param {Object} opts
   * @param {string} opts.id - Required. Emitted as data-settings-field="<id>"
   *   (sanitized token: [A-Za-z0-9_-]+). Missing/invalid id renders nothing —
   *   an obvious "nothing rendered" signal, matching segmentedControl's guard.
   * @param {string} [opts.label] - Field title text (HTML-escaped)
   * @param {string} [opts.help] - Helper/description text (HTML-escaped)
   * @param {string} [opts.metaHtml] - TRUSTED markup slot rendered on the title
   *   line (default value, "Modified", a per-field reset): same rules as
   *   controlHtml - inventory-builder output only. Lives in the text column so
   *   it never pushes the control.
   * @param {string} [opts.controlHtml] - TRUSTED markup slot for the control.
   *   Inserted verbatim, UNESCAPED — callers must pass inventory-builder
   *   output (e.g. inventory.toggleSwitch({...}), inventory.selectField({...})),
   *   never raw user text, or they open an injection hole.
   * @param {'inline'|'stacked'|'toggle'|'row'} [opts.variant='inline'] - 'row' is the
   *   flat list idiom (label + help left, control right, hairline between
   *   siblings, no card chrome) matching .settings-field-row in settings-grid.css.
   * @param {string} [opts.error] - Optional initial error text; non-empty sets
   *   data-state="error" and pre-populates/unhides .settings-field-error.
   * @param {boolean} [opts.busy] - Initial busy state (data-state="busy").
   *   Ignored if opts.error is also set — error wins (matches
   *   setFieldError/setFieldBusy runtime precedence below).
   * @param {string} [opts.className]
   * @param {Object<string,string>} [opts.dataset] - Extra data-* attrs
   *   (key must match /^[a-z][a-z0-9-]*$/)
   * @returns {string} HTML string (empty string when id is missing/invalid)
   */
  function settingsField(opts) {
    var o = opts || {};
    var id = sanitizeToken(o.id, '');
    if (!id) return '';

    var variant = VALID_VARIANTS[o.variant] ? o.variant : 'inline';
    var cls = 'settings-field settings-field--' + variant;
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    var errorText = o.error != null ? String(o.error).trim() : '';
    var busy = Boolean(o.busy);
    // Error state wins over busy at render time too, mirroring the runtime
    // precedence documented on setFieldError/setFieldBusy below.
    var state = errorText ? 'error' : (busy ? 'busy' : '');

    var dataset = '';
    if (o.dataset && typeof o.dataset === 'object') {
      var keys = Object.keys(o.dataset);
      for (var i = 0; i < keys.length; i += 1) {
        var rawKey = keys[i];
        if (!/^[a-z][a-z0-9-]*$/.test(rawKey)) continue;
        dataset += ' data-' + rawKey + '="' + escapeHtml(o.dataset[rawKey]) + '"';
      }
    }

    var label = o.label != null ? String(o.label) : '';
    var help = o.help != null ? String(o.help) : '';
    var metaHtml = o.metaHtml != null ? String(o.metaHtml) : '';
    var titleHtml = label ? '<span class="settings-field-title">' + escapeHtml(label) + '</span>' : '';
    if (metaHtml) {
      titleHtml = '<span class="settings-field-title-row">' + titleHtml + metaHtml + '</span>';
    }
    var textHtml = '';
    if (label || help || metaHtml) {
      textHtml = '<div class="settings-field-text">'
        + titleHtml
        + (help ? '<p class="settings-field-help">' + escapeHtml(help) + '</p>' : '')
        + '</div>';
    }

    var controlHtml = o.controlHtml != null ? String(o.controlHtml) : '';

    return '<div'
      + ' class="' + cls + '"'
      + ' data-settings-field="' + id + '"'
      + (state ? ' data-state="' + state + '"' : '')
      + dataset
      + '>'
      + textHtml
      + '<div class="settings-field-control">' + controlHtml + '</div>'
      + '<p class="settings-field-error"' + (errorText ? '' : ' hidden') + '>' + escapeHtml(errorText) + '</p>'
      + '</div>';
  }

  /**
   * Set (or clear) a field's error state.
   *
   * A non-empty message sets data-state="error" on the root and
   * unhides/populates the .settings-field-error slot. A null/empty/undefined
   * message clears the error state (removes data-state if it was "error")
   * and re-hides the slot. Does NOT restore a prior busy state on clear —
   * call setFieldBusy again if the caller still wants busy after the error
   * goes away.
   * @param {HTMLElement} rootEl - The .settings-field root element
   * @param {string|null|undefined} message
   */
  function setFieldError(rootEl, message) {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return;
    var errorEl = rootEl.querySelector('.settings-field-error');
    var text = message != null ? String(message).trim() : '';
    if (text) {
      rootEl.setAttribute('data-state', 'error');
      if (errorEl) {
        errorEl.hidden = false;
        errorEl.textContent = text;
      }
      return;
    }
    if (rootEl.getAttribute('data-state') === 'error') {
      rootEl.removeAttribute('data-state');
    }
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }
  }

  /**
   * Toggle a field's busy state (data-state="busy").
   *
   * Precedence: error always wins. If the root currently carries
   * data-state="error", this is a no-op regardless of the `busy` argument —
   * callers must clear the error first (setFieldError(rootEl, null)) before
   * a busy state can show.
   * @param {HTMLElement} rootEl - The .settings-field root element
   * @param {boolean} busy
   */
  function setFieldBusy(rootEl, busy) {
    if (!rootEl || typeof rootEl.getAttribute !== 'function') return;
    if (rootEl.getAttribute('data-state') === 'error') {
      return;
    }
    if (busy) {
      rootEl.setAttribute('data-state', 'busy');
      return;
    }
    if (rootEl.getAttribute('data-state') === 'busy') {
      rootEl.removeAttribute('data-state');
    }
  }

  /**
   * Convenience lookup for a rendered field by id.
   * @param {HTMLElement|Document} root
   * @param {string} fieldId
   * @returns {HTMLElement|null}
   */
  function findField(root, fieldId) {
    if (!root || typeof root.querySelector !== 'function') return null;
    var id = String(fieldId || '').trim();
    if (!id) return null;
    return root.querySelector('[data-settings-field="' + id + '"]');
  }

  settingsField.setFieldError = setFieldError;
  settingsField.setFieldBusy = setFieldBusy;
  settingsField.findField = findField;
  settingsField.escapeHtml = escapeHtml;
  settingsField.sanitizeToken = sanitizeToken;
  settingsField.sanitizeClassName = sanitizeClassName;
  return settingsField;
});
