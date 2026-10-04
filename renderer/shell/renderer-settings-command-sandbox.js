/* renderer/shell/renderer-settings-command-sandbox.js
 *
 * Settings > Tools command sandbox surface. The Electron bridge owns Docker,
 * errors, and persisted state; this controller owns only the bounded view
 * model, one bridge subscription, and the event handlers for this host.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCommandSandboxUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t)
    || globalThis.jennyI18nFallback
    || function (key, fallback, params) {
      if (!params) return fallback;
      return String(fallback).replace(/\{(\w+)\}/g, (match, name) => (
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
      ));
    };

  const VALID_STATES = new Set([
    'disabled', 'unavailable', 'preparing', 'ready', 'busy', 'recovery-required',
  ]);
  const RETRY_STATES = new Set(['unavailable', 'recovery-required']);
  const UNVERIFIED_PLATFORMS = new Set(['linux', 'darwin', 'macos', 'mac']);
  const DEFAULT_PLATFORM = 'unknown';

  function normalizePlatform(value) {
    const platform = String(value || DEFAULT_PLATFORM).trim().toLowerCase();
    if (platform === 'win32' || platform === 'windows') return 'windows';
    if (platform === 'darwin' || platform === 'macos' || platform === 'mac') return 'macos';
    if (platform === 'linux') return 'linux';
    return platform || DEFAULT_PLATFORM;
  }

  function normalizeReason(value) {
    return String(value == null ? '' : value).trim().slice(0, 240);
  }

  function normalizeMessage(value) {
    return String(value == null ? '' : value).trim().slice(0, 500);
  }

  function defaultState(options = {}) {
    const bridge = options.bridge || null;
    const platform = normalizePlatform(bridge?.platform || options.platform);
    return {
      enabled: false,
      state: 'disabled',
      reason: '',
      message: '',
      platform,
      qualified: false,
      workspace: 'disposable_copy',
      network: 'none',
    };
  }

  function normalizeState(rawState, previousState, options = {}) {
    const raw = rawState && typeof rawState === 'object' && !Array.isArray(rawState)
      ? rawState
      : {};
    const fallback = previousState || defaultState(options);
    const platform = normalizePlatform(raw.platform || fallback.platform || options.platform);
    const sourceState = String(raw.state || '').trim().toLowerCase();
    const enabled = raw.enabled === true;
    let state = VALID_STATES.has(sourceState) ? sourceState : '';
    if (!state) state = enabled ? 'ready' : 'disabled';
    return {
      enabled,
      state,
      reason: normalizeReason(raw.reason),
      message: normalizeMessage(raw.message),
      platform,
      // Windows is the only qualified desktop platform. Linux/macOS remain
      // visible and actionable when the bridge reports them, but are marked
      // unverified in the surface.
      qualified: platform === 'windows' && raw.qualified === true,
      workspace: 'disposable_copy',
      network: 'none',
    };
  }

  function errorMessage(error, fallback) {
    const message = normalizeMessage(error?.message || error?.reason || error);
    return message || fallback;
  }

  function platformLabel(platform) {
    if (platform === 'windows') return jt('settings.commandSandbox.platformWindows', 'Windows');
    if (platform === 'linux') return jt('settings.commandSandbox.platformLinux', 'Linux');
    if (platform === 'macos') return jt('settings.commandSandbox.platformMacos', 'macOS');
    return jt('settings.commandSandbox.platformUnknown', 'Unknown platform');
  }

  function stateMessage(state, reason = '') {
    if (reason === 'docker_missing') return jt('settings.commandSandbox.dockerMissing', 'Install and start Docker independently, then Retry.');
    if (reason === 'docker_local_daemon_required') return jt('settings.commandSandbox.localDaemon', 'Select a local Docker context, then Retry. Remote Docker daemons are unavailable.');
    if (reason === 'docker_linux_cgroup_v2_required') return jt('settings.commandSandbox.linuxEngine', 'Start Docker with a Linux engine supporting cgroup v2, then Retry.');
    if (reason === 'snapshot_limit') return jt('settings.commandSandbox.snapshotLimit', 'Choose a workspace within 64 MiB, 2,048 entries and 32 levels, then Retry.');
    if (reason === 'sandbox_workspace_required') return jt('settings.commandSandbox.workspaceRequired', 'Configure a tools workspace before running a command.');
    if (reason.startsWith('snapshot_')) return jt('settings.commandSandbox.snapshotRejected', 'The workspace copy was rejected. Use an ordinary local directory without links or special files, stop concurrent changes, then Retry.');
    const messages = {
      disabled: jt('settings.commandSandbox.messageDisabled', 'Command sandbox is off.'),
      unavailable: jt('settings.commandSandbox.messageUnavailable', 'Docker sandbox is unavailable. Install Docker or check the Docker service.'),
      preparing: jt('settings.commandSandbox.messagePreparing', 'Preparing the Docker sandbox…'),
      ready: jt('settings.commandSandbox.messageReady', 'Docker sandbox is ready for foreground Linux shell commands.'),
      busy: jt('settings.commandSandbox.messageBusy', 'A sandbox command is running.'),
      'recovery-required': jt('settings.commandSandbox.messageRecoveryRequired', 'Sandbox recovery is required before another command can run.'),
    };
    return messages[state] || messages.unavailable;
  }

  function createCommandSandboxController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const host = options.host || documentRef?.getElementById?.('toolsCommandSandboxHost') || null;
    const inventory = options.inventory || windowRef?.inventory || (typeof globalThis !== 'undefined' ? globalThis.inventory : null) || {};
    // The inventory barrel attaches setDisabled to the switch renderer; a bare render function falls back to the module.
    const setSwitchDisabled = inventory.toggleSwitch?.setDisabled
      || (typeof require === 'function' ? require('../inventory/toggle-switch').setDisabled : null);
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge
      : () => options.bridge || windowRef?.jennyShell?.commandSandbox || null;
    let currentState = defaultState({ bridge: getBridge?.(), platform: options.platform });
    let disposed = false;
    let bound = false;
    let unsubscribe = null;
    let actionPromise = null;
    let requestGeneration = 0;
    // The row depends on the Terminal commands switch; the Tools render passes that switch's state.
    let parentOn = true;
    const listeners = [];

    function setState(rawState) {
      if (disposed) return currentState;
      currentState = normalizeState(rawState, currentState, { platform: options.platform });
      render();
      return currentState;
    }

    function setFailure(fallbackState, error, key, fallback) {
      const base = currentState || defaultState({ platform: options.platform });
      setState({
        ...base,
        enabled: fallbackState === 'disabled' ? false : base.enabled,
        state: fallbackState,
        reason: key,
        message: errorMessage(error, fallback),
      });
    }

    // One rule for the locks, so a full render and the in-place parent patch agree.
    function retryLocked() {
      return Boolean(actionPromise) || !parentOn || !getBridge();
    }
    function toggleLocked() {
      return retryLocked() || currentState.state === 'preparing' || currentState.state === 'busy';
    }

    // The binding module loads after this one, so it resolves when a row is built or bound.
    function fieldBinding() {
      return globalThis.rendererSettingsFieldBinding
        || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
    }

    function getMarkup() {
      const state = currentState;
      const parentOff = !parentOn;
      const retryMarkup = typeof inventory.actionButton === 'function' && RETRY_STATES.has(state.state)
        ? inventory.actionButton({
          id: 'commandSandboxRetry', label: jt('settings.commandSandbox.retry', 'Retry'), variant: 'secondary',
          disabled: retryLocked(),
        }) : '';
      const platformMarkup = UNVERIFIED_PLATFORMS.has(state.platform)
        ? jt('settings.commandSandbox.unverifiedPlatform', 'Linux/macOS support is unverified on this build.')
        : state.platform === 'windows'
          ? jt('settings.commandSandbox.qualifiedPlatform', 'Windows is the qualified platform for this build.')
          : jt('settings.commandSandbox.unknownPlatform', 'Platform qualification is unavailable.');
      // A failure is announced from the row's error slot; a state in progress replaces the help.
      const failure = state.reason ? state.message || stateMessage(state.state, state.reason) : '';
      const help = failure || state.state === 'disabled' || state.state === 'ready'
        ? jt('settings.commandSandbox.rowHelp', 'A disposable copy with no network. Needs Docker.')
        : state.message || stateMessage(state.state, state.reason);
      const detail = jt('settings.commandSandbox.rowDetail', 'Foreground Linux shell only. Files are discarded after each run; the other file tools still work in your workspace as usual.')
        + ' ' + jt('settings.commandSandbox.platformLine', 'Platform: {platform} · Workspace: disposable copy · Network: none', { platform: platformLabel(state.platform) })
        + ' ' + platformMarkup;
      return fieldBinding().renderToggleRow({
        id: 'commandSandboxEnabled', controlId: 'commandSandboxEnabled', sub: true, parentOff, inventory,
        label: jt('settings.commandSandbox.rowLabel', 'Run commands in a sandbox'), help, detail, error: failure,
        controlPrefixHtml: retryMarkup, checked: state.enabled === true, disabled: toggleLocked(),
      });
    }

    // The parent switch patches the rendered row in place: a repaint would replace
    // the row's alert node, and a screen reader would announce the failure again.
    function setParentOn(value) {
      if (parentOn === (value === true)) return;
      parentOn = value === true;
      const row = disposed ? null : host?.querySelector?.('[data-settings-field="commandSandboxEnabled"]');
      if (!row) return;
      if (parentOn) row.removeAttribute('data-setting-parent-off');
      else row.setAttribute('data-setting-parent-off', 'true');
      const track = row.querySelector('[data-inv-toggle="commandSandboxEnabled"]');
      if (track && setSwitchDisabled) {
        setSwitchDisabled(track, toggleLocked());
        // A write the settings binding has in flight keeps its own lock.
        if (track.hasAttribute('data-setting-busy')) track.disabled = true;
      }
      const retry = row.querySelector('[data-action="commandSandboxRetry"]');
      if (retry) retry.disabled = retryLocked();
    }

    function render() {
      if (disposed || !host) return;
      host.dataset.commandSandboxState = currentState.state;
      host.dataset.commandSandboxQualified = currentState.qualified ? 'true' : 'false';
      host.innerHTML = getMarkup();
    }

    async function refresh() {
      const bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') {
        setFailure('unavailable', null, 'api_unavailable', jt('settings.commandSandbox.apiUnavailable', 'Command sandbox is unavailable in this window.'));
        return currentState;
      }
      const generation = ++requestGeneration;
      try {
        const result = await bridge.getState();
        if (disposed || generation !== requestGeneration) return currentState;
        return setState(result?.state && typeof result.state === 'object' ? result.state : result);
      } catch (error) {
        if (!disposed && generation === requestGeneration) {
          setFailure('unavailable', error, 'get_state_failed', jt('settings.commandSandbox.loadFailed', 'Command sandbox status could not be loaded.'));
        }
        return currentState;
      }
    }

    function onChanged(rawState) {
      if (disposed) return;
      // An event is newer than any in-flight hydration read. Bump the same
      // generation used by refresh() so a late getState() cannot roll the
      // persisted state back to an older snapshot.
      requestGeneration += 1;
      const next = rawState?.state && typeof rawState.state === 'object' ? rawState.state : rawState;
      setState(next);
    }

    async function invokeAction(method, args, fallbackState, key, fallback) {
      if (disposed || actionPromise) return currentState;
      const bridge = getBridge();
      if (!bridge || typeof bridge[method] !== 'function') {
        setFailure('unavailable', null, 'api_unavailable', jt('settings.commandSandbox.apiUnavailable', 'Command sandbox is unavailable in this window.'));
        return currentState;
      }
      const previous = actionPromise;
      const generation = ++requestGeneration;
      // The switch keeps the acknowledged value until the bridge echoes a new one.
      setState({
        ...currentState,
        state: 'preparing',
        reason: '',
        message: jt('settings.commandSandbox.messagePreparing', 'Preparing the Docker sandbox…'),
      });
      const operation = Promise.resolve()
        .then(() => (args === undefined ? bridge[method]() : bridge[method](args)))
        .then(async (result) => {
          if (disposed || generation !== requestGeneration) return currentState;
          if (result?.state && typeof result.state === 'object') return setState(result.state);
          if (result && typeof result === 'object' && (VALID_STATES.has(result.state) || 'enabled' in result)) {
            return setState(result);
          }
          return refresh();
        })
        .catch((error) => {
          if (!disposed && generation === requestGeneration) {
            setFailure(fallbackState, error, key, fallback);
          }
          return currentState;
        })
        .finally(() => {
          if (actionPromise === operation || actionPromise === previous) actionPromise = null;
          if (!disposed) render();
        });
      actionPromise = operation;
      render();
      return operation;
    }

    // The switch persists through the shared Settings binding. The controller
    // binds once for the app's lifetime, so its registry (one coordinator) lives here.
    function bindEnabledSwitch(registerListener) {
      const binding = fieldBinding();
      if (typeof binding?.bindSettingFields !== 'function') return;
      const updateFailed = () => jt('settings.commandSandbox.updateFailed', 'Command sandbox setting could not be saved.');
      const registry = binding.createSettingsAdapterRegistry();
      registry.register({
        id: 'commandSandbox',
        mode: 'patch',
        optimistic: false,
        read: () => ({ enabled: currentState.enabled }),
        normalize: (value) => ({ enabled: value?.enabled === true }),
        // invokeAction owns the transport and surfaces an unavailable or failed call itself.
        write: (patch) => invokeAction('setEnabled', { enabled: patch.enabled }, 'unavailable', 'set_enabled_failed', updateFailed()),
        ack: (echo, patch) => {
          // The row shows one reason: the one invokeAction recorded, when there is one.
          if (echo?.enabled !== patch.enabled) throw new Error((currentState.reason && currentState.message) || updateFailed());
          return { enabled: echo.enabled };
        },
        // invokeAction already adopted the echoed state; repaint from it.
        apply: () => render(),
        // A failure the bridge or invokeAction already explained keeps its own reason.
        onError: (error) => {
          if (!currentState.reason) setState({ ...currentState, reason: 'set_enabled_failed', message: errorMessage(error, updateFailed()) });
        },
      });
      binding.bindSettingFields({ container: host, ids: ['commandSandboxEnabled'], registry, registerListener, inventory });
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action="commandSandboxRetry"]');
      if (!target || target.disabled || !host?.contains?.(target)) return;
      const fallbackState = currentState.state === 'unavailable' ? 'unavailable' : 'recovery-required';
      void invokeAction('retry', undefined, fallbackState, 'retry_failed', jt('settings.commandSandbox.retryFailed', 'Command sandbox recovery could not be completed.'));
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      if (host?.addEventListener) {
        const registerListener = (target, type, handler, listenerOptions) => {
          target.addEventListener(type, handler, listenerOptions);
          listeners.push(() => target.removeEventListener(type, handler, listenerOptions));
        };
        registerListener(host, 'click', onClick);
        bindEnabledSwitch(registerListener);
      }
      const bridge = getBridge();
      if (bridge && typeof bridge.onChanged === 'function') {
        try {
          const maybeUnsubscribe = bridge.onChanged(onChanged);
          if (typeof maybeUnsubscribe === 'function') unsubscribe = maybeUnsubscribe;
        } catch (error) {
          setFailure('unavailable', error, 'subscribe_failed', jt('settings.commandSandbox.subscriptionFailed', 'Command sandbox status updates are unavailable.'));
        }
      }
      render();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      requestGeneration += 1;
      if (typeof unsubscribe === 'function') {
        try { unsubscribe(); } catch (_error) { /* cleanup is best effort */ }
      }
      unsubscribe = null;
      for (const cleanup of listeners.splice(0)) cleanup();
      actionPromise = null;
    }

    return {
      bind,
      dispose,
      render,
      refresh,
      setParentOn,
      getState: () => ({ ...currentState }),
    };
  }

  // The controller Settings bound; the Tools render passes the Terminal commands switch to it.
  let boundController = null;

  function bindCommandSandboxSettings(windowRef, registerCleanup) {
    const controller = createCommandSandboxController({ windowRef, documentRef: windowRef.document,
      host: windowRef.document?.getElementById?.('toolsCommandSandboxHost') || null });
    boundController = controller;
    controller.bind();
    registerCleanup(() => {
      controller.dispose();
      if (boundController === controller) boundController = null;
    });
  }

  function onParentChange(parentOn) {
    boundController?.setParentOn(parentOn);
  }

  return {
    bindCommandSandboxSettings,
    createCommandSandboxController,
    onParentChange,
    normalizeState,
    stateMessage,
  };
});
