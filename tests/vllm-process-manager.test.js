const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { VLLMProcessManager, buildVllmLaunchArgs } = require('../services/backend/vllm-process-manager');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Minimal fake state store that records calls and holds a single value. */
function makeStateStore(initialValue) {
  const calls = { reads: [], writes: [], deletes: [] };
  let stored = initialValue !== undefined ? initialValue : null;
  return {
    _calls: calls,
    _stored() { return stored; },
    read(defaultVal) {
      const result = stored !== null ? stored : defaultVal;
      calls.reads.push(result);
      return result;
    },
    write(value) {
      calls.writes.push(value);
      stored = value;
    },
    delete() {
      calls.deletes.push(true);
      stored = null;
    },
  };
}

/**
 * Fake child process: EventEmitter with a stderr EventEmitter.
 * Calling kill('SIGTERM') schedules an 'exit' emit on next tick by default
 * (simulating a clean shutdown that clears the SIGKILL timer).
 */
function makeFakeProc(pid) {
  const proc = new EventEmitter();
  proc.pid = pid || 12345;
  proc.stderr = new EventEmitter();
  proc.kill = function (signal) {
    this._killCalls = this._killCalls || [];
    this._killCalls.push(signal || 'SIGTERM');
    if (signal === 'SIGTERM' || signal == null) {
      // Emit exit on next tick so the once('exit') handler fires and clears the SIGKILL timer.
      process.nextTick(() => { this.emit('exit', 0, null); });
    }
  };
  return proc;
}

test('start() skips when no model is configured', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: '',
  });
  // start() probes http://127.0.0.1:8000/v1/models BEFORE it reads the model,
  // so without this stub the case depends on whether anything else on the host
  // happens to hold vLLM's default port. Verified: with a server answering
  // /v1/models on 8000, start() returns {started:false, external:true} and logs
  // vllm.already_running instead of vllm.no_model, failing both assertions
  // below. Every other start() case in this file stubs the same seam.
  manager._isRunning = async () => false;

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, false);
  assert.ok(logs.some((l) => l.event === 'vllm.no_model'));
});

test('setModel() updates the model before start', () => {
  const manager = new VLLMProcessManager({ model: '' });
  manager.setModel('Qwen/Qwen3.5-9B');
  assert.equal(manager._model, 'Qwen/Qwen3.5-9B');
});

test('stop() is a no-op when no owned process', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.5-9B',
  });

  await manager.stop();

  assert.equal(logs.length, 0);
});

// F12a (configure) and F12c (HTTP identity probe / external adoption) coverage
// lives in the sibling file tests/vllm-process-config.test.js (600-line target).

test('start() returns not started when vllm is not on PATH', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.5-9B',
  });

  // Ensure vllm is not running and not on PATH
  manager._isRunning = async () => false;
  manager._resolveCommand = () => null;

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, false);
  assert.ok(logs.some((l) => l.event === 'vllm.not_found'));
});

/* ── buildVllmLaunchArgs ── */

test('buildVllmLaunchArgs returns minimal argv with just model+port', () => {
  const argv = buildVllmLaunchArgs({ model: 'Qwen/Qwen3.5-9B', port: 8000 });
  assert.deepEqual(argv, [
    'serve', 'Qwen/Qwen3.5-9B',
    '--host', '127.0.0.1',
    '--port', '8000',
  ]);
});

test('buildVllmLaunchArgs builds full qwen3.6 argv per plan', () => {
  const argv = buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    maxModelLen: 131072,
    reasoningParser: 'qwen3',
    toolCallParser: 'qwen3_coder',
    enableAutoToolChoice: true,
  });
  assert.deepEqual(argv, [
    'serve', 'Qwen/Qwen3.6-35B-A3B',
    '--host', '127.0.0.1',
    '--port', '8000',
    '--max-model-len', '131072',
    '--reasoning-parser', 'qwen3',
    '--tool-call-parser', 'qwen3_coder',
    '--enable-auto-tool-choice',
  ]);
});

test('buildVllmLaunchArgs appends well-formed extraArgs', () => {
  const argv = buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    extraArgs: ['--gpu-memory-utilization', '0.92'],
  });
  assert.deepEqual(argv.slice(-2), ['--gpu-memory-utilization', '0.92']);
});

test('buildVllmLaunchArgs rejects extraArgs that override the loopback host', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    extraArgs: ['--host', '0.0.0.0'],
  }), /host is managed/);
});

test('buildVllmLaunchArgs rejects non-string extraArgs entries', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    extraArgs: [42],
  }), /extraArgs entries must be strings/);
});

test('buildVllmLaunchArgs rejects extraArgs with newline', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    extraArgs: ['--evil\nflag'],
  }), /newline or NUL/);
});

