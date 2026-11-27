'use strict';

// Slice 4b member wiring (row 123): a member's Jenny lists a team's models and runs
// a turn on the team through the engine port. Real engine ports (engine-port.js) and
// real fake hosts (the team engine routes over the real pool composition and
// authorizer, tests/server/helpers/team-engine-fixture.js) on loopback; the backend is
// a plain object driven through the real loadModel, model list, config resolvers,
// managed-server owner lookup and team registration. No sidecar, no model, no window.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');

const {
  CHAT_PATH, DEVICES, DONE, MODELS_PATH, createNode, delta, model, setupEngine, waitFor,
} = require('./server/helpers/team-engine-fixture');
const { tempProfile } = require('./helpers/team-client-host');
const { registerTeam } = require('../services/main/team-registration');
const { loadModel } = require('../services/backend/backend-model-load');
const { listModels } = require('../services/backend/backend-model-list');
const { applyManagedInitializePayload } = require('../services/backend/managed-sidecar-lifecycle');
const {
  resolveManagedConfiguredModel, resolveOpenAICompatibleApiUrl,
} = require('../services/backend/managed-sidecar-config-model');
const { managedServerApiKey, resolveManagedServerOwner } = require('../services/backend/managed-server-owner');
const { runBackgroundTask } = require('../services/backend/backend-background-tasks');
const { pickInstalledDefaultModel, resolveModel } = require('../services/backend/backend-chat-model-resolution');
const { buildManagedSidecarConfig } = require('../services/backend/managed-sidecar-config');
const { generateCommitMessage } = require('../services/backend/backend-commit');
const { parseTeamModelId, teamModelId } = require('../services/backend/team-engine-models');
const { TeamError } = require('../services/team/team-errors');
const { groupCatalogEntries, groupSectionHtml } = require('../renderer/chat/renderer-composer-model-picker-utils');
const { ROUTE_TOKEN_HEADER } = require('../server/team/pool-gateway');

const it = (name, fn) => test(name, { timeout: 30_000 }, fn);
const TEAM_A = 'team_alpha1';
const TEAM_B = 'team_bravo2';
const LOCAL_URL = 'http://127.0.0.1:9/v1';
const D7 = 'The team’s host and the person whose hardware responds can read your prompts and replies.';

