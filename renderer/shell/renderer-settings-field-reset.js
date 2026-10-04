/**
 * renderer/shell/renderer-settings-field-reset.js
 *
 * The guarded two-step "Reset Appearance" section reset (arm, then confirm
 * within 5 s; one reset in flight). Per-field Revert belongs to the shared
 * Settings binding (renderer-settings-field-binding.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsFieldReset = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var DEFAULT_ARM_TIMEOUT_MS = 5000;

  function noopLog() {}

  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message) {
      return error.message;
    }
    return String(error == null ? jt('settings.fieldReset.unknownError', 'Unknown error') : error);
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
   * @param {{ appearance?: function }} [deps.resetActions] - the section-reset
   *   callbacks (each returns a value or a Promise). Confirm invokes
   *   `resetActions[key]()` verbatim.
   * @param {function} [deps.onAfterReset] - called after a settled
   *   section-reset action.
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
    var onAfterReset = typeof d.onAfterReset === 'function' ? d.onAfterReset : function noop() {};
    var log = typeof d.log === 'function' ? d.log : noopLog;
    var resetActions = d.resetActions && typeof d.resetActions === 'object' ? d.resetActions : {};
    var armTimeoutMs = typeof d.armTimeoutMs === 'number' && d.armTimeoutMs >= 0 ? d.armTimeoutMs : DEFAULT_ARM_TIMEOUT_MS;
    var setTimeoutFn = typeof d.setTimeoutFn === 'function' ? d.setTimeoutFn : setTimeout;
    var clearTimeoutFn = typeof d.clearTimeoutFn === 'function' ? d.clearTimeoutFn : clearTimeout;
    var actionButton = resolveActionButton(d);

    var mounted = false;
    var sectionEntries = [];

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
        ? '<span class="settings-reset-confirm-label">' + String(jt('settings.fieldReset.resetAll', 'Reset all?')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;') + '</span>'
          + actionButton({ id: 'confirm', label: jt('settings.fieldReset.confirm', 'Confirm'), variant: 'danger', size: 'sm', className: 'settings-reset-confirm-confirm' })
          + actionButton({ id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'ghost', size: 'sm', className: 'settings-reset-confirm-cancel' })
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
      sectionEntries = [
        mountSectionEntry('appearance', 'appearanceResetButton'),
      ].filter(Boolean);
    }

    function dispose() {
      if (!mounted) return;
      mounted = false;
      sectionEntries.forEach(function (entry) { if (entry._dispose) entry._dispose(); });
      sectionEntries = [];
    }

    return {
      mount: mount,
      dispose: dispose,
      // Test/debug seam.
      getSectionEntries: function () { return sectionEntries.slice(); },
    };
  }

  return {
    createSettingsFieldReset: createSettingsFieldReset,
  };
});
