'use strict';

// The third managed-server owner kind (row 123, slice 4b member half): the team
// engine port. It is matched by local origin like llama-server and NInfer, its
// key goes only to its own origin and only while it is ready, it carries no
// alias, and it changes nothing for an endpoint owned by the other two or by nobody.

const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const { DEFAULT_MANAGED_SHELL_MODEL } = require('../services/backend/backend-config');
const { buildManagedSidecarConfig, buildManagedSidecarSecrets } = require('../services/backend/managed-sidecar-lifecycle');
const { resolveManagedConfiguredModel } = require('../services/backend/managed-sidecar-config');
const { managedServerAlias, managedServerApiKey, ninferManagedOrigin, resolveManagedServerOwner } = require('../services/backend/managed-server-owner');
const { resolveProviderIdentity } = require('../services/performance/provider-identity');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const TEAM_URL = 'http://127.0.0.1:51234/v1';

function makeManager({ state, baseUrl, apiKey, alias }) {
  return { getStatus: () => ({ state, alias }), getBaseUrl: () => baseUrl, getApiKey: () => apiKey };
}

function teamPort({ state = 'ready', baseUrl = TEAM_URL, apiKey = 'team-key' } = {}) {
  return { getStatus: () => ({ state, alias: '' }), getBaseUrl: () => (state === 'stopped' ? '' : baseUrl), getApiKey: () => apiKey };
}

function owners({ team = teamPort(), ninfer = 'ready', llama = 'ready' } = {}) {
  return { options: {
    getNinferManager: () => makeManager({ state: ninfer, baseUrl: ninfer === 'stopped' ? '' : 'http://127.0.0.1:8034/v1', apiKey: 'ninfer-key', alias: 'ninfer-model' }),
    getLlamaServerManager: () => makeManager({ state: llama, baseUrl: llama === 'stopped' ? '' : 'http://127.0.0.1:8033/v1', apiKey: 'llama-key', alias: 'llama-model' }),
    ...(team ? { getTeamEnginePort: () => team } : {}),
  } };
}

test('the team engine port is the third owner kind, matched by local origin', () => {
  const service = owners();
  for (const url of ['http://127.0.0.1:51234', 'http://127.0.0.1:51234/v1', 'http://localhost:51234/v1/chat/completions']) {
    const owner = resolveManagedServerOwner(service, url);
    assert.equal(owner?.kind, 'team-engine', url);
    assert.deepEqual(owner.status, { state: 'ready', alias: '' });
  }
  assert.equal(resolveManagedServerOwner(service, 'http://127.0.0.1:51235/v1'), null);
  assert.equal(resolveManagedServerOwner(service, 'https://127.0.0.1:51234/v1'), null);
});

test('its key goes only to its own origin and only while it is ready', () => {
  assert.equal(managedServerApiKey(owners(), TEAM_URL), 'team-key');
  assert.equal(managedServerApiKey(owners(), 'http://127.0.0.1:9000/v1'), '');
  for (const state of ['starting', 'stopping', 'error', '']) {
    // A port that still reports its URL but is not ready keeps its key.
    assert.equal(managedServerApiKey(owners({ team: teamPort({ state }) }), TEAM_URL), '', state);
  }
  assert.equal(managedServerApiKey(owners({ team: teamPort({ state: 'stopped' }) }), TEAM_URL), '');
  const keyless = { getStatus: () => ({ state: 'ready' }), getBaseUrl: () => TEAM_URL, getApiKey: undefined };
  assert.equal(managedServerApiKey(owners({ team: keyless }), TEAM_URL), '');
});

test('it carries no alias, so the configured model stays the model', () => {
  assert.equal(managedServerAlias(owners(), TEAM_URL), '');
  assert.equal(managedServerAlias(owners({ team: teamPort({ state: 'starting' }) }), TEAM_URL), '');
});

test('the other two kinds and an unowned endpoint answer exactly as without the port', () => {
  const urls = ['http://127.0.0.1:8034/v1', 'http://127.0.0.1:8033', 'http://localhost:8033/v1', 'http://127.0.0.1:9000/v1', 'not a url', ''];
  for (const llama of ['ready', 'stopped']) {
    for (const ninfer of ['ready', 'starting', 'stopped']) {
      const without = owners({ team: null, llama, ninfer });
      const withPort = owners({ llama, ninfer });
      for (const url of urls) {
        const label = `${llama}/${ninfer}/${url}`;
        assert.equal(resolveManagedServerOwner(withPort, url)?.kind ?? null, resolveManagedServerOwner(without, url)?.kind ?? null, label);
        assert.equal(managedServerAlias(withPort, url), managedServerAlias(without, url), label);
        assert.equal(managedServerApiKey(withPort, url), managedServerApiKey(without, url), label);
      }
      assert.equal(ninferManagedOrigin(withPort), ninferManagedOrigin(without));
    }
  }
  // A getter that returns null is ignored.
  assert.equal(resolveManagedServerOwner({ options: { getTeamEnginePort: () => null } }, TEAM_URL), null);
});