// The connection manager's `engine` call against one fake host: the member's device on loopback. It has the
// real call's shape (http-client.js streamRequest): a TeamError with a reason, the head timeout, the abort.
function hostEngine(host, calls) {
  return (route, body, { engineKey, signal, headTimeoutMs = 15_000 } = {}) => new Promise((resolve, reject) => {
    calls.push({ route, engineKey: engineKey || null });
    let headed = false;
    const request = http.request({ host: '127.0.0.1', port: host.port, agent: false,
      method: route === 'chat' ? 'POST' : 'GET', path: route === 'chat' ? CHAT_PATH : MODELS_PATH,
      headers: { 'x-test-device': DEVICES.member, ...(engineKey ? { 'x-engine-key': engineKey } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
    });
    const refuse = (reason) => {
      if (headed) return;
      headed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      request.destroy();
      reject(new TeamError('CONNECTION_FAILED', reason, { reset: true }));
    };
    const onAbort = () => refuse('team_request_aborted');
    const timer = setTimeout(() => refuse('team_request_timeout'), headTimeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', () => refuse('team_connection_reset'));
    request.on('response', (response) => {
      if (headed) { response.destroy(); return; }
      headed = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ status: response.statusCode, headers: response.headers, body: response, close: () => response.destroy() });
    });
    request.end(body || undefined);
  });
}

function fakeManager(teamId, name, host) {
  const calls = [];
  const manager = { calls, snap: { team_id: teamId, team_name: name, state: 'online', member_state: 'active' } };
  manager.snapshot = () => ({ ...manager.snap });
  manager.engine = hostEngine(host, calls);
  return manager;
}

// A managed llama-server and NInfer that are running, with the boot targets that go with them.
function withServers(backend) {
  const calls = [];
  const server = (kind) => ({ getStatus: () => ({ state: 'ready' }),
    stop: async (options) => { calls.push([kind, 'stop', options]); return { state: 'stopped' }; },
    ensureRunning: async () => { calls.push([kind, 'ensureRunning']); return { state: 'ready' }; } });
  const managed = { enabled: true, lastUsedTag: 'qwen-local', profileId: 'p', perModel: {} };
  Object.assign(backend.options, { getLlamaServerManager: () => server('llama'), getNinferManager: () => server('ninfer') });
  backend.configService.getLocalEngines = () => ({ openaiCompatible: { apiUrl: LOCAL_URL, managed },
    ninfer: { lastUsedArtifactId: 'artifact-1' } });
  backend.configService.updateManagedLlamaServer = (patch) => calls.push(['config', 'llama', patch]);
  backend.configService.updateNinferSettings = (patch) => calls.push(['config', 'ninfer', patch]);
  backend.configService.updatePreferredEngineType = (engine) => calls.push(['config', 'engine', engine]);
  backend.exclusiveGpuCoordinator = { getState: () => ({ state: 'chat_resident' }) };
  backend.sidecarClient = { modelsUnload: async (tag) => { calls.push(['sidecar', 'unload', tag]); } };
  return calls;
}

function createBackend() {
  const backend = new EventEmitter();
  Object.assign(backend, {
    options: {}, featureFlags: { team: true }, currentEngineType: 'ollama', currentModel: 'alpha', defaultModel: 'alpha',
    activeStreams: new Map(), inits: [], sent: [], refreshes: [], logs: [],
    getBackendStatus: () => ({ phase: 'starting' }),
    configService: { getState: () => ({ localEngines: { openaiCompatible: { apiUrl: LOCAL_URL } } }),
      getLocalEngines: () => ({ openaiCompatible: { apiUrl: LOCAL_URL } }) },
    _emitServiceLog: (level, event, fields) => backend.logs.push([level, event, fields]),
    refreshStatusSnapshot: async () => null,
    refreshManagedConfig: async (reason) => { backend.refreshes.push(reason); },
    listModelsForEngine: async (engineType) => (engineType === 'ollama'
      ? { object: 'list', available: true, data: [{ id: 'alpha' }] }
      : { object: 'list', available: true, data: [{ id: 'alpha' }, { id: 'served-by-endpoint' }] }),
  });
  backend.loadModel = (request, options) => loadModel(backend, request, options);
  // The sidecar's initialize: it gets the resolved endpoint, model and key, and answers with that model.
  backend._initializeManagedSidecar = async ({ requestedModel, requestedEngineType }) => {
    backend.inits.push({ requestedModel, requestedEngineType });
    if (backend.failNextInit) { backend.failNextInit = false; throw new Error('sidecar_initialize_failed'); }
    backend.currentEngineType = requestedEngineType;
    backend._managedPendingModel = requestedModel;
    const apiUrl = resolveOpenAICompatibleApiUrl(backend);
    const sent = { apiUrl, model: resolveManagedConfiguredModel(backend), key: managedServerApiKey(backend, apiUrl) };
    backend.sent.push(sent);
    applyManagedInitializePayload(backend, { active_engine: requestedEngineType, active_model: sent.model });
    backend._managedPendingModel = '';
  };
  return backend;
}

// The registration with the real team engine and a stand-in service that only hands it over.
async function createWorld(t, { backend = createBackend() } = {}) {
  const logs = [];
  const handlers = new Map();
  const shutdown = [];
  let engine = null;
  registerTeam({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    featureFlags: { team: true }, backendService: backend, userDataPath: tempProfile(t, 'jenny-team-engine-'),
    log: (level, event) => logs.push([level, event]),
    getMainLifecycle: () => ({ registerShutdownTask: (task) => shutdown.push(task) }),
    loadService: () => ({ createTeamService: ({ teamEngine }) => {
      engine = teamEngine;
      return { handle: async () => ({ ok: true }), startExisting: async () => {}, stopAll: () => teamEngine.stopAll() };
    } }),
  });
  await handlers.get('team:status')({ sender: {} }, {});
  t.after(() => shutdown[0]?.());
  const teams = {};
  async function addTeam(teamId, name, models) {
    const host = await setupEngine(t, { nodes: [{ models: models.map((id) => model(id)) }] });
    const manager = fakeManager(teamId, name, host);
    engine.connectionChanged(teamId, manager);
    await waitFor(() => engine.teamState(teamId)?.portReady && engine.teamState(teamId).models.length === models.length,
      `${teamId} ready with its models`);
    teams[teamId] = { host, manager, port: () => engine.portFor(teamId) };
    return teams[teamId];
  }
  return { backend, logs, engine: () => engine, teams, addTeam, dispose: () => shutdown[0]() };
}

// The sidecar's chat request to the endpoint it was given, with the route token when there is one.
function sidecarChat(sent, { token, body = { model: sent.model, stream: true, messages: [{ role: 'user', content: 'hi' }] } } = {}) {
  const url = new URL(`${sent.apiUrl}/chat/completions`);
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: 'POST', agent: false,
      headers: { host: url.host, authorization: `Bearer ${sent.key}`, 'content-type': 'application/json',
        'content-length': payload.length, ...(token ? { [ROUTE_TOKEN_HEADER]: token } : {}) },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

it('a team id parses only with a team id and a model id; the model id is everything after the second slash', () => {
  assert.deepEqual(parseTeamModelId('team/team_alpha1/org/model:7b'),
    { id: 'team/team_alpha1/org/model:7b', teamId: 'team_alpha1', modelId: 'org/model:7b' });
  for (const bad of ['team/', 'team/team_alpha1', 'team/team_alpha1/', 'team/alpha/x', 'team/team_a b/x',
    'team/team_alpha1/ x', 'team/team_alpha1/x\u0000', `team/team_alpha1/${'m'.repeat(201)}`, 'api/x/y', 7]) {
    assert.equal(parseTeamModelId(bad), null, String(bad));
  }
  assert.equal(teamModelId(TEAM_A, 'alpha'), 'team/team_alpha1/alpha');
});

it('two teams online: each lists its models under its name with the notice, beside a same-named local model', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha', 'beta']);
  await world.addTeam(TEAM_B, 'Bravo crew', ['alpha']);
  const list = await listModels(world.backend);
  const ids = list.data.map((row) => row.id);
  assert.deepEqual(ids.filter((id) => id.endsWith('alpha')).sort(), ['alpha', 'team/team_alpha1/alpha', 'team/team_bravo2/alpha']);
  assert.ok(ids.includes('team/team_alpha1/beta'));
  assert.equal(world.backend._modelEngineHints.get('alpha'), 'ollama');
  assert.equal(world.backend._modelEngineHints.get('team/team_bravo2/alpha'), 'openai-compatible');
  const row = list.data.find((entry) => entry.id === 'team/team_bravo2/alpha');
  assert.deepEqual({ ...row }, { id: 'team/team_bravo2/alpha', engine_type: 'openai-compatible', available: true,
    team_id: TEAM_B, team_name: 'Bravo crew', context_length: 32768 });
  const groups = groupCatalogEntries(list.data, {});
  const alpha = groups.find((group) => group.key === `team:${TEAM_A}`);
  assert.equal(alpha.label, 'Alpha crew');
  assert.deepEqual(alpha.entries.map((entry) => [entry.family, entry.hint]), [['alpha', ''], ['beta', '']], 'the notice is drawn once per team, not per row');
  const section = groupSectionHtml(alpha, '', { escapeHtml: (value) => String(value), id: 'g1', showHeading: true });
  assert.equal(section.split(D7).length - 1, 1, 'the team group carries the notice once');
  assert.equal(groups.find((group) => group.key === 'ollama').entries[0].hint, '');
  assert.notEqual(world.teams[TEAM_A].port().getApiKey(), world.teams[TEAM_B].port().getApiKey());
  assert.notEqual(world.teams[TEAM_A].port().getBaseUrl(), world.teams[TEAM_B].port().getBaseUrl());
});

it('a team row needs the team online, the member active and models; force local lists none', async (t) => {
  const world = await createWorld(t);
  const { manager } = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  const teamRows = async () => {
    world.backend._modelListLastResult = null;
    return (await listModels(world.backend)).data.filter((row) => row.team_id);
  };
  assert.equal((await teamRows()).length, 1);
  world.backend.offlineIntelligenceService = { getMode: () => 'local_only' };
  assert.deepEqual(await teamRows(), []);
  delete world.backend.offlineIntelligenceService;
  manager.snap = { ...manager.snap, member_state: 'pending' };
  world.engine().connectionChanged(TEAM_A, manager);
  assert.deepEqual(await teamRows(), []);
  manager.snap = { ...manager.snap, member_state: 'active', state: 'reconnecting' };
  world.engine().connectionChanged(TEAM_A, manager);
  assert.deepEqual(await teamRows(), []);
  assert.equal(world.teams[TEAM_A].port().getStatus().state, 'ready', 'the port outlives a reconnect');
});

it('picking a team A model routes the turn to A with its turn header; B sees no byte and no key', async (t) => {
  const world = await createWorld(t);
  const a = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  const b = await world.addTeam(TEAM_B, 'Bravo crew', ['alpha']);
  await listModels(world.backend);
  const bRequestsBefore = b.host.responses.length;
  const bCallsBefore = b.manager.calls.length;
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  const sent = world.backend.sent.at(-1);
  assert.deepEqual(world.backend.inits.at(-1), { requestedModel: 'team/team_alpha1/alpha', requestedEngineType: 'openai-compatible' });
  assert.equal(sent.apiUrl, a.port().getBaseUrl());
  assert.equal(sent.model, 'alpha', 'the real id goes on the wire');
  assert.equal(sent.key, a.port().getApiKey());
  assert.equal(world.backend.currentModel, 'team/team_alpha1/alpha', 'the listed id stays, so the next turn does not reload');
  assert.equal(resolveManagedServerOwner(world.backend, sent.apiUrl).kind, 'team-engine');

  const route = world.backend.turnRoute;
  assert.equal(route, a.port().turnRoute);
  const handle = await route.acquire({ sessionId: 'session_one' });
  assert.equal(a.port().resources().turns, 1);
  const node = createNode(a.host.scheduler, a.host.nodeIds[0]);
  const answer = sidecarChat(sent, { token: handle.token });
  const job = await node.claimNext();
  assert.equal(job.request.model, 'alpha');
  job.send(delta('hello'));
  job.send(DONE, true);
  const reply = await answer;
  assert.equal(reply.status, 200);
  assert.match(reply.text, /hello/u);
  const engineKey = a.manager.calls.at(-1).engineKey;
  assert.match(engineKey, /^[A-Za-z0-9_-]{43}$/u, 'the conversation key rides the request');
  assert.notEqual(engineKey, a.port().getApiKey());
  handle.release();
  assert.equal(a.port().resources().turns, 0);

  assert.equal(b.host.responses.length, bRequestsBefore, 'team B got no request');
  assert.equal(b.manager.calls.length, bCallsBefore, 'team B forwarded nothing');
  assert.equal(b.host.scheduler.listJobs().length, 0);
  const crossed = await sidecarChat({ ...sent, apiUrl: b.port().getBaseUrl() });
  assert.equal(crossed.status, 401, "A's key opens nothing on B's port");
});

it('a local turn never touches a turn route, with a team online and after a team model was selected', async (t) => {
  const world = await createWorld(t);
  const a = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await listModels(world.backend);
  assert.equal(world.backend.turnRoute, null, 'a team online with an Ollama model loaded');
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  assert.ok(world.backend.turnRoute);
  for (const [request, engine] of [[{ model: 'alpha', engine_type: 'ollama' }, 'ollama'],
    [{ model: 'my-local', engine_type: 'openai-compatible' }, 'openai-compatible']]) {
    await loadModel(world.backend, request);
    assert.equal(world.backend.currentEngineType, engine);
    assert.equal(world.backend._teamEngineSelection, null);
    assert.equal(world.backend.turnRoute, null, engine);
    const sent = world.backend.sent.at(-1);
    assert.equal(sent.model === 'alpha' && engine === 'openai-compatible', false);
    if (engine === 'openai-compatible') {
      assert.equal(sent.apiUrl, LOCAL_URL, 'the configured endpoint, not the port');
      assert.equal(sent.key, '', 'the port key never reaches a user endpoint');
    }
  }
  assert.equal(a.port().resources().turns, 0);
});

it('every refusal comes before any switch: no server stopped, unloaded or retargeted, the selection kept', async (t) => {
  const world = await createWorld(t);
  const calls = withServers(world.backend);
  const { manager } = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await world.addTeam(TEAM_B, 'Bravo crew', ['alpha']);
  await loadModel(world.backend, 'team/team_bravo2/alpha');
  calls.length = 0;
  world.backend.activeStreams.set('stream_other_chat', { sessionId: 'session_two', controller: new AbortController() });
  const before = () => [world.backend.currentModel, world.backend.currentEngineType, world.backend._teamEngineSelection,
    world.backend.inits.length, calls.length];
  const expectRefused = async (id, reason) => {
    const was = before();
    await assert.rejects(loadModel(world.backend, id), (error) => {
      assert.equal(error.reason, reason);
      assert.equal(error.error_code, 'CMP-TEAM-0010');
      assert.equal(error.retryable, false);
      return true;
    });
    assert.deepEqual(before(), was, reason);
  };
  await expectRefused('team/team_zulu9/alpha', 'team_not_found');
  await expectRefused('team/team_alpha1/gamma', 'team_model_unavailable');
  await expectRefused('team/not-a-team/alpha', 'team_not_found');
  manager.snap = { ...manager.snap, member_state: 'pending' };
  world.engine().connectionChanged(TEAM_A, manager);
  await expectRefused('team/team_alpha1/alpha', 'team_member_not_active');
  manager.snap = { ...manager.snap, member_state: 'active', state: 'offline' };
  world.engine().connectionChanged(TEAM_A, manager);
  await expectRefused('team/team_alpha1/alpha', 'team_not_connected');
  world.backend.offlineIntelligenceService = { getMode: () => 'local_only' };
  await expectRefused('team/team_bravo2/alpha', 'team_force_local');
  world.backend.offlineIntelligenceService = { getMode: () => { throw new Error('unreadable'); } };
  await expectRefused('team/team_bravo2/alpha', 'team_force_local');
  delete world.backend.offlineIntelligenceService;
  assert.deepEqual(calls, [], 'nothing was stopped, unloaded or written');
  const notReady = createBackend();
  notReady.options.getTeamEngine = () => ({ teamState: () => ({ online: true, active: true, portReady: false, models: ['alpha'] }) });
  await assert.rejects(loadModel(notReady, 'team/team_alpha1/alpha'), { reason: 'team_engine_not_ready' });
  assert.equal(notReady.inits.length, 0);
  const off = createBackend();
  await assert.rejects(loadModel(off, 'team/team_alpha1/alpha'), { reason: 'team_feature_off' });
  assert.deepEqual([off.inits.length, off.currentModel, off.currentEngineType], [0, 'alpha', 'ollama']);
});

// E71 (owner, 2026-11-14; review X2b-F01): the `team/` prefix is reserved only while the Team flag is on.
it('with the team flag off a `team/` id is an ordinary model: it loads, resolves, stays a default; with it on the prefix is reserved', async () => {
  const flagOff = createBackend();
  flagOff.featureFlags = { team: false, model_catalog_guard: false };
  for (const id of ['team/llama3:8b', 'team/qwen3-coder', 'team/x', 'team/team_alpha1/alpha']) {
    await loadModel(flagOff, id);
    assert.deepEqual(flagOff.inits.at(-1)?.requestedModel, id, `${id} reached the sidecar initialize`);
    assert.equal(flagOff._teamEngineSelection ?? null, null, 'no team selection was made');
    assert.equal(await resolveModel(flagOff, id), id, `${id} is used by a send`);
  }
  flagOff.currentModel = 'team/llama3:8b';
  assert.equal(await resolveModel(flagOff, ''), 'team/llama3:8b', 'a current `team/` model is kept on a send with no model');
  flagOff.offlineIntelligenceService = { getPreferredLocalModel: () => 'team/llama3:8b' };
  flagOff._modelEngineHints = new Map([['team/llama3:8b', 'ollama']]);
  assert.deepEqual(await pickInstalledDefaultModel(flagOff), { model: 'team/llama3:8b', missing: '', unconfirmed: false },
    'a Settings default that starts with `team/` is a default candidate');

  const flagUnset = createBackend();
  flagUnset.featureFlags = {};
  await loadModel(flagUnset, 'team/llama3:8b');
  assert.equal(flagUnset.inits.at(-1)?.requestedModel, 'team/llama3:8b', 'an absent flag counts as off');

  const flagOn = createBackend();
  await assert.rejects(loadModel(flagOn, 'team/llama3:8b'), { reason: 'team_feature_off' });
  assert.equal(flagOn.inits.length, 0, 'with the flag on the prefix stays reserved');
});

// Fix list item 1: a selection whose port stopped answers the typed refusal at the send and at the config.
it('a selection whose port stopped fails closed at the next send and at the sidecar config, never the default endpoint', async (t) => {
  const world = await createWorld(t);
  const a = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await listModels(world.backend);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  const inits = world.backend.inits.length;
  await a.port().stop(); // the port went away and nothing told the backend yet
  await assert.rejects(resolveModel(world.backend, 'team/team_alpha1/alpha'),
    { reason: 'team_engine_not_ready', error_code: 'CMP-TEAM-0010' });
  world.backend.options.userDataPath = tempProfile(t, 'jenny-team-config-');
  assert.throws(() => buildManagedSidecarConfig(world.backend), { reason: 'team_engine_not_ready' });
  assert.equal(world.backend.inits.length, inits, 'no initialize ran');
});

// Item 2: the selection is restored when its load fails and cleared with its team, its connection and the registration.
it('a failed load restores the selection; the team dropped, revoked or the registration disposed clears it', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(world.backend, { model: 'my-local', engine_type: 'openai-compatible' });
  world.backend.failNextInit = true;
  await assert.rejects(loadModel(world.backend, 'team/team_alpha1/alpha'), /sidecar_initialize_failed/u);
  assert.equal(world.backend._teamEngineSelection, null, 'the failed load left no selection behind');
  assert.equal(resolveOpenAICompatibleApiUrl(world.backend), LOCAL_URL, 'the local endpoint is still the local one');

  await loadModel(world.backend, 'team/team_alpha1/alpha');
  await world.engine().drop(TEAM_A);
  assert.equal(world.backend._teamEngineSelection, null, 'dropped');
  assert.equal(world.backend.currentModel, '', 'the team id is no longer current');
  assert.deepEqual(world.backend.refreshes, [], 'a cleared selection is not pointed anywhere else');
  await assert.rejects(resolveModel(world.backend, 'team/team_alpha1/alpha'), { reason: 'team_not_found' });

  const b = await world.addTeam(TEAM_B, 'Bravo crew', ['alpha']);
  await loadModel(world.backend, 'team/team_bravo2/alpha');
  b.manager.snap = { ...b.manager.snap, state: 'revoked' };
  world.engine().connectionChanged(TEAM_B, b.manager);
  assert.equal(world.backend._teamEngineSelection, null, 'revoked');

  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  await world.dispose();
  assert.equal(world.backend._teamEngineSelection, null, 'disposed');
  assert.equal(world.backend.options.getTeamEngine, undefined);
});