test('buildVllmLaunchArgs rejects invalid parser names', () => {
  assert.throws(() => buildVllmLaunchArgs({
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8000,
    reasoningParser: 'bad name; rm -rf /',
  }), /reasoningParser/);
});

test('buildVllmLaunchArgs rejects missing model', () => {
  assert.throws(() => buildVllmLaunchArgs({ port: 8000 }), /model is required/);
});

test('VLLMProcessManager routes launchArgs through _spawnProcess', async () => {
  const captured = [];
  const fakeProcess = {
    pid: 9999,
    stderr: null,
    on() { /* noop */ },
    once() { /* noop */ },
    kill() { /* noop */ },
  };
  const manager = new VLLMProcessManager({
    logger: () => {},
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8077,
    launchArgs: {
      maxModelLen: 131072,
      reasoningParser: 'qwen3',
      toolCallParser: 'qwen3_coder',
      enableAutoToolChoice: true,
    },
  });
  manager._isRunning = async () => false;
  manager._resolveCommand = () => '/usr/bin/vllm';
  manager._waitForReady = async () => true;
  manager._spawnProcess = (command, argv) => {
    captured.push({ command, argv });
    return fakeProcess;
  };

  const result = await manager.start();

  assert.equal(result.started, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].command, '/usr/bin/vllm');
  assert.deepEqual(captured[0].argv, [
    'serve', 'Qwen/Qwen3.6-35B-A3B',
    '--host', '127.0.0.1',
    '--port', '8077',
    '--max-model-len', '131072',
    '--reasoning-parser', 'qwen3',
    '--tool-call-parser', 'qwen3_coder',
    '--enable-auto-tool-choice',
  ]);
});

// ── _readOwnedState: rejection cases ──────────────────────────────────────────

test('_readOwnedState returns null when stateStore has no data', () => {
  const store = makeStateStore(null);
  const manager = new VLLMProcessManager({ model: 'M', stateStore: store });
  const result = manager._readOwnedState();
  assert.equal(result, null);
  // read() was called once with null default
  assert.equal(store._calls.reads.length, 1);
  assert.equal(store._calls.reads[0], null);
});

test('_readOwnedState returns null when app_owned is not true', () => {
  const store = makeStateStore({ pid: 1234, app_owned: false, command: '/usr/bin/vllm', port: 8000, model: 'M' });
  const manager = new VLLMProcessManager({ model: 'M', stateStore: store });
  assert.equal(manager._readOwnedState(), null);
});

test('_readOwnedState returns null when pid is non-integer', () => {
  const store = makeStateStore({ pid: 'abc', app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'M' });
  const manager = new VLLMProcessManager({ model: 'M', stateStore: store });
  assert.equal(manager._readOwnedState(), null);
});

test('_readOwnedState returns null when pid is zero or negative', () => {
  const storeZero = makeStateStore({ pid: 0, app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'M' });
  const storeNeg = makeStateStore({ pid: -5, app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'M' });
  assert.equal(new VLLMProcessManager({ model: 'M', stateStore: storeZero })._readOwnedState(), null);
  assert.equal(new VLLMProcessManager({ model: 'M', stateStore: storeNeg })._readOwnedState(), null);
});

test('_readOwnedState returns structured object when state is valid', () => {
  const store = makeStateStore({ pid: 7777, app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'Qwen/Q', startedAt: '2026-01-01T00:00:00Z' });
  const manager = new VLLMProcessManager({ model: 'M', stateStore: store });
  const result = manager._readOwnedState();
  assert.equal(result.pid, 7777);
  assert.equal(result.app_owned, true);
  assert.equal(result.command, '/usr/bin/vllm');
  assert.equal(result.port, 8000);
  assert.equal(result.model, 'Qwen/Q');
});

// ── start() with stale OWNED state: process still alive ───────────────────────

test('start() kills stale owned process when still alive and matches vllm', async () => {
  const logs = [];
  const stalePid = 5050;
  const store = makeStateStore({ pid: stalePid, app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'OldM', startedAt: '2026-01-01T00:00:00Z' });
  const killCalls = [];
  const waitCalls = [];

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: '',
    stateStore: store,
    isProcessAliveImpl: (pid) => { return pid === stalePid; },
    pidMatchesVllmImpl: (pid) => { return pid === stalePid; },
    killProcessTreeImpl: async (pid, opts) => { killCalls.push({ pid, opts }); },
    waitForProcessExitImpl: async (pid, ms) => { waitCalls.push({ pid, ms }); return true; },
  });

  // After clearing stale state, _isRunning -> false, no model -> no_model path
  manager._isRunning = async () => false;

  await manager.start();

  // killProcessTreeImpl must have been called with the stale pid
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0].pid, stalePid);
  assert.deepEqual(killCalls[0].opts, { force: true });

  // waitForProcessExitImpl must have been called
  assert.equal(waitCalls.length, 1);
  assert.equal(waitCalls[0].pid, stalePid);

  // log must include killing_stale_owned_process
  assert.ok(logs.some((l) => l.event === 'vllm.killing_stale_owned_process' && l.details.pid === stalePid),
    'expected vllm.killing_stale_owned_process log');

  // stateStore.delete() must have been called to clear state
  assert.equal(store._calls.deletes.length, 1);
});

