'use strict';

// new-test-file: a new surface (services/team/node/share-set.js and ollama-context.js, and the idle offer refresh of
// team-sharing.js); tests/team-node-sharing.test.js is the lane of the sharing states and sits near its size ceiling.
//
// Row 201, OD-3 and OD-4: an idle shared GPU reads its offer again and registers again only when it changed; Ollama
// shares a share set, never every installed model; a cloud chat does not make the owner busy. The real node agent and team
// link run over the sharing fixtures; the engine is a scripted loopback server whose model list the test changes.

const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough, Readable } = require('node:stream');
const nodeTest = require('node:test');

const { createTeamSharing } = require('../services/team/node/team-sharing');
const { createNodeAgent } = require('../services/team/node/node-agent');
const { createOllamaShareSet, createShareClient, modelSignature } = require('../services/team/node/share-set');
const { contextOfInfo, createOllamaContextReader } = require('../services/team/node/ollama-context');
const { createFakeHost, createLogs, createManualTimers } = require('./helpers/team-node-agent-fixture');
const { createBridge, createManager, createSavedStore } = require('./helpers/team-node-sharing-fixture');

const test = (name, fn) => nodeTest(name, { timeout: 60_000 }, fn);
const TEAM = 'team_AAAAAAAAAAAAAAAAAAAAAA';
const WALL = 1_800_000_000_000;
const WINDOW = 46_000; // a little over the refresh interval

// A loopback engine with a model list the test changes: `/v1/models`, Ollama's `/api/ps`, and a chat that answers at once.
async function startListEngine(t, models, loaded = []) {
  const engine = { models, loaded, lists: 0 };
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.method === 'GET' && req.url === '/v1/models') {
      engine.lists += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: engine.models.map((row) => (typeof row === 'string' ? { id: row } : row)) }));
    } else if (req.method === 'GET' && req.url === '/api/ps') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ models: engine.loaded.map((name) => ({ name, model: name })) }));
    } else { res.writeHead(404); res.end(); }
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  engine.url = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return engine;
}

async function setup(t, { engine, kind = 'llama-server', backend = {}, isBusy = () => false, capabilities = null } = {}) {
  const timers = createManualTimers();
  const host = createFakeHost({ timers });
  const manager = createManager(createBridge(host));
  const clock = { wall: WALL };
  const store = createSavedStore();
  const logs = createLogs();
  const sharing = createTeamSharing({
    userDataPath: 'unused-profile', getBackend: () => backend, isBusy, log: logs.logger, now: () => clock.wall, timers,
    createAgent: (o) => createNodeAgent({ ...o, timers, now: () => clock.wall, clock: timers.now }),
    resolveEngine: () => ({ url: engine.url, kind, key: '' }), load: store.load, save: store.save,
    readCapabilities: async () => (typeof capabilities === 'function' ? capabilities() : capabilities),
  });
  t.after(() => sharing.stopAll());
  const drive = async (predicate, label, step = 250, steps = 2000) => {
    for (let i = 0; i < steps; i += 1) {
      if (predicate()) return;
      await timers.advance(step);
    }
    throw new Error(`not reached: ${label}`);
  };
  const s = { timers, host, manager, clock, sharing, store, logs, drive, state: () => sharing.snapshot()?.state ?? 'off' };
  s.registers = () => host.of('team.node.register');
  s.offered = () => s.registers().at(-1).params.models.map((row) => row.name);
  s.window = async () => { clock.wall += WINDOW; await timers.advance(2000); };
  sharing.connectionChanged(TEAM, manager);
  assert.equal((await sharing.set(TEAM, true, { confirmed: true })).ok, true);
  await drive(() => s.state() === 'idle', 'idle');
  return s;
}

test('OD-4: an idle offer is read again every interval and registers again only when a model, a length or a capability changed', async (t) => {
  const engine = await startListEngine(t, ['alpha']);
  const caps = { value: null };
  const s = await setup(t, { engine, capabilities: () => caps.value });
  await s.drive(() => engine.lists >= 2, 'the baseline read');
  assert.equal(s.registers().length, 1);
  for (let i = 0; i < 3; i += 1) await s.window();
  assert.equal(s.registers().length, 1, 'an unchanged offer registers once');
  assert.ok(engine.lists >= 4, 'but it is read again each interval');

  engine.models = ['alpha', 'beta'];
  await s.window();
  await s.drive(() => s.registers().length === 2 && s.state() === 'idle', 'a new model registers again');
  assert.deepEqual(s.offered(), ['alpha', 'beta']);
  assert.equal(s.host.of('team.node.unregister').length, 1, 'the old registration let go first');

  await s.window();
  await s.window();
  assert.equal(s.registers().length, 2, 'the new offer is the baseline');
  engine.models = [{ id: 'alpha', context_length: 65536 }, 'beta'];
  await s.window();
  await s.drive(() => s.registers().length === 3 && s.state() === 'idle', 'a new context length registers again');
  assert.equal(s.registers().at(-1).params.models.find((row) => row.name === 'alpha').context_length, 65536);

  await s.window();
  await s.window();
  caps.value = new Map([['beta', { vision: true, thinking: false }]]);
  await s.window();
  await s.drive(() => s.registers().length === 4 && s.state() === 'idle', 'a new capability registers again');
  assert.equal(s.registers().at(-1).params.models.find((row) => row.name === 'beta').vision, true);
});