// Item 4: a turn with no model of its own loads the default, never the team model another chat loaded.
it('a turn with no model loads the default instead of running on a loaded team model; the team id itself stays current', async (t) => {
  const world = await createWorld(t);
  const { manager } = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await listModels(world.backend);
  assert.equal(await resolveModel(world.backend, 'team/team_alpha1/alpha'), 'team/team_alpha1/alpha');
  assert.deepEqual(world.backend.inits.at(-1), { requestedModel: 'team/team_alpha1/alpha', requestedEngineType: 'openai-compatible' },
    'the hint map routed it');
  const inits = world.backend.inits.length;
  assert.equal(await resolveModel(world.backend, 'team/team_alpha1/alpha'), 'team/team_alpha1/alpha');
  assert.equal(world.backend.inits.length, inits, 'the live selection is current: no reload');
  manager.snap = { ...manager.snap, member_state: 'pending' };
  world.engine().connectionChanged(TEAM_A, manager);
  await assert.rejects(resolveModel(world.backend, 'team/team_alpha1/alpha'), { reason: 'team_member_not_active' },
    'checked again on every send');
  manager.snap = { ...manager.snap, member_state: 'active' };
  world.engine().connectionChanged(TEAM_A, manager);

  assert.equal(await resolveModel(world.backend, ''), 'alpha', 'no model of its own: the default');
  assert.deepEqual(world.backend.inits.at(-1), { requestedModel: 'alpha', requestedEngineType: 'ollama' });
  assert.equal(world.backend._teamEngineSelection, null);
  await resolveModel(world.backend, 'team/team_alpha1/alpha');
  world.backend.defaultModel = 'team/team_alpha1/alpha';
  await assert.rejects(resolveModel(world.backend, ''), { reason: 'team_engine_other_chat' });
  assert.equal(world.backend._teamEngineSelection.id, 'team/team_alpha1/alpha');
});

