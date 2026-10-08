'use strict';

// Coverage for services/main/cloud-models-registration.js: the core owner of
// the ChatGPT catalog and the cloudModels.* IPC behind Settings > Models
// (plugin platform retirement, stage 2).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerCloudModels, publicAuthStatus } = require('../services/main/cloud-models-registration');
const { assertChatTurnAdmissible } = require('../services/backend/chat-turn-admission');
const { chatgptModelsEnabled } = require('../services/backend/chatgpt-models-enabled');
const { normalizeState } = require('../services/shell-config-state');

function fakeIpc() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) { handlers.set(channel, fn); },
    invoke(methodPath, ...args) {
      return handlers.get(getBridgeChannel(methodPath, 'invoke'))({ sender: {} }, ...args);
    },
  };
}

function fakeAuth({ signedIn = false } = {}) {
  let state = signedIn ? 'signed_in' : 'signed_out';
  let pending = null;
  const subscribers = new Set();
  const emit = () => { for (const fn of subscribers) fn(); };
  return {
    starts: 0,
    getStatus: () => ({ state, email: state === 'signed_in' ? 'sam@example.com' : '',
      planType: state === 'signed_in' ? 'plus' : '', accountId: 'acct', error: null,
      access_token: 'must-never-leak' }),
    hasCredential: () => state === 'signed_in',
    getAccountId: () => 'acct',
    getCredentialEpoch: () => 1,
    getAccessToken: async () => (state === 'signed_in' ? 'token' : ''),
    start() {
      this.starts += 1;
      state = 'connecting';
      emit();
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    finish(next) { state = next; emit(); pending?.resolve(); pending = null; },
    cancel() {
      // Like the real service: the abort settles a tick later.
      setTimeout(() => { state = 'signed_out'; emit(); pending?.reject(new Error('cancelled')); pending = null; }, 5);
    },
    async signOut() { state = 'signed_out'; emit(); },
    onStatusChange(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}

function setup({ config = {}, auth = fakeAuth(), backend = {}, readLegacyPluginFacts,
  saveFails = false, legacyChoiceTimeoutMs } = {}) {
  let state = { preferredEngineType: 'ollama', chatgptModelsEnabled: null, ...config };
  const shellConfigService = {
    getState: () => state,
    // The real writer answers with the old snapshot when the save fails.
    updateChatgptModelsEnabled(value) {
      if (!saveFails) state = { ...state, chatgptModelsEnabled: value };
      return state;
    },
    updatePreferredEngineType(value) { state = { ...state, preferredEngineType: value }; },
  };
  const refreshes = [];
  const backendService = {
    chatgptAuthService: auth,
    configService: shellConfigService,
    currentEngineType: state.preferredEngineType,
    refreshManagedConfig: async (reason, options) => {
      refreshes.push({ reason, options });
      if (options?.requestedEngineType) backendService.currentEngineType = options.requestedEngineType;
      return { ok: true };
    },
    ...backend,
  };
  const events = [];
  const ipc = fakeIpc();
  const handle = registerCloudModels(ipc, {
    backendService,
    shellConfigService,
    sendBridgeEvent: (channel, payload) => events.push({ channel, payload }),
    processRef: { env: {} },
    primeTimeoutMs: 20,
    ...(readLegacyPluginFacts ? { readLegacyPluginFacts } : {}),
    ...(legacyChoiceTimeoutMs ? { legacyChoiceTimeoutMs } : {}),
  });
  return { ipc, handle, auth, backendService, shellConfigService, refreshes, events,
    getConfig: () => state };
}

test('registers every cloudModels invoke method and owns the ChatGPT catalog', async () => {
  const { ipc, handle, backendService } = setup();
  for (const method of ['getState', 'setChatgptEnabled', 'chatgptSignIn', 'chatgptCancel', 'chatgptSignOut',
    'chatgptCompletePasted', 'chatgptExtendPending', 'chatgptPendingLink']) {
    assert.ok(ipc.handlers.has(getBridgeChannel(`cloudModels.${method}`, 'invoke')), method);
  }
  assert.equal(backendService.chatgptModelCatalogService, handle.catalog);
  assert.equal(typeof backendService._awaitChatgptStartupCatalog, 'function');
  handle.dispose();
  assert.equal(backendService.chatgptModelCatalogService, undefined);
  assert.equal(backendService._awaitChatgptStartupCatalog, undefined);
});

test('paste handlers pass through bounded service results and the public state', async (t) => {
  const auth = fakeAuth();
  const calls = [];
  auth.completeFromPastedUrl = (url) => { calls.push(url); return { ok: false, reason: 'state_mismatch' }; };
  auth.extendPending = () => ({ ok: true, deadline_ms: 600000 });
  auth.getPendingAuthorizeUrl = () => 'https://auth.openai.com/oauth/authorize?state=pending';
  const { ipc, handle } = setup({ auth });
  t.after(() => handle.dispose());
  const state = handle.getState();
  const raw = 'http://localhost:1455/auth/callback?code=private';
  assert.deepEqual(await ipc.invoke('cloudModels.chatgptCompletePasted', raw), { ok: false, reason: 'state_mismatch', state });
  assert.deepEqual(calls, [raw]);
  auth.completeFromPastedUrl = () => ({ ok: true });
  assert.deepEqual(await handle.chatgptCompletePasted(raw), { ok: true, reason: undefined, state });
  assert.deepEqual(await ipc.invoke('cloudModels.chatgptExtendPending'), { ok: true, reason: undefined, deadlineMs: 600000, state });
  assert.deepEqual(await ipc.invoke('cloudModels.chatgptPendingLink'), { ok: true,
    url: 'https://auth.openai.com/oauth/authorize?state=pending', state });
  auth.extendPending = () => ({ ok: false, reason: 'no_pending_flow' });
  assert.deepEqual(await handle.chatgptExtendPending(), { ok: false, reason: 'no_pending_flow', deadlineMs: undefined, state });
});

test('paste handlers fail closed when the auth methods are unavailable', async (t) => {
  const { ipc, handle } = setup();
  t.after(() => handle.dispose());
  for (const method of ['chatgptCompletePasted', 'chatgptExtendPending', 'chatgptPendingLink']) {
    assert.deepEqual(await ipc.invoke(`cloudModels.${method}`), {
      ok: false, reason: 'chatgpt_auth_unavailable', state: handle.getState(),
    });
  }
});

test('the state carries status, email and plan but never token material', async () => {
  const { ipc, handle } = setup({ auth: fakeAuth({ signedIn: true }),
    config: { offlineIntelligence: { mode: 'local_only' } } });
  const state = await ipc.invoke('cloudModels.getState');
  assert.deepEqual(state, {
    chatgpt: { enabled: true, active: false,
      auth: { state: 'signed_in', email: 'sam@example.com', planType: 'plus', error: null } },
    localOnly: true,
  });
  assert.doesNotMatch(JSON.stringify(state), /must-never-leak|acct/);
  handle.dispose();
});

test('cancel answers with the settled state, not the in-flight connecting one', async () => {
  const { ipc, handle } = setup();
  const signIn = ipc.invoke('cloudModels.chatgptSignIn');
  const cancelled = await ipc.invoke('cloudModels.chatgptCancel');
  assert.equal(cancelled.state.chatgpt.auth.state, 'signed_out');
  assert.equal((await signIn).ok, true);
  handle.dispose();
});

test('a second sign-in click joins the flight instead of starting another', async () => {
  const { ipc, handle, auth } = setup();
  const first = ipc.invoke('cloudModels.chatgptSignIn');
  const second = ipc.invoke('cloudModels.chatgptSignIn');
  await new Promise((resolve) => setImmediate(resolve));
  auth.finish('signed_in');
  await Promise.all([first, second]);
  assert.equal(auth.starts, 1);
  handle.dispose();
});

test('the engine refreshes only on a real credential transition', async () => {
  const { ipc, handle, auth, refreshes } = setup({ config: { preferredEngineType: 'chatgpt' } });
  // A cancelled sign-in goes connecting -> signed_out: no transition.
  const signIn = ipc.invoke('cloudModels.chatgptSignIn');
  await ipc.invoke('cloudModels.chatgptCancel');
  await signIn;
  assert.equal(refreshes.length, 0);
  // A completed sign-in is a transition.
  const again = ipc.invoke('cloudModels.chatgptSignIn');
  await new Promise((resolve) => setImmediate(resolve));
  auth.finish('signed_in');
  await again;
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].options.requestedEngineType, 'chatgpt');
  await ipc.invoke('cloudModels.chatgptSignOut');
  assert.equal(refreshes.length, 2);
  handle.dispose();
});

test('auth changes push the public state to the renderer', async () => {
  const { handle, auth, events } = setup();
  auth.finish('signed_in');
  const pushed = events.filter((event) => event.channel === 'cloudModels.onChanged');
  assert.ok(pushed.length >= 1);
  assert.equal(pushed.at(-1).payload.chatgpt.auth.state, 'signed_in');
  handle.dispose();
});

async function settle() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('turning ChatGPT models off persists, hides the catalog and hands the engine to the default', async () => {
  const { ipc, handle, getConfig, refreshes, backendService } = setup({
    auth: fakeAuth({ signedIn: true }), config: { preferredEngineType: 'chatgpt' },
    backend: { sidecarClient: {}, defaultModel: 'qwen3:8b' },
  });
  assert.equal((await ipc.invoke('cloudModels.setChatgptEnabled', 'yes')).ok, false);
  const result = await ipc.invoke('cloudModels.setChatgptEnabled', false);
  assert.equal(result.ok, true);
  assert.equal(result.state.chatgpt.enabled, false);
  assert.equal(getConfig().chatgptModelsEnabled, false);
  assert.equal(getConfig().preferredEngineType, '');
  await settle();
  // Re-targeted at the default engine, not a re-initialized ChatGPT engine.
  assert.deepEqual(refreshes, [{ reason: 'chatgpt_models_disabled',
    options: { requestedEngineType: 'ollama' } }]);
  assert.equal(backendService.currentEngineType, 'ollama');
  // No authority, so the catalog lists nothing.
  assert.equal((await backendService.chatgptModelCatalogService.refresh())?.models ?? null, null);
  handle.dispose();
});

test('a ChatGPT turn is refused while the models are turned off', () => {
  const service = {
    currentEngineType: 'chatgpt',
    configService: { getState: () => ({ chatgptModelsEnabled: false }) },
    chatgptAuthService: { hasCredential: () => true, getCredentialEpoch: () => 1 },
    _chatgptRuntimeCredentialEpoch: 1,
  };
  assert.throws(() => assertChatTurnAdmissible(service, 'session-1'),
    (error) => error.code === 'chatgpt_models_disabled' && error.category === 'setup');
  service.configService = { getState: () => ({ chatgptModelsEnabled: null }) };
  assert.doesNotThrow(() => assertChatTurnAdmissible(service, 'session-1'));
});

test('the enabled setting is three-state in shell config and unset counts as on', () => {
  assert.equal(normalizeState({}).chatgptModelsEnabled, null);
  assert.equal(normalizeState({ chatgptModelsEnabled: false }).chatgptModelsEnabled, false);
  assert.equal(normalizeState({ chatgptModelsEnabled: 'no' }).chatgptModelsEnabled, null);
  assert.equal(chatgptModelsEnabled({ getState: () => ({ chatgptModelsEnabled: null }) }), true);
  assert.equal(chatgptModelsEnabled({ getState: () => ({ chatgptModelsEnabled: false }) }), false);
  assert.equal(chatgptModelsEnabled(null), true);
});

test('publicAuthStatus bounds the error text and drops unknown fields', () => {
  const status = publicAuthStatus({ state: 'error', error: { code: 'x', message: 'm'.repeat(500) }, token: 't' });
  assert.equal(status.error.message.length, 240);
  assert.equal('token' in status, false);
});

test('the access token stays out of the sidecar secrets while ChatGPT models are off', () => {
  const { buildManagedSidecarSecrets } = require('../services/backend/managed-sidecar-config');
  const service = (enabled) => ({
    currentEngineType: 'chatgpt',
    configService: { getState: () => ({ chatgptModelsEnabled: enabled }) },
    chatgptAuthService: { getCachedAccessToken: () => 'token-1' },
  });
  assert.equal(buildManagedSidecarSecrets(service(null)).chatgpt_access_token, 'token-1');
  assert.equal(buildManagedSidecarSecrets(service(false)).chatgpt_access_token, undefined);
});

test('turning ChatGPT off waits for a running initialization before re-targeting', async () => {
  let release;
  const flight = new Promise((resolve) => { release = resolve; });
  const { ipc, handle, refreshes, backendService } = setup({
    auth: fakeAuth({ signedIn: true }), config: { preferredEngineType: 'chatgpt' },
    backend: { sidecarClient: {}, defaultModel: '', _managedInitializeFlight: { promise: flight } },
  });
  backendService.currentEngineType = 'chatgpt';
  assert.equal((await ipc.invoke('cloudModels.setChatgptEnabled', false)).ok, true);
  await settle();
  assert.deepEqual(refreshes, [], 'no refresh joins the ChatGPT flight');
  release();
  await settle();
  assert.deepEqual(refreshes.map((entry) => entry.options), [{ requestedEngineType: 'ollama' }]);
  handle.dispose();
});

test('a setting the config writer did not save is reported as not saved', async () => {
  const { ipc, handle, getConfig } = setup({ saveFails: true });
  const result = await ipc.invoke('cloudModels.setChatgptEnabled', false);
  assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: 'settings_write_failed' });
  assert.equal(getConfig().chatgptModelsEnabled, null);
  handle.dispose();
});

