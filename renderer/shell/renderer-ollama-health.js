/* renderer/shell/renderer-ollama-health.js
 *
 * Renderer-only Ollama health UI consuming the feature-flagged
 * `window.jennyShell.ollamaTray` bridge. It fails soft when the bridge is
 * unavailable or the flag is off.
 *
 * Remediation actions run only from an explicit click.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererOllamaHealth = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var GROUP_ID = 'ollamaHealthGroup';
  // Card-scoped selector — see renderer-model-library.js's identical comment:
  // the settings NAV items carry the same data-settings-section attribute and
  // precede the cards in the DOM, so a bare attribute selector would mount
  // into the nav sidebar instead of the card.
  var MODELS_SECTION_SELECTOR = '.settings-card[data-settings-section="models"]';

  function resolveStringUtils() {
    return (root && root.stringUtils)
      || (typeof require === 'function' ? require('../shared/string-utils') : null)
      || {};
  }

  function resolveActionButton() {
    return (root && root.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null)
      || null;
  }

  var escapeHtml = resolveStringUtils().escapeHtml || function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  function boundedStatusMessage(value, fallback) {
    var message = String(value && value.message ? value.message : value || '').trim();
    if (!message) return fallback;
    return message
      .replace(/\b[A-Za-z]:\\[^\s]+/g, '[local path]')
      .slice(0, 240);
  }

  function describeTrayProcesses(trayProcesses) {
    var list = Array.isArray(trayProcesses) ? trayProcesses : [];
    if (!list.length) {
      return 'Not running';
    }
    return list
      .map(function (proc) {
        var name = proc && proc.name ? String(proc.name) : 'process';
        var pid = proc && proc.pid != null ? ' (pid ' + proc.pid + ')' : '';
        return name + pid;
      })
      .join(', ');
  }

  function describeStartupShortcuts(startupShortcuts) {
    var list = Array.isArray(startupShortcuts) ? startupShortcuts : [];
    return list.length ? list.join(', ') : 'None';
  }

  function buildGroupHtml(view) {
    var actionButton = resolveActionButton();
    var disabledForPlatform = view.status.supported === false;
    var busy = view.busyAction !== '';

    var platformNoteHtml = disabledForPlatform
      ? '<p class="settings-note ollama-health-platform-note">Not applicable on this platform.</p>'
      : '';

    var trayLabel = view.status.detected || (view.status.trayProcesses || []).length
      ? describeTrayProcesses(view.status.trayProcesses)
      : 'Not running';
    var shortcutsLabel = describeStartupShortcuts(view.status.startupShortcuts);

    var rowsHtml = ''
      + '<div class="settings-field-row ollama-health-row">'
      + '<div class="settings-field-row-text">'
      + '<span class="settings-field-label">Tray app</span>'
      + '<p class="settings-field-description">' + escapeHtml(trayLabel) + '</p>'
      + '</div>'
      + '</div>'
      + '<div class="settings-field-row ollama-health-row">'
      + '<div class="settings-field-row-text">'
      + '<span class="settings-field-label">Startup shortcut(s)</span>'
      + '<p class="settings-field-description">' + escapeHtml(shortcutsLabel) + '</p>'
      + '</div>'
      + '</div>';

    var buttonsHtml = ''
      + actionButton({
        plain: true,
        className: 'settings-secondary',
        label: view.busyAction === 'recheck' ? 'Checking…' : 'Re-check',
        disabled: busy,
        dataset: { 'ollama-health-action': 'recheck' },
      })
      + actionButton({
        plain: true,
        className: 'settings-primary',
        label: view.busyAction === 'quit' ? 'Quitting…' : 'Quit tray app',
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'quit' },
      })
      + actionButton({
        plain: true,
        className: 'settings-secondary',
        label: view.busyAction === 'disable' ? 'Disabling…' : 'Disable Startup shortcut',
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'disable' },
      })
      + actionButton({
        plain: true,
        className: 'settings-secondary',
        label: view.busyAction === 'restart' ? 'Restarting…' : 'Restart engine',
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'restart' },
      })
      + actionButton({
        plain: true,
        className: 'settings-secondary',
        label: 'Open Diagnostics',
        disabled: busy,
        dataset: { 'ollama-health-action': 'diagnostics' },
      });

    return ''
      + '<div class="settings-group ollama-health-group" role="group" aria-labelledby="ollamaHealthHeading" id="' + GROUP_ID + '">'
      + '<h4 class="settings-group-heading" id="ollamaHealthHeading">Ollama engine health</h4>'
      + '<p class="settings-group-copy">Check for the Ollama tray app, which can silently kill Jenny\'s managed engine.</p>'
      + platformNoteHtml
      + rowsHtml
      + '<div class="settings-actions">' + buttonsHtml + '</div>'
      + '<div class="settings-note ollama-health-status" aria-live="polite">' + escapeHtml(view.statusMessage || '') + '</div>'
      + '</div>';
  }

  function createOllamaHealthController(deps) {
    var d = deps || {};
    var state = d.state || {};
    var windowRef = d.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var documentRef = d.documentRef || windowRef.document || null;
    var appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : function noop() {};
    var setActiveView = typeof d.setActiveView === 'function' ? d.setActiveView : function noop() {};

    var mountedRoot = null;
    var disposed = false;
    var requestGeneration = 0;

    var view = {
      status: { supported: true, detected: false, trayProcesses: [], startupShortcuts: [] },
      busyAction: '',
      statusMessage: '',
    };

    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.ollama_tray_remediation === true
      );
    }

    function findModelsCard() {
      if (!documentRef || typeof documentRef.querySelector !== 'function') {
        return null;
      }
      return documentRef.querySelector(MODELS_SECTION_SELECTOR);
    }

    function removeExistingGroup() {
      var card = findModelsCard();
      var existing = card ? card.querySelector('#' + GROUP_ID) : (documentRef && documentRef.getElementById(GROUP_ID));
      if (existing && existing.parentNode) {
        existing.parentNode.removeChild(existing);
      }
    }

    function render() {
      if (disposed) return;
      if (!isFeatureEnabled()) {
        removeExistingGroup();
        mountedRoot = null;
        return;
      }
      var card = findModelsCard();
      if (!card) {
        return;
      }
      var html = buildGroupHtml(view);
      var existing = card.querySelector('#' + GROUP_ID);
      if (existing) {
        existing.outerHTML = html;
      } else {
        card.insertAdjacentHTML('beforeend', html);
      }
      mountedRoot = card.querySelector('#' + GROUP_ID);
    }

    function getBridge() {
      return (windowRef.jennyShell && windowRef.jennyShell.ollamaTray) || null;
    }

    function refresh() {
      if (disposed) return Promise.resolve();
      if (!isFeatureEnabled()) {
        render();
        return Promise.resolve();
      }
      var bridge = getBridge();
      if (!bridge || typeof bridge.status !== 'function') {
        view.statusMessage = 'Ollama engine health is unavailable right now.';
        render();
        return Promise.resolve();
      }
      var generation = ++requestGeneration;
      return Promise.resolve()
        .then(function () { return bridge.status(); })
        .then(function (result) {
          if (disposed || generation !== requestGeneration) return;
          if (result && result.ok) {
            view.status = {
              supported: result.supported !== false,
              detected: Boolean(result.detected),
              trayProcesses: Array.isArray(result.trayProcesses) ? result.trayProcesses : [],
              startupShortcuts: Array.isArray(result.startupShortcuts) ? result.startupShortcuts : [],
            };
          } else {
            view.statusMessage = boundedStatusMessage(result && result.reason, 'Could not read Ollama engine health.');
          }
          render();
        })
        .catch(function (error) {
          if (disposed || generation !== requestGeneration) return;
          view.statusMessage = boundedStatusMessage(error, 'Could not read Ollama engine health.');
          appendClientLog('WARN', 'ollama_health.status_failed', { message: view.statusMessage });
          render();
        });
    }

    function runAction(actionKey, methodName, successMessage) {
      if (view.busyAction) {
        return Promise.resolve();
      }
      var bridge = getBridge();
      var fn = bridge && bridge[methodName];
      if (typeof fn !== 'function') {
        view.statusMessage = 'That action is unavailable right now.';
        render();
        return Promise.resolve();
      }
      view.busyAction = actionKey;
      view.statusMessage = '';
      render();
      var generation = ++requestGeneration;
      return Promise.resolve()
        .then(function () { return fn(); })
        .then(function (result) {
          if (disposed || generation !== requestGeneration) return;
          view.busyAction = '';
          if (result && result.ok) {
            view.statusMessage = typeof successMessage === 'function' ? successMessage(result) : successMessage;
          } else {
            view.statusMessage = boundedStatusMessage(result && result.reason, 'That action did not complete.');
            appendClientLog('WARN', 'ollama_health.' + actionKey + '_failed', { message: view.statusMessage });
          }
          return refresh();
        })
        .catch(function (error) {
          if (disposed || generation !== requestGeneration) return;
          view.busyAction = '';
          view.statusMessage = boundedStatusMessage(error, 'That action failed.');
          appendClientLog('WARN', 'ollama_health.' + actionKey + '_failed', { message: view.statusMessage });
          render();
        });
    }

    function handleRecheck() {
      view.statusMessage = '';
      return refresh();
    }

    function handleQuit() {
      return runAction('quit', 'quitTrayApp', function (result) {
        var killed = Array.isArray(result.killedPids) ? result.killedPids : [];
        return killed.length
          ? 'Quit the tray app (' + killed.length + ' process' + (killed.length === 1 ? '' : 'es') + ' removed).'
          : 'Tray app was not running.';
      });
    }

    function handleDisable() {
      return runAction('disable', 'disableStartupShortcut', function (result) {
        var disabled = Array.isArray(result.disabled) ? result.disabled : [];
        return disabled.length ? 'Disabled: ' + disabled.join(', ') + '.' : 'No Startup shortcut was found.';
      });
    }

    function handleRestart() {
      return runAction('restart', 'restartEngine', function (result) {
        return result.running ? 'Engine restarted and is running.' : 'Engine restart requested.';
      });
    }

    function handleClick(event) {
      var target = event && event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      var actionEl = target.closest('[data-ollama-health-action]');
      if (!actionEl) {
        return;
      }
      var action = actionEl.getAttribute('data-ollama-health-action');
      if (action === 'recheck') {
        handleRecheck();
      } else if (action === 'quit') {
        handleQuit();
      } else if (action === 'disable') {
        handleDisable();
      } else if (action === 'restart') {
        handleRestart();
      } else if (action === 'diagnostics') {
        setActiveView('logs');
      }
    }

    // Idempotent feature (re)activation. Re-invoked post-hydration by
    // reactivateSettingsSections — the renderer boot seed omits
    // ollama_tray_remediation, so the flag is false at bind() time (the
    // 0d0118d hydration-race class). refresh() mounts when enabled and removes
    // the group when disabled, so it is safe to call in both states.
    function syncFeatureState() {
      return refresh();
    }

    function bind() {
      if (!documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      syncFeatureState();
    }

    function dispose() {
      disposed = true;
      requestGeneration += 1;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
      }
      removeExistingGroup();
    }

    return {
      bind: bind,
      dispose: dispose,
      render: render,
      refresh: refresh,
      syncFeatureState: syncFeatureState,
      isFeatureEnabled: isFeatureEnabled,
      _view: view,
    };
  }

  return {
    createOllamaHealthController: createOllamaHealthController,
  };
});