// Item 6: a team load, and a load that leaves a team model, wait for every other chat's stream.
it('a team load and a load away from a team model are refused while another chat streams', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  world.backend.activeStreams.set('stream_other_chat', { sessionId: 'session_two', controller: new AbortController() });
  await assert.rejects(loadModel(world.backend, 'team/team_alpha1/alpha'), { category: 'model_busy' });
  assert.deepEqual([world.backend.currentModel, world.backend._teamEngineSelection], ['alpha', null]);
  await assert.rejects(loadModel(world.backend, 'team/team_alpha1/alpha', { ownStreamId: 'stream_mine' }), { category: 'model_busy' });
  world.backend.activeStreams.clear();
  world.backend.activeStreams.set('stream_mine', {});
  await loadModel(world.backend, 'team/team_alpha1/alpha', { ownStreamId: 'stream_mine' });
  world.backend.activeStreams.set('stream_other_chat', {});
  await assert.rejects(loadModel(world.backend, { model: 'alpha', engine_type: 'ollama' }, { ownStreamId: 'stream_mine' }),
    { category: 'model_busy' });
  assert.equal(world.backend._teamEngineSelection.id, 'team/team_alpha1/alpha');
});

// Item 7: a team load takes the GPU over like any other load but never changes what starts at boot.
it('a team load stops the managed servers but leaves both boot targets alone', async (t) => {
  const world = await createWorld(t);
  const calls = withServers(world.backend);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  assert.deepEqual(calls.filter(([kind]) => kind === 'llama' || kind === 'ninfer').map(([kind, what]) => `${kind}.${what}`),
    ['llama.stop', 'ninfer.stop']);
  assert.deepEqual(calls.filter(([kind]) => kind === 'config'), [], 'no boot target or engine pin was written');
});

