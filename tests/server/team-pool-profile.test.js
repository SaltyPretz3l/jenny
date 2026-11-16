'use strict';

// Slice 4f (row 123): every pool turn is sized for the model that serves it. The gateway's
// /props reports the largest model's length (capped by the owner's value), the context floor
// is gone, `acquire` answers the leased model, the turn route puts it on chat.send as
// `model_profile`, and a member's turn on a team model carries the same profile from the
// host's models answer. Loopback fakes only: no real model, sidecar or network.

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const nodeTest = require('node:test');

const { composePool, model } = require('./helpers/team-pool-fixture');
const { MODELS_PATH, headersFor, send, setupEngine } = require('./helpers/team-engine-fixture');
const { createManagedChatServiceStub, buildManagedChatRequest } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');
const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const {
  beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization,
} = require('../../services/session-runtime/inference-protocol');
const { buildChatSendOptionalFields, modelProfileFields } = require('../../services/backend/chat-send-optional-fields');
const { teamCatalogKey, teamModelEntries } = require('../../services/backend/team-engine-models');
const { createTeamEnginePort } = require('../../services/team/engine-port');
const { createTeamEngine } = require('../../services/team/team-engine');

const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const AUTHOR = Object.freeze({ kind: 'member', member_id: 'member_alice' });
const NODE_MEMBER = 'member_node';

// ---------------------------------------------------------------------------
// Helpers.

function getProps(port, key) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/props', method: 'GET', agent: false,
      headers: { authorization: `Bearer ${key}` } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
    });
    req.on('error', reject);
    req.end();
  });
}

