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
  // normalizePlatform maps every alias to one of these names.
  const UNVERIFIED_PLATFORMS = new Set(['linux', 'macos']);
  const DEFAULT_PLATFORM = 'unknown';
  // Every run has no network, whatever the bridge reports; the workspace follows the mode.
  const SANDBOX_NETWORK = 'none';
  // Row 106: an isolated copy (changes discarded) or a synced workspace (changes copied back).
  const MODES = Object.freeze(['copy', 'synced']);
  const MODE_FIELD = 'commandSandboxMode';
  // The main process always sends the active mode's limits; an older main sends no mode at all.
  const COPY_LIMITS = Object.freeze({ bytes: 64 * 1024 * 1024, entries: 2048, depth: 32 });
  // Refused before anything changed: the sandbox stays as it was and the edited row says why.
  const REFUSALS = new Set(['sandbox_wait_for_active_chats', 'sandbox_busy', 'sandbox_settings_invalid']);

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

  // Limits the bridge reports for the active mode; anything else reads as that mode's known limits.
  function normalizeLimits(raw) {
    const valid = (value) => Number.isSafeInteger(value) && value > 0;
    if (!raw || typeof raw !== 'object' || !['bytes', 'entries', 'depth'].every((name) => valid(raw[name]))) {
      return { ...COPY_LIMITS };
    }
    return { bytes: raw.bytes, entries: raw.entries, depth: raw.depth };
  }

  // The kill switch (or an older main process) offers only the copy; then the choice is hidden.
  function modeFields(raw) {
    const modes = Array.isArray(raw.modes) && raw.modes.includes('synced') ? [...MODES] : ['copy'];
    const mode = modes.includes(raw.mode) ? raw.mode : 'copy';
    return { mode, modes, workspace: mode === 'synced' ? 'synced' : 'disposable_copy', network: SANDBOX_NETWORK, limits: normalizeLimits(raw.limits) };
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
      ...modeFields({}),
    };
  }

  // The bridge answers with the state itself or wrapped as { state: {...} }.
  function unwrapState(value) {
    return value?.state && typeof value.state === 'object' ? value.state : value;
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
      ...modeFields(raw),
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

  function formatCount(value) {
    return Number(value).toLocaleString(globalThis.jennyI18n?.tag?.() || undefined);
  }

  function formatBytes(bytes) {
    const gib = bytes >= 1024 * 1024 * 1024;
    const scaled = bytes / (gib ? 1024 * 1024 * 1024 : 1024 * 1024);
    return formatCount(Math.round(scaled * 10) / 10) + (gib ? ' GiB' : ' MiB');
  }

  // The message for a specific reason, or '' when the reason has none of its own.
  // `context` is the sandbox state (its mode and that mode's limits).
  function reasonMessage(reason, context = {}) {
    reason = String(reason || '');
    if (reason === 'docker_missing') return jt('settings.commandSandbox.dockerMissing', 'Install and start Docker independently, then Retry.');
    if (reason === 'docker_local_daemon_required') return jt('settings.commandSandbox.localDaemon', 'Select a local Docker context, then Retry. Remote Docker daemons are unavailable.');
    if (reason === 'docker_linux_cgroup_v2_required') return jt('settings.commandSandbox.linuxEngine', 'Start Docker with a Linux engine supporting cgroup v2, then Retry.');
    if (reason === 'snapshot_limit') {
      const limits = normalizeLimits(context.limits);
      return jt('settings.commandSandbox.snapshotLimitWithin', 'Choose a workspace within {size}, {entries} entries and {depth} levels, then Retry.',
        { size: formatBytes(limits.bytes), entries: formatCount(limits.entries), depth: formatCount(limits.depth) });
    }
    if (reason === 'sandbox_workspace_required') return jt('settings.commandSandbox.workspaceRequired', 'Configure a tools workspace before running a command.');
    if (reason.startsWith('snapshot_')) return jt('settings.commandSandbox.snapshotRejected', 'The workspace copy was rejected. Use an ordinary local directory without links or special files, stop concurrent changes, then Retry.');
    if (reason === 'sandbox_wait_for_active_chats') return jt('settings.commandSandbox.waitForActiveChats', 'Wait for running chats and commands to finish, then try again.');
    if (reason === 'sandbox_busy') return jt('settings.commandSandbox.busyTryAgain', 'A sandbox command is running. Try again when it finishes.');
    if (reason === 'sandbox_settings_invalid') return jt('settings.commandSandbox.settingsInvalid', 'That choice is not available right now.');
    return '';
  }

  function stateMessage(state, reason = '', context = {}) {
    const specific = reasonMessage(reason, context);
    if (specific) return specific;
    const messages = {
      disabled: jt('settings.commandSandbox.messageDisabled', 'Command sandbox is off.'),
      unavailable: jt('settings.commandSandbox.messageUnavailable', 'Docker sandbox is unavailable. Install Docker or check the Docker service.'),
      preparing: jt('settings.commandSandbox.messagePreparing', 'Preparing the Docker sandbox…'),
      ready: context.mode === 'synced'
        ? jt('settings.commandSandbox.messageReadySynced', 'Ready. Commands run offline in a Linux copy of this workspace; changed files are copied back (not .git, hook or dependency folders, or links) and can be undone.')
        : jt('settings.commandSandbox.messageReady', 'Docker sandbox is ready for foreground Linux shell commands.'),
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
    let paintedMarkup = null; // the row markup last written into the host
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

    // The mode control takes the switch's locks; it also needs a bridge that can write it.
    function modeLocked() {
      return toggleLocked() || typeof getBridge()?.setMode !== 'function';
    }
    function modeDescriptor() {
      const descriptors = globalThis.rendererSettingsFieldDescriptors
        || (typeof require === 'function' ? require('./renderer-settings-field-descriptors') : null);
      return descriptors?.getSettingDescriptor?.(MODE_FIELD) || null;
    }

    // "Where commands run" sits under the switch, on or off: turning the sandbox on starts in the chosen mode.
    function getModeMarkup() {
      const state = currentState;
      const descriptor = state.modes.length > 1 ? modeDescriptor() : null;
      if (!descriptor) return '';
      const help = state.mode === 'synced'
        ? jt('settings.commandSandbox.modeSyncedHelp', 'Commands change your files offline; Jenny copies changes back after a restore point.')
        : jt('settings.commandSandbox.modeCopyHelp', 'Commands work on a throwaway copy; nothing they change is kept.');
      return fieldBinding().renderSettingRow(descriptor, state.mode, { inventory, sub: true, parentOff: !parentOn, disabled: modeLocked(), help });
    }

    function getMarkup() {
      return getToggleMarkup() + getModeMarkup();
    }

    // A disabled segmented group only dims; the row lock disables its options too (a patch may also lift it).
    function lockModeRow(patch = false) {
      const locked = modeLocked();
      const descriptor = (locked || patch) && host?.querySelector?.(`[data-settings-field="${MODE_FIELD}"]`) ? modeDescriptor() : null;
      if (descriptor) fieldBinding().setRowDisabled(host, descriptor, locked);
    }

    function getToggleMarkup() {
      const state = currentState;
      const synced = state.mode === 'synced';
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
      const failure = state.reason ? state.message || stateMessage(state.state, state.reason, state) : '';
      const help = failure || state.state === 'disabled' || state.state === 'ready'
        ? (synced
          ? jt('settings.commandSandbox.rowHelpSynced', 'Runs offline on a synced copy of your files. Needs Docker.')
          : jt('settings.commandSandbox.rowHelp', 'A disposable copy with no network. Needs Docker.'))
        : state.message || stateMessage(state.state, state.reason, state);
      const platform = { platform: platformLabel(state.platform) };
      const detail = (synced
        ? jt('settings.commandSandbox.rowDetailSynced', 'Foreground Linux shell only. After each run, changed files are copied back to your workspace after a restore point, except .git, hook and dependency folders and links. Each change can be undone.')
          + ' ' + jt('settings.commandSandbox.platformLineSynced', 'Platform: {platform} · Workspace: synced · Network: none', platform)
        : jt('settings.commandSandbox.rowDetail', 'Foreground Linux shell only. Files are discarded after each run; the other file tools still work in your workspace as usual.')
          + ' ' + jt('settings.commandSandbox.platformLine', 'Platform: {platform} · Workspace: disposable copy · Network: none', platform))
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
      const markParent = (el) => {
        if (parentOn) el.removeAttribute('data-setting-parent-off');
        else el.setAttribute('data-setting-parent-off', 'true');
      };
      const modeRow = disposed ? null : host?.querySelector?.(`[data-settings-field="${MODE_FIELD}"]`);
      if (modeRow) markParent(modeRow);
      lockModeRow(true);
      const row = disposed ? null : host?.querySelector?.('[data-settings-field="commandSandboxEnabled"]');
      if (!row) return;
      markParent(row);
      const track = row.querySelector('[data-inv-toggle="commandSandboxEnabled"]');
      if (track && setSwitchDisabled) {
        setSwitchDisabled(track, toggleLocked());
        // A write the settings binding has in flight keeps its own lock.
        if (track.hasAttribute('data-setting-busy')) track.disabled = true;
      }
      const retry = row.querySelector('[data-action="commandSandboxRetry"]');
      if (retry) retry.disabled = retryLocked();
    }

    // A state event that changes nothing on screen keeps the row's nodes, so focus and the
    // row's alert are not replaced (and announced) again.
    function render() {
      if (disposed || !host) return;
      host.dataset.commandSandboxState = currentState.state;
      host.dataset.commandSandboxQualified = currentState.qualified ? 'true' : 'false';
      const markup = getMarkup();
      if (markup === paintedMarkup) return;
      host.innerHTML = markup;
      paintedMarkup = markup;
      lockModeRow();
    }

    function setApiUnavailable() {
      setFailure('unavailable', null, 'api_unavailable', jt('settings.commandSandbox.apiUnavailable', 'Command sandbox is unavailable in this window.'));
    }

    async function refresh() {
      const bridge = getBridge();
      if (!bridge || typeof bridge.getState !== 'function') {
        setApiUnavailable();
        return currentState;
      }
      const generation = ++requestGeneration;
      try {
        const result = await bridge.getState();
        if (disposed || generation !== requestGeneration) return currentState;
        return setState(unwrapState(result));
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
      setState(unwrapState(rawState));
    }

    // A null fallbackState marks a write whose row reports its own failures (the mode):
    // any failure then restores the state from before the call, like a refusal does.
    async function invokeAction(method, args, fallbackState, key, fallback) {
      if (disposed || actionPromise) return currentState;
      const bridge = getBridge();
      if (!bridge || typeof bridge[method] !== 'function') {
        setApiUnavailable();
        return currentState;
      }
      const before = currentState;
      // The echo carries `refusal`, the reason the adapter's ack hands to the edited row.
      const refuse = (raw, reason, error) => {
        setState({ ...(raw || before), reason: before.reason, message: before.message });
        return { ...currentState, refusal: reasonMessage(reason, currentState) || errorMessage(error, fallback) };
      };
      const generation = ++requestGeneration;
      // The switch keeps the acknowledged value until the bridge echoes a new one.
      setState({
        ...currentState,
        state: 'preparing',
        reason: '',
        message: stateMessage('preparing'),
      });
      const operation = Promise.resolve()
        .then(() => (args === undefined ? bridge[method]() : bridge[method](args)))
        .then(async (result) => {
          if (disposed || generation !== requestGeneration) return currentState;
          if (result?.ok === false && REFUSALS.has(result.reason)) return refuse(unwrapState(result), result.reason);
          if (result?.state && typeof result.state === 'object') return setState(result.state);
          if (result && typeof result === 'object' && (VALID_STATES.has(result.state) || 'enabled' in result)) {
            return setState(result);
          }
          return refresh();
        })
        .catch((error) => {
          if (disposed || generation !== requestGeneration) return currentState;
          if (fallbackState === null || REFUSALS.has(error?.reason)) return refuse(null, error?.reason, error);
          setFailure(fallbackState, error, key, fallback);
          return currentState;
        })
        .finally(() => {
          if (actionPromise === operation) actionPromise = null;
          if (!disposed) render();
        });
      actionPromise = operation;
      render();
      return operation;
    }

    // The switch and the mode persist through the shared Settings binding. The controller
    // binds once for the app's lifetime, so its registry (one coordinator each) lives here.
    function bindSandboxFields(registerListener) {
      const binding = fieldBinding();
      if (typeof binding?.bindSettingFields !== 'function') return;
      const updateFailed = () => jt('settings.commandSandbox.updateFailed', 'Command sandbox setting could not be saved.');
      const registry = binding.createSettingsAdapterRegistry();
      registry.register({
        id: MODE_FIELD,
        mode: 'patch',
        optimistic: false,
        read: () => ({ mode: currentState.mode }),
        normalize: (value) => ({ mode: value?.mode === 'synced' ? 'synced' : 'copy' }),
        // A failed mode write leaves the sandbox state alone; the binding shows the reason on the mode row.
        // A choice the main process already holds needs no write (a pick queued behind an in-flight one).
        write: (patch) => (patch.mode === currentState.mode && !actionPromise ? currentState
          : invokeAction('setMode', { mode: patch.mode }, null, 'set_mode_failed', updateFailed())),
        ack: (echo, patch) => {
          if (echo?.refusal) throw new Error(echo.refusal);
          if (echo?.mode !== patch.mode) throw new Error(updateFailed());
          return { mode: echo.mode };
        },
        apply: () => render(),
      });
      registry.register({
        id: 'commandSandbox',
        mode: 'patch',
        optimistic: false,
        read: () => ({ enabled: currentState.enabled }),
        normalize: (value) => ({ enabled: value?.enabled === true }),
        // invokeAction owns the transport and surfaces an unavailable or failed call itself.
        write: (patch) => invokeAction('setEnabled', { enabled: patch.enabled }, 'unavailable', 'set_enabled_failed', updateFailed()),
        ack: (echo, patch) => {
          if (echo?.refusal) throw new Error(echo.refusal);
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
      binding.bindSettingFields({ container: host, ids: ['commandSandboxEnabled', MODE_FIELD], registry, registerListener, inventory });
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
        bindSandboxFields(registerListener);
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