// Item 3: the callers of requestRuntimeInference that are not the team chat's own (the rest: backend-runtime-inference-reflect).
it('a commit message is not generated on the team while a team model is loaded', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  const sent = [];
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  world.backend.sidecarClient = { request: async (method) => { sent.push(method); return { message: 'feat: x' }; },
    chatCompact: async () => { sent.push('chat.compact'); } };
  const answer = await generateCommitMessage(world.backend, { diff: 'diff --git a/secret b/secret' });
  assert.equal(answer.ok, false);
  assert.deepEqual(sent, [], 'the staged diff never left');
  await loadModel(world.backend, { model: 'alpha', engine_type: 'ollama' });
  assert.deepEqual(await generateCommitMessage(world.backend, { diff: 'd' }), { ok: true, message: 'feat: x' });
});

it('background work is skipped while a team model is loaded', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  let ran = 0;
  world.backend.sidecarClient = { backgroundRun: async () => { ran += 1; return { status: 'ok' }; } };
  assert.equal((await runBackgroundTask(world.backend, 'automation_run')).status, 'ok');
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  assert.deepEqual(await runBackgroundTask(world.backend, 'automation_run'),
    { status: 'skipped', task: 'automation_run', reason: 'team_engine_loaded' });
  assert.equal(ran, 1);
});

