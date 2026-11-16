/* renderer/shell/renderer-settings-cloud-models.js
 *
 * Settings > Models > Engines and providers: the ChatGPT and Codex CLI rows
 * (plugin platform retirement, stage 2). The main process owns sign-in, tokens
 * and the persisted choice (services/main/cloud-models-registration.js); this
 * controller registers the two rows on the services table
 * (model-library/model-library-services.js), renders their controls into the
 * Manage drawers, and owns the bridge subscription and the row actions. It
 * never sees token material.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsCloudModels = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || ((key, fallback, params) => (params ? String(fallback).replace(/\{(\w+)\}/g, (m, name) => (Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : m)) : fallback));

  const AUTH_STATES = new Set(['signed_out', 'connecting', 'signed_in', 'error']);
  const SERVICES_READY_EVENT = 'model-library-services-ready';
  // The drawer bodies the controls render into; looked up at render time (a drawer is a fresh node per open).
  const HOST_IDS = { chatgpt: 'cloudModelsChatgptHost', codex: 'cloudModelsCodexHost' };
  const PASTE_ACTIONS = { cloudModelsChatgptPasteOpen: 'open', cloudModelsChatgptPasteSubmit: 'submit', cloudModelsChatgptCopyLink: 'copy' };

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
    // auth_unchecked is the main process's placeholder while its own check runs: not a sign-out.
    if (code !== 'auth_unchecked' && /auth/.test(code)) return { status: 'signed_out', message: '' };
    return { status: 'unavailable', message: text(source.message, 240) };
  }

  function planLabel(planType) {
    if (!planType) return '';
    return planType.charAt(0).toUpperCase() + planType.slice(1);
  }

  function createCloudModelsController(options = {}) {
    const windowRef = options.windowRef || (typeof globalThis !== 'undefined' ? globalThis.window || globalThis : null);
    const documentRef = options.documentRef || windowRef?.document || null;
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
    let loaded = false;
    let visibilityKey = '';
    let codexSeeded = false;
    const now = () => (windowRef?.Date || Date).now();
    const emptyPaste = () => ({ open: false, value: '', error: '', busy: false, deadlineMs: 0, connectingSince: 0 });
    let paste = emptyPaste();
    let pasteStatus = '';
    let copiedUntil = 0;
    let ticker = null;
    let codexRecheck = null;
    let codexRechecks = 0;
    let slowShown = false; // what the last repaint showed, so the ticker knows when a repaint is due
    let copiedShown = false;
    const slots = { chatgpt: { node: null, cleanups: [] }, codex: { node: null, cleanups: [] } };
    const listeners = [];
    const listen = (list, target, type, handler, listenerOptions) => {
      target.addEventListener(type, handler, listenerOptions);
      list.push(() => target.removeEventListener(type, handler, listenerOptions));
    };

    function services() {
      if (typeof options.services === 'function') return options.services() || null;
      const module = windowRef?.modelLibraryServices;
      return module && typeof module.shared === 'function' ? module.shared({ documentRef, windowRef }) : null;
    }

    const st = (text, tone, set = false) => ({ text, tone, set });
    const checking = () => st(jt('settings.models.services.checking', 'Checking…'), 'busy');

    function chatgptStatus() {
      const auth = state.chatgpt.auth;
      const reason = auth.error || failure;
      const plan = planLabel(auth.planType);
      if (!loaded) return checking();
      if (auth.state === 'signed_in') {
        return st(plan ? jt('settings.models.services.chatgpt.connectedPlan', 'Connected · {plan}', { plan }) : jt('settings.cloudModels.connected', 'Connected'), 'ready', true);
      }
      if (auth.state === 'connecting') {
        return st(paste.busy ? jt('settings.cloudModels.finishingSignIn', 'Finishing sign-in…') : jt('settings.cloudModels.waitingForBrowser', 'Waiting for browser'), 'busy');
      }
      if (auth.state === 'error' || reason) {
        return st(reason && reason.length <= 60 ? reason : jt('settings.models.services.chatgpt.failed', 'Sign-in failed'), 'warn');
      }
      return st(jt('settings.models.services.chatgpt.notConnected', 'Not connected'), 'off');
    }

    function codexStatus() {
      if (pending === 'codex' || codexRecheck !== null || !codexSeeded) return checking();
      if (codex.status === 'ready') return st(jt('settings.models.services.codex.ready', 'Ready'), 'ready', true);
      return st(codex.status === 'signed_out' ? jt('settings.cloudModels.notSignedIn', 'Not signed in') : jt('settings.models.services.codex.notFound', 'Not found'), 'off');
    }

    // A Manage drawer: one quiet line, then the host its controls render into.
    const drawerBody = (kind, line) => (body) => {
      body.innerHTML = `<p class="mp-quiet">${escapeHtml(line)}</p><div id="${HOST_IDS[kind]}"></div>`;
      render();
    };
    const rows = [
      {
        id: 'chatgpt', kind: 'cloud', order: 10, name: 'ChatGPT', getStatus: chatgptStatus,
        what: jt('settings.models.services.chatgpt.what', 'Your ChatGPT subscription'), actionLabel: jt('settings.cloudModels.signInShort', 'Sign in'),
        renderDrawer: drawerBody('chatgpt', jt('settings.models.services.chatgpt.description', "Uses your ChatGPT subscription. Signing in opens your browser; the sign-in is kept in this device's secure store.")),
      },
      {
        id: 'codex', kind: 'cloud', order: 20, name: jt('composer.modelPicker.codexCliGroup', 'Codex CLI'), getStatus: codexStatus,
        what: jt('settings.models.services.codex.what', 'The codex command and its own login'), actionLabel: jt('settings.cloudModels.checkAgain', 'Check again'),
        renderDrawer: drawerBody('codex', jt('settings.models.services.codex.description', 'Uses the codex command and its own login. Jenny never reads that login. Run codex login in a terminal, then check again.')),
      },
    ];

    // Registered as soon as the (lazily loaded) services module exists; every render retries until then.
    function syncRows() {
      const svc = services();
      if (svc) for (const entry of rows) if (!svc.has(entry.id)) svc.register(entry);
      return svc;
    }

    const fieldBinding = () => globalThis.rendererSettingsFieldBinding
      || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
    const button = (id, label, variant, disabled) => (typeof inventory.actionButton === 'function'
      ? inventory.actionButton({ id, label, variant, size: 'sm', disabled: disabled === true }) : '');
    const status = (tone, label) => (typeof inventory.badge === 'function' ? inventory.badge({ tone, size: 'sm', text: label }) : '');

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
        slowShown = now() - paste.connectingSince >= 20000;
        help = slowShown
          ? jt('settings.cloudModels.chatgptConnectingSlow', 'Still waiting for the browser? If it showed an error page after you signed in, use "Browser didn\'t return?" below.')
          : jt('settings.cloudModels.chatgptConnecting', 'Finish signing in in your browser.');
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
        help = jt('settings.cloudModels.localOnlyUse', 'Force local inference is on, so ChatGPT will not run. Turn it off under Local use.');
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

    // The status itself is the table row's; this row keeps the action and what is wrong.
    function codexRow() {
      const help = codex.status === 'ready' ? ''
        : codex.status === 'signed_out' ? jt('settings.cloudModels.codexSignedOut', 'Run codex login in a terminal, then check again.')
          : codex.message || jt('settings.cloudModels.codexUnavailable', 'The codex command was not found or is not set up.');
      return inventory.settingsField({
        id: 'cloudModelsCodexCli', variant: 'row', label: jt('composer.modelPicker.codexCliGroup', 'Codex CLI'), help,
        controlHtml: button('cloudModelsCodexRefresh', jt('settings.cloudModels.checkAgain', 'Check again'), 'ghost', pending === 'codex'),
        dataset: { 'cloud-codex-state': codex.status },
      });
    }

    function link(id, label) {
      return inventory.actionButton?.({ id, label, className: 'cloud-models-link', plain: true }) || '';
    }

    // The inventory text-field primitive is a standalone global (as in
    // renderer-mcp-servers.js).
    function textField(opts) {
      const render = windowRef?.inventoryTextField || globalThis.inventoryTextField;
      return typeof render === 'function' ? render(opts) : '';
    }

    function waitingText() {
      const seconds = Math.max(0, Math.floor((paste.deadlineMs - now()) / 1000));
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
      return jt('settings.cloudModels.waitingMore', 'Waiting up to {time} more', { time });
    }

    function pasteBlock() {
      if (state.chatgpt.auth.state !== 'connecting') return '';
      if (!paste.open) return `<div class="cloud-models-paste">${link('cloudModelsChatgptPasteOpen',
        jt('settings.cloudModels.browserDidNotReturn', "Browser didn't return?"))}</div>`;
      const help = pasteStatus || jt('settings.cloudModels.pasteHelp', 'If the browser shows an error page after you signed in, copy the whole address from its address bar and paste it here.');
      const label = jt('settings.cloudModels.pasteFieldLabel', 'Sign-in address from the browser');
      copiedShown = copiedUntil > now();
      return `<div class="cloud-models-paste"${paste.error ? ' data-state="error"' : ''}>
        <p class="cloud-models-paste-help">${escapeHtml(help)}</p>
        <div class="cloud-models-paste-row">${textField({
          ariaLabel: label, placeholder: jt('settings.cloudModels.pastePlaceholder', 'http://localhost:1455/auth/callback?code=...'), value: paste.value,
          disabled: paste.busy, maxLength: 16384, className: 'cloud-models-paste-field', dataset: { 'paste-field': '' },
        })}
          ${button('cloudModelsChatgptPasteSubmit', jt('settings.cloudModels.finishSignIn', 'Finish sign-in'), 'primary', !paste.value.trim() || paste.busy)}</div>
        <p class="cloud-models-paste-help">${escapeHtml(jt('settings.cloudModels.anotherDevice', 'Signing in on another device?'))}
          ${link('cloudModelsChatgptCopyLink', copiedShown
            ? jt('settings.cloudModels.copied', 'Copied') : jt('settings.cloudModels.copySignInLink', 'Copy sign-in link'))}
          <span data-paste-countdown>${escapeHtml(waitingText())}</span></p>
        ${paste.error ? `<p class="settings-field-error" role="alert">${escapeHtml(paste.error)}</p>` : ''}
      </div>`;
    }

    function stopTicker() {
      if (ticker !== null) windowRef?.clearInterval?.(ticker);
      ticker = null;
    }

    // Once a second while connecting. A repaint replaces every node (focus, a click in flight), so the
    // tick only writes the countdown; it repaints when a rendered state flips (20 s slow help, 2 s "Copied").
    function tick() {
      if (disposed) return;
      if (!slots.chatgpt.node?.isConnected) { stopTicker(); return; } // the drawer closed; its next render restarts it
      if ((now() - paste.connectingSince >= 20000) !== slowShown || (copiedUntil > now()) !== copiedShown) {
        render();
        return;
      }
      const countdown = slots.chatgpt.node.querySelector('[data-paste-countdown]');
      if (countdown) countdown.textContent = waitingText();
    }

    function syncPaste() {
      if (state.chatgpt.auth.state === 'connecting') {
        if (!paste.connectingSince) paste.connectingSince = now();
        if (ticker === null) ticker = windowRef?.setInterval?.(tick, 1000) ?? null;
      } else {
        stopTicker();
        paste = emptyPaste();
        pasteStatus = '';
        copiedUntil = 0;
      }
    }

    function render() {
      if (disposed || typeof inventory.settingsField !== 'function') return;
      const svc = syncRows();
      const host = syncHost('chatgpt');
      if (host) {
        const focused = host.querySelector('[data-paste-field]') === documentRef?.activeElement;
        host.innerHTML = chatgptAccountRow() + pasteBlock() + chatgptSwitchRow();
        const input = host.querySelector('[data-paste-field]');
        if (input) {
          input.value = paste.value;
          if (focused && !input.disabled) input.focus();
        }
        if (ticker === null && state.chatgpt.auth.state === 'connecting') syncPaste();
      }
      const codexHost = syncHost('codex');
      if (codexHost) codexHost.innerHTML = codexRow();
      if (svc) for (const entry of rows) svc.refresh(entry.id);
    }

    const refreshComposerSoon = () => { if (!disposed) Promise.resolve().then(refreshComposerModels).catch(() => {}); };

    // True when the reply carried a state to show.
    function adopt(result) {
      const next = result?.state && typeof result.state === 'object' ? result.state : result;
      if (!next || typeof next !== 'object' || !next.chatgpt) return false;
      state = normalizeState(next);
      syncPaste();
      // ChatGPT models are listed only while signed in with the switch on: the first read seeds, a later change refreshes Composer once.
      const key = `${state.chatgpt.enabled}|${state.chatgpt.auth.state === 'signed_in'}`;
      const changed = visibilityKey !== '' && key !== visibilityKey;
      visibilityKey = key;
      if (changed) refreshComposerSoon();
      return true;
    }

    // Codex CLI models are listed only while its login is ready (no push for it): the first read seeds, a later change refreshes Composer once.
    function adoptCodex(raw) {
      const next = normalizeCodexState(raw);
      const changed = codexSeeded && next.status !== codex.status;
      codexSeeded = true;
      codex = next;
      if (changed) refreshComposerSoon();
      if (raw?.code !== 'auth_unchecked') codexRechecks = 0;
      scheduleCodexRecheck(raw?.code === 'auth_unchecked');
    }

    // The main process answers auth_unchecked and checks in the background; nothing pushes the
    // result, so the row re-reads a bounded few times (1.5 s, 3 s, ... ~30 s in all).
    function scheduleCodexRecheck(unchecked) {
      if (codexRecheck !== null) windowRef?.clearTimeout?.(codexRecheck);
      codexRecheck = null;
      if (!unchecked || disposed || codexRechecks >= 6 || typeof windowRef?.setTimeout !== 'function') return;
      codexRechecks += 1;
      codexRecheck = windowRef.setTimeout(async () => {
        codexRecheck = null;
        try {
          const codexState = await getCodexBridge()?.getState?.();
          if (disposed) return;
          adoptCodex(codexState);
          render();
        } catch (_error) { /* the row keeps its last state */ }
      }, 1500 * codexRechecks);
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
      } catch (_error) { /* the row keeps "Not found" */ }
      loaded = true;
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

    function pasteError(reason) {
      const messages = {
        invalid_url: jt('settings.cloudModels.pasteErrorInvalidUrl', "That isn't the sign-in address. Copy the whole address from the browser's address bar; it starts with http://localhost."),
        missing_code: jt('settings.cloudModels.pasteErrorMissingCode', 'That address has no sign-in code. Finish signing in in the browser first, then copy the address.'),
        access_denied: jt('settings.cloudModels.pasteErrorAccessDenied', 'Sign-in was cancelled in the browser.'),
        state_mismatch: jt('settings.cloudModels.pasteErrorStateMismatch', 'That address belongs to an earlier sign-in attempt. Use the browser tab that opened last, or start again.'),
        no_pending_flow: jt('settings.cloudModels.pasteErrorExpired', 'This sign-in timed out. Start again from Sign in with ChatGPT.'),
      };
      return messages[reason] || jt('settings.cloudModels.actionFailed', 'Jenny could not complete that request. Try again.');
    }

    async function pasteAction(kind) {
      if (disposed || state.chatgpt.auth.state !== 'connecting') return;
      const current = paste;
      const bridge = getBridge();
      if (kind === 'submit') {
        if (!paste.open || paste.busy || !paste.value.trim()) return;
        paste.busy = true;
        paste.error = '';
      } else if (kind === 'open') {
        paste.open = true;
      }
      render();
      try {
        if (kind === 'copy') {
          const { url } = await bridge.chatgptPendingLink();
          if (disposed || current !== paste || !url) return;
          await windowRef.navigator.clipboard.writeText(url);
          if (!disposed && current === paste) copiedUntil = now() + 2000;
        } else {
          const result = kind === 'open'
            ? await bridge.chatgptExtendPending()
            : await bridge.chatgptCompletePasted(paste.value.trim());
          if (disposed || current !== paste) return;
          adopt(result);
          if (current !== paste) return;
          if (kind === 'open' && result.ok) paste.deadlineMs = result.deadlineMs;
          else if (kind === 'submit' && (result.ok || result.reason === 'already_received')) {
            pasteStatus = result.ok
              ? jt('settings.cloudModels.finishingSignIn', 'Finishing sign-in…')
              : jt('settings.cloudModels.alreadySigningIn', 'Already signing in…');
          } else {
            if (kind === 'submit') paste.busy = false;
            paste.error = pasteError(result.reason);
          }
        }
      } catch (_error) {
        if (!disposed && current === paste) {
          if (kind === 'submit') paste.busy = false;
          paste.error = pasteError('action_failed');
        }
      }
      render();
    }

    function onInput(event) {
      if (!event.target?.matches?.('[data-paste-field]') || paste.busy) return;
      paste.value = event.target.value;
      const submit = slots.chatgpt.node?.querySelector('[data-action="cloudModelsChatgptPasteSubmit"]');
      if (submit) submit.disabled = !paste.value.trim();
    }

    function onKeyDown(event) {
      if (event.key === 'Enter' && event.target?.matches?.('[data-paste-field]')) {
        event.preventDefault();
        void pasteAction('submit');
      }
    }

    function onClick(event) {
      const target = event?.target?.closest?.('[data-action]');
      if (!target || target.disabled) return;
      const bridge = getBridge();
      const action = target.getAttribute('data-action');
      if (action === 'cloudModelsChatgptSignIn') {
        void run('sign-in', async () => {
          const previous = state.chatgpt.auth;
          state.chatgpt.auth = { ...previous, state: 'connecting', error: '' };
          syncPaste();
          render();
          // A rejected call or a reply without a state ends the attempt: the optimistic row goes back.
          const revert = () => {
            if (disposed || state.chatgpt.auth.state !== 'connecting') return;
            state.chatgpt.auth = previous;
            syncPaste();
          };
          let adopted = false;
          try {
            adopted = adopt(await bridge.chatgptSignIn());
          } finally {
            if (!adopted) revert();
          }
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
      } else if (PASTE_ACTIONS[action]) {
        void pasteAction(PASTE_ACTIONS[action]);
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

    function bindSwitch(registerListener, host) {
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

    // A drawer host is a fresh node on every open: listeners follow the node the page has now.
    function syncHost(kind) {
      const slot = slots[kind];
      const node = documentRef?.getElementById?.(HOST_IDS[kind]) || null;
      if (slot.node === node) return node;
      for (const cleanup of slot.cleanups.splice(0)) cleanup();
      slot.node = node;
      if (!node?.addEventListener) return node;
      const registerListener = (target, type, handler, listenerOptions) => listen(slot.cleanups, target, type, handler, listenerOptions);
      registerListener(node, 'click', onClick);
      if (kind === 'chatgpt') {
        registerListener(node, 'input', onInput);
        registerListener(node, 'keydown', onKeyDown);
        bindSwitch(registerListener, node);
      }
      return node;
    }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      if (windowRef?.addEventListener) listen(listeners, windowRef, 'pagehide', stopTicker);
      if (documentRef?.addEventListener) listen(listeners, documentRef, SERVICES_READY_EVENT, render);
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
      stopTicker();
      if (codexRecheck !== null) windowRef?.clearTimeout?.(codexRecheck);
      generation += 1;
      try { unsubscribe?.(); } catch (_error) { /* best effort */ }
      for (const cleanup of listeners.splice(0)) cleanup();
      for (const slot of Object.values(slots)) {
        for (const cleanup of slot.cleanups.splice(0)) cleanup();
        slot.node = null;
      }
      for (const entry of rows) services()?.unregister(entry.id);
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
