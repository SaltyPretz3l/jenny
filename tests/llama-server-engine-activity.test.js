'use strict';

// Owner session 2026-09-19: a managed llama-server decoded a 7k-token tool call
// at ~58 tok/s while the router's stream-inactivity watchdog, seeing no chat
// chunks, killed the turn as "engine stalled". Only the Ollama manager fed the
// watchdog's liveness clock; the llama-server launch fed it nothing. Its stderr
// telemetry now forwards to the same sink.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startLlamaServer } = require('../services/llama-server-lifecycle');
const { FakeChildProcess, getClosedPort } = require('./helpers/llama-server-lifecycle-fixtures');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// The launch fails (the child exits before readiness) — deliberately: the point
// is what reached the sink while the child was alive, which is also the only
// state a stalled decode is ever observed in.
async function launch({ stderr = [], stdout = [], onEngineActivity = null } = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-activity-'));
  trackDirectory(userDataPath);
  const child = new FakeChildProcess(45001);
  await startLlamaServer({
    modelTag: 'ternary-bonsai-2-27b-pq2_0',
    binaryPath: path.join(userDataPath, 'llama-server.exe'),
    runtimeLabel: 'bundled',
    runtimeSource: 'bundled',
    modelPath: path.join(userDataPath, 'model.gguf'),
    projectorPath: '',
    userDataPath,
    port: await getClosedPort(),
    readinessTimeoutMs: 3000,
    readinessPollIntervalMs: 1,
    platform: 'win32',
    onEngineActivity,
    spawnImpl: () => {
      setImmediate(() => {
        for (const line of stdout) child.stdout.emit('data', `${line}\n`);
        for (const line of stderr) child.stderr.emit('data', `${line}\n`);
        child.emit('exit', 1, null);
        setTimeout(() => child.stderr.emit('end'), 20);
      });
      return child;
    },
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
    logger: () => {},
  }).then(() => null, () => null);
}

test('llama-server decode telemetry reaches the liveness sink', async () => {
  let beats = 0;
  await launch({
    stderr: ['13.45.081.978 I slot print_timing: id  2 | task 20326 | n_gen = 159, tg = 52.47 t/s'],
    onEngineActivity: () => {
      beats += 1;
    },
  });
  assert.equal(beats, 1);
});

test('ambient server chatter and stdout never beat', async () => {
  let beats = 0;
  await launch({
    stdout: ['[GIN] 2026/09/19 - 09:11:08 | 200 | GET "/api/tags"'],
    stderr: [
      '15.51.896.797 W srv   operator (): unauthorized: Invalid API Key',
      'main: server is listening on http://127.0.0.1:8033',
    ],
    onEngineActivity: () => {
      beats += 1;
    },
  });
  assert.equal(beats, 0);
});

test('telemetry past the load-failure inspection budget still beats', async () => {
  // A stalled decode happens thousands of lines after the loader window has
  // closed; the forward must sit before those early-outs.
  let beats = 0;
  const noise = Array.from(
    { length: 2_100 },
    (_unused, index) => `I llama_model_loader: - kv ${index}: general.name str = model`
  );
  await launch({
    stderr: [...noise, '14.00.130.869 I slot print_timing: id 2 | task 1 | n_gen = 978'],
    onEngineActivity: () => {
      beats += 1;
    },
  });
  assert.ok(beats >= 1, `expected a heartbeat after the inspection budget, got ${beats}`);
});

test('the sink is throttled, so a chatty decode is not a beat per line', async () => {
  const beats = [];
  await launch({
    stderr: Array.from(
      { length: 40 },
      (_unused, index) => `13.45.081.97${index % 10} I slot print_timing: id 2 | n_gen = ${index}`
    ),
    onEngineActivity: () => beats.push(1),
  });
  // The whole burst lands inside one throttle window (5s).
  assert.equal(beats.length, 1);
});