// Items 13 and 23: the port is not asked for a list it would only add as team rows; a local endpoint keeps its rows.
it('the team port is not read for the model list; a local openai-compatible endpoint keeps its rows', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  const asked = [];
  const read = world.backend.listModelsForEngine;
  world.backend.listModelsForEngine = (engineType) => { asked.push(engineType); return read(engineType); };
  await loadModel(world.backend, { model: 'my-local', engine_type: 'openai-compatible' });
  world.backend._modelListLastResult = null;
  const local = (await listModels(world.backend)).data;
  assert.ok(local.some((row) => row.id === 'served-by-endpoint' && row.engine_type === 'openai-compatible'));
  assert.deepEqual(asked, ['openai-compatible', 'ollama']);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  world.backend._modelListLastResult = null;
  asked.length = 0;
  const team = (await listModels(world.backend)).data;
  assert.deepEqual(asked, ['ollama'], 'the team port was not asked');
  assert.equal(team.some((row) => row.id === 'served-by-endpoint'), false);
  assert.ok(team.some((row) => row.id === 'team/team_alpha1/alpha'));
});

it('a host composition turn route is kept, and the registration says so', async (t) => {
  const backend = createBackend();
  const hosted = { acquire: async () => ({ token: '', release() {} }) };
  Object.defineProperty(backend, 'turnRoute', { configurable: true, enumerable: false, value: hosted, writable: false });
  const world = await createWorld(t, { backend });
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(backend, 'team/team_alpha1/alpha');
  assert.equal(backend.turnRoute, hosted);
  assert.deepEqual(world.logs.filter(([, event]) => event === 'team.engine.turn_route_taken'), [['WARN', 'team.engine.turn_route_taken']]);
});

