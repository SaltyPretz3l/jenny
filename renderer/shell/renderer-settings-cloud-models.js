/* renderer/shell/renderer-settings-cloud-models.js
 *
 * Settings > Models "Cloud models" group (plugin platform retirement, stage 2).
 * The main process owns sign-in, tokens and the persisted choice
 * (services/main/cloud-models-registration.js); this controller owns the view
 * model of one host, the bridge subscription and the row actions. It never
 * sees token material.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCloudModels = factory();
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

  const AUTH_STATES = new Set(['signed_out', 'connecting', 'signed_in', 'error']);

  function text(value, max) {
    return String(value == null ? '' : value).trim().slice(0, max);
  }

  function normalizeState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const chatgpt = source.chatgpt && typeof source.chatgpt === 'object' ? source.chatgpt : {};
    const auth = chatgpt.auth && typeof chatgpt.auth === 'object' ? chatgpt.auth : {};
    const authState = AUTH_STATES.has(auth.state) ? auth.state : 'signed_out';
    return {
      chatgpt: {
        enabled: chatgpt.enabled !== false,
        auth: {
          state: authState,
          email: text(auth.email, 254),
          planType: text(auth.planType, 40),
          error: auth.error && typeof auth.error === 'object' ? text(auth.error.message, 240) : '',
        },
      },
      localOnly: source.localOnly === true,
    };
  }

  function normalizeCodexState(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const code = text(source.code, 64);
    if (source.status === 'ready') return { status: 'ready', message: '' };
    if (/auth/.test(code)) return { status: 'signed_out', message: '' };
    return { status: 'unavailable', message: text(source.message, 240) };
  }

  function planLabel(planType) {
    if (!planType) return '';
    return planType.charAt(0).toUpperCase() + planType.slice(1);
  }

  function createCloudModelsController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || null;
    const host = options.host || documentRef?.getElementById?.('cloudModelsHost') || null;
    const inventory = options.inventory || windowRef?.inventory || globalThis.inventory || {};
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge : () => windowRef?.jennyShell?.cloudModels || null;
    const getCodexBridge = typeof options.getCodexBridge === 'function'
      ? options.getCodexBridge : () => windowRef?.jennyShell?.codexCli || null;
    // Composer's model list is the shared snapshot refresher's; nothing else
    // re-reads it while a local engine is selected.
    const refreshComposerModels = typeof options.refreshComposerModels === 'function'
      ? options.refreshComposerModels
      : () => windowRef?.rendererSnapshotRefresh?.instance?.refreshSnapshots?.();
    let state = normalizeState(null);
    let codex = { status: 'unavailable', message: '' };
    let failure = '';
    let pending = '';
    let generation = 0;
    let disposed = false;
    let bound = false;
    let unsubscribe = null;
    let visibilityKey = '';
    let codexSeeded = false;
    const listeners = [];

    function fieldBinding() {
      return globalThis.rendererSettingsFieldBinding
        || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
    }

    function button(id, label, variant, disabled) {
      return typeof inventory.actionButton === 'function'
        ? inventory.actionButton({ id, label, variant, size: 'sm', disabled: disabled === true }) : '';
    }

    function status(tone, label) {
      return typeof inventory.badge === 'function' ? inventory.badge({ tone, size: 'sm', text: label }) : '';
    }

    function chatgptAccountRow() {
      const auth = state.chatgpt.auth;
      const busy = Boolean(pending);
      let help;
      let control;
      let error = '';
      if (auth.state === 'signed_in') {
        const plan = planLabel(auth.planType);
        help = auth.email
          ? (plan
            ? jt('settings.cloudModels.chatgptSignedInPlan', 'Signed in as {email} · {plan}', { email: auth.email, plan })
            : jt('settings.cloudModels.chatgptSignedIn', 'Signed in as {email}', { email: auth.email }))
          : jt('settings.cloudModels.chatgptConnected', 'Your ChatGPT subscription is ready.');
        control = status('success', jt('settings.cloudModels.connected', 'Connected'))
          + button('cloudModelsChatgptSignOut', jt('settings.cloudModels.signOut', 'Sign out'), 'ghost', busy);
      } else if (auth.state === 'connecting') {
        help = jt('settings.cloudModels.chatgptConnecting', 'Finish signing in in your browser.');
        control = status('pending', jt('settings.cloudModels.waitingForBrowser', 'Waiting for browser'))
          + button('cloudModelsChatgptCancel', jt('settings.cloudModels.cancel', 'Cancel'), 'secondary', pending === 'cancel');
      } else {
        help = jt('settings.cloudModels.chatgptSignedOut', 'Not connected. Signing in opens your browser.');
        error = auth.error || failure;
        control = button('cloudModelsChatgptSignIn', auth.error
          ? jt('settings.cloudModels.tryAgain', 'Try again')
          : jt('settings.cloudModels.signIn', 'Sign in with ChatGPT'), 'primary', busy);
      }
      if (state.localOnly && auth.state === 'signed_in') {
        help = jt('settings.cloudModels.localOnly', 'Force local inference is on, so ChatGPT will not run. Turn it off in Offline.');
      }
      return inventory.settingsField({
        id: 'cloudModelsChatgptAccount', variant: 'row', label: 'ChatGPT', help, error,
        controlHtml: control, dataset: { 'cloud-auth-state': auth.state },
      });
    }

    function chatgptSwitchRow() {
      const signedIn = state.chatgpt.auth.state === 'signed_in';
      return fieldBinding().renderToggleRow({
        id: 'chatgptModelsEnabledToggle', controlId: 'chatgptModelsEnabledToggle', sub: true, inventory,
        label: jt('settings.cloudModels.chatgptShowLabel', 'Show ChatGPT models in Composer'),
        help: signedIn
          ? jt('settings.cloudModels.chatgptShowHelp', 'Turning it off keeps you signed in.')
          : jt('settings.cloudModels.chatgptShowSignedOut', 'Available after you sign in.'),
        checked: state.chatgpt.enabled, parentOff: !signedIn,
      });
    }

    function codexRow() {
      let help;
      let badge;
      if (codex.status === 'ready') {
        help = jt('settings.cloudModels.codexReady', 'Uses the codex command and its own login. Jenny never reads that login.');
        badge = status('success', jt('settings.cloudModels.connected', 'Connected'));
      } else if (codex.status === 'signed_out') {
        help = jt('settings.cloudModels.codexSignedOut', 'Run codex login in a terminal, then check again.');
        badge = status('muted', jt('settings.cloudModels.notSignedIn', 'Not signed in'));
      } else {
        help = codex.message || jt('settings.cloudModels.codexUnavailable', 'The codex command was not found or is not set up.');
        badge = status('muted', jt('settings.cloudModels.unavailable', 'Unavailable'));
      }
      return inventory.settingsField({
        id: 'cloudModelsCodexCli', variant: 'row', label: jt('composer.modelPicker.codexCliGroup', 'Codex CLI'), help,
        controlHtml: badge + button('cloudModelsCodexRefresh', jt('settings.cloudModels.checkAgain', 'Check again'), 'ghost', pending === 'codex'),
        dataset: { 'cloud-codex-state': codex.status },
      });
    }

    function render() {
      if (disposed || !host || typeof inventory.settingsField !== 'function') return;
      host.innerHTML = chatgptAccountRow() + chatgptSwitchRow() + codexRow();
    }

    function adopt(result) {
      const next = result?.state && typeof result.state === 'object' ? result.state : result;
      if (!next || typeof next !== 'object' || !next.chatgpt) return;
      state = normalizeState(next);
      // ChatGPT models are listed only while signed in with the switch on; the
      // first read seeds the key, a later change refreshes Composer once.
      const key = `${state.chatgpt.enabled}|${state.chatgpt.auth.state === 'signed_in'}`;
      const changed = visibilityKey !== '' && key !== visibilityKey;
      visibilityKey = key;
      if (changed && !disposed) {
        Promise.resolve().then(refreshComposerModels).catch(() => {});
      }
    }

    // Codex CLI models are listed only while its login is ready, and no push
    // exists for that route: the first read seeds the status, a later change
    // refreshes Composer once.
    function adoptCodex(raw) {
      const next = normalizeCodexState(raw);
      const changed = codexSeeded && next.status !== codex.status;
      codexSeeded = true;
      codex = next;
      if (changed && !disposed) {
        Promise.resolve().then(refreshComposerModels).catch(() => {});
      }
    }

    async function refresh() {
      const bridge = getBridge();
      const ticket = ++generation;
      try {
        const result = await bridge?.getState?.();
        if (!disposed && ticket === generation) adopt(result);
      } catch (_error) {
        failure = jt('settings.cloudModels.loadFailed', 'Cloud model status could not be loaded.');
      }
      try {
        const codexState = await getCodexBridge()?.getState?.();
        if (!disposed) adoptCodex(codexState);
      } catch (_error) { /* the row keeps "Unavailable" */ }
      render();
    }

    async function run(kind, task) {
      if (disposed || pending) return;
      pending = kind;
      failure = '';
      render();
      try {
        await task();
      } catch (_error) {
        failure = jt('settings.cloudModels.actionFailed', 'Jenny could not complete that request. Try again.');
      } finally {
        pending = '';
        render();
      }
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action]');
      if (!target || target.disabled || !host?.contains?.(target)) return;
      const bridge = getBridge();
      const action = target.getAttribute('data-action');
      if (action === 'cloudModelsChatgptSignIn') {
        // Sign-in stays open until the browser flow ends; pushes repaint meanwhile.
        void run('sign-in', async () => {
          state.chatgpt.auth = { ...state.chatgpt.auth, state: 'connecting', error: '' };
          render();
          adopt(await bridge.chatgptSignIn());
        });
      } else if (action === 'cloudModelsChatgptCancel') {
        // Cancel must work while the sign-in call is still pending.
        pending = 'cancel';
        render();
        Promise.resolve(bridge?.chatgptCancel?.()).then(adopt, () => {}).finally(() => {
          if (pending === 'cancel') pending = '';
          render();
        });
      } else if (action === 'cloudModelsChatgptSignOut') {
        void run('sign-out', async () => adopt(await bridge.chatgptSignOut()));
      } else if (action === 'cloudModelsCodexRefresh') {
        void run('codex', async () => { adoptCodex(await getCodexBridge()?.refresh?.()); });
      }
    }

    function onChanged(raw) {
      if (disposed) return;
      generation += 1;
      adopt(raw);
      render();
    }

    function bindSwitch(registerListener) {
      const binding = fieldBinding();
      if (typeof binding?.bindSettingFields !== 'function') return;
      const registry = binding.createSettingsAdapterRegistry();
      registry.register({
        id: 'cloudModels',
        mode: 'patch',
        optimistic: false,
        read: () => ({ chatgptEnabled: state.chatgpt.enabled }),
        normalize: (value) => ({ chatgptEnabled: value?.chatgptEnabled !== false }),
        write: async (patch) => {
          const result = await getBridge()?.setChatgptEnabled?.(patch.chatgptEnabled === true);
          if (result?.ok !== true) throw new Error(jt('settings.cloudModels.saveFailed', 'The setting could not be saved.'));
          adopt(result);
          return { chatgptEnabled: state.chatgpt.enabled };
        },
        ack: (echo) => ({ chatgptEnabled: echo?.chatgptEnabled !== false }),
        apply: () => render(),
      });
      binding.bindSettingFields({ container: host, ids: ['chatgptModelsEnabledToggle'], registry, registerListener, inventory });
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
        bindSwitch(registerListener);
      }
      try {
        const maybe = getBridge()?.onChanged?.(onChanged);
        if (typeof maybe === 'function') unsubscribe = maybe;
      } catch (_error) { /* the section still refreshes on bind */ }
      render();
      void refresh();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      try { unsubscribe?.(); } catch (_error) { /* best effort */ }
      for (const cleanup of listeners.splice(0)) cleanup();
    }

    return { bind, dispose, refresh, render, getState: () => normalizeState(state) };
  }

  function bindCloudModelsSettings(windowRef, registerCleanup) {
    const controller = createCloudModelsController({ windowRef, documentRef: windowRef.document });
    controller.bind();
    registerCleanup(() => controller.dispose());
    return controller;
  }

  return { bindCloudModelsSettings, createCloudModelsController, normalizeState, normalizeCodexState };
});
