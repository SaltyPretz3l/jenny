/**
 * renderer/shell/renderer-settings-field-reset.js
 *
 * The guarded "Reset Appearance" section reset: a confirm strip under the button
 * (the Projects delete strip's shape; no timer; one reset in flight). Per-field
 * Revert belongs to the shared Settings binding (renderer-settings-field-binding.js).
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

  /**
   * @param {object} deps
   * @param {Document} deps.documentRef
   * @param {{ appearance?: function }} [deps.resetActions] - the section-reset
   *   callbacks (each returns a value or a Promise). Confirm invokes
   *   `resetActions[key]()` verbatim.
   * @param {object} [deps.confirmLabels] - the strip's question per section key
   *   (defaults to "Reset all?").
   * @param {object} [deps.confirmDetails] - the sentence that says what is lost, per section key.
   * @param {function} [deps.onAfterReset] - called after a settled
   *   section-reset action.
   * @param {function} [deps.log]
   * @param {object} [deps.actionButton] - test seam; defaults to the shared
   *   renderer/inventory/action-button.js module.
   */
  function createSettingsFieldReset(deps) {
    var d = deps || {};
    var documentRef = d.documentRef || null;
    var onAfterReset = typeof d.onAfterReset === 'function' ? d.onAfterReset : function noop() {};
    var log = typeof d.log === 'function' ? d.log : noopLog;
    var resetActions = d.resetActions && typeof d.resetActions === 'object' ? d.resetActions : {};
    var confirmLabels = d.confirmLabels && typeof d.confirmLabels === 'object' ? d.confirmLabels : {};
    var confirmDetails = d.confirmDetails && typeof d.confirmDetails === 'object' ? d.confirmDetails : {};
    var actionButton = resolveActionButton(d);

    var mounted = false;
    var sectionEntries = [];

    // ── section reset: the confirm strip ────────────────────────────────

    function disarm(entry) {
      if (!entry.armed) return;
      entry.armed = false;
      // Focus inside the strip would fall to the page when it is removed; it goes back to the trigger.
      var active = documentRef && documentRef.activeElement;
      var hadFocus = !!active && entry.strip.contains(active);
      entry.strip.remove();
      entry.strip = null;
      if (!hadFocus) return;
      // A confirmed reset leaves the trigger disabled (nothing left to reset): the page heading takes focus.
      var card = typeof entry.trigger.closest === 'function' ? entry.trigger.closest('.settings-card') : null;
      var back = entry.trigger.disabled ? card && card.querySelector('h3') : entry.trigger;
      if (!back || typeof back.focus !== 'function') return;
      if (back !== entry.trigger && !back.hasAttribute('tabindex')) back.setAttribute('tabindex', '-1');
      back.focus();
    }

    function clearFailure(entry) {
      if (entry.errorNode && entry.errorNode.parentNode) entry.errorNode.parentNode.removeChild(entry.errorNode);
      entry.errorNode = null;
    }

    // A failed reset stays visible beside its trigger until the next arm: the
    // confirm group disarms either way, so a log line alone would be silent.
    function reportFailure(entry, error) {
      log('settings section-reset "' + entry.key + '" failed: ' + describeError(error));
      clearFailure(entry);
      if (documentRef && typeof documentRef.createElement === 'function') {
        var node = documentRef.createElement('span');
        node.className = 'settings-reset-confirm-label settings-reset-error';
        node.setAttribute('role', 'alert');
        node.textContent = jt('settings.fieldReset.failed', 'Could not reset: {reason}', { reason: describeError(error) });
        entry.container.appendChild(node);
        entry.errorNode = node;
      }
    }

    function confirmReset(entry) {
      if (entry.inFlight) return; // single in-flight guard
      entry.inFlight = true;
      var action = resetActions[entry.key];
      var result;
      try {
        result = typeof action === 'function' ? action() : undefined;
      } catch (error) {
        entry.inFlight = false;
        disarm(entry);
        reportFailure(entry, error);
        return;
      }
      Promise.resolve(result)
        .then(function () {
          // The reset is saved; a repaint failure is logged, not shown as a failed reset.
          try { onAfterReset(); } catch (error) { log('settings section-reset "' + entry.key + '" repaint failed: ' + describeError(error)); }
        }, function (error) {
          reportFailure(entry, error);
        })
        .finally(function () { entry.inFlight = false; disarm(entry); });
    }

    function arm(entry) {
      if (entry.armed || entry.inFlight) return; // idempotent
      clearFailure(entry);
      // Without the action-button builder there is nothing to draw the strip with: reset directly.
      if (!actionButton) {
        confirmReset(entry);
        return;
      }
      var escape = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
      var strip = documentRef.createElement('div');
      var title = confirmLabels[entry.key] || jt('settings.fieldReset.resetAll', 'Reset all?');
      strip.className = 'projects-confirm';
      strip.setAttribute('role', 'group');
      strip.setAttribute('aria-label', title);
      strip.innerHTML = '<p><strong>' + escape(title) + '</strong></p>'
        + (confirmDetails[entry.key] ? '<p>' + escape(confirmDetails[entry.key]) + '</p>' : '')
        + '<div class="settings-actions">'
        + actionButton({ id: 'confirm', label: entry.trigger.textContent.trim(), variant: 'danger', size: 'sm' })
        + actionButton({ id: 'cancel', label: jt('common.cancel', 'Cancel'), variant: 'ghost', size: 'sm' }) + '</div>';
      entry.container.insertAdjacentElement('afterend', strip);
      entry.strip = strip;
      entry.armed = true;
      strip.querySelector('[data-action="confirm"]').addEventListener('click', function () { confirmReset(entry); });
      strip.querySelector('[data-action="cancel"]').addEventListener('click', function () { if (!entry.inFlight) disarm(entry); });
      strip.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape' || entry.inFlight) return;
        event.stopPropagation();
        disarm(entry);
      });
      // The strip opens with focus on Cancel, the safe answer.
      strip.querySelector('[data-action="cancel"]').focus();
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
        strip: null,
        errorNode: null,
      };
      var onTriggerClick = function () { arm(entry); };
      trigger.addEventListener('click', onTriggerClick);
      entry._dispose = function () {
        disarm(entry);
        clearFailure(entry);
        trigger.removeEventListener('click', onTriggerClick);
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
