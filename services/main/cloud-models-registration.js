'use strict';

// Cloud models group (plugin platform retirement, stage 2): the core owner of
// the ChatGPT model catalog, of the engine refresh that follows a sign-in or
// sign-out, and of the cloudModels.* IPC behind Settings > Models. Until
// 2026-10-02 these lived in the signed ChatGPT plugin's runtime wiring.
// Credential handling is unchanged: chatgptAuthService keeps the tokens in the
// safeStorage-backed secure store and this module never returns token
// material to the renderer.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const {
  createChatGptAuthServiceDefault,
  ensureChatgptAuthService,
  syntheticAuthEnabled,
  triggerProviderSidecarReinit,
} = require('../provider-auth-runtime');
const {
  createChatgptModelCatalogService,
  primeChatgptCatalogForRestore,
} = require('../backend/chatgpt-model-catalog-service');
const {
  chatgptModelsEnabled,
  chatgptChoiceFromRetiredPlugin,
} = require('../backend/chatgpt-models-enabled');
const { inferEngineTypeFromModel } = require('../backend/backend-service-utils');

const CANCEL_SETTLE_TIMEOUT_MS = 2000;
const LEGACY_CHOICE_TIMEOUT_MS = 2000;
const ENGINE_SETTLE_TIMEOUT_MS = 30000;

function noop() {}

