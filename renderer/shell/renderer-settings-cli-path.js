/**
 * renderer/shell/renderer-settings-cli-path.js
 *
 * Settings > Profile, data & updates > About & Updates: the "Command-line tool"
 * row, appended under the update check when the lazily loaded Settings page is
 * ready. On a packaged Windows install it shows the resolved resources\bin path
 * and one button that adds it to, or removes it from, the user PATH through
 * jennyShell.cli.path.*; Linux and macOS installs show the export line; a
 * source checkout shows the npm link hint. The renderer never sends a path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCliPath = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackT(key, fallback) {
    return fallback;
  }

  function resolveT() {
    return (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || fallbackT;
  }

  function errorMessage(jt, result) {
    var reason = result && typeof result.reason === 'string' ? result.reason : '';
    if (reason === 'path_changed') return jt('settings.cliPath.errorChanged', 'Your PATH changed while Jenny was updating it. Try again.');
    if (reason === 'busy') return jt('settings.cliPath.errorBusy', 'Another change is still applying.');
    if (reason === 'shim_missing') return jt('settings.cliPath.errorShimMissing', 'The command-line tool is missing from this install.');
    if (reason === 'path_too_long') return jt('settings.cliPath.errorTooLong', 'Your PATH is too long to add another folder.');
    return jt('settings.cliPath.errorFailed', 'Jenny could not read or change your PATH.');
  }

  /**
   * Pure view model for one state. `busy` is '', 'install' or 'remove'.
   * Returns { copy, path, manual, button: null | { action, label, disabled } }.
   */
  function describeView(state, busy, translate) {
    var jt = translate || resolveT();
    if (!state) {
      return { copy: jt('settings.cliPath.checking', 'Checking your PATH…'), path: '', manual: '', button: null };
    }
    if (state.supported !== true) {
      if (state.reason === 'manual' && state.manualCommand) {
        return {
          copy: jt('settings.cliPath.manual', 'To run jenny from a terminal, add this line to your shell profile:'),
          path: '', manual: String(state.manualCommand), button: null,
        };
      }
      if (state.reason === 'appimage') {
        return { copy: jt('settings.cliPath.appImage', 'The AppImage moves on every launch. Install the deb to get a jenny command.'), path: '', manual: '', button: null };
      }
      return { copy: jt('settings.cliPath.sourceCheckout', 'From a source checkout, run npm link to put jenny on your PATH.'), path: '', manual: '', button: null };
    }
    var onPath = state.onPath === true;
    var removing = busy === 'remove' || (busy === '' && onPath);
    var label;
    if (busy === 'install') label = jt('settings.cliPath.adding', 'Adding…');
    else if (busy === 'remove') label = jt('settings.cliPath.removing', 'Removing…');
    else if (onPath) label = jt('settings.cliPath.remove', 'Remove from PATH');
    else label = jt('settings.cliPath.add', 'Add to PATH');
    return {
      copy: onPath
        ? jt('settings.cliPath.onPath', 'On your PATH. Open a new terminal to use jenny.')
        : jt('settings.cliPath.offPath', 'Run Jenny from any terminal with the jenny command.'),
      path: String(state.binDir || ''),
      manual: '',
      button: { action: removing ? 'remove' : 'install', label: label, disabled: busy !== '' },
    };
  }

  function createCliPathSettings(options) {
    var opts = options || {};
    var mount = opts.mount;
    var api = opts.api;
    var actionButton = opts.actionButton;
    var documentRef = opts.documentRef || (mount && mount.ownerDocument);
    var jt = opts.t || resolveT();
    if (!mount || !api || typeof api.getState !== 'function' || typeof actionButton !== 'function' || !documentRef) return null;

    var state = null;
    var busy = '';
    var error = '';
    var disposed = false;

    mount.textContent = '';
    var row = documentRef.createElement('div');
    row.className = 'settings-setup-row cli-path-settings-row';
    var text = documentRef.createElement('div');
    text.className = 'cli-path-settings-text';
    var label = documentRef.createElement('div');
    label.className = 'settings-note';
    label.textContent = jt('settings.cliPath.label', 'Command-line tool');
    var copy = documentRef.createElement('p');
    copy.className = 'settings-group-copy';
    var pathLine = documentRef.createElement('code');
    pathLine.className = 'cli-path-settings-path';
    var manualLine = documentRef.createElement('code');
    manualLine.className = 'cli-path-settings-manual';
    var status = documentRef.createElement('p');
    status.className = 'settings-note cli-path-settings-status';
    status.setAttribute('aria-live', 'polite');
    status.dataset.activityState = 'error';
    var actions = documentRef.createElement('div');
    actions.className = 'settings-actions cli-path-settings-actions';
    actions.innerHTML = actionButton({ id: 'cli-path-toggle', label: '', variant: 'secondary' });
    var button = actions.querySelector('button');
    text.append(label, copy, pathLine, manualLine, status);
    row.append(text, actions);
    mount.appendChild(row);

    function render() {
      if (disposed) return;
      var view = describeView(state, busy, jt);
      copy.textContent = view.copy;
      pathLine.textContent = view.path;
      pathLine.hidden = !view.path;
      manualLine.textContent = view.manual;
      manualLine.hidden = !view.manual;
      status.textContent = error;
      status.hidden = !error;
      actions.hidden = !view.button;
      if (view.button && button) {
        button.textContent = view.button.label;
        button.disabled = view.button.disabled;
        button.dataset.cliPathAction = view.button.action;
      }
    }

    function refresh(keepError) {
      return Promise.resolve()
        .then(function () { return api.getState(); })
        .then(function (result) {
          if (disposed) return;
          state = result && typeof result === 'object' ? result : null;
          if (!keepError) error = '';
          if (!state || state.ok !== true) error = errorMessage(jt, state);
          render();
        })
        .catch(function () {
          if (disposed) return;
          error = errorMessage(jt, null);
          render();
        });
    }

    function act(kind) {
      var call = api[kind];
      if (busy || typeof call !== 'function') return Promise.resolve();
      busy = kind;
      error = '';
      render();
      return Promise.resolve()
        .then(function () { return call(); })
        .then(function (result) {
          if (disposed) return null;
          busy = '';
          if (result && result.ok === true) {
            state = result;
            render();
            return null;
          }
          error = errorMessage(jt, result);
          render();
          return refresh(true);
        })
        .catch(function () {
          if (disposed) return null;
          busy = '';
          error = errorMessage(jt, null);
          render();
          return refresh(true);
        });
    }

    function onClick(event) {
      var target = event.target && event.target.closest ? event.target.closest('[data-action="cli-path-toggle"]') : null;
      if (!target || target.disabled) return;
      act(target.dataset.cliPathAction === 'remove' ? 'remove' : 'install');
    }

    actions.addEventListener('click', onClick);
    render();
    var ready = refresh(false);

    return {
      ready: ready,
      refresh: refresh,
      act: act,
      dispose: function () {
        disposed = true;
        actions.removeEventListener('click', onClick);
      },
    };
  }

  var GROUP_SELECTOR = '[data-settings-merged-section="aboutUpdates"]';
  var MOUNT_ID = 'cliPathSettingsMount';

  // Called once the Settings page group is loaded (renderer-app-controller-composition).
  function bindCliPathSettings(windowRef, registerCleanup) {
    var documentRef = windowRef && windowRef.document;
    var api = windowRef && windowRef.jennyShell && windowRef.jennyShell.cli && windowRef.jennyShell.cli.path;
    var group = documentRef && documentRef.querySelector(GROUP_SELECTOR);
    if (!group || !api || documentRef.getElementById(MOUNT_ID)) return null;
    var mount = documentRef.createElement('div');
    mount.id = MOUNT_ID;
    group.appendChild(mount);
    var controller = createCliPathSettings({ mount: mount, api: api, actionButton: windowRef.inventoryActionButton, documentRef: documentRef });
    if (!controller) {
      mount.remove();
      return null;
    }
    if (typeof registerCleanup === 'function') {
      registerCleanup(function () {
        controller.dispose();
        mount.remove();
      });
    }
    return controller;
  }

  return {
    bindCliPathSettings: bindCliPathSettings,
    createCliPathSettings: createCliPathSettings,
    describeView: describeView,
    errorMessage: errorMessage,
  };
});