test('an "off" from the retired plugin is adopted before the first engine start', async () => {
  const { handle, getConfig, backendService, refreshes } = setup({
    auth: fakeAuth({ signedIn: true }), config: { preferredEngineType: 'chatgpt' },
    readLegacyPluginFacts: async () => ({ receipt: { status: 'removed' }, desiredState: '' }),
  });
  backendService.currentEngineType = 'chatgpt';
  await backendService._awaitChatgptStartupCatalog();
  assert.equal(getConfig().chatgptModelsEnabled, false);
  assert.equal(getConfig().preferredEngineType, '');
  // No sidecar yet: the first initialize starts on the default engine, without the token.
  assert.equal(backendService.currentEngineType, 'ollama');
  assert.deepEqual(refreshes, []);
  handle.dispose();
});

// The bounded wait lets startup go on when the plugin store is slow. Until the
// old choice is known the token stays out of the sidecar (an old "off" must
// hold from the first start); once it settles as "on", ChatGPT re-initializes.
test('a slow legacy read keeps the token out until the choice is known', async () => {
  const { buildManagedSidecarSecrets } = require('../services/backend/managed-sidecar-config');
  let settleRead;
  const auth = { ...fakeAuth({ signedIn: true }), getCachedAccessToken: () => 'token-1' };
  const { handle, getConfig, backendService, refreshes } = setup({
    auth, config: { preferredEngineType: 'chatgpt' }, legacyChoiceTimeoutMs: 10,
    readLegacyPluginFacts: () => new Promise((resolve) => { settleRead = resolve; }),
  });
  backendService.currentEngineType = 'chatgpt';
  await backendService._awaitChatgptStartupCatalog();
  assert.equal(getConfig().chatgptModelsEnabled, null, 'nothing is invented on timeout');
  assert.equal(buildManagedSidecarSecrets(backendService).chatgpt_access_token, undefined,
    'no token while the old choice is unknown');
  backendService.sidecarClient = {};
  settleRead({ receipt: { status: 'installed', auto_enabled: true }, desiredState: 'active' });
  await settle();
  assert.equal(getConfig().chatgptModelsEnabled, true);
  assert.equal(buildManagedSidecarSecrets(backendService).chatgpt_access_token, 'token-1');
  assert.deepEqual(refreshes.map((entry) => entry.reason), ['chatgpt_legacy_choice_settled']);
  handle.dispose();
});