// ── start() with stale OWNED state: process is dead ──────────────────────────

test('start() clears stale state without killing when process is not alive', async () => {
  const logs = [];
  const stalePid = 6060;
  const store = makeStateStore({ pid: stalePid, app_owned: true, command: '/usr/bin/vllm', port: 8000, model: 'OldM', startedAt: '2026-01-01T00:00:00Z' });
  const killCalls = [];

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: '',
    stateStore: store,
    isProcessAliveImpl: () => false,   // process is dead
    pidMatchesVllmImpl: () => true,
    killProcessTreeImpl: async (pid, opts) => { killCalls.push({ pid, opts }); },
    waitForProcessExitImpl: async () => {},
  });

  manager._isRunning = async () => false;

  await manager.start();

  // Kill must NOT be called because process is not alive
  assert.equal(killCalls.length, 0);

  // stale_owned_process_state_cleared must be logged
  assert.ok(logs.some((l) => l.event === 'vllm.stale_owned_process_state_cleared' && l.details.pid === stalePid),
    'expected vllm.stale_owned_process_state_cleared log');

  // state must still be cleared
  assert.equal(store._calls.deletes.length, 1);
});

// ── full successful start(): stateStore.write recorded ───────────────────────

test('start() successful: stateStore.write called with correct shape, exit clears state', async () => {
  const logs = [];
  const store = makeStateStore(null);
  const fakeProc = makeFakeProc(41414);

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8100,
    stateStore: store,
    spawnImpl: () => fakeProc,
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => {},
  });

  manager._isRunning = async () => false;
  manager._resolveCommand = () => '/usr/bin/vllm';
  manager._waitForReady = async () => true;

  const result = await manager.start();

  assert.equal(result.started, true);
  assert.equal(result.external, false);

  // stateStore.write must have been called exactly once
  assert.equal(store._calls.writes.length, 1);
  const written = store._calls.writes[0];
  assert.equal(written.pid, 41414);
  assert.equal(written.app_owned, true);
  assert.equal(written.command, '/usr/bin/vllm');
  assert.equal(written.port, 8100);
  assert.equal(written.model, 'Qwen/Qwen3.6-35B-A3B');
  assert.ok(typeof written.startedAt === 'string' && written.startedAt.length > 0, 'startedAt must be set');

  // Emit exit from the process — _resetOwnership should call stateStore.delete
  fakeProc.emit('exit', 0, null);
  assert.equal(store._calls.deletes.length, 1, 'stateStore.delete must be called on exit');

  // vllm.started log must be present
  assert.ok(logs.some((l) => l.event === 'vllm.started'), 'expected vllm.started log');
});

// ── stderr tail truncation ────────────────────────────────────────────────────

test('start() truncates _stderrTail to <=2048 chars when chunk exceeds 4096', async () => {
  const store = makeStateStore(null);
  const fakeProc = makeFakeProc(55555);

  const manager = new VLLMProcessManager({
    logger: () => {},
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8200,
    stateStore: store,
    spawnImpl: () => fakeProc,
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => {},
  });

  manager._isRunning = async () => false;
  manager._resolveCommand = () => '/usr/bin/vllm';
  manager._waitForReady = async () => true;

  await manager.start();

  // Emit a chunk larger than 4096 characters on stderr
  const bigChunk = 'x'.repeat(5000);
  fakeProc.stderr.emit('data', bigChunk);

  // The tail must be truncated to at most 2048 characters
  assert.ok(manager._stderrTail.length <= 2048,
    `_stderrTail should be <=2048 chars, got ${manager._stderrTail.length}`);
  // And it must be the LAST 2048 chars of the big chunk (not empty)
  assert.equal(manager._stderrTail, bigChunk.slice(-2048));
});

// ── launch_args_invalid path ──────────────────────────────────────────────────

