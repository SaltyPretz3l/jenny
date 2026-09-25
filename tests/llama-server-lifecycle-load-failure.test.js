'use strict';

// A llama-server build that cannot read the model file exits during load and
// says why only on stderr. The launch names that failure, and whose build it
// was, instead of the bare child_exited_before_ready.

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

// Captured from bundled b10749 loading the Bonsai 2 PQ2_0 file on 2026-09-18.
const TYPE_142 = "E gguf_init_from_reader: tensor 'output.weight' has invalid ggml type 142. should be in [0, 43)";
// The form both local builds print (b10749's and the fork's llama.dll carry no
// "error loading model architecture: " wrapper).
const ARCH = "E llama_model_load: error loading model: unknown model architecture: 'qwen35'";
const LOAD_EXIT = 'E srv  llama_server: exiting due to model loading error';

async function launch({
  stderr = [],
  stdout = [],
  late = [],
  endStderr = true,
  spawnError = null,
  runtimeSource = 'bundled',
  runtimeLabel = 'bundled',
  binaryPath: binaryPathOverride = '',
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-load-failure-'));
  trackDirectory(userDataPath);
  const child = new FakeChildProcess(45000);
  const logs = [];
  const binaryPath = binaryPathOverride
    || path.join(userDataPath, 'llama-prism-b10683-cuda13.3', 'llama-server.exe');
  // A line may be a function of the build's folder, for output that names it.
  const text = (line) => (typeof line === 'function' ? line(path.dirname(binaryPath)) : line);
  const startedAt = Date.now();
  const error = await startLlamaServer({
    modelTag: 'ternary-bonsai-2-27b-pq2_0',
    binaryPath,
    runtimeLabel,
    runtimeSource,
    modelPath: path.join(userDataPath, 'Ternary-Bonsai-2-27B-PQ2_0.gguf'),
    projectorPath: '',
    userDataPath,
    port: await getClosedPort(),
    readinessTimeoutMs: 5000,
    readinessPollIntervalMs: 1,
    platform: 'win32',
    spawnImpl: () => {
      setImmediate(() => {
        if (spawnError) {
          child.emit('error', spawnError);
          return;
        }
        for (const line of stdout) child.stdout.emit('data', `${text(line)}\n`);
        for (const line of stderr) child.stderr.emit('data', `${text(line)}\n`);
        child.emit('exit', 1, null);
        // Lines still in the pipe when the exit is noticed arrive afterwards.
        setTimeout(() => {
          for (const line of late) child.stderr.emit('data', `${text(line)}\n`);
          if (endStderr) child.stderr.emit('end');
        }, 60);
      });
      return child;
    },
    spawnSyncImpl: () => ({ status: 0 }),
    isProcessAliveImpl: () => false,
    logger: (level, event, details) => logs.push({ level, event, details }),
  }).then(() => null, (rejection) => rejection);
  return { error, logs, binaryPath, elapsedMs: Date.now() - startedAt };
}

const unsupportedLogs = (logs) => logs.filter((entry) => entry.event === 'llama.server.model_unsupported');

test('the bundled build failing on a quant type it lacks is named as the bundled build', async () => {
  const { error, logs, binaryPath } = await launch({ stderr: [TYPE_142, LOAD_EXIT] });
  assert.equal(error?.message, 'llama_server_model_unsupported:bundled');
  assert.deepEqual(unsupportedLogs(logs).map((entry) => [entry.level, entry.details]),
    [['WARN', { runtime: 'bundled' }]]);
  // The folder name, not the path: JSON doubles a win32 path's backslashes.
  assert.equal(JSON.stringify(unsupportedLogs(logs)).includes(path.basename(path.dirname(binaryPath))), false);
});

test('a saved or env build failing the same way is named as a custom build', async () => {
  const saved = await launch({ stderr: [TYPE_142], runtimeSource: 'saved', runtimeLabel: 'build 10683' });
  assert.equal(saved.error?.message, 'llama_server_model_unsupported:custom');
  assert.deepEqual(unsupportedLogs(saved.logs)[0].details, { runtime: 'build 10683' });
  const env = await launch({ stderr: [TYPE_142], runtimeSource: 'env', runtimeLabel: 'env' });
  assert.equal(env.error?.message, 'llama_server_model_unsupported:custom');
});

test('an unknown architecture is the same failure, with or without an upstream wrapper', async () => {
  for (const line of [
    ARCH,
    "E llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'qwen35'",
  ]) {
    const { error } = await launch({ stderr: [line] });
    assert.equal(error?.message, 'llama_server_model_unsupported:bundled', line);
  }
});

test('llama.cpp\'s optional log prefix still classifies: no level letter, a timestamp, colours', async () => {
  const bare = TYPE_142.slice(2);
  for (const line of [
    bare,
    `0.00.041.713 ${TYPE_142}`,
    `\u001b[34m0.00.041.713\u001b[0m \u001b[31mE ${bare}\u001b[0m`,
    ARCH.slice(2),
    `\u001b[34m0.00.041.713\u001b[0m \u001b[31m${ARCH}\u001b[0m`,
  ]) {
    const { error } = await launch({ stderr: [line] });
    assert.equal(error?.message, 'llama_server_model_unsupported:bundled', JSON.stringify(line));
  }
});

test('a path or a metadata value that merely contains the phrase is not a load failure', async () => {
  const { error, logs } = await launch({
    stderr: [
      'I llama_model_loader: loaded meta data with 44 key-value pairs and 626 tensors from D:\\invalid ggml type 7\\gemma-4-12b.gguf',
      "I llama_model_loader: - kv   2: general.name str = unknown model architecture: 'x'",
      'E ggml_backend_cuda_buffer_type_alloc_buffer: allocating 512 MiB on device 0: cudaMalloc failed: out of memory',
      LOAD_EXIT,
    ],
  });
  assert.equal(error?.message, 'child_exited_before_ready');
  assert.equal(unsupportedLogs(logs).length, 0);
});

test('any other early exit keeps child_exited_before_ready', async () => {
  const { error, logs } = await launch({
    stderr: ['E llama_model_load: error loading model: failed to allocate CUDA0 buffer', LOAD_EXIT],
  });
  assert.equal(error?.message, 'child_exited_before_ready');
  assert.equal(unsupportedLogs(logs).length, 0);
});

test('stdout is not inspected', async () => {
  const { error } = await launch({ stdout: [TYPE_142] });
  assert.equal(error?.message, 'child_exited_before_ready');
});

test('only the first 2,000 stderr lines are inspected', async () => {
  const filler = (count) => Array.from({ length: count }, (_value, index) => `I load: line ${index}`);
  const inside = await launch({ stderr: [...filler(1999), TYPE_142] });
  assert.equal(inside.error?.message, 'llama_server_model_unsupported:bundled');
  const outside = await launch({ stderr: [...filler(2000), TYPE_142] });
  assert.equal(outside.error?.message, 'child_exited_before_ready');
});

test('a line that arrives after the exit, before stderr closes, still counts', async () => {
  const { error } = await launch({ late: [TYPE_142] });
  assert.equal(error?.message, 'llama_server_model_unsupported:bundled');
});

test('a stderr that never closes delays the error only briefly', async () => {
  const { error, elapsedMs } = await launch({ endStderr: false });
  assert.equal(error?.message, 'child_exited_before_ready');
  assert.ok(elapsedMs < 2000, `took ${elapsedMs} ms`);
});

test('the spawn log names the build by its label, never its path', async () => {
  const { logs, binaryPath } = await launch({ stderr: [TYPE_142], runtimeSource: 'saved', runtimeLabel: 'build 10683' });
  const spawn = logs.find((entry) => entry.event === 'llama.server.spawn');
  assert.equal(spawn?.details.runtime, 'build 10683');
  assert.equal('binary' in spawn.details, false);
  assert.equal(JSON.stringify(spawn.details).includes(path.basename(path.dirname(binaryPath))), false);
});

test('output lines name the build\'s folder by a token, in any case or separator, and still classify', async () => {
  const { error, logs } = await launch({
    stderr: [
      (folder) => `load_backend: loaded CUDA backend from ${folder}\\ggml-cuda.dll`,
      (folder) => `load_backend: loaded CPU backend from ${folder.replaceAll('\\', '/').toUpperCase()}/ggml-cpu.dll`,
      TYPE_142,
    ],
    runtimeSource: 'saved',
    runtimeLabel: 'build 10683',
  });
  assert.equal(error?.message, 'llama_server_model_unsupported:custom');
  assert.deepEqual(logs.filter((entry) => entry.event === 'llama.server.output').map((entry) => entry.details.line), [
    'load_backend: loaded CUDA backend from [llama-server folder]\\ggml-cuda.dll',
    'load_backend: loaded CPU backend from [llama-server folder]/ggml-cpu.dll',
    TYPE_142,
  ]);
});

test('a long run of separators in an output line is redacted in linear time', async () => {
  // A folder that starts with a separator (any posix build, the bundled one
  // included) once made every position of the run start a backtracking match.
  const { logs, elapsedMs } = await launch({
    binaryPath: '/opt/jenny/llama_server_extract/llama-server',
    stderr: ['/'.repeat(128 * 1024), 'loaded CPU backend from /opt/jenny/llama_server_extract/libggml-cpu.so'],
  });
  assert.ok(elapsedMs < 1000, `took ${elapsedMs} ms`);
  assert.equal(logs.filter((entry) => entry.event === 'llama.server.output').at(-1).details.line,
    'loaded CPU backend from [llama-server folder]/libggml-cpu.so');
});

test('an env build at the root of a network share is still redacted', { skip: process.platform !== 'win32' }, async () => {
  const { logs } = await launch({
    binaryPath: '\\\\nas\\John Smith\\llama-server.exe',
    runtimeSource: 'env',
    runtimeLabel: 'env',
    stderr: ['load_backend: loaded CPU backend from \\\\nas\\John Smith\\ggml-cpu.dll'],
  });
  assert.deepEqual(logs.filter((entry) => entry.event === 'llama.server.output').map((entry) => entry.details.line),
    ['load_backend: loaded CPU backend from [llama-server folder]\\ggml-cpu.dll']);
});

test('a spawn error is logged by its code, never by its message', async () => {
  const withCode = Object.assign(new Error('spawn G:/Jane Doe/llama-b10683/llama-server.exe ENOENT'), { code: 'ENOENT' });
  const coded = await launch({ spawnError: withCode });
  assert.deepEqual(coded.logs.find((entry) => entry.event === 'llama.server.spawn_error')?.details, { code: 'ENOENT' });
  const bare = await launch({ spawnError: new Error('spawn G:/Jane Doe/llama-b10683/llama-server.exe failed') });
  assert.deepEqual(bare.logs.find((entry) => entry.event === 'llama.server.spawn_error')?.details, { code: 'spawn_failed' });
});