test('a choice saved in Settings wins over the retired plugin, and "on" leaves the engine alone', async () => {
  let reads = 0;
  const saved = setup({ config: { chatgptModelsEnabled: true },
    readLegacyPluginFacts: async () => { reads += 1; return { receipt: { status: 'removed' } }; } });
  await saved.backendService._awaitChatgptStartupCatalog();
  assert.equal(saved.getConfig().chatgptModelsEnabled, true);
  assert.equal(reads, 0);
  saved.handle.dispose();

  const enabledPlugin = setup({ config: { preferredEngineType: 'chatgpt' },
    readLegacyPluginFacts: async () => ({ receipt: { status: 'installed' }, desiredState: 'active' }) });
  enabledPlugin.backendService.currentEngineType = 'chatgpt';
  await enabledPlugin.backendService._awaitChatgptStartupCatalog();
  assert.equal(enabledPlugin.getConfig().chatgptModelsEnabled, true);
  assert.equal(enabledPlugin.backendService.currentEngineType, 'chatgpt');
  enabledPlugin.handle.dispose();

  const unreadable = setup({ readLegacyPluginFacts: async () => { throw new Error('store'); } });
  await unreadable.backendService._awaitChatgptStartupCatalog();
  assert.equal(unreadable.getConfig().chatgptModelsEnabled, null);
  unreadable.handle.dispose();
});

test('a sign-in transition drops the cached model lists so Composer picks up ChatGPT models', async () => {
  const auth = fakeAuth();
  const { handle, backendService } = setup({ auth });
  backendService._modelListLastResult = { at: Date.now(), value: { data: [] }, engineType: 'ollama' };
  const pending = auth.start();
  auth.finish('signed_in');
  await pending;
  assert.equal(backendService._modelListLastResult, null);
  handle.dispose();
});

test('the core registrar creates the ChatGPT auth service the plugin runtime used to create', () => {
  const created = [];
  const backendService = { chatgptAuthService: null, secureStore: { marker: true } };
  const handle = registerCloudModels(fakeIpc(), {
    backendService,
    shellConfigService: { getState: () => ({ chatgptModelsEnabled: null }) },
    processRef: { env: {} },
    createAuthService: (options) => {
      created.push(options);
      return fakeAuth();
    },
  });
  assert.equal(created.length, 1);
  assert.equal(created[0].secureStore, backendService.secureStore);
  assert.ok(backendService.chatgptAuthService);
  handle.dispose();
});
