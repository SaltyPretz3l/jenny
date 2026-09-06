/**
 * renderer/shell/renderer-settings-field-reset.js
 *
 * Resettable appearance keys are paletteId, typographyId, fontScaleId, and
 * surfaceEffectId. Theme bundles are composite across multiple appearance
 * keys, and app zoom is an Electron window preference, so neither has a
 * per-field reset. Section confirmation permits only one in-flight reset.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsFieldReset = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DEFAULT_ARM_TIMEOUT_MS = 5000;

  // Appearance-preference-backed selects eligible for per-field reset. See
  // the module header for what is excluded and why.
  var APPEARANCE_FIELD_MAP = [
    { id: 'appearancePaletteSelect', key: 'paletteId', label: 'Palette' },
    { id: 'appearanceTypographySelect', key: 'typographyId', label: 'Typography' },
    { id: 'appearanceFontScaleSelect', key: 'fontScaleId', label: 'Text size' },
    { id: 'appearanceChatWidthSelect', key: 'chatWidthId', label: 'Chat width' },
    { id: 'appearanceSurfaceEffectSelect', key: 'surfaceEffectId', label: 'Background effect' },
  ];

  // Not reset-eligible itself (see header), but its change can shift several
  // of the fields above at once -- watched so their reset buttons re-sync.
  var WATCH_ONLY_SELECT_IDS = ['appearanceThemeBundleSelect'];

  function noop() {}
  function noopLog() {}

  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error == null ? 'Unknown error' : error);
  }

  function resolveActionButton(deps) {
    // An EXPLICIT actionButton key (even null) wins outright, so harnesses
    // can exercise the builder-unavailable fallback paths; only an absent
    // key falls through to the global/require production resolution.
    if (deps && Object.prototype.hasOwnProperty.call(deps, 'actionButton')) {
      return deps.actionButton || null;
    }
    return (typeof globalThis !== 'undefined' && globalThis.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  function firstElementFromHtml(documentRef, html) {
    if (!documentRef || !html || typeof documentRef.createElement !== 'function') {
      return null;
    }
    var holder = documentRef.createElement('div');
    holder.innerHTML = html;
    return holder.firstElementChild || null;
  }

  function childElementsFromHtml(documentRef, html) {
    if (!documentRef || !html || typeof documentRef.createElement !== 'function') {
      return [];
    }
    var holder = documentRef.createElement('div');
    holder.innerHTML = html;
    return Array.prototype.slice.call(holder.children);
  }

  /**
   * @param {object} deps
   * @param {Document} deps.documentRef
   * @param {{ appearance?: object, zoom?: object }} deps.adapters - settings
   *   adapters (createSettingsAdapter shape). Only `adapters.appearance` is
   *   read by v1 per-field reset (see module header for scope).
   * @param {object} [deps.appearanceUtils] - unused directly today (the
   *   appearance adapter already wraps it); accepted for interface parity
   *   with the other Tier C settings modules and future per-field growth.
   * @param {object} [deps.chatZoomUtils] - unused directly today; zoom
   *   selects are out of v1 per-field scope (see module header).
   * @param {{ appearance?: function, chatZoom?: function }} [deps.resetActions] -
   *   the exact pre-existing section-reset callbacks (each returns a value
   *   or a Promise). Confirm invokes `resetActions[key]()` verbatim.
   * @param {function} [deps.onAfterReset] - called after a successful
   *   per-field write and after a settled section-reset action (matches the
   *   pre-existing renderSettings() call site in both cases).
   * @param {function} [deps.log]
   * @param {number} [deps.armTimeoutMs] - test seam, defaults to 5000.
   * @param {function} [deps.setTimeoutFn] - test seam (fake timers).
   * @param {function} [deps.clearTimeoutFn] - test seam (fake timers).
   * @param {object} [deps.actionButton] - test seam; defaults to the shared
   *   renderer/inventory/action-button.js module.
   */
  function createSettingsFieldReset(deps) {
    var d = deps || {};
    var documentRef = d.documentRef || null;
    var adapters = d.adapters && typeof d.adapters === 'object' ? d.adapters : {};
    var appearanceAdapter = adapters.appearance || null;
    var onAfterReset = typeof d.onAfterReset === 'function' ? d.onAfterReset : noop;
    var log = typeof d.log === 'function' ? d.log : noopLog;
    var resetActions = d.resetActions && typeof d.resetActions === 'object' ? d.resetActions : {};
    var armTimeoutMs = typeof d.armTimeoutMs === 'number' && d.armTimeoutMs >= 0 ? d.armTimeoutMs : DEFAULT_ARM_TIMEOUT_MS;
    var setTimeoutFn = typeof d.setTimeoutFn === 'function' ? d.setTimeoutFn : setTimeout;
    var clearTimeoutFn = typeof d.clearTimeoutFn === 'function' ? d.clearTimeoutFn : clearTimeout;
    var actionButton = resolveActionButton(d);

    var mounted = false;
    var fieldEntries = [];
    var sectionEntries = [];
    var watchDisposers = [];

    // ── per-field reset ──────────────────────────────────────────────────

    function currentAppearance() {
      if (!appearanceAdapter) return {};
      try {
        return appearanceAdapter.normalize(appearanceAdapter.read()) || {};
      } catch (_error) {
        return typeof appearanceAdapter.getDefault === 'function' ? appearanceAdapter.getDefault() || {} : {};
      }
    }

    function defaultAppearance() {
      if (!appearanceAdapter || typeof appearanceAdapter.getDefault !== 'function') return {};
      return appearanceAdapter.getDefault() || {};
    }

    function buildFieldResetHtml(fieldDef) {
      if (!actionButton) return '';
      return actionButton({
        id: fieldDef.id + 'Reset',
        label: '↺ Reset',
        plain: true,
        className: 'settings-field-reset',
        ariaLabel: 'Reset ' + fieldDef.label + ' to default',
        title: 'Reset to default',
      });
    }

    function mountFieldEntry(fieldDef) {
      if (!documentRef || typeof documentRef.getElementById !== 'function') return null;
      var selectEl = documentRef.getElementById(fieldDef.id);
      if (!selectEl) return null;
      var shell = typeof selectEl.closest === 'function' ? selectEl.closest('.select-shell') : null;
      // Preferred mount: the title line of the row's text column, right after
      // the label, so the affordance uses the empty space beside the title and
      // never pushes the control. Fallback: after the select (legacy markup).
      var row = typeof selectEl.closest === 'function' ? selectEl.closest('.settings-field-row') : null;
      var textColumn = row ? row.querySelector('.settings-field-row-text') : null;
      var container = textColumn || (shell && shell.parentElement) || selectEl.parentElement;
      if (!container) return null;
      var buttonEl = container.querySelector('[data-action="' + fieldDef.id + 'Reset"]');
      if (!buttonEl) {
        buttonEl = firstElementFromHtml(documentRef, buildFieldResetHtml(fieldDef));
        if (!buttonEl) return null;
        var labelEl = textColumn ? textColumn.querySelector('.settings-field-label') : null;
        if (labelEl && labelEl.parentElement === textColumn && labelEl.nextSibling) {
          textColumn.insertBefore(buttonEl, labelEl.nextSibling);
        } else {
          container.appendChild(buttonEl);
        }
      }
      var entry = { def: fieldDef, selectEl: selectEl, buttonEl: buttonEl, busy: false };
      var onClick = function () { handleFieldReset(entry); };
      var onChange = function () { syncFieldVisibility(entry); };
      buttonEl.addEventListener('click', onClick);
      selectEl.addEventListener('change', onChange);
      entry._dispose = function () {
        buttonEl.removeEventListener('click', onClick);
        selectEl.removeEventListener('change', onChange);
      };
      return entry;
    }

    function syncFieldVisibility(entry) {
      if (!entry || !entry.buttonEl || !appearanceAdapter) return;
      var current = currentAppearance();
      var defaults = defaultAppearance();
      entry.buttonEl.hidden = current[entry.def.key] === defaults[entry.def.key];
    }

    function syncAllVisibility() {
      fieldEntries.forEach(syncFieldVisibility);
    }

    function handleFieldReset(entry) {
      if (!appearanceAdapter || entry.busy) return;
      entry.busy = true;
      var current = currentAppearance();
      var defaults = defaultAppearance();
      var next = {};
      Object.keys(current).forEach(function (k) { next[k] = current[k]; });
      next[entry.def.key] = defaults[entry.def.key];
      Promise.resolve(appearanceAdapter.write(next))
        .then(function () {
          syncAllVisibility();
          onAfterReset();
        })
        .catch(function (error) {
          log('settings field-reset "' + entry.def.id + '" write failed: ' + describeError(error));
        })
        .then(
          function settleOk() { entry.busy = false; },
          function settleErr() { entry.busy = false; }
        );
    }

    function mountWatchOnly(selectId) {
      if (!documentRef || typeof documentRef.getElementById !== 'function') return null;
      var selectEl = documentRef.getElementById(selectId);
      if (!selectEl) return null;
      var onChange = function () { syncAllVisibility(); };
      selectEl.addEventListener('change', onChange);
      return function dispose() { selectEl.removeEventListener('change', onChange); };
    }

    // ── two-step inline section reset ───────────────────────────────────

    function clearArmTimer(entry) {
      if (entry.timer !== null) {
        clearTimeoutFn(entry.timer);
        entry.timer = null;
      }
    }

    function disarm(entry) {
      if (!entry.armed) return;
      entry.armed = false;
      clearArmTimer(entry);
      if (entry._disposeConfirmButtons) {
        entry._disposeConfirmButtons();
        entry._disposeConfirmButtons = null;
      }
      entry.confirmNodes.forEach(function (node) {
        if (node && node.parentNode === entry.container) {
          entry.container.removeChild(node);
        }
      });
      entry.confirmNodes = [];
      entry.container.classList.remove('settings-reset-confirm');
      entry.container.removeAttribute('data-armed');
      entry.trigger.hidden = false;
    }

    function confirmReset(entry) {
      if (entry.inFlight) return; // single in-flight guard
      clearArmTimer(entry);
      entry.inFlight = true;
      var action = resetActions[entry.key];
      var result;
      try {
        result = typeof action === 'function' ? action() : undefined;
      } catch (error) {
        log('settings section-reset "' + entry.key + '" action threw: ' + describeError(error));
        entry.inFlight = false;
        disarm(entry);
        return;
      }
      Promise.resolve(result)
        .then(function () {
          onAfterReset();
        })
        .catch(function (error) {
          log('settings section-reset "' + entry.key + '" failed: ' + describeError(error));
        })
        .then(
          function settleOk() { entry.inFlight = false; disarm(entry); },
          function settleErr() { entry.inFlight = false; disarm(entry); }
        );
    }

    function arm(entry) {
      if (entry.armed || entry.inFlight) return; // idempotent
      // Degenerate state: without the action-button builder there is nothing
      // to render the Confirm/Cancel pair with -- arming would hide the
      // trigger and strand the user until the timeout. Fall back to the
      // pre-two-step behavior (direct reset on click) instead.
      if (!actionButton) {
        confirmReset(entry);
        return;
      }
      entry.armed = true;
      entry.container.classList.add('settings-reset-confirm');
      entry.container.setAttribute('data-armed', 'true');
      entry.trigger.hidden = true;
      var html = actionButton
        ? '<span class="settings-reset-confirm-label">Reset all?</span>'
          + actionButton({ id: 'confirm', label: 'Confirm', variant: 'danger', size: 'sm', className: 'settings-reset-confirm-confirm' })
          + actionButton({ id: 'cancel', label: 'Cancel', variant: 'ghost', size: 'sm', className: 'settings-reset-confirm-cancel' })
        : '';
      entry.confirmNodes = childElementsFromHtml(documentRef, html);
      entry.confirmNodes.forEach(function (node) { entry.container.appendChild(node); });
      var confirmBtn = entry.container.querySelector('[data-action="confirm"]');
      var cancelBtn = entry.container.querySelector('[data-action="cancel"]');
      var onConfirm = function () { confirmReset(entry); };
      var onCancel = function () { if (!entry.inFlight) disarm(entry); };
      if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      entry._disposeConfirmButtons = function () {
        if (confirmBtn) confirmBtn.removeEventListener('click', onConfirm);
        if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
      };
      entry.timer = setTimeoutFn(function () { disarm(entry); }, armTimeoutMs);
    }

    function mountSectionEntry(key, triggerId) {
      if (!documentRef || typeof documentRef.getElementById !== 'function') return null;
      var trigger = documentRef.getElementById(triggerId);
      if (!trigger) return null;
      var container = (typeof trigger.closest === 'function' && trigger.closest('.settings-actions')) || trigger.parentElement;
      if (!container) return null;
      var entry = {
        key: key,
        trigger: trigger,
        container: container,
        armed: false,
        inFlight: false,
        timer: null,
        confirmNodes: [],
      };
      var onTriggerClick = function () { arm(entry); };
      var onDocumentClick = function (event) {
        if (!entry.armed) return;
        var target = event && event.target;
        if (target && container.contains(target)) return;
        disarm(entry);
      };
      trigger.addEventListener('click', onTriggerClick);
      documentRef.addEventListener('click', onDocumentClick, true);
      entry._dispose = function () {
        disarm(entry);
        trigger.removeEventListener('click', onTriggerClick);
        documentRef.removeEventListener('click', onDocumentClick, true);
      };
      return entry;
    }

    // ── lifecycle ────────────────────────────────────────────────────────

    function mount() {
      if (mounted) return;
      mounted = true;
      fieldEntries = APPEARANCE_FIELD_MAP.map(mountFieldEntry).filter(Boolean);
      watchDisposers = WATCH_ONLY_SELECT_IDS.map(mountWatchOnly).filter(Boolean);
      sectionEntries = [
        mountSectionEntry('appearance', 'appearanceResetButton'),
      ].filter(Boolean);
      syncAllVisibility();
    }

    function dispose() {
      if (!mounted) return;
      mounted = false;
      fieldEntries.forEach(function (entry) { if (entry._dispose) entry._dispose(); });
      sectionEntries.forEach(function (entry) { if (entry._dispose) entry._dispose(); });
      watchDisposers.forEach(function (fn) { fn(); });
      fieldEntries = [];
      sectionEntries = [];
      watchDisposers = [];
    }

    return {
      mount: mount,
      dispose: dispose,
      syncVisibility: syncAllVisibility,
      // Test/debug seams.
      getFieldEntries: function () { return fieldEntries.slice(); },
      getSectionEntries: function () { return sectionEntries.slice(); },
    };
  }

  return {
    createSettingsFieldReset: createSettingsFieldReset,
    APPEARANCE_FIELD_MAP: APPEARANCE_FIELD_MAP,
  };
});
