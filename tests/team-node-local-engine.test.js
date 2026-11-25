'use strict';

// Row 123 slice 4e: the guard that keeps a shared request on this PC. `resolveLocalEngine`
// (services/team/node/local-engine.js) names the engine a shared GPU forwards to, or nothing;
// `readModels` and the job path (engine-forward.js) never offer or forward an Ollama cloud model
// (`-cloud` or `:cloud`, the CLI's local-only rule). No engine, no network, no window.

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const { DEFAULT_READERS, ownInferenceUsesLocalEngine, readModelCapabilities, resolveLocalEngine } = require('../services/team/node/local-engine');
const { readModels } = require('../services/team/node/engine-forward');
const { isCloudModelName } = require('../services/cli-host/local-only-providers');
const { createManualTimers } = require('./helpers/team-node-agent-fixture');

const LOOPBACK = 'http://127.0.0.1:8081/v1';
const readers = (over = {}) => ({ ...DEFAULT_READERS, apiUrl: () => LOOPBACK, owner: () => null, ownerKey: () => 'managed-key',
  managedLocal: () => null, configuredUrl: () => '', ollamaInUse: () => false, localHelper: () => false, ...over });
const compatible = (over = {}) => ({ currentEngineType: 'openai-compatible', ...over });

test('the team engine port and a hosted endpoint offer nothing; a team model alone leaves the local engine to the configured one', () => {
  const onTeam = compatible({ _teamEngineSelection: { team_id: 'team_x', model: 'm' } });
  assert.equal(resolveLocalEngine(onTeam, readers({ teamSelection: () => ({ teamId: 'team_x' }) })), null, 'a team model and no local engine configured');
  assert.equal(resolveLocalEngine(compatible(), readers({ owner: () => ({ kind: 'team-engine', status: { state: 'ready' } }) })), null, 'the team port');
  assert.equal(resolveLocalEngine(compatible({ hostMode: 'server', options: { modelEndpoint: { engine: 'openai-compatible', apiUrl: LOOPBACK } } }),
    readers()), null, 'a hosted endpoint');
  assert.equal(resolveLocalEngine(null), null);
  for (const engine of ['mock', 'openai', 'anthropic', 'gemini', '']) {
    assert.equal(resolveLocalEngine({ currentEngineType: engine }, readers()), null, `${engine || 'no engine'} offers nothing`);
  }
});

test('a managed server offers only when ready, with its key; a custom loopback endpoint has no key', () => {
  const ninfer = (state) => readers({ owner: () => ({ kind: 'ninfer', status: { state } }) });
  assert.equal(resolveLocalEngine(compatible(), ninfer('starting')), null, 'not ready');
  assert.deepEqual(resolveLocalEngine(compatible(), ninfer('ready')), { url: LOOPBACK, kind: 'NInfer', key: 'managed-key' });
  assert.deepEqual(resolveLocalEngine(compatible(), readers({ owner: () => ({ kind: 'llama-server', status: { state: 'ready' } }) })),
    { url: LOOPBACK, kind: 'llama-server', key: 'managed-key' });
  assert.deepEqual(resolveLocalEngine(compatible(), readers()), { url: LOOPBACK, kind: 'local', key: '' }, 'no key for a server Jenny does not run');
  assert.equal(resolveLocalEngine(compatible(), readers({ apiUrl: () => { throw new Error('config'); } })), null);
});

test('Ollama: its loopback host and port; a daemon on another machine offers nothing', () => {
  const ollama = (manager) => resolveLocalEngine({ currentEngineType: 'ollama', ollamaManager: manager }, readers());
  assert.deepEqual(ollama({ _host: '127.0.0.1', _port: 11500 }), { url: 'http://127.0.0.1:11500/v1', kind: 'Ollama', key: '' });
  assert.deepEqual(ollama({ _host: '::1', _port: 11434 }), { url: 'http://[::1]:11434/v1', kind: 'Ollama', key: '' });
  assert.deepEqual(ollama({}), { url: 'http://127.0.0.1:11434/v1', kind: 'Ollama', key: '' }, 'the default port');
  assert.equal(ollama({ _host: '192.168.1.20', _port: 11434 }), null, 'another machine');
  assert.equal(ollama({ _host: 'ollama.example.com', _port: 443 }), null);
});