test('start() returns {started:false} and logs launch_args_invalid when extraArgs contains --host', async () => {
  const logs = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8300,
    launchArgs: { extraArgs: ['--host', '0.0.0.0'] },
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => {},
  });

  manager._isRunning = async () => false;
  manager._resolveCommand = () => '/usr/bin/vllm';

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, false);
  const invalidLog = logs.find((l) => l.event === 'vllm.launch_args_invalid');
  assert.ok(invalidLog, 'expected vllm.launch_args_invalid log');
  assert.ok(typeof invalidLog.details.message === 'string' && invalidLog.details.message.length > 0,
    'message in log must be non-empty string');
});

// ── stop(): owned proc -> SIGTERM -> exit -> logs vllm.stopped ────────────────

test('stop() sends SIGTERM, confirms the exit, and only THEN clears the owned record', async () => {
  const logs = [];
  const fakeProc = makeFakeProc(77777);
  const store = makeStateStore({ pid: 77777, app_owned: true, command: 'vllm' });

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8400,
    spawnImpl: () => fakeProc,
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => true,
    stateStore: store,
  });

  // Manually wire up an owned process (simulates a post-start state)
  manager._process = fakeProc;
  manager._ownedProcess = true;
  manager._ownedPid = fakeProc.pid;

  await manager.stop();

  // kill('SIGTERM') must have been called
  assert.ok(Array.isArray(fakeProc._killCalls) && fakeProc._killCalls.length >= 1,
    'kill() must be called at least once');
  assert.equal(fakeProc._killCalls[0], 'SIGTERM');

  const stopped = logs.find((l) => l.event === 'vllm.stopped');
  assert.ok(stopped, 'expected vllm.stopped log');
  assert.equal(stopped.level, 'INFO');
  assert.equal(stopped.details.confirmed, true);

  // vllm.stopping must have been logged with the right pid
  assert.ok(logs.some((l) => l.event === 'vllm.stopping' && l.details.pid === 77777),
    'expected vllm.stopping log with pid=77777');

  // After stop, manager must no longer own the process
  assert.equal(manager._ownedProcess, false);
  assert.equal(manager._process, null);
  assert.ok(store._calls.deletes.length >= 1, 'owned-state record must be cleared on a confirmed exit');
});

// ── _pidMatchesVllm via injected pidMatchesVllmImpl ──────────────────────────

test('_pidMatchesVllm delegates to injected pidMatchesVllmImpl returning true', () => {
  const calls = [];
  const manager = new VLLMProcessManager({
    model: 'M',
    platform: 'linux',
    pidMatchesVllmImpl: (pid, opts) => { calls.push({ pid, opts }); return true; },
  });

  const result = manager._pidMatchesVllm(9999);

  assert.equal(result, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, 9999);
  // opts must carry the manager's platform through verbatim (pins both presence and value).
  assert.equal(calls[0].opts.platform, 'linux');
});

test('_pidMatchesVllm delegates to injected pidMatchesVllmImpl returning false', () => {
  const calls = [];
  const manager = new VLLMProcessManager({
    model: 'M',
    pidMatchesVllmImpl: (pid) => { calls.push(pid); return false; },
  });

  const result = manager._pidMatchesVllm(1234);

  assert.equal(result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], 1234);
});

// ── start() -> _waitForReady returns false -> startup_timeout ────────────────

test('start() returns {started:false} and logs vllm.startup_timeout when _waitForReady fails', async () => {
  const logs = [];
  const store = makeStateStore(null);
  const fakeProc = makeFakeProc(88888);

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'Qwen/Qwen3.6-35B-A3B',
    port: 8500,
    stateStore: store,
    spawnImpl: () => fakeProc,
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => {},
    waitForProcessExitImpl: async () => {},
  });

  manager._isRunning = async () => false;
  manager._resolveCommand = () => '/usr/bin/vllm';
  manager._waitForReady = async () => false;

  const result = await manager.start();

  assert.equal(result.started, false);
  assert.equal(result.external, false);
  assert.ok(logs.some((l) => l.event === 'vllm.startup_timeout'), 'expected vllm.startup_timeout log');
});

// ── setLaunchArgs ─────────────────────────────────────────────────────────────

test('setLaunchArgs replaces _launchArgs with a new object copy', () => {
  const manager = new VLLMProcessManager({ model: 'M', launchArgs: { maxModelLen: 8192 } });
  manager.setLaunchArgs({ reasoningParser: 'qwen3', maxModelLen: 131072 });
  assert.equal(manager._launchArgs.maxModelLen, 131072);
  assert.equal(manager._launchArgs.reasoningParser, 'qwen3');
  // original key not in new object
  assert.equal('enableAutoToolChoice' in manager._launchArgs, false);
});

test('setLaunchArgs with non-object resets to empty', () => {
  const manager = new VLLMProcessManager({ model: 'M', launchArgs: { maxModelLen: 8192 } });
  manager.setLaunchArgs(null);
  assert.deepEqual(manager._launchArgs, {});
});
