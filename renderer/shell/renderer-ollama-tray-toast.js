/* renderer/shell/renderer-ollama-tray-toast.js
 *
 * Emits a toast for `ollama.tray_app_conflict_detected`.
 *
 * Depends on the `window.jennyShell.ollamaTray` bridge and the
 * `ollama_tray_remediation` feature flag, and fails soft when either is absent.
 * Toasts are deduplicated per session.
 *
 * Remediation actions run only from an explicit click.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root, require('../shared/log-contract-utils'));
    return;
  }
  root.rendererOllamaTrayToast = factory(root, root.rendererLogContractUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root, logContractUtils) {
  'use strict';

  var TRAY_CONFLICT_EVENT = 'ollama.tray_app_conflict_detected';
  var TOAST_SOURCE = 'ollama_tray_remediation';

  // Show at most once per app session.
  var shownThisSession = false;

  function isFeatureEnabled(featureFlags) {
    return Boolean(featureFlags && featureFlags.ollama_tray_remediation === true);
  }

  function normalizeFailureReason(value) {
    var message = String(value && value.message ? value.message : value || '').trim();
    if (!message) return '';
    var redacted = typeof logContractUtils?.redactLogText === 'function'
      ? logContractUtils.redactLogText(message)
      : message.replace(/\b[A-Za-z]:[\\/][^\s"'`<>|]+/g, '[redacted:path]');
    return redacted.slice(0, 240);
  }

  function summarizeQuitResult(result) {
    if (result && result.ok === true) {
      var killed = Array.isArray(result.killedPids) ? result.killedPids : [];
      return killed.length
        ? 'Quit the Ollama tray app (' + killed.length + ' process' + (killed.length === 1 ? '' : 'es') + ').'
        : 'Ollama tray app was not running.';
    }
    var reason = normalizeFailureReason(result && result.reason);
    return reason ? 'Could not quit the tray app: ' + reason : 'Could not quit the tray app.';
  }

  function summarizeDisableResult(result) {
    if (result && result.ok === true) {
      var disabled = Array.isArray(result.disabled) ? result.disabled : [];
      return disabled.length
        ? 'Disabled Startup shortcut: ' + disabled.join(', ') + '.'
        : 'No Startup shortcut was found.';
    }
    var reason = normalizeFailureReason(result && result.reason);
    return reason ? 'Could not disable the Startup shortcut: ' + reason : 'Could not disable the Startup shortcut.';
  }

  function safeCall(fn, appendClientLog, logEvent) {
    return Promise.resolve()
      .then(function () {
        if (typeof fn !== 'function') {
          return { ok: false, reason: 'unavailable' };
        }
        return fn();
      })
      .catch(function (error) {
        var reason = normalizeFailureReason(error);
        if (typeof appendClientLog === 'function') {
          appendClientLog('WARN', logEvent, {
            message: reason,
          });
        }
        return { ok: false, reason: reason };
      });
  }

  function buildActions(deps) {
    var bridge = deps.bridge || null;
    var showToast = typeof deps.showToast === 'function' ? deps.showToast : null;
    var appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : null;
    var navigate = typeof deps.navigate === 'function' ? deps.navigate : function noopNavigate() {};

    return [
      {
        id: 'quit',
        label: 'Quit tray app',
        kind: 'primary',
        onClick: function onQuitClick() {
          return safeCall(
            bridge && bridge.quitTrayApp ? function () { return bridge.quitTrayApp(); } : null,
            appendClientLog,
            'ollama_tray_remediation.quit_failed'
          ).then(function (result) {
            if (showToast) {
              showToast(summarizeQuitResult(result), {
                title: 'Ollama Tray App',
                tone: result && result.ok ? 'success' : 'warning',
                source: TOAST_SOURCE,
              });
            }
            return result;
          });
        },
      },
      {
        id: 'disable',
        label: 'Disable Startup shortcut',
        kind: 'default',
        onClick: function onDisableClick() {
          return safeCall(
            bridge && bridge.disableStartupShortcut ? function () { return bridge.disableStartupShortcut(); } : null,
            appendClientLog,
            'ollama_tray_remediation.disable_startup_failed'
          ).then(function (result) {
            if (showToast) {
              showToast(summarizeDisableResult(result), {
                title: 'Ollama Tray App',
                tone: result && result.ok ? 'success' : 'warning',
                source: TOAST_SOURCE,
              });
            }
            return result;
          });
        },
      },
      {
        id: 'settings',
        label: 'Open Settings',
        kind: 'default',
        onClick: function onSettingsClick() {
          navigate('models');
        },
      },
    ];
  }

  /**
   * Handle a single incoming log entry. No-op unless the entry is the
   * tray-conflict WARN AND the flag is on. Dedup: shows at most once per
   * app session (module-level guard).
   *
   * @param {Object} entry - a log entry from window.jennyShell.logs.onAppend
   * @param {Object} deps
   * @param {Function} deps.showToast - (message, options) => toastId; mirrors
   *   renderer-shell/renderer-toast-utils.js's showToastMessage
   * @param {Object} [deps.bridge] - window.jennyShell.ollamaTray (or a stub)
   * @param {Object} [deps.featureFlags] - state.features.featureFlags
   * @param {Function} [deps.navigate] - (sectionId) => void; routes to
   *   Settings > <sectionId>, mirrors openSettingsSection
   * @param {Function} [deps.appendClientLog] - (level, event, payload) => void
   */
  function handleOllamaTrayConflictLogEntry(entry, deps) {
    var d = deps || {};
    if (!entry || entry.event !== TRAY_CONFLICT_EVENT) {
      return;
    }
    if (!isFeatureEnabled(d.featureFlags)) {
      return;
    }
    if (shownThisSession) {
      return;
    }
    if (typeof d.showToast !== 'function') {
      return;
    }
    shownThisSession = true;

    var actions = buildActions(d);
    d.showToast(
      "The Ollama tray app can silently kill Jenny's engine. Quit it or disable its Startup shortcut to prevent unexpected restarts.",
      {
        title: 'Ollama Tray App Conflict',
        tone: 'warning',
        sticky: true,
        source: TOAST_SOURCE,
        dedupeKey: TOAST_SOURCE,
        actions: actions,
      }
    );
  }

  return {
    TRAY_CONFLICT_EVENT: TRAY_CONFLICT_EVENT,
    handleOllamaTrayConflictLogEntry: handleOllamaTrayConflictLogEntry,
  };
});