test('OD-4: a running request is never cut by the refresh, and a busy owner is not probed', async (t) => {
  const engine = await startListEngine(t, ['alpha']);
  const busy = { on: false };
  const s = await setup(t, { engine, isBusy: () => busy.on });
  await s.drive(() => engine.lists >= 2, 'the baseline read');
  busy.on = true;
  await s.drive(() => s.state() === 'busy_own', 'busy_own');
  const lists = engine.lists;
  engine.models = ['alpha', 'beta'];
  await s.window();
  await s.window();
  assert.equal(engine.lists, lists, 'no read while the owner works');
  assert.equal(s.registers().length, 1);
  busy.on = false;
  await s.drive(() => s.registers().length === 2 && s.state() === 'idle', 'the changed offer registers once the owner is done');
});

test('OD-4: Ollama shares the owner\'s current model, else the loaded ones, else the sharer\'s chosen set, never every installed model', async (t) => {
  const installed = ['qwen3:8b', 'llama3:8b', 'gemma:2b', 'phi:latest'];
  const engine = await startListEngine(t, installed, ['gemma:2b']);
  const backend = { currentEngineType: 'ollama', currentModel: 'qwen3:8b' };
  const s = await setup(t, { engine, kind: 'Ollama', backend });
  assert.deepEqual(s.offered(), ['qwen3:8b'], 'the current local model only');

  backend.currentEngineType = 'chatgpt';
  backend.currentModel = 'gpt-5';
  await s.window();
  await s.drive(() => s.registers().length === 2 && s.state() === 'idle', 'a cloud chat: the loaded models');
  assert.deepEqual(s.offered(), ['gemma:2b']);

  assert.deepEqual(s.sharing.setOllamaModels(TEAM, ['llama3:8b', 'phi', 'gone:1b']), { ok: true, ollama_models: ['llama3:8b', 'phi', 'gone:1b'] });
  assert.deepEqual(s.sharing.ollamaModels(TEAM), ['llama3:8b', 'phi', 'gone:1b']);
  await s.window();
  await s.drive(() => s.registers().length === 3 && s.state() === 'idle', 'the chosen set');
  assert.deepEqual(s.offered(), ['llama3:8b', 'phi:latest'], 'a name without a tag matches :latest; a model not installed is not offered');
  assert.equal(s.store.writes.find((write) => write.ollama_models).ollama_models.length, 3, 'saved');

  assert.deepEqual(s.sharing.setOllamaModels(TEAM, null), { ok: true, ollama_models: null });
  await s.window();
  await s.drive(() => s.registers().length === 4 && s.state() === 'idle', 'back to the default');
  assert.deepEqual(s.offered(), ['gemma:2b']);

  for (const bad of [[], ['a\u0001'], 'x', [3]]) {
    assert.deepEqual(s.sharing.setOllamaModels(TEAM, bad), { ok: false, error: { code: 'invalid_request', reason: 'team_sharing_invalid' } });
  }
  assert.deepEqual(s.sharing.setOllamaModels('team_ZZZZZZZZZZZZZZZZZZZZZZ', null).error.reason, 'team_not_found');
  engine.loaded = [];
  backend.currentEngineType = 'ollama';
  backend.currentModel = '';
  await s.window();
  await s.drive(() => s.state() === 'no_model', 'nothing loaded and nothing current: nothing is offered (fail closed)');
});

test('OD-4: another engine\'s whole list is offered, untouched by the Ollama share set', async (t) => {
  const engine = await startListEngine(t, ['a', 'b', 'c'], ['a']);
  const s = await setup(t, { engine, kind: 'llama-server', backend: { currentEngineType: 'ollama', currentModel: 'a' } });
  assert.deepEqual(s.offered(), ['a', 'b', 'c']);
});

test('OD-3: a cloud chat leaves the idle local GPU free; an Ollama or llama-server chat makes the owner busy', async (t) => {
  const engine = await startListEngine(t, ['alpha']);
  const backend = { currentEngineType: 'chatgpt', activeStreams: new Map() };
  const { sharingIsBusy } = require('../services/main/team-registration');
  const s = await setup(t, { engine, backend, isBusy: sharingIsBusy(backend) });
  backend.activeStreams.set('chat', {});
  await s.timers.advance(5000);
  assert.equal(s.state(), 'idle', 'a cloud chat runs');
  backend.currentEngineType = 'ollama';
  await s.drive(() => s.state() === 'busy_own', 'a local chat runs');
  backend.activeStreams.clear();
  await s.drive(() => s.state() === 'idle', 'idle again');
});

// ---------------------------------------------------------------- the share set and its pieces