// Item 21: the port's own mapping of a failed forward, with the real call's TeamError reason.
it('a team host that is gone answers the sidecar 502 with the connection reason, and no key', async (t) => {
  const world = await createWorld(t);
  await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  const closed = await new Promise((resolve) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
  world.teams[TEAM_A].manager.engine = hostEngine({ port: closed }, world.teams[TEAM_A].manager.calls);
  const sent = world.backend.sent.at(-1);
  const handle = await world.backend.turnRoute.acquire({ sessionId: 'session_one' });
  const reply = await sidecarChat(sent, { token: handle.token });
  handle.release();
  assert.equal(SIDECAR_RETRIED.includes(reply.status), false, `status ${reply.status} is one the sidecar retries`);
  assert.equal(JSON.parse(reply.text).error.code, 'team_connection_reset');
  assert.equal(reply.text.includes(sent.key), false);
});

// R16-F04: the statuses the sidecar's provider retry retries, read from the sidecar itself, so this test
// follows the sidecar's table rather than a copy of it.
const SIDECAR_RETRIED = (() => {
  const python = process.env.JENNY_TEST_PYTHON || path.resolve('.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const read = spawnSync(python, ['-c', 'import json; from sidecar.ai.engines.provider_http import is_retryable_http_status as r; '
    + 'print(json.dumps([s for s in range(100, 600) if r(s)]))'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' });
  assert.equal(read.status, 0, `the sidecar's retry table could not be read: ${read.stderr}`);
  return JSON.parse(read.stdout);
})();

it('R16-F04: a non-streamed turn whose node fails before any byte: one lease, one job, a status never retried', async (t) => {
  assert.ok(SIDECAR_RETRIED.includes(502) && SIDECAR_RETRIED.includes(429), 'the table was read');
  const world = await createWorld(t);
  const a = await world.addTeam(TEAM_A, 'Alpha crew', ['alpha']);
  await loadModel(world.backend, 'team/team_alpha1/alpha');
  const sent = world.backend.sent.at(-1);
  const node = createNode(a.host.scheduler, a.host.nodeIds[0]);
  const answer = sidecarChat(sent, { body: { model: sent.model, stream: false, messages: [{ role: 'user', content: 'hi' }] } });
  const job = await node.claimNext();
  assert.equal(job.fail('engine_error').ok, true);
  const reply = await answer;
  assert.equal(SIDECAR_RETRIED.includes(reply.status), false, `status ${reply.status} is one the sidecar retries`);
  assert.equal(JSON.parse(reply.text).error.code, 'engine_error', 'the reason still reaches the sidecar');
  assert.deepEqual([a.host.scheduler.listLeases().length, a.host.scheduler.listJobs().length], [1, 1]);
});
