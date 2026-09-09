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

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

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

  function stateLabel(state) {
    const labels = {
      disabled: jt('settings.commandSandbox.stateDisabled', 'Disabled'),
      unavailable: jt('settings.commandSandbox.stateUnavailable', 'Unavailable'),
      preparing: jt('settings.commandSandbox.statePreparing', 'Preparing'),
      ready: jt('settings.commandSandbox.stateReady', 'Ready'),
      busy: jt('settings.commandSandbox.stateBusy', 'Busy'),
      'recovery-required': jt('settings.commandSandbox.stateRecoveryRequired', 'Recovery required'),
    };
    return labels[state] || labels.unavailable;
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

  function stateTone(state) {
    if (state === 'ready') return 'success';
    if (state === 'preparing' || state === 'busy') return 'pending';
    if (state === 'recovery-required') return 'danger';
    if (state === 'unavailable') return 'warning';
    return 'default';
  }

  function createCommandSandboxController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const host = options.host || documentRef?.getElementById?.('toolsCommandSandboxHost') || null;
    const inventory = options.inventory || windowRef?.inventory || (typeof globalThis !== 'undefined' ? globalThis.inventory : null) || {};
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge
      : () => options.bridge || windowRef?.jennyShell?.commandSandbox || null;
    let currentState = defaultState({ bridge: getBridge?.(), platform: options.platform });
    let disposed = false;
    let bound = false;
    let unsubscribe = null;
    let actionPromise = null;
    let requestGeneration = 0;
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

    function getMarkup() {
      const state = currentState;
      const toggleSwitch = typeof inventory.toggleSwitch === 'function' ? inventory.toggleSwitch : null;
      const statusRow = typeof inventory.statusRow === 'function' ? inventory.statusRow : null;
      const actionButton = typeof inventory.actionButton === 'function' ? inventory.actionButton : null;
      const pending = Boolean(actionPromise);
      const stateLocksToggle = state.state === 'preparing' || state.state === 'busy';
      const toggleMarkup = toggleSwitch
        ? toggleSwitch({
          id: 'commandSandboxEnabled',
          label: jt('settings.commandSandbox.enable', 'Enable command sandbox'),
          description: jt('settings.commandSandbox.enableDescription', 'Run eligible run_command calls in a disposable copy with no network.'),
          checked: state.enabled,
          disabled: pending || stateLocksToggle || !getBridge(),
        })
        : '';
      const statusMarkup = statusRow
        ? statusRow({
          tone: stateTone(state.state),
          label: stateLabel(state.state),
          message: state.message || stateMessage(state.state, state.reason),
          badgeText: state.reason ? state.reason : '',
          spinner: state.state === 'preparing' || state.state === 'busy',
          ariaLive: 'polite',
        })
        : '';
      const retryMarkup = actionButton && RETRY_STATES.has(state.state)
        ? actionButton({
          id: 'commandSandboxRetry',
          label: jt('settings.commandSandbox.retry', 'Retry'),
          variant: 'secondary',
          disabled: pending || !getBridge(),
        })
        : '';
      const platformMarkup = UNVERIFIED_PLATFORMS.has(state.platform)
        ? jt('settings.commandSandbox.unverifiedPlatform', 'Linux/macOS support is unverified on this build.')
        : state.platform === 'windows'
          ? jt('settings.commandSandbox.qualifiedPlatform', 'Windows is the qualified platform for this build.')
          : jt('settings.commandSandbox.unknownPlatform', 'Platform qualification is unavailable.');
      return '<h4 class="settings-group-heading" id="toolsCommandSandboxHeading">'
        + escapeHtml(jt('settings.commandSandbox.heading', 'Command sandbox'))
        + '</h4>'
        + '<p class="settings-group-copy">'
        + escapeHtml(jt('settings.commandSandbox.description', 'Optional Docker sandbox for foreground Linux shell commands. Files are discarded after each run; typed tools keep their durable workspace behavior.'))
        + '</p>'
        + '<p class="settings-field-note">'
        + escapeHtml(jt('settings.commandSandbox.boundary', 'Foreground Linux shell only. Network is disabled; executable tools remain unavailable.'))
        + '</p>'
        + '<div class="settings-toggle-list" aria-live="polite">'
        + toggleMarkup
        + '</div>'
        + '<div class="settings-note">'
        + escapeHtml(jt('settings.commandSandbox.dockerPrerequisite', 'Requires Docker. Install Docker Desktop if Docker is not available.'))
        + '</div>'
        + (statusMarkup || '<p class="settings-note" role="status" aria-live="polite">'
          + escapeHtml(state.message || stateMessage(state.state, state.reason)) + '</p>')
        + '<p class="settings-field-note">'
        + escapeHtml(jt('settings.commandSandbox.platformLine', 'Platform: {platform} · Workspace: disposable copy · Network: none', { platform: platformLabel(state.platform) }))
        + '</p>'
        + '<p class="settings-field-note">' + escapeHtml(platformMarkup) + '</p>'
        + (retryMarkup ? '<div class="settings-actions">' + retryMarkup + '</div>' : '');
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
      setState({
        ...currentState,
        enabled: method === 'setEnabled' ? args.enabled === true : currentState.enabled,
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

    function onToggle(event) {
      const detail = event?.detail || {};
      if (detail.id !== 'commandSandboxEnabled' || typeof detail.checked !== 'boolean') return;
      void invokeAction('setEnabled', { enabled: detail.checked }, 'unavailable', 'set_enabled_failed', jt('settings.commandSandbox.updateFailed', 'Command sandbox setting could not be saved.'));
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action="commandSandboxRetry"]');
      if (!target || !host?.contains?.(target)) return;
      const fallbackState = currentState.state === 'unavailable' ? 'unavailable' : 'recovery-required';
      void invokeAction('retry', undefined, fallbackState, 'retry_failed', jt('settings.commandSandbox.retryFailed', 'Command sandbox recovery could not be completed.'));
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      if (host?.addEventListener) {
        host.addEventListener('inv-toggle-change', onToggle);
        host.addEventListener('click', onClick);
        listeners.push(() => host.removeEventListener('inv-toggle-change', onToggle));
        listeners.push(() => host.removeEventListener('click', onClick));
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
      getState: () => ({ ...currentState }),
    };
  }

  function bindCommandSandboxSettings(windowRef, registerCleanup) {
    const controller = createCommandSandboxController({ windowRef, documentRef: windowRef.document,
      host: windowRef.document?.getElementById?.('toolsCommandSandboxHost') || null });
    controller.bind();
    registerCleanup(() => controller.dispose());
  }

  return {
    bindCommandSandboxSettings,
    createCommandSandboxController,
    normalizeState,
    stateMessage,
  };
});