async function startPool(t, { cap = 131072, nodes = [] } = {}) {
  const { pool } = composePool(t, { contextLength: cap });
  const { modelEndpoint } = await pool.start();
  const port = Number(new URL(modelEndpoint.apiUrl).port);
  nodes.forEach((models, i) => {
    const result = pool.scheduler.registerNode({ deviceId: `device_${i}`, memberId: NODE_MEMBER, slots: 2, models });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
  return { pool, port, props: () => getProps(port, pool.modelCredential()) };
}

function tokenOf(seed) {
  return createHash('sha256').update(seed).digest().toString('base64url');
}

// The managed chat.send path with a stub sidecar client (as in turn-route-send.test.js).
function chatFixture(t, { turnRoute, preferredModel = 'alpha' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-pool-profile-'));
  const service = createManagedChatServiceStub({ featureFlags: { canonical_bridge: false, canonical_turn_events: false } });
  service.userDataPath = root;
  service.pendingUserQuestions = new Map();
  service.sessionStore = new ElectronSessionStore(path.join(root, 'sessions.json'), { writeDebounceMs: 0 });
  if (turnRoute !== undefined) service.turnRoute = turnRoute;
  t.after(() => { service.sessionStore.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const request = buildManagedChatRequest();
  service.sessionStore.createSessionWithId(request.sessionId, { title: 'Pool profile' });
  service.sessionStore.updateSession(request.sessionId, { preferred_model: preferredModel });
  service.sidecarManager = { process: { pid: 4242 }, getStatus: () => ({ phase: 'ready' }) };
  service.sidecarClient = { connected: true, process: service.sidecarManager.process };
  completeRuntimeInferenceInitialization(service.sidecarClient,
    beginRuntimeInferenceInitialization(service.sidecarClient), {
      runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1,
    });
  ensureSessionTurnActorRegistry(service);
  return { service, request, root };
}

async function runTurn(f) {
  const sent = [];
  f.service.sidecarClient.chatSend = async (params) => {
    sent.push(JSON.parse(JSON.stringify(params)));
    return { status: 'completed', response_text: 'Done.' };
  };
  const stream = await startManagedSidecarChatStream(f.service, { ...f.request, author: AUTHOR });
  const controller = f.service.activeStreams.get(stream.streamId);
  if (controller) await controller._pendingPromise.catch(() => {});
  return sent;
}

function filesUnder(root) {
  const out = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full)); else out.push(full);
  }
  return out;
}

function assertTokenNowhere(f, token) {
  assert.equal(JSON.stringify(f.service.serviceLogs).includes(token), false, 'service log');
  assert.equal(JSON.stringify(f.service.emittedEvents).includes(token), false, 'emitted event');
  for (const file of filesUnder(f.root)) assert.equal(fs.readFileSync(file, 'utf8').includes(token), false, file);
}

// ---------------------------------------------------------------------------
// 1. The gateway's /props.

test('/props reports the largest model length, capped by the owner value; an empty pool reports the cap', async (t) => {
  const empty = await startPool(t, { cap: 65536 });
  assert.equal((await empty.props()).default_generation_settings.n_ctx, 65536, 'empty pool: the cap alone');
  const mixed = await startPool(t, { cap: 1048576, nodes: [[model('alpha', { contextLength: 16384 })],
    [model('beta', { contextLength: 131072 })]] });
  assert.equal((await mixed.props()).default_generation_settings.n_ctx, 131072, 'the largest, not the smallest');
  const capped = await startPool(t, { cap: 32768, nodes: [[model('beta', { contextLength: 131072 })]] });
  assert.equal((await capped.props()).default_generation_settings.n_ctx, 32768, 'the cap stays a ceiling');
});

test('two nodes serving one model at different lengths give that model the smaller', async (t) => {
  const fx = await startPool(t, { cap: 1048576, nodes: [[model('alpha', { contextLength: 65536 })],
    [model('alpha', { contextLength: 16384 })]] });
  assert.deepEqual(fx.pool.scheduler.poolSummary().models.map((m) => [m.id, m.context_length]), [['alpha', 16384]]);
  assert.equal(fx.pool.scheduler.poolSummary().largest_context_length, 16384);
  assert.equal((await fx.props()).default_generation_settings.n_ctx, 16384);
});

// ---------------------------------------------------------------------------
// 2. Eligibility and the lease's model on the turn.

test('a model smaller than the largest is leased and its chat.send carries its own length and id', async (t) => {
  const { pool } = await startPool(t, { nodes: [[model('alpha', { contextLength: 16384 })],
    [model('beta', { contextLength: 131072 })]] });
  const f = chatFixture(t, { turnRoute: pool.turnRoute, preferredModel: 'alpha' });
  const sent = await runTurn(f);
  assert.equal(sent.length, 1);
  assert.match(sent[0].route_token, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(sent[0].model_profile, { context_length: 16384, name: 'alpha' });
  assert.equal(pool.scheduler.listLeases()[0].model, 'alpha');
  assertTokenNowhere(f, sent[0].route_token);
});

test('a node advertising no length is leased and its turn carries no context_length', async (t) => {
  const { pool } = await startPool(t, { nodes: [[model('alpha', { contextLength: null })],
    [model('beta', { contextLength: 131072 })]] });
  const handle = await pool.turnRoute.acquire({ sessionId: 'session_a', projectId: null, memberId: 'member_alice',
    model: 'alpha' });
  assert.deepEqual(handle.model, { id: 'alpha', context_length: null });
  handle.release({ ok: true });
  const f = chatFixture(t, { turnRoute: pool.turnRoute, preferredModel: 'alpha' });
  const sent = await runTurn(f);
  assert.deepEqual(sent[0].model_profile, { name: 'alpha' });
});

// ---------------------------------------------------------------------------
// 3. The turn route.

test('the profile rides with the token; an invalid model answer adds nothing and the turn still runs', async (t) => {
  const answers = [
    [{ id: 'gamma', context_length: 65536 }, { context_length: 65536, name: 'gamma' }],
    [null, undefined], ['gamma', undefined], [{ id: 7, context_length: '65536' }, undefined],
    [{ id: 'bad\u0007id', context_length: 0 }, undefined], [{ id: ' padded', context_length: 1048577 }, undefined],
    [{ id: 'g'.repeat(129), context_length: -4096 }, undefined], [{ id: 'gamma', context_length: 1.5 }, { name: 'gamma' }],
  ];
  for (const [answer, expected] of answers) {
    const token = tokenOf(`profile-${JSON.stringify(answer)}`);
    const releases = [];
    const f = chatFixture(t, { turnRoute: { acquire: async () => ({ token, model: answer,
      release: (outcome) => releases.push(outcome) }) } });
    const sent = await runTurn(f);
    assert.equal(sent.length, 1, JSON.stringify(answer));
    assert.equal(sent[0].route_token, token);
    assert.deepEqual(sent[0].model_profile, expected, JSON.stringify(answer));
    assert.deepEqual(releases, [{ ok: true }]);
    assertTokenNowhere(f, token);
  }
});

test('a refused route still keeps the token out of every log line and error', async (t) => {
  const token = tokenOf('refused');
  const f = chatFixture(t, { turnRoute: { acquire: async () => ({ token: `${token}!`, model: { id: 'alpha' },
    release() {} }) } });
  const sent = await runTurn(f);
  assert.equal(sent.length, 0, 'a malformed token never sends');
  assertTokenNowhere(f, token);
});

test('modelProfileFields keeps each valid member and nothing else', () => {
  assert.deepEqual(modelProfileFields({ id: 'm'.repeat(128), context_length: 2048 }),
    { model_profile: { context_length: 2048, name: 'm'.repeat(128) } });
  assert.deepEqual(modelProfileFields({ id: 'alpha', context_length: 2047, extra: 'x' }), { model_profile: { name: 'alpha' } });
  assert.deepEqual(modelProfileFields({}), {});
  assert.deepEqual(modelProfileFields(), {});
});

// ---------------------------------------------------------------------------
// 4. The member side.

test('the engine models route emits context_length only for a model that has one', async (t) => {
  const fx = await setupEngine(t, { nodes: [{ models: [model('alpha', { contextLength: 16384 }),
    model('beta', { contextLength: null })] }] });
  const answer = await send(fx.port, { method: 'GET', path: MODELS_PATH, headers: headersFor('member') });
  assert.equal(answer.status, 200);
  assert.deepEqual(JSON.parse(answer.text).data, [
    { id: 'alpha', object: 'model', created: 0, owned_by: 'team', context_length: 16384 },
    { id: 'beta', object: 'model', created: 0, owned_by: 'team' },
  ]);
});

function upstream(body) {
  const stream = new PassThrough();
  setImmediate(() => stream.end(body));
  return { status: 200, body: stream, close: () => stream.destroy() };
}

async function readTeam(body) {
  const manager = { snapshot: () => ({ state: 'online', member_state: 'active', team_name: 'Alpha crew' }),
    engine: () => Promise.resolve(upstream(body)) };
  const engine = createTeamEngine({ createPort: () => ({ start: async () => {}, stop: async () => {},
    getStatus: () => ({ state: 'ready' }) }) });
  engine.connectionChanged('team_alpha1', manager);
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
  const state = engine.teamState('team_alpha1');
  await engine.stopAll();
  return state;
}

test('a hostile models answer keeps the ids the rule keeps and drops the bad lengths', async () => {
  const rows = [
    { id: 'ok', context_length: 65536 }, { id: 'str', context_length: '65536' }, { id: 'neg', context_length: -1 },
    { id: 'big', context_length: 1048577 }, { id: 'small', context_length: 2047 }, { id: 'flt', context_length: 4096.5 },
    { id: 'bad\u0001id', context_length: 4096 }, { id: 'ok', context_length: 2048 },
    ...Array.from({ length: 59 }, (_, i) => ({ id: `m${i}`, context_length: 8192 })), // 65 valid ids in all
  ];
  const state = await readTeam(JSON.stringify({ object: 'list', data: rows }));
  assert.equal(state.models.length, 64, 'at most 64 models, as today');
  assert.deepEqual(state.models.slice(0, 7), ['ok', 'str', 'neg', 'big', 'small', 'flt', 'm0']);
  assert.equal(state.contextLengths.ok, 65536, 'the first row of a duplicate id wins');
  for (const id of ['str', 'neg', 'big', 'small', 'flt']) assert.equal(Object.hasOwn(state.contextLengths, id), false, id);
  assert.equal(state.contextLengths.m57, 8192);
  assert.equal(state.models.includes('m58'), false, 'the 65th model is not kept');
  assert.equal(Object.hasOwn(state.contextLengths, 'm58'), false);
});

function memberService({ selection = null, lengths = { alpha: 65536 } } = {}) {
  const teamEngine = {
    teamState: () => ({ online: true, active: true, portReady: true, models: ['alpha', 'beta'], contextLengths: lengths }),
    listTeams: () => [{ teamId: 'team_alpha1', name: 'Alpha crew', models: ['alpha', 'beta'], contextLengths: lengths }],
  };
  return { currentEngineType: 'openai-compatible', _teamEngineSelection: selection, options: { getTeamEngine: () => teamEngine },
    offlineIntelligenceService: { getMode: () => 'auto' } };
}

test('the member chat.send carries the team model profile, and none on a local model', () => {
  const selection = { id: 'team/team_alpha1/alpha', teamId: 'team_alpha1', modelId: 'alpha' };
  const fields = (service) => buildChatSendOptionalFields(service, { sessionId: 's', sessionSummary: {}, sessionMessages: [] });
  assert.deepEqual(fields(memberService({ selection })).model_profile, { context_length: 65536, name: 'alpha' });
  assert.deepEqual(fields(memberService({ selection, lengths: {} })).model_profile, { name: 'alpha' });
  assert.equal(Object.hasOwn(fields(memberService()), 'model_profile'), false, 'a local model: no profile');
  const local = memberService({ selection });
  local.currentEngineType = 'ollama';
  assert.equal(Object.hasOwn(fields(local), 'model_profile'), false, 'a selection whose engine is not running');
  const rows = teamModelEntries(memberService());
  assert.deepEqual(rows.map((row) => [row.id, row.context_length]),
    [['team/team_alpha1/alpha', 65536], ['team/team_alpha1/beta', undefined]]);
  assert.equal(Object.hasOwn(rows[1], 'context_length'), false);
});

test('a model whose context length changes makes a new catalog key, so the member list refreshes', () => {
  const row = { id: 'team/team_alpha1/alpha', team_name: 'Alpha crew', context_length: 32768 };
  assert.notEqual(teamCatalogKey([row]), teamCatalogKey([{ ...row, context_length: 65536 }]));
});

// A member's send on a live team model: the profile buildChatSendOptionalFields adds survives a route
// that answers no model (the engine port's), is replaced by a valid model, and is removed by a bad one.
function memberChat(t, turnRoute) {
  const f = chatFixture(t, { turnRoute });
  const member = memberService({ selection: { id: 'team/team_alpha1/alpha', teamId: 'team_alpha1', modelId: 'alpha' } });
  Object.assign(f.service, { currentEngineType: member.currentEngineType, _teamEngineSelection: member._teamEngineSelection,
    offlineIntelligenceService: member.offlineIntelligenceService });
  f.service.options = { ...(f.service.options || {}), getTeamEngine: member.options.getTeamEngine };
  return f;
}

test('the member engine port route answers no model and the team profile still reaches chat.send', async (t) => {
  const port = createTeamEnginePort({ forward: async () => { throw new Error('unused'); } });
  await port.start();
  t.after(() => port.stop());
  const f = memberChat(t, port.turnRoute);
  const sent = await runTurn(f);
  assert.equal(sent.length, 1);
  assert.match(sent[0].route_token, /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(sent[0].model_profile, { context_length: 65536, name: 'alpha' });
});

test('a route model replaces a profile already present; a malformed one leaves none', async (t) => {
  for (const [model, expected] of [
    [{ id: 'gamma', context_length: 16384 }, { context_length: 16384, name: 'gamma' }],
    [null, undefined], ['gamma', undefined], [{ id: 7, context_length: 'x' }, undefined],
  ]) {
    const token = tokenOf(`member-${JSON.stringify(model)}`);
    const f = memberChat(t, { acquire: async () => ({ token, model, release() {} }) });
    const sent = await runTurn(f);
    assert.equal(sent.length, 1, JSON.stringify(model));
    assert.deepEqual(sent[0].model_profile, expected, JSON.stringify(model));
  }
});

test('a lease that queued and then activated answers its model and length like an immediate one', async (t) => {
  const { pool } = await startPool(t);
  const result = pool.scheduler.registerNode({ deviceId: 'device_q', memberId: NODE_MEMBER, slots: 1,
    models: [model('alpha', { contextLength: 16384 })] });
  assert.equal(result.ok, true);
  const turn = (sessionId) => ({ sessionId, projectId: null, memberId: 'member_alice', model: 'alpha' });
  const first = await pool.turnRoute.acquire(turn('session_a'));
  const waiting = pool.turnRoute.acquire(turn('session_b'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pool.scheduler.listLeases().filter((lease) => lease.state === 'queued').length, 1, 'the second lease queued');
  first.release({ ok: true });
  const second = await waiting;
  assert.deepEqual(second.model, { id: 'alpha', context_length: 16384 });
  second.release({ ok: true });
});
