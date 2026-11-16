/* renderer/shell/renderer-ollama-health.js
 *
 * Renderer-only Ollama health UI consuming the feature-flagged
 * `window.jennyShell.ollamaTray` bridge. It fails soft when the bridge is
 * unavailable or the flag is off. The Ollama row of "Engines and providers"
 * (model-library-services.js) is registered here; the health facts and
 * actions render into that row's Manage drawer.
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

  var jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  var GROUP_ID = 'ollamaHealthGroup';
  var DRAWER_HOST_ID = 'ollamaHealthDrawerHost';
  var SERVICE_ID = 'ollama';
  var SERVICES_READY_EVENT = 'model-library-services-ready';

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

  var escapeHtml = resolveStringUtils().escapeHtml || (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
      return jt('models.ollama.health.notRunning', 'Not running');
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
      ? '<p class="settings-note ollama-health-platform-note">' + escapeHtml(jt('models.ollama.health.notApplicable', 'Not applicable on this platform.')) + '</p>'
      : '';

    var trayLabel = view.status.detected || (view.status.trayProcesses || []).length
      ? describeTrayProcesses(view.status.trayProcesses)
      : jt('models.ollama.health.notRunning', 'Not running');
    var shortcutsLabel = describeStartupShortcuts(view.status.startupShortcuts);

    var rowsHtml = '<div class="eng-facts">'
      + '<span><b>' + escapeHtml(jt('models.ollama.health.trayApp', 'Tray app')) + '</b> ' + escapeHtml(trayLabel) + '</span>'
      + '<span><b>' + escapeHtml(jt('models.ollama.health.startupShortcuts', 'Startup shortcut(s)')) + '</b> ' + escapeHtml(shortcutsLabel) + '</span>'
      + '</div>';

    var buttonsHtml = ''
      + actionButton({
        variant: 'secondary', size: 'sm',
        label: view.busyAction === 'recheck' ? jt('models.ollama.health.checking', 'Checking…') : jt('models.ollama.health.recheck', 'Re-check'),
        disabled: busy,
        dataset: { 'ollama-health-action': 'recheck' },
      })
      // The tray actions have nothing to act on unless the tray app or its Startup shortcut was found.
      + (view.status.detected ? actionButton({
        variant: 'primary', size: 'sm',
        label: view.busyAction === 'quit' ? jt('models.ollama.health.quitting', 'Quitting…') : jt('models.ollama.health.quitTrayApp', 'Quit tray app'),
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'quit' },
      })
      + actionButton({
        variant: 'secondary', size: 'sm',
        label: view.busyAction === 'disable' ? jt('models.ollama.health.disabling', 'Disabling…') : jt('models.ollama.health.disableStartupShortcut', 'Disable Startup shortcut'),
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'disable' },
      }) : '')
      + actionButton({
        variant: 'secondary', size: 'sm',
        label: view.busyAction === 'restart' ? jt('models.ollama.health.restarting', 'Restarting…') : jt('models.ollama.health.restartEngine', 'Restart engine'),
        disabled: busy || disabledForPlatform,
        dataset: { 'ollama-health-action': 'restart' },
      })
      + actionButton({
        variant: 'ghost', size: 'sm',
        label: jt('models.ollama.health.openDiagnostics', 'Open Diagnostics'),
        disabled: busy,
        dataset: { 'ollama-health-action': 'diagnostics' },
      });

    return '<div class="ollama-health-group" id="' + GROUP_ID + '">'
      + platformNoteHtml
      + rowsHtml
      + '<div class="eng-buttons">' + buttonsHtml + '</div>'
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

    var disposed = false;
    var requestGeneration = 0;

    var view = {
      status: { supported: true, detected: false, trayProcesses: [], startupShortcuts: [] },
      busyAction: '',
      statusMessage: '',
      probing: false,
      unavailable: false,
    };

    function isFeatureEnabled() {
      return Boolean(
        state
        && state.features
        && state.features.featureFlags
        && state.features.featureFlags.ollama_tray_remediation === true
      );
    }

    function services() {
      if (typeof d.services === 'function') return d.services() || null;
      var module = windowRef.modelLibraryServices || root.modelLibraryServices;
      return module && typeof module.shared === 'function' ? module.shared({ documentRef: documentRef, windowRef: windowRef }) : null;
    }

    // The row's status, in priority order: a tray app that can kill the
    // engine, then an unreadable status, then a check in flight.
    function rowStatus() {
      // Without the tray check nothing is probed, so the row claims no health it has not read.
      if (!isFeatureEnabled()) return { text: jt('settings.models.services.ollama.builtIn', 'Built in'), tone: 'off', set: true };
      if (view.status.detected) return { text: jt('settings.models.services.ollama.trayRunning', 'Tray app running'), tone: 'warn', set: true };
      if (view.unavailable) return { text: jt('settings.models.services.ollama.unavailable', 'Status unavailable'), tone: 'off', set: true };
      if (view.probing) return { text: jt('models.ollama.health.checking', 'Checking…'), tone: 'busy', set: true };
      return { text: jt('settings.models.services.ollama.ready', 'Ready'), tone: 'ready', set: true };
    }

    var serviceEntry = {
      id: SERVICE_ID, kind: 'chat', order: 10, name: 'Ollama',
      what: jt('settings.models.services.ollama.what', 'Runs Ollama models'),
      getStatus: rowStatus,
      renderDrawer: function (body) {
        body.innerHTML = '<p class="mp-quiet">' + escapeHtml(jt('settings.models.services.ollama.description', 'Jenny runs her own Ollama engine. The Ollama tray app can silently stop it.'))
          + '</p><div id="' + DRAWER_HOST_ID + '"></div>';
        render();
      },
    };

    // Registered while the controller is bound, as soon as the (lazily
    // loaded) services module exists; every render retries until then.
    function syncRow() {
      var svc = services();
      if (!svc) return null;
      if (!svc.has(SERVICE_ID)) svc.register(serviceEntry);
      return svc;
    }

    function render() {
      if (disposed) return;
      var svc = syncRow();
      var target = documentRef && documentRef.getElementById ? documentRef.getElementById(DRAWER_HOST_ID) : null;
      if (target) target.innerHTML = isFeatureEnabled() ? buildGroupHtml(view) : '';
      if (svc) svc.refresh(SERVICE_ID);
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
        view.statusMessage = jt('models.ollama.health.unavailable', 'Ollama engine health is unavailable right now.');
        view.unavailable = true;
        render();
        return Promise.resolve();
      }
      var generation = ++requestGeneration;
      view.probing = true;
      render();
      return Promise.resolve()
        .then(function () { return bridge.status(); })
        .then(function (result) {
          if (disposed || generation !== requestGeneration) return;
          view.probing = false;
          view.unavailable = !(result && result.ok);
          if (result && result.ok) {
            view.status = {
              supported: result.supported !== false,
              detected: Boolean(result.detected),
              trayProcesses: Array.isArray(result.trayProcesses) ? result.trayProcesses : [],
              startupShortcuts: Array.isArray(result.startupShortcuts) ? result.startupShortcuts : [],
            };
          } else {
            view.statusMessage = boundedStatusMessage(result && result.reason, jt('models.ollama.health.readFailed', 'Could not read Ollama engine health.'));
          }
          render();
        })
        .catch(function (error) {
          if (disposed || generation !== requestGeneration) return;
          view.probing = false;
          view.unavailable = true;
          view.statusMessage = boundedStatusMessage(error, jt('models.ollama.health.readFailed', 'Could not read Ollama engine health.'));
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
        view.statusMessage = jt('models.ollama.health.actionUnavailable', 'That action is unavailable right now.');
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
            view.statusMessage = boundedStatusMessage(result && result.reason, jt('models.ollama.health.actionIncomplete', 'That action did not complete.'));
            appendClientLog('WARN', 'ollama_health.' + actionKey + '_failed', { message: view.statusMessage });
          }
          return refresh();
        })
        .catch(function (error) {
          if (disposed || generation !== requestGeneration) return;
          view.busyAction = '';
          view.statusMessage = boundedStatusMessage(error, jt('models.ollama.health.actionFailed', 'That action failed.'));
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
          ? jtn('models.ollama.health.trayProcessesRemoved', killed.length, { count: killed.length }, 'Quit the tray app ({count} process removed).', 'Quit the tray app ({count} processes removed).')
          : jt('models.ollama.health.trayNotRunning', 'Tray app was not running.');
      });
    }

    function handleDisable() {
      return runAction('disable', 'disableStartupShortcut', function (result) {
        var disabled = Array.isArray(result.disabled) ? result.disabled : [];
        return disabled.length ? 'Disabled: ' + disabled.join(', ') + '.' : jt('models.ollama.health.noStartupShortcut', 'No Startup shortcut was found.');
      });
    }

    function handleRestart() {
      return runAction('restart', 'restartEngine', function (result) {
        return result.running ? jt('models.ollama.health.restartedRunning', 'Engine restarted and is running.') : jt('models.ollama.health.restartRequested', 'Engine restart requested.');
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
    // 0d0118d hydration-race class). refresh() fills the drawer when enabled and
    // clears it when disabled, so it is safe to call in both states.
    function syncFeatureState() {
      return refresh();
    }

    function bind() {
      if (!documentRef || typeof documentRef.addEventListener !== 'function') {
        return;
      }
      documentRef.addEventListener('click', handleClick);
      // The services module loads with the Settings page, after this controller binds.
      documentRef.addEventListener(SERVICES_READY_EVENT, render);
      syncRow();
      syncFeatureState();
    }

    function dispose() {
      disposed = true;
      requestGeneration += 1;
      if (documentRef && typeof documentRef.removeEventListener === 'function') {
        documentRef.removeEventListener('click', handleClick);
        documentRef.removeEventListener(SERVICES_READY_EVENT, render);
      }
      var svc = services();
      if (svc) svc.unregister(SERVICE_ID);
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