test('the cloud-model rule is the CLI’s: -cloud and :cloud names, any case', () => {
  for (const name of ['gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'deepseek:cloud', 'X-CLOUD']) assert.equal(isCloudModelName(name), true, name);
  for (const name of ['qwen3.8-27b', 'cloudy-7b', 'cloud', 'my-cloud-model']) assert.equal(isCloudModelName(name), false, name);
});

test('readModels never offers a cloud model, on any engine', async () => {
  const listed = ['qwen3.8-27b', 'gpt-oss:120b-cloud', 'kimi-k2:1t-cloud', 'gemma-4-12b'];
  const engine = { call: async () => ({ status: 200, body: Readable.from([Buffer.from(JSON.stringify({ data: listed.map((id) => ({ id })) }))]) }) };
  const read = await readModels({ engine, target: {}, timers: createManualTimers() });
  assert.deepEqual(read.models.map((entry) => entry.name), ['qwen3.8-27b', 'gemma-4-12b']);
});

test('model capabilities come from the member\'s own list for the current engine; a failed read is null', async () => {
  const seen = [];
  const list = async (service, engineType) => {
    seen.push(engineType);
    return { data: [
      { id: 'thinker', capabilities: { thinking: true, reasoning_effort: true } },
      { id: 'seer', capabilities: { vision: true } },
      { id: 'plain' },
      { id: 'thinker', capabilities: { vision: true } },
      { id: 'odd', capabilities: { vision: 'yes', thinking: 1 } },
    ] };
  };
  const caps = await readModelCapabilities({ currentEngineType: 'Ollama' }, list, '', async () => null);
  assert.deepEqual(seen, ['ollama']);
  assert.deepEqual([...caps], [['thinker', { vision: false, thinking: true }], ['seer', { vision: true, thinking: false }],
    ['odd', { vision: false, thinking: false }]]);
  assert.equal(await readModelCapabilities({ currentEngineType: 'ollama' }, async () => { throw new Error('sidecar'); }), null);
  assert.equal(await readModelCapabilities({ currentEngineType: 'ollama' }, async () => ({ data: 'x' })), null);
  assert.equal(await readModelCapabilities({ currentEngineType: '' }, list), null);
  assert.equal(await readModelCapabilities(null, list), null);
});

// OD-3 (row 201): the shared engine is the configured local engine, whatever the owner's chat runs on.
const ready = { url: 'http://127.0.0.1:8034', kind: 'NInfer', key: 'ninfer-key' };

test('OD-3: a cloud or team chat still shares the ready managed server, else Ollama in use, else the configured endpoint', () => {
  for (const engine of ['chatgpt', 'api-provider', 'codex-cli']) {
    assert.deepEqual(resolveLocalEngine({ currentEngineType: engine }, readers({ managedLocal: () => ready })), ready, `${engine}: a ready managed server`);
    assert.equal(resolveLocalEngine({ currentEngineType: engine }, readers()), null, `${engine}: nothing configured offers nothing`);
  }
  const cloud = { currentEngineType: 'chatgpt', ollamaManager: { _port: 11500 } };
  assert.deepEqual(resolveLocalEngine(cloud, readers({ ollamaInUse: () => true })), { url: 'http://127.0.0.1:11500/v1', kind: 'Ollama', key: '' });
  assert.equal(resolveLocalEngine({ ...cloud, ollamaManager: { _host: '10.0.0.5' } }, readers({ ollamaInUse: () => true })), null, 'a remote daemon');
  assert.deepEqual(resolveLocalEngine(cloud, readers({ configuredUrl: () => LOOPBACK })), { url: LOOPBACK, kind: 'local', key: '' });
  assert.equal(resolveLocalEngine(cloud, readers({ configuredUrl: () => LOOPBACK, owner: () => ({ kind: 'llama-server', status: { state: 'starting' } }) })),
    null, 'a managed server that is not ready');
  const onTeam = { currentEngineType: 'openai-compatible', _teamEngineSelection: { team_id: 'team_x', model: 'm' } };
  assert.deepEqual(resolveLocalEngine(onTeam, readers({ teamSelection: () => ({ teamId: 'team_x' }), managedLocal: () => ready })), ready, 'a team model');
  assert.equal(resolveLocalEngine(cloud, readers({ managedLocal: () => ready, hostedEndpoint: () => ({ engine: 'openai-compatible' }) })), null, 'hosted');
});

test('OD-3: the owner\'s chat counts as using the local GPU only when it can', () => {
  const local = (over = {}) => readers({ teamSelection: () => null, localHelper: () => false, ...over });
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'ollama' }, local()), true);
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'openai-compatible' }, local()), true);
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'chatgpt' }, local()), false, 'a cloud chat');
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'chatgpt' }, local({ localHelper: () => true })), true, 'a cloud chat with a local helper server');
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'chatgpt' }, local({ localHelper: () => { throw new Error('x'); } })), true, 'unreadable: busy');
  assert.equal(ownInferenceUsesLocalEngine({ currentEngineType: 'openai-compatible' }, local({ teamSelection: () => ({ teamId: 't' }) })), false, 'a team model');
  assert.equal(ownInferenceUsesLocalEngine(null, local()), true);
  assert.equal(ownInferenceUsesLocalEngine({}, local()), true, 'an engine it does not know');
});

