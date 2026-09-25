'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveLlamaServerOutputLevel } = require('../services/backend/llama-server-stderr-level');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const {
  FakeChildProcess,
  closeServer,
  makeUserDataDir,
  startReadyFakeServer,
} = require('./helpers/llama-server-lifecycle-fixtures');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const level = (line, stream = 'stderr') => resolveLlamaServerOutputLevel({ line, stream, defaultLevel: 'WARN' });

test('llama.cpp level letters map to log levels, with or without the timestamp', () => {
  assert.equal(level('0.00.047.868 I cmn  common_param: common_params_print_info: verbosity = 3'), 'INFO');
  assert.equal(level('0.34.838.467 I slot get_availabl: id  3 | task -1 | selected slot by LRU'), 'INFO');
  assert.equal(level('0.00.101.002 W srv  load_model: unauthorized: Invalid API Key'), 'WARN');
  assert.equal(level('0.00.101.002 E llama_model_load: error loading model'), 'ERROR');
  assert.equal(level('0.00.101.002 D ggml_backend: probing'), 'DEBUG');
  assert.equal(level('I srv  main: server is listening'), 'INFO');
});

test('unlettered stderr falls back to the embedded llama.cpp classifier', () => {
  assert.equal(level('srv  load_model: loading model'), 'INFO');
  assert.equal(level('cudaMalloc failed: out of memory'), 'ERROR');
  assert.equal(level('something unexpected failed to parse'), 'WARN');
  assert.equal(level('plain stdout line', 'stdout'), 'WARN', 'non-stderr keeps the caller default');
});

test('an exit Jenny requested logs INFO; an unrequested exit stays WARN', async () => {
  const requestedLogs = [];
  const requestedChild = new FakeChildProcess(41101);
  requestedChild.kill = () => { setImmediate(() => requestedChild.emit('exit', null, 'SIGTERM')); };
  const requested = await startReadyFakeServer({
    userDataPath: makeUserDataDir('jenny-llama-exit-requested-'), child: requestedChild, logs: requestedLogs,
  });
  try {
    await requested.handle.stop({ timeoutMs: 1000 });
  } finally {
    await closeServer(requested.server);
  }
  const requestedExit = requestedLogs.find((entry) => entry.event === 'llama.server.exited');
  assert.equal(requestedExit.level, 'INFO');
  assert.equal(requestedExit.details.requested, true);

  const crashLogs = [];
  const crashChild = new FakeChildProcess(41102);
  const crashed = await startReadyFakeServer({
    userDataPath: makeUserDataDir('jenny-llama-exit-crash-'), child: crashChild, logs: crashLogs,
  });
  try {
    crashChild.emit('exit', 3221225477, null);
  } finally {
    await closeServer(crashed.server);
  }
  const crashExit = crashLogs.find((entry) => entry.event === 'llama.server.exited');
  assert.equal(crashExit.level, 'WARN');
  assert.equal(crashExit.details.requested, false);
});
