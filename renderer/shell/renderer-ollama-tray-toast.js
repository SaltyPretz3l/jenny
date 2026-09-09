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

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
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
        ? jtn('models.ollama.tray.quitResult', killed.length, { count: killed.length }, 'Quit the Ollama tray app ({count} process).', 'Quit the Ollama tray app ({count} processes).')
        : jt('models.ollama.tray.notRunning', 'Ollama tray app was not running.');
    }
    var reason = normalizeFailureReason(result && result.reason);
    return reason ? jt('models.ollama.tray.quitFailedReason', 'Could not quit the tray app: {reason}', { reason: reason }) : jt('models.ollama.tray.quitFailed', 'Could not quit the tray app.');
  }

  function summarizeDisableResult(result) {
    if (result && result.ok === true) {
      var disabled = Array.isArray(result.disabled) ? result.disabled : [];
      return disabled.length
        ? jt('models.ollama.tray.startupDisabled', 'Disabled Startup shortcut: {shortcuts}.', { shortcuts: disabled.join(', ') })
        : jt('models.ollama.tray.noStartupShortcut', 'No Startup shortcut was found.');
    }
    var reason = normalizeFailureReason(result && result.reason);
    return reason ? jt('models.ollama.tray.disableStartupFailedReason', 'Could not disable the Startup shortcut: {reason}', { reason: reason }) : jt('models.ollama.tray.disableStartupFailed', 'Could not disable the Startup shortcut.');
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
        label: jt('models.ollama.tray.quitApp', 'Quit tray app'),
        kind: 'primary',
        onClick: function onQuitClick() {
          return safeCall(
            bridge && bridge.quitTrayApp ? function () { return bridge.quitTrayApp(); } : null,
            appendClientLog,
            'ollama_tray_remediation.quit_failed'
          ).then(function (result) {
            if (showToast) {
              showToast(summarizeQuitResult(result), {
                title: jt('models.ollama.tray.title', 'Ollama Tray App'),
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
        label: jt('models.ollama.tray.disableStartupShortcut', 'Disable Startup shortcut'),
        kind: 'default',
        onClick: function onDisableClick() {
          return safeCall(
            bridge && bridge.disableStartupShortcut ? function () { return bridge.disableStartupShortcut(); } : null,
            appendClientLog,
            'ollama_tray_remediation.disable_startup_failed'
          ).then(function (result) {
            if (showToast) {
              showToast(summarizeDisableResult(result), {
                title: jt('models.ollama.tray.title', 'Ollama Tray App'),
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
        label: jt('models.ollama.tray.openSettings', 'Open Settings'),
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
      jt('models.ollama.tray.conflictMessage', "The Ollama tray app can silently kill Jenny's engine. Quit it or disable its Startup shortcut to prevent unexpected restarts."),
      {
        title: jt('models.ollama.tray.conflictTitle', 'Ollama Tray App Conflict'),
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