const answerOf = (value, status = 200) => ({ status, body: Readable.from([Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]) });
const target = { host: '127.0.0.1', port: 11434 };
const textOf = async (body) => { const parts = []; for await (const part of body) parts.push(part); return Buffer.concat(parts).toString('utf8'); };

test('the share client filters only the models answer, fails closed, and passes everything else through', async () => {
  const calls = [];
  const base = { openRequests: () => 7, call: async (options) => {
    calls.push(options.path);
    if (options.path === '/api/ps') return answerOf({ models: [{ name: 'b:latest' }] });
    return options.path === '/v1/models' ? answerOf({ object: 'list', data: [{ id: 'a' }, { id: 'B:latest', context_length: 9 }, { id: 3 }] }) : answerOf('chat');
  } };
  const allowed = createOllamaShareSet({ base, chosen: () => null, current: () => '' });
  const client = createShareClient({ base, allowed });
  assert.equal(client.openRequests(), 7);
  const listed = await client.call({ target, method: 'GET', path: '/v1/models' });
  assert.deepEqual(JSON.parse(await textOf(listed.body)).data, [{ id: 'B:latest', context_length: 9 }], 'the loaded model, by stem');
  assert.equal(await textOf((await client.call({ target, method: 'POST', path: '/v1/chat/completions' })).body), 'chat', 'a chat is untouched');
  const everything = createShareClient({ base, allowed: async () => null });
  assert.equal(JSON.parse(await textOf((await everything.call({ target, method: 'GET', path: '/v1/models' })).body)).data.length, 3, 'null: every model');
  const failing = createShareClient({ base, allowed: async () => { throw new Error('x'); } });
  assert.deepEqual(JSON.parse(await textOf((await failing.call({ target, method: 'GET', path: '/v1/models' })).body)).data, [], 'a failed set is an empty one');
  const broken = createShareClient({ base: { openRequests: () => 0, call: async () => answerOf('not json') }, allowed: async () => new Set(['a']) });
  assert.equal((await broken.call({ target, method: 'GET', path: '/v1/models' })).status, 502, 'a list that cannot be read offers nothing');
  const down = createOllamaShareSet({ base: { call: async () => answerOf('x', 500) }, chosen: () => null, current: () => '' });
  assert.equal((await down({ target })).size, 0, 'loaded models unreadable: empty');
  assert.ok(calls.includes('/api/ps'));
});

test('the offer text changes with a name, a length and a capability, not with row order', () => {
  const rows = [{ name: 'b', context_length: 8192 }, { name: 'a', context_length: null }];
  const base = modelSignature(rows, null);
  assert.equal(modelSignature([...rows].reverse(), null), base);
  assert.notEqual(modelSignature([...rows, { name: 'c', context_length: null }], null), base);
  assert.notEqual(modelSignature([{ ...rows[0], context_length: 4096 }, rows[1]], null), base);
  assert.notEqual(modelSignature(rows, new Map([['a', { vision: true, thinking: false }]])), base);
  assert.notEqual(modelSignature(rows, new Map([['a', { vision: false, thinking: false, context_length: 32768 }]])), base, 'a length the capabilities carry');
});

test('Ollama context length: model_info bounds, one POST per model and a cache by digest', async () => {
  assert.equal(contextOfInfo({ 'llama.context_length': 131072, 'general.x': 5 }), 131072);
  assert.equal(contextOfInfo({ 'llama.context_length': 1024 }), null, 'below 2048');
  assert.equal(contextOfInfo({ 'llama.context_length': 2 ** 21 }), null, 'above 1048576');
  assert.equal(contextOfInfo({ 'a.context_length': 8192, 'b.context_length': 4096 }), 4096);
  assert.equal(contextOfInfo(null), null);
  const posts = [];
  const request = (options) => {
    const req = new PassThrough();
    req.destroy = () => {};
    req.end = (body) => {
      posts.push({ options, body: JSON.parse(body.toString('utf8')) });
      const response = Readable.from([Buffer.from(JSON.stringify({ model_info: { 'qwen.context_length': 40960 } }))]);
      response.statusCode = posts.length === 3 ? 500 : 200;
      setImmediate(() => req.emit('response', response));
    };
    return req;
  };
  const read = createOllamaContextReader({ request });
  assert.equal(await read('127.0.0.1', 11434, 'qwen:8b', 'd1'), 40960);
  assert.equal(await read('127.0.0.1', 11434, 'qwen:8b', 'd1'), 40960);
  assert.equal(posts.length, 1, 'answered from the cache');
  assert.deepEqual([posts[0].options.method, posts[0].options.path, posts[0].body], ['POST', '/api/show', { model: 'qwen:8b' }]);
  assert.equal(await read('127.0.0.1', 11434, 'qwen:8b', 'd2'), 40960, 'a new digest asks again');
  assert.equal(await read('127.0.0.1', 11434, 'other', 'd3'), null, 'a refusal is null');
  assert.equal(await read('127.0.0.1', 11434, 'other', ''), 40960, 'no digest: asked each time');
  assert.equal(posts.length, 4);
});