test('OD-3: capabilities are read for the shared engine, not the cloud engine the chat runs on', async () => {
  const seen = [];
  const list = async (service, engineType) => { seen.push(engineType); return { data: [{ id: 'seer', capabilities: { vision: true } }] }; };
  const caps = await readModelCapabilities({ currentEngineType: 'chatgpt' }, list, 'ollama', async () => null);
  assert.deepEqual(seen, ['ollama']);
  assert.deepEqual([...caps], [['seer', { vision: true, thinking: false }]]);
});

test('OD-4: a model\'s context length goes to the registration when the engine knows it (its own list, else Ollama\'s /api/show)', async () => {
  const asked = [];
  const list = async () => ({ data: [
    { id: 'own', capabilities: { vision: false }, context_length: 65536 },
    { id: 'shown', capabilities: { thinking: true }, digest: 'sha256:aa' },
    { id: 'unknown', capabilities: {} },
    { id: 'plain' }] });
  const contextOf = async (host, port, name, digest) => {
    asked.push([host, port, name, digest]);
    return { shown: 131072 }[name] ?? null;
  };
  const backend = { currentEngineType: 'ollama', ollamaManager: { _host: '::1', _port: 11500 } };
  const caps = await readModelCapabilities(backend, list, '', contextOf);
  assert.deepEqual([...caps], [
    ['own', { vision: false, thinking: false, context_length: 65536 }],
    ['shown', { vision: false, thinking: true, context_length: 131072 }],
    ['unknown', { vision: false, thinking: false }]]);
  assert.deepEqual(asked.map((row) => row.slice(0, 3)).sort(), [['::1', 11500, 'shown'], ['::1', 11500, 'unknown']],
    'one /api/show per model that has none; the list\'s own length is not asked again');
  const compat = await readModelCapabilities({ currentEngineType: 'openai-compatible' }, list, '', contextOf);
  assert.equal(compat.get('shown').context_length, undefined, 'only Ollama is asked');
  assert.equal(compat.get('own').context_length, 65536);
});

test('row 201 (OD-4): Ollama\'s model_info context length is the smallest in bounds; a bad answer is null', () => {
  const { contextOfInfo } = require('../services/team/node/ollama-context');
  assert.equal(contextOfInfo({ 'llama.context_length': 131072, 'clip.context_length': 8192, 'general.name': 'x' }), 8192);
  assert.equal(contextOfInfo({ 'llama.context_length': 1024 }), null, 'below 2048');
  assert.equal(contextOfInfo({ 'llama.context_length': 2 ** 21 }), null, 'above 1048576');
  assert.equal(contextOfInfo(null), null);
});

test('row 201 review: the reader caches a length per digest, and asks again for a null answer only after five minutes', async () => {
  const { EventEmitter } = require('node:events');
  const { createOllamaContextReader } = require('../services/team/node/ollama-context');
  let answers = [{ model_info: { 'llama.context_length': 32768 } }, {}, {}];
  let calls = 0;
  let clock = 0;
  const request = () => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      calls += 1;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.destroy = () => {};
      setImmediate(() => { req.emit('response', res); res.emit('data', Buffer.from(JSON.stringify(answers.shift()))); res.emit('end'); });
    };
    return req;
  };
  const read = createOllamaContextReader({ request, now: () => clock });
  assert.equal(await read('127.0.0.1', 11434, 'a', 'sha256:a'), 32768);
  assert.equal(await read('127.0.0.1', 11434, 'a', 'sha256:a'), 32768);
  assert.equal(calls, 1, 'a known length is not asked again');
  assert.equal(await read('127.0.0.1', 11434, 'b', 'sha256:b'), null);
  assert.equal(await read('127.0.0.1', 11434, 'b', 'sha256:b'), null);
  assert.equal(calls, 2, 'a null answer is held');
  clock = 5 * 60 * 1000 + 1;
  await read('127.0.0.1', 11434, 'b', 'sha256:b');
  assert.equal(calls, 3, 'and asked again after five minutes');
  answers = [];
});