test('provider identity treats the team engine as an ordinary provider with no live options', () => {
  const service = owners();
  assert.deepEqual(resolveProviderIdentity({ service, apiUrl: TEAM_URL, engineType: 'openai-compatible' }),
    { provider_kind: 'other', live_capable: false });
  assert.equal(resolveProviderIdentity({ service, apiUrl: 'http://127.0.0.1:8033/v1', engineType: 'openai-compatible' }).provider_kind, 'llama-server');
});

function makeBackend({ apiUrl, team = teamPort(), llamaState = 'stopped' }) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-owner-'));
  trackDirectory(userDataPath);
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: { getState: () => ({ localEngines: { openaiCompatible: { port: 8033, apiUrl } } }) },
    getLlamaServerManager: () => makeManager({ state: llamaState, baseUrl: llamaState === 'stopped' ? '' : 'http://127.0.0.1:8033/v1', apiKey: 'llama-key', alias: 'gemma4:12b' }),
    getNinferManager: () => makeManager({ state: 'stopped', baseUrl: '', apiKey: 'ninfer-key', alias: 'qwen' }),
    getTeamEnginePort: () => team,
  });
  service.currentEngineType = 'openai-compatible';
  return service;
}

test('pointed at the port, the sidecar gets the port key, keeps its model and no llama-server json_schema', () => {
  const service = makeBackend({ apiUrl: TEAM_URL });
  assert.deepEqual(buildManagedSidecarSecrets(service), { openai_compatible_api_key: 'team-key' });
  const config = buildManagedSidecarConfig(service);
  assert.equal(config.api_url, TEAM_URL);
  assert.equal(config.json_schema_response_format, false);
  assert.notEqual(resolveManagedConfiguredModel(service), 'gemma4:12b');
  const stopped = makeBackend({ apiUrl: TEAM_URL, team: teamPort({ state: 'starting' }) });
  assert.deepEqual(buildManagedSidecarSecrets(stopped), {});
});

test('pointed elsewhere, a running port changes nothing: llama-server keeps its key, a user server gets none', () => {
  const llama = makeBackend({ apiUrl: '', llamaState: 'ready' });
  assert.deepEqual(buildManagedSidecarSecrets(llama), { openai_compatible_api_key: 'llama-key' });
  assert.equal(buildManagedSidecarConfig(llama).json_schema_response_format, true);
  assert.equal(resolveManagedConfiguredModel(llama), 'gemma4:12b');
  const user = makeBackend({ apiUrl: 'http://127.0.0.1:9000/v1' });
  assert.deepEqual(buildManagedSidecarSecrets(user), {});
  assert.equal(buildManagedSidecarConfig(user).json_schema_response_format, false);
});

test('4b member wiring: a live team selection resolves to its own port before NInfer, never to another endpoint, with the team id', () => {
  const { resolveOpenAICompatibleApiUrl } = require('../services/backend/managed-sidecar-config-model');
  const selection = { id: 'team/team_alpha1/alpha', teamId: 'team_alpha1', modelId: 'alpha' };
  const build = (port) => ({ currentEngineType: 'openai-compatible', currentModel: selection.id, _teamEngineSelection: selection,
    options: { ...owners().options, getTeamEngine: () => ({ portFor: (teamId) => (teamId === 'team_alpha1' ? port : null) }) },
    configService: { getState: () => ({ localEngines: { openaiCompatible: { apiUrl: 'http://127.0.0.1:9000/v1' } } }) } });
  const ready = build(teamPort());
  assert.equal(resolveOpenAICompatibleApiUrl(ready), TEAM_URL, 'ahead of a serving NInfer');
  assert.equal(resolveManagedConfiguredModel(ready), 'alpha', 'the real id goes on the wire');
  for (const port of [teamPort({ state: 'starting' }), teamPort({ state: 'stopped' }), null]) {
    assert.equal(resolveOpenAICompatibleApiUrl(build(port)), '', 'no fall-through to NInfer or the configured endpoint');
  }
  ready.currentEngineType = 'ollama';
  assert.equal(resolveOpenAICompatibleApiUrl(ready), 'http://127.0.0.1:8034', 'a selection counts only while its engine runs');
  assert.notEqual(resolveManagedConfiguredModel(ready), 'alpha');
});

// Row 200 S2 step 5: managed Strata is the fourth owner kind. Its origin is
// brokered only while ready, its key goes only to its own origin, it never
// borrows llama-server's profile context or prefill progress, and a failure is
// stamped on the most recently changed of the three managers.
const STRATA_URL = 'http://127.0.0.1:8035';

