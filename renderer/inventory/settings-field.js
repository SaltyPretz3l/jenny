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

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
    var titleTag = o.labelFor ? 'label' : 'span';
    var titleHtml = label ? '<' + titleTag + ' class="settings-field-title"'
      + (o.labelFor ? ' for="' + escapeHtml(o.labelFor) + '"' : '')
      + (o.titleId ? ' id="' + escapeHtml(o.titleId) + '"' : '')
      + '>' + escapeHtml(label) + '</' + titleTag + '>' : '';
    var detail = o.detail != null ? String(o.detail) : '';
    // The Revert sits on the title line after "Modified", never beside the
    // control, so it cannot read as one more option of the control.
    var revertHtml = o.revertSlot === true
      ? '<span class="settings-field-revert-slot" data-setting-revert-slot="'
        + escapeHtml(o.revertSlotId || id) + '">' + String(o.revertHtml || '') + '</span>'
      : '';
    if (detail || metaHtml || revertHtml) {
      // The tooltip (it opens below the row) describes the button only while it shows;
      // aria-description says the same text from the start, and gives way to the tooltip.
      var detailHtml = detail ? '<button type="button" class="settings-field-detail inv-tooltip-pin"'
        + ' data-tooltip="' + escapeHtml(detail) + '" data-tooltip-placement="below" aria-label="' + escapeHtml(o.detailLabel || '') + '"'
        + ' aria-description="' + escapeHtml(detail) + '">?</button>' : '';
      var tailHtml = metaHtml || revertHtml ? '<span class="settings-field-title-tail">' + metaHtml + revertHtml + '</span>' : '';
      titleHtml = '<span class="settings-field-title-row">' + titleHtml + detailHtml + tailHtml + '</span>';
    }
    var textHtml = '';
    if (label || help || detail || metaHtml || revertHtml) {
      textHtml = '<div class="settings-field-text">'
        + titleHtml
        + (help ? '<p class="settings-field-help"' + (o.helpId ? ' id="' + escapeHtml(o.helpId) + '"' : '') + '>' + escapeHtml(help) + '</p>' : '')
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
      + '<p class="settings-field-error" role="alert"' + (errorText ? '' : ' hidden') + '>' + escapeHtml(errorText) + '</p>'
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
        // An alert that is written again is announced again: a poll that repeats the same reason leaves it alone.
        if (errorEl.textContent !== text) errorEl.textContent = text;
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
   * Stamp a field's modified state (data-modified="true") and show/hide the
   * meta-line affordances that only a modified field carries (the "Modified"
   * tag and the revert button), so a sync can flip the row without rebuilding
   * its markup. Rows without a meta line are a no-op.
   * @param {HTMLElement} rootEl - The .settings-field root element
   * @param {boolean} modified
   */
  function setFieldModified(rootEl, modified) {
    if (!rootEl || typeof rootEl.querySelector !== 'function') return;
    var on = Boolean(modified);
    if (on) rootEl.setAttribute('data-modified', 'true');
    else rootEl.removeAttribute('data-modified');
    var tag = rootEl.querySelector('.settings-field-meta-modified');
    if (tag) tag.hidden = !on;
    var revert = rootEl.querySelector('.settings-field-reset');
    if (revert) revert.hidden = !on;
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
  settingsField.setFieldModified = setFieldModified;
  settingsField.findField = findField;
  settingsField.escapeHtml = escapeHtml;
  settingsField.sanitizeToken = sanitizeToken;
  settingsField.sanitizeClassName = sanitizeClassName;
  return settingsField;
});
