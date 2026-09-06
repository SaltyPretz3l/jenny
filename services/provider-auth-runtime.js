'use strict';

// Jenny-owned composition for descriptor-driven provider authentication.
// Credential storage remains in the existing safeStorage-backed owner; this
// module exposes no renderer IPC surface and never returns token material.
const { createChatGptAuthService } = require('./backend/chatgpt-auth-service');

const createChatGptAuthServiceDefault = createChatGptAuthService;

function syntheticAuthEnabled(env = process.env) {
  return env?.JENNY_AGENT_DEV === '1' && env?.JENNY_STAGE7_SYNTHETIC_OAUTH === '1';
}

function createSyntheticChatGptAuthService({ transitionDelayMs = 300 } = {}) {
  let state = 'signed_out';
  let credentialEpoch = 0;
  let timer = null;
  let pending = null;
  const subscribers = new Set();
  const status = () => ({ state, ...(state === 'signed_in'
    ? { email: 'stage7-smoke@jenny.test', plan_type: 'synthetic' } : {}) });
  const emit = () => { for (const callback of subscribers) callback(status()); };
  const settle = (nextState) => {
    if (timer) clearTimeout(timer);
    timer = null;
    state = nextState;
    if (nextState !== 'connecting') credentialEpoch += 1;
    const active = pending;
    pending = null;
    emit();
    active?.resolve(status());
    return status();
  };
  return Object.freeze({
    getStatus: status,
    start() {
      if (pending) return pending.promise;
      state = 'connecting';
      emit();
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      pending = { promise, resolve };
      timer = setTimeout(() => settle('signed_in'), transitionDelayMs);
      timer.unref?.();
      return promise;
    },
    cancel: () => settle('signed_out'),
    signOut: async () => settle('signed_out'),
    hasCredential: () => state === 'signed_in',
    getAccessToken: async () => (state === 'signed_in' ? 'stage7-synthetic-access-token' : ''),
    getCachedAccessToken: () => (state === 'signed_in' ? 'stage7-synthetic-access-token' : ''),
    getAccountId: () => (state === 'signed_in' ? 'stage7-synthetic-account' : ''),
    getCredentialEpoch: () => credentialEpoch,
    onStatusChange(callback) {
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
  });
}

function resolveOpenExternal() {
  try {
    const electron = require('electron');
    if (typeof electron?.shell?.openExternal === 'function') {
      return (url) => electron.shell.openExternal(url);
    }
  } catch (_error) { /* test/non-Electron process */ }
  return async () => {};
}

function ensureChatgptAuthService({ backendService, log, createAuthService, env = process.env } = {}) {
  if (backendService && !backendService.chatgptAuthService && typeof createAuthService === 'function') {
    try {
      const factory = createAuthService === createChatGptAuthServiceDefault && syntheticAuthEnabled(env)
        ? createSyntheticChatGptAuthService : createAuthService;
      backendService.chatgptAuthService = factory({
        secureStore: backendService.secureStore,
        openExternal: resolveOpenExternal(),
        logger: log,
      });
    } catch (_error) {
      backendService.chatgptAuthService = backendService.chatgptAuthService || null;
    }
  }
  return backendService?.chatgptAuthService || null;
}

function providerReinitIntended(backendService, shellConfigService) {
  const preferredEngineType = String(
    shellConfigService?.getState?.()?.preferredEngineType || ''
  ).trim().toLowerCase();
  return (backendService?.currentEngineType === 'chatgpt' || preferredEngineType === 'chatgpt')
    && typeof backendService?.refreshManagedConfig === 'function';
}

function triggerProviderSidecarReinit(
  backendService,
  shellConfigService,
  log,
  reason = 'provider_auth_updated'
) {
  if (!providerReinitIntended(backendService, shellConfigService)) return;
  Promise.resolve(
    backendService.refreshManagedConfig(reason, { requestedEngineType: 'chatgpt' })
  ).catch((error) => {
    if (typeof log === 'function') {
      log('WARN', 'provider_auth.reinit_failed', { errorName: String(error?.name || 'Error') });
    }
  });
}

module.exports = {
  createChatGptAuthServiceDefault,
  createSyntheticChatGptAuthService,
  ensureChatgptAuthService,
  syntheticAuthEnabled,
  triggerProviderSidecarReinit,
};