function strataManager({ state = 'ready', changedAt = 0, lastError = '' } = {}) {
  return {
    getStatus: () => ({ state, alias: 'inkling-2-mini-sq-20', changedAt, lastError }),
    getBaseUrl: () => (state === 'stopped' || state === 'crashed' ? '' : `${STRATA_URL}/v1`),
    getApiKey: () => 'strata-key',
  };
}

function strataBackend({ strata = strataManager(), apiUrl = '' } = {}) {
  const service = makeBackend({ apiUrl, llamaState: 'stopped' });
  service.options.getStrataManager = () => strata;
  service.options.managedLlamaServerProfile = { contextSize: 131_072 };
  return service;
}

test('a Strata origin resolves to its own manager and key, and is brokered only while ready', () => {
  const { strataManagedOrigin } = require('../services/backend/managed-server-owner');
  const { resolveOpenAICompatibleApiUrl } = require('../services/backend/managed-sidecar-config-model');
  const service = { options: { ...owners({ ninfer: 'stopped', llama: 'stopped' }).options, getStrataManager: () => strataManager() } };
  assert.equal(resolveManagedServerOwner(service, `${STRATA_URL}/v1`)?.kind, 'strata');
  assert.equal(managedServerApiKey(service, `${STRATA_URL}/v1`), 'strata-key');
  assert.equal(managedServerApiKey(service, 'http://127.0.0.1:9000/v1'), '', 'never to another origin');
  assert.equal(managedServerAlias(service, `${STRATA_URL}/v1`), 'inkling-2-mini-sq-20');
  assert.equal(strataManagedOrigin(service), STRATA_URL);
  const starting = { options: { getStrataManager: () => strataManager({ state: 'starting' }) } };
  assert.equal(strataManagedOrigin(starting), '', 'a loading server is not brokered (G9)');
  assert.equal(resolveOpenAICompatibleApiUrl(strataBackend()), STRATA_URL);
  assert.equal(resolveOpenAICompatibleApiUrl(strataBackend({ strata: strataManager({ state: 'starting' }), apiUrl: 'http://127.0.0.1:9000/v1' })), 'http://127.0.0.1:9000/v1');
});

test('pointed at Strata, the sidecar gets its key and alias, no llama-server profile context and no prefill progress', () => {
  const service = strataBackend();
  service.featureFlags = { ...(service.featureFlags || {}), prefill_progress: true };
  assert.deepEqual(buildManagedSidecarSecrets(service), { openai_compatible_api_key: 'strata-key' });
  const config = buildManagedSidecarConfig(service);
  assert.equal(config.api_url, STRATA_URL);
  assert.equal(config.model, 'inkling-2-mini-sq-20');
  assert.equal(config.context_length, null, 'the server reports its own window');
  assert.equal(config.managed_prefill_progress, false);
  assert.equal(config.json_schema_response_format, false);
  // A user's own server (no managed owner) keeps today's profile fallback.
  const user = strataBackend({ strata: strataManager({ state: 'stopped' }), apiUrl: 'http://127.0.0.1:9000/v1' });
  assert.equal(buildManagedSidecarConfig(user).context_length, 131_072);
});

test('a load failure is stamped on the live manager, else the most recently changed one', () => {
  const { managedServerKindForFailure } = require('../services/backend/ninfer-load-path');
  const status = (state, changedAt, lastError = '') => ({ getStatus: () => ({ state, changedAt, lastError }) });
  const kind = ({ strata = null, ninfer = null, llama = null }, engine = 'openai-compatible') => managedServerKindForFailure({
    options: { getStrataManager: () => strata, getNinferManager: () => ninfer, getLlamaServerManager: () => llama },
  }, engine);
  assert.equal(kind({ strata: status('starting', 10), llama: status('stopped', 50, 'x') }), 'strata');
  assert.equal(kind({ strata: status('crashed', 200, 'strata_exited:1'), llama: status('stopped', 100, 'x') }), 'strata');
  assert.equal(kind({ strata: status('stopped', 100, 'strata_pack:sha256_mismatch'), ninfer: status('crashed', 300) }), 'ninfer');
  assert.equal(kind({ strata: status('stopped', 300, 'x'), llama: status('ready', 100) }), 'llama-server', 'a live manager wins');
  assert.equal(kind({ strata: status('stopped', 0) }), '', 'a clean stop names nobody');
  assert.equal(kind({ strata: status('ready', 1) }, 'ollama'), '');
  // Unchanged two-manager answers.
  assert.equal(kind({ ninfer: status('stopped', 0, 'e'), llama: status('stopped', 0) }), 'ninfer');
  assert.equal(kind({ ninfer: status('stopped', 0, 'e'), llama: status('ready', 0) }), 'llama-server');
});
