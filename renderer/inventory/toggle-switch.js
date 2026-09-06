/**
 * renderer/inventory/toggle-switch.js
 *
 * Accessible toggle switch primitive (UMD).
 * Returns HTML strings. role="switch" with aria-checked.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryToggleSwitch = factory();
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

  function sanitizeDomId(value) {
    var normalized = String(value || '').trim();
    return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(normalized) ? normalized : '';
  }

  /**
   * Render a toggle switch.
   * @param {Object} opts
   * @param {string} opts.id - Unique identifier for the switch
   * @param {string} opts.label - Visible label text
   * @param {string} [opts.tooltip] - Optional tooltip on the labeled control
   * @param {boolean} [opts.checked=false] - Initial checked state
   * @param {boolean} [opts.disabled=false] - Disabled state
   * @param {string} [opts.description] - Optional visible supporting text
   * @param {string} [opts.descriptionId] - Safe DOM id referenced by aria-describedby
   * @param {string} [opts.className] - Additional class names
   * @returns {string} HTML string
   */
  function toggleSwitch(opts) {
    var o = opts || {};
    var id = escapeHtml(o.id || '');
    var label = escapeHtml(o.label || '');
    var tooltip = typeof o.tooltip === 'string' ? escapeHtml(o.tooltip) : null;
    var description = escapeHtml(o.description || '');
    var descriptionId = description ? sanitizeDomId(o.descriptionId) : '';
    var checked = Boolean(o.checked);
    var disabled = Boolean(o.disabled);
    var cls = 'inv-toggle';
    if (checked) cls += ' inv-toggle--on';
    if (disabled) cls += ' inv-toggle--disabled';
    var extraClassName = sanitizeClassName(o.className);
    if (extraClassName) cls += ' ' + extraClassName;

    var labelContent = '';
    if (label) {
      if (description) {
        labelContent = '<span class="inv-toggle-label-group">'
          + '<span class="inv-toggle-label">' + label + '</span>'
          + '<span class="inv-toggle-description"'
          + (descriptionId ? ' id="' + escapeHtml(descriptionId) + '"' : '')
          + '>' + description + '</span>'
          + '</span>';
      } else {
        labelContent = '<span class="inv-toggle-label">' + label + '</span>';
      }
    }

    return '<label class="' + cls + '"' + (tooltip != null ? ' title="' + tooltip + '"' : '')
      + (disabled ? ' aria-disabled="true"' : '') + '>'
      + '<button class="inv-toggle-track" type="button"'
      + ' role="switch"'
      + ' aria-checked="' + (checked ? 'true' : 'false') + '"'
      + (descriptionId ? ' aria-describedby="' + escapeHtml(descriptionId) + '"' : '')
      + (id ? ' data-inv-toggle="' + id + '"' : '')
      + (disabled ? ' disabled aria-disabled="true"' : '')
      + '>'
      + '<span class="inv-toggle-thumb"></span>'
      + '</button>'
      + labelContent
      + '</label>';
  }

  /**
   * Silently sync a switch's checked state (aria-checked + --on class) WITHOUT
   * dispatching inv-toggle-change. This is the reflection primitive for
   * consumers whose state handler is what *triggers* the sync — dispatching
   * there would re-enter the handler. toggle() composes this with the event.
   * @param {HTMLElement} trackEl - The button[role="switch"] element
   * @param {boolean} nextChecked
   */
  function setChecked(trackEl, nextChecked) {
    if (!trackEl) return;
    var checked = Boolean(nextChecked);
    trackEl.setAttribute('aria-checked', checked ? 'true' : 'false');
    var wrapper = typeof trackEl.closest === 'function' ? trackEl.closest('.inv-toggle') : null;
    if (wrapper) {
      if (checked) wrapper.classList.add('inv-toggle--on');
      else wrapper.classList.remove('inv-toggle--on');
    }
  }

  /**
   * Imperatively toggle a switch element.
   * @param {HTMLElement} trackEl - The button[role="switch"] element
   * @param {boolean} nextChecked - Whether to check or uncheck
   */
  function toggle(trackEl, nextChecked) {
    if (!trackEl) return;
    var checked = Boolean(nextChecked);
    setChecked(trackEl, checked);
    var view = trackEl.ownerDocument && trackEl.ownerDocument.defaultView || null;
    var EventCtor = view && typeof view.CustomEvent === 'function' ? view.CustomEvent : typeof CustomEvent === 'function' ? CustomEvent : null;
    if (EventCtor) {
      trackEl.dispatchEvent(new EventCtor('inv-toggle-change', {
        bubbles: true,
        detail: { id: trackEl.getAttribute('data-inv-toggle'), checked: checked },
      }));
    }
  }

  /**
   * Install delegated click handler for toggle switches.
   * @param {HTMLElement|Document} rootEl
   */
  function initToggleHandlers(rootEl) {
    if (!rootEl || typeof rootEl.addEventListener !== 'function') return;
    if (rootEl.__invToggleHandlersInstalled) return;
    rootEl.__invToggleHandlersInstalled = true;
    rootEl.addEventListener('click', function (event) {
      var track = event.target.closest('[data-inv-toggle]');
      if (!track || track.disabled) return;
      var current = track.getAttribute('aria-checked') === 'true';
      toggle(track, !current);
    });
  }

  return {
    toggleSwitch: toggleSwitch,
    toggle: toggle,
    setChecked: setChecked,
    initToggleHandlers: initToggleHandlers,
  };
});
