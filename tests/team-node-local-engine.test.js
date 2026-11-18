'use strict';

// Row 123 slice 4e: the guard that keeps a shared request on this PC. `resolveLocalEngine`
// (services/team/node/local-engine.js) names the engine a shared GPU forwards to, or nothing;
// `readModels` and the job path (engine-forward.js) never offer or forward an Ollama cloud model
// (`-cloud` or `:cloud`, the CLI's local-only rule). No engine, no network, no window.

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const { DEFAULT_READERS, readModelCapabilities, resolveLocalEngine } = require('../services/team/node/local-engine');
const { readModels } = require('../services/team/node/engine-forward');
const { isCloudModelName } = require('../services/cli-host/local-only-providers');
const { createManualTimers } = require('./helpers/team-node-agent-fixture');

const LOOPBACK = 'http://127.0.0.1:8081/v1';
const readers = (over = {}) => ({ ...DEFAULT_READERS, apiUrl: () => LOOPBACK, owner: () => null, ownerKey: () => 'managed-key', ...over });
const compatible = (over = {}) => ({ currentEngineType: 'openai-compatible', ...over });

test('a selected team model, the team engine port and a hosted endpoint offer nothing', () => {
  assert.equal(resolveLocalEngine(compatible({ _teamEngineSelection: { team_id: 'team_x', model: 'm' } }), readers()), null, 'a team model');
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
  const caps = await readModelCapabilities({ currentEngineType: 'Ollama' }, list);
  assert.deepEqual(seen, ['ollama']);
  assert.deepEqual([...caps], [['thinker', { vision: false, thinking: true }], ['seer', { vision: true, thinking: false }],
    ['odd', { vision: false, thinking: false }]]);
  assert.equal(await readModelCapabilities({ currentEngineType: 'ollama' }, async () => { throw new Error('sidecar'); }), null);
  assert.equal(await readModelCapabilities({ currentEngineType: 'ollama' }, async () => ({ data: 'x' })), null);
  assert.equal(await readModelCapabilities({ currentEngineType: '' }, list), null);
  assert.equal(await readModelCapabilities(null, list), null);
});
