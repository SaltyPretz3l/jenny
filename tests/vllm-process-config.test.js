'use strict';

// vLLM configuration + readiness-identity contract.
//
// Split out of tests/vllm-process-manager.test.js (600-line soft target).
//   F12a — the managed manager is constructed at boot with only {logger,
//          userDataPath, model}, so every configured field (port, maxModelLen,
//          parsers, extraArgs) was dropped from the launch argv. configure()
//          re-reads live config immediately before start().
//   F12c — readiness was a bare TCP connect, so ANY listener on port 8000 (a
//          very common dev-server port) short-circuited auto-start as
//          {started:false, external:true} and the sidecar then posted
//          OpenAI-format chat to an unrelated service.

const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const { VLLMProcessManager } = require('../services/backend/vllm-process-manager');

async function withJsonServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ── F12c: readiness is an HTTP identity probe ────────────────────────────────

test('start() adopts an already-running server that serves the configured model', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.5-9B',
    port: 0, // Port 0 would fail to connect, but we override the probe.
  });

  manager._probeServedModels = async () => ['Qwen/Qwen3.5-9B'];

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, true);
  assert.ok(logs.some((l) => l.event === 'vllm.already_running'));
});

test('start() refuses to adopt a port held by a service that does not serve the model', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.5-9B',
    port: 8000,
  });

  // A stranger answers /v1/models with a valid OpenAI shape, different models.
  manager._probeServedModels = async () => ['some-other-tool/model-a'];

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, false, 'a stranger must NOT be adopted as ready');
  const warn = logs.find((l) => l.event === 'vllm.port_occupied_by_other_service');
  assert.ok(warn, 'expected the distinct vllm.port_occupied_by_other_service WARN');
  assert.equal(warn.level, 'WARN');
  assert.deepEqual(warn.details.servedModels, ['some-other-tool/model-a']);
  assert.equal(
    logs.some((l) => l.event === 'vllm.already_running'),
    false,
    'must NOT log already_running for a foreign service',
  );
});

test('_isRunning rejects a listener whose /v1/models payload is not an OpenAI list', async () => {
  await withJsonServer(
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hello: 'this is a webpack dev server' }));
    },
    async (port) => {
      const manager = new VLLMProcessManager({ model: 'Qwen/Qwen3.5-9B', port });
      assert.equal(
        await manager._isRunning(),
        false,
        'a 200 without a data[] array must not count as a ready vLLM',
      );
    },
  );
});

test('_probeServedModels returns the served ids for a real OpenAI /v1/models response', async () => {
  await withJsonServer(
    (req, res) => {
      assert.equal(req.url, '/v1/models');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'Qwen/Qwen3.5-9B' }, { id: 'b' }] }));
    },
    async (port) => {
      const manager = new VLLMProcessManager({ model: 'Qwen/Qwen3.5-9B', port });
      assert.deepEqual(await manager._probeServedModels(), ['Qwen/Qwen3.5-9B', 'b']);
      assert.equal(await manager._isRunning(), true);
    },
  );
});

test('_isRunning rejects a non-2xx /v1/models response', async () => {
  await withJsonServer(
    (_req, res) => {
      res.writeHead(404);
      res.end('nope');
    },
    async (port) => {
      const manager = new VLLMProcessManager({ model: 'm', port });
      assert.equal(await manager._isRunning(), false);
    },
  );
});

// ── F12a: configure() stops the launch argv from dropping every setting ──────

test('configure() applies live port + launch args so _buildArgv stops dropping config', () => {
  const manager = new VLLMProcessManager({ model: 'boot-model' });
  assert.deepEqual(manager._buildArgv(), [
    'serve', 'boot-model', '--host', '127.0.0.1', '--port', '8000',
  ]);

  manager.configure({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8123,
    launchArgs: {
      port: 8123,
      maxModelLen: 48000,
      reasoningParser: 'qwen3',
      toolCallParser: 'qwen3_coder',
      enableAutoToolChoice: true,
      extraArgs: ['--gpu-memory-utilization=0.9'],
    },
  });

  assert.deepEqual(manager._buildArgv(), [
    'serve', 'Qwen/Qwen3.6-35B-A3B',
    '--host', '127.0.0.1',
    '--port', '8123',
    '--max-model-len', '48000',
    '--reasoning-parser', 'qwen3',
    '--tool-call-parser', 'qwen3_coder',
    '--enable-auto-tool-choice',
    '--gpu-memory-utilization=0.9',
  ]);
});

test('configure() leaves current settings untouched for absent/invalid fields', () => {
  const manager = new VLLMProcessManager({ model: 'keep-me', port: 8400 });
  manager.setLaunchArgs({ maxModelLen: 1024 });

  manager.configure({});
  assert.equal(manager._model, 'keep-me');
  assert.equal(manager._port, 8400);
  assert.deepEqual(manager._launchArgs, { maxModelLen: 1024 });

  manager.configure({ model: '   ', port: 0, launchArgs: null });
  assert.equal(manager._model, 'keep-me');
  assert.equal(manager._port, 8400);
  assert.deepEqual(manager._launchArgs, { maxModelLen: 1024 });
});