function boundedWait(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

function publicAuthStatus(status) {
  const source = status && typeof status === 'object' ? status : {};
  const error = source.error && typeof source.error === 'object'
    ? { code: String(source.error.code || ''), message: String(source.error.message || '').slice(0, 240) }
    : null;
  return {
    state: String(source.state || 'signed_out'),
    email: String(source.email || ''),
    planType: String(source.planType || source.plan_type || ''),
    error,
  };
}

function registerCloudModels(ipcMainLike, {
  backendService,
  shellConfigService = backendService?.configService || null,
  sendBridgeEvent = noop,
  processRef = process,
  createAuthService = createChatGptAuthServiceDefault,
  readLegacyPluginFacts = async () => null,
  legacyChoiceTimeoutMs = LEGACY_CHOICE_TIMEOUT_MS,
  primeTimeoutMs,
  authorization = {},
  log = noop,
} = {}) {
  if (!backendService) return { dispose: noop };
  const env = processRef?.env || process.env;
  const authService = ensureChatgptAuthService({ backendService, log, createAuthService, env });
  let disposed = false;
  let signInFlight = null;

  const configState = () => {
    try { return shellConfigService?.getState?.() || {}; } catch (_error) { return {}; }
  };
  const enabled = () => chatgptModelsEnabled(shellConfigService);

  const catalog = createChatgptModelCatalogService({
    authService,
    getAuthority: () => (!disposed && enabled() && !syntheticAuthEnabled(env)
      ? { source: 'core' } : null),
    onInvalidated: () => {
      backendService._modelCatalogEpoch = (backendService._modelCatalogEpoch || 0) + 1;
      backendService._modelListLastResult = null;
      backendService._modelListInFlightPromise = null;
      for (const cache of [backendService._modelListForEngineLastResults,
        backendService._modelListForEngineInFlightPromises]) {
        if (typeof cache?.clear === 'function') cache.clear();
      }
    },
    log: (event, data) => log('INFO', event, data),
  });
  backendService.chatgptModelCatalogService = catalog;

  function getState() {
    const state = configState();
    return {
      chatgpt: {
        enabled: enabled(),
        active: String(state.preferredEngineType || '') === 'chatgpt',
        auth: publicAuthStatus(authService?.getStatus?.()),
      },
      localOnly: state.offlineIntelligence?.mode === 'local_only',
    };
  }

  function pushState() {
    if (!disposed) sendBridgeEvent('cloudModels.onChanged', getState());
  }

  // The engine follows the credential only on a real transition. A cancelled
  // or failed sign-in leaves the credential where it was, so it no longer
  // re-initializes a live engine (it used to, through the plugin bridge).
  let lastSignedIn = authService?.hasCredential?.() === true;
  const unsubscribeAuth = authService?.onStatusChange?.(() => {
    const signedIn = authService?.hasCredential?.() === true;
    if (signedIn !== lastSignedIn) {
      lastSignedIn = signedIn;
      if (enabled()) {
        triggerProviderSidecarReinit(backendService, shellConfigService, log, 'chatgpt_auth_changed');
      }
    }
    pushState();
  }) || noop;

  // Turning ChatGPT off hands the engine to the default one. Before the first
  // engine start that is a field write; afterwards it waits for any running
  // initialization (which may carry the token) and then re-targets, so the
  // refresh cannot join a ChatGPT flight and the next initialize omits the token.
  async function leaveChatgptEngine() {
    if (configState().preferredEngineType === 'chatgpt') {
      shellConfigService?.updatePreferredEngineType?.('');
    }
    const fallback = inferEngineTypeFromModel(backendService.defaultModel || '');
    const target = fallback && fallback !== 'chatgpt' ? fallback : 'ollama';
    if (!backendService.sidecarClient) {
      if (backendService.currentEngineType === 'chatgpt') backendService.currentEngineType = target;
      return;
    }
    const pending = backendService._managedInitializeFlight?.promise;
    if (pending) await boundedWait(pending, ENGINE_SETTLE_TIMEOUT_MS);
    if (disposed || enabled() || backendService.currentEngineType !== 'chatgpt') return;
    await backendService.refreshManagedConfig?.('chatgpt_models_disabled', { requestedEngineType: target });
  }

  // The retired plugin's on/off choice, read from its store before the first
  // engine start so an old "off" holds from the start (also with the plugins
  // flag off or in plugin safe mode). A choice saved in Settings wins.
  async function adoptLegacyPluginChoice() {
    if (typeof configState().chatgptModelsEnabled === 'boolean') return;
    const facts = await readLegacyPluginFacts();
    const value = facts ? chatgptChoiceFromRetiredPlugin(facts) : null;
    if (value === null || typeof configState().chatgptModelsEnabled === 'boolean') return;
    shellConfigService?.updateChatgptModelsEnabled?.(value);
    log('INFO', 'cloud_models.legacy_plugin_choice_adopted', { enabled: value });
    if (!value) await leaveChatgptEngine();
  }

  // Startup waits for the old choice only so long. Until it is known the
  // token stays out of the sidecar (managed-sidecar-config), so a slow store
  // cannot let an old "off" start ChatGPT; if it then settles as "on", an
  // already-started ChatGPT engine re-initializes to pick the token up.
  let startupWentAhead = false;
  backendService._chatgptLegacyChoicePending = typeof configState().chatgptModelsEnabled !== 'boolean';
  const adoption = adoptLegacyPluginChoice().catch(() => {
    log('WARN', 'cloud_models.legacy_plugin_choice_failed', {});
  }).finally(() => {
    if (!backendService._chatgptLegacyChoicePending) return;
    backendService._chatgptLegacyChoicePending = false;
    if (startupWentAhead && !disposed && enabled() && backendService.sidecarClient) {
      triggerProviderSidecarReinit(backendService, shellConfigService, log, 'chatgpt_legacy_choice_settled');
    }
  });
  // B13: a ChatGPT startup restores the saved model only while the catalog
  // lists it. Start the bounded fetch now, during IPC registration, and let
  // the startup engine initialization wait for it (local-engine-lifecycle).
  const legacyChoice = boundedWait(adoption, legacyChoiceTimeoutMs).then(() => {
    if (backendService._chatgptLegacyChoicePending) {
      startupWentAhead = true;
      log('WARN', 'cloud_models.legacy_plugin_choice_slow', {});
    }
  });
  const startupPrime = legacyChoice.then(() => primeChatgptCatalogForRestore(backendService, catalog, {
    ...(Number.isFinite(primeTimeoutMs) ? { timeoutMs: primeTimeoutMs } : {}),
  }));
  backendService._awaitChatgptStartupCatalog = () => startupPrime;

  async function setChatgptEnabled(_event, value) {
    if (typeof value !== 'boolean') return { ok: false, reason: 'invalid_value', state: getState() };
    if (value === enabled() && configState().chatgptModelsEnabled === value) {
      return { ok: true, state: getState() };
    }
    shellConfigService?.updateChatgptModelsEnabled?.(value);
    // The config writer answers with the old snapshot when the save fails.
    if (configState().chatgptModelsEnabled !== value) {
      log('WARN', 'cloud_models.chatgpt_enabled_not_saved', { enabled: value });
      return { ok: false, reason: 'settings_write_failed', state: getState() };
    }
    catalog.invalidate();
    if (!value) {
      leaveChatgptEngine().catch(() => log('WARN', 'cloud_models.disable_refresh_failed', {}));
    }
    log('INFO', 'cloud_models.chatgpt_enabled_updated', { enabled: value });
    pushState();
    return { ok: true, state: getState() };
  }

  async function chatgptSignIn() {
    if (!authService?.start) return { ok: false, reason: 'chatgpt_auth_unavailable', state: getState() };
    if (!signInFlight) {
      signInFlight = Promise.resolve()
        .then(() => authService.start())
        .finally(() => { signInFlight = null; });
    }
    try {
      await signInFlight;
    } catch (_error) { /* the auth status carries the bounded error */ }
    return { ok: true, state: getState() };
  }

  async function chatgptCancel() {
    const flight = signInFlight;
    authService?.cancel?.();
    // Answer with the settled state, not the in-flight "connecting" one.
    if (flight) await boundedWait(flight, CANCEL_SETTLE_TIMEOUT_MS);
    return { ok: true, state: getState() };
  }

  async function chatgptSignOut() {
    try {
      await authService?.signOut?.();
    } catch (_error) { /* the auth status carries the bounded error */ }
    return { ok: true, state: getState() };
  }

  function chatgptCompletePasted(url) {
    if (!authService?.completeFromPastedUrl) return { ok: false, reason: 'chatgpt_auth_unavailable', state: getState() };
    const { ok, reason } = authService.completeFromPastedUrl(url);
    return { ok, reason, state: getState() };
  }

  function chatgptExtendPending() {
    if (!authService?.extendPending) return { ok: false, reason: 'chatgpt_auth_unavailable', state: getState() };
    const { ok, reason, deadline_ms: deadlineMs } = authService.extendPending();
    return { ok, reason, deadlineMs, state: getState() };
  }

  function chatgptPendingLink() {
    if (!authService?.getPendingAuthorizeUrl) return { ok: false, reason: 'chatgpt_auth_unavailable', state: getState() };
    return { ok: true, url: authService.getPendingAuthorizeUrl(), state: getState() };
  }

  registerIpcInvokeHandlers(ipcMainLike, {
    'cloudModels.getState': () => getState(),
    'cloudModels.setChatgptEnabled': setChatgptEnabled,
    'cloudModels.chatgptSignIn': () => chatgptSignIn(),
    'cloudModels.chatgptCancel': () => chatgptCancel(),
    'cloudModels.chatgptSignOut': () => chatgptSignOut(),
    'cloudModels.chatgptCompletePasted': (_event, url) => chatgptCompletePasted(url),
    'cloudModels.chatgptExtendPending': () => chatgptExtendPending(),
    'cloudModels.chatgptPendingLink': () => chatgptPendingLink(),
  }, authorization);

  function dispose() {
    if (disposed) return;
    disposed = true;
    unsubscribeAuth();
    catalog.dispose();
    if (backendService.chatgptModelCatalogService === catalog) {
      delete backendService.chatgptModelCatalogService;
    }
    delete backendService._awaitChatgptStartupCatalog;
    delete backendService._chatgptLegacyChoicePending;
  }

  return { getState, setChatgptEnabled, chatgptSignIn, chatgptCancel, chatgptSignOut,
    chatgptCompletePasted, chatgptExtendPending, chatgptPendingLink, catalog, dispose };
}

module.exports = { registerCloudModels, publicAuthStatus };
