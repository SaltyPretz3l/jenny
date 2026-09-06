/**
 * Dark-path coverage for vllm-process-manager.js
 * Targets uncovered lines: 46-47, 62-63, 88-89, 197-198, 233-234,
 * 238-243, 326, 328-362, 368-383, 404-410
 *
 * Pattern: static import, hand-built fakes injected for ALL subprocess seams,
 * non-vacuous oracles only.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { VLLMProcessManager, buildVllmLaunchArgs } = require('../services/backend/vllm-process-manager');

// ── shared helpers ────────────────────────────────────────────────────────────

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
 * Minimal fake child process. kill() records signal; by default SIGTERM
 * schedules an 'exit' on next tick so the SIGKILL-timer is cleared.
 * Pass exitBehavior='none' to suppress the auto-exit (lets the SIGKILL timer fire).
 */
function makeFakeProc(pid, { exitBehavior = 'sigterm' } = {}) {
  const proc = new EventEmitter();
  proc.pid = pid || 12345;
  proc.stderr = new EventEmitter();
  proc._killCalls = [];
  proc.kill = function (signal) {
    this._killCalls.push(signal || 'SIGTERM');
    if (exitBehavior === 'sigterm' && (signal === 'SIGTERM' || signal == null)) {
      process.nextTick(() => { this.emit('exit', 0, null); });
    }
    if (exitBehavior === 'sigkill' && signal === 'SIGKILL') {
      process.nextTick(() => { this.emit('exit', null, 'SIGKILL'); });
    }
    // 'none' = never emit exit
  };
  return proc;
}

// ── buildVllmLaunchArgs: uncovered error branches ─────────────────────────────

// Lines 46-47: maxModelLen is a number but not a positive integer
test('buildVllmLaunchArgs throws when maxModelLen is a float', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', maxModelLen: 4096.5 }),
    (err) => {
      assert.ok(err instanceof Error, 'must throw Error');
      assert.match(err.message, /maxModelLen must be a positive integer/);
      assert.match(err.message, /4096\.5/);
      return true;
    },
  );
});

// Lines 46-47: maxModelLen is zero (not positive)
test('buildVllmLaunchArgs throws when maxModelLen is zero', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', maxModelLen: 0 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /maxModelLen must be a positive integer/);
      return true;
    },
  );
});

// Lines 46-47: maxModelLen is negative
test('buildVllmLaunchArgs throws when maxModelLen is negative', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', maxModelLen: -1 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /maxModelLen must be a positive integer/);
      return true;
    },
  );
});

// Lines 46-47: maxModelLen is NaN (Number('abc') === NaN)
test('buildVllmLaunchArgs throws when maxModelLen is a non-numeric string', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', maxModelLen: 'abc' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /maxModelLen must be a positive integer/);
      return true;
    },
  );
});

// Lines 62-63: toolCallParser with invalid characters
test('buildVllmLaunchArgs throws when toolCallParser contains spaces', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', toolCallParser: 'bad parser' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /toolCallParser has invalid characters/);
      assert.match(err.message, /bad parser/);
      return true;
    },
  );
});

// Lines 62-63: toolCallParser with semicolons (injection attempt)
test('buildVllmLaunchArgs throws when toolCallParser contains semicolon', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', toolCallParser: 'qwen3;evil' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /toolCallParser has invalid characters/);
      return true;
    },
  );
});

// Lines 88-89: extraArgs is a non-array, non-null, non-undefined value
test('buildVllmLaunchArgs throws when extraArgs is a plain string', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', extraArgs: '--sample-flag' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /extraArgs must be an array of strings/);
      return true;
    },
  );
});

// Lines 88-89: extraArgs is a number
test('buildVllmLaunchArgs throws when extraArgs is a number', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', extraArgs: 42 }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /extraArgs must be an array of strings/);
      return true;
    },
  );
});

// Lines 88-89: extraArgs is an object (not array)
test('buildVllmLaunchArgs throws when extraArgs is a plain object', () => {
  assert.throws(
    () => buildVllmLaunchArgs({ model: 'example-model', extraArgs: { flag: 'value' } }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /extraArgs must be an array of strings/);
      return true;
    },
  );
});

// ── start() process 'error' event -> vllm.spawn_error + _resetOwnership ───────
// Lines 197-198

test('start() process error event logs vllm.spawn_error and resets ownership', async (t) => {
  const logs = [];
  const store = makeStateStore(null);
  const fakeProc = makeFakeProc(31337, { exitBehavior: 'none' });

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'example-model',
    port: 8101,
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
  assert.equal(result.started, true, 'start() must succeed before the error event fires');

  // Now fire the 'error' event on the fake process
  const spawnError = new Error('dummy spawn failure');
  fakeProc.emit('error', spawnError);

  // vllm.spawn_error must be logged with the error message
  const errorLog = logs.find((l) => l.event === 'vllm.spawn_error');
  assert.ok(errorLog, 'vllm.spawn_error must be logged');
  assert.equal(errorLog.level, 'ERROR');
  assert.ok(
    typeof errorLog.details.message === 'string' && errorLog.details.message.includes('dummy spawn failure'),
    `details.message must contain 'dummy spawn failure', got: ${JSON.stringify(errorLog.details.message)}`,
  );

  // _resetOwnership must have been called: _process=null, _ownedProcess=false, _ownedPid=0
  assert.equal(manager._process, null, '_process must be null after error');
  assert.equal(manager._ownedProcess, false, '_ownedProcess must be false after error');
  assert.equal(manager._ownedPid, 0, '_ownedPid must be 0 after error');
  // stateStore.delete() must have been called
  assert.ok(store._calls.deletes.length >= 1, 'stateStore.delete must be called on error');
});

// ── stop() SIGKILL timeout branch ─────────────────────────────────────────────
// Lines 233-234 and 238-243: the timeout fires and sends SIGKILL

// F2d: the escalation after the SIGTERM grace period must go through the
// INJECTED process-TREE kill, not proc.kill('SIGKILL'). On win32 proc.kill()
// signals only the direct child, so the vLLM worker subprocesses were never in
// the kill set at all. The exit is then VERIFIED before the stop is claimed.
test('stop() escalates through _killProcessTree (not proc.kill) and verifies the exit', async () => {
  const logs = [];
  const store = makeStateStore({ pid: 22222, app_owned: true, command: 'vllm' });

  // exitBehavior='sigkill': proc would only exit on a direct SIGKILL, which the
  // new implementation never sends — the tree kill is what ends it.
  const fakeProc = makeFakeProc(22222, { exitBehavior: 'sigkill' });

  const treeKills = [];
  const waits = [];
  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'example-model',
    port: 8102,
    stateStore: store,
    spawnImpl: () => fakeProc,
    isProcessAliveImpl: () => false,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async (pid, options) => { treeKills.push({ pid, options }); },
    waitForProcessExitImpl: async (pid, timeoutMs) => {
      waits.push({ pid, timeoutMs });
      return true;
    },
  });

  // Wire up owned process state directly
  manager._process = fakeProc;
  manager._ownedProcess = true;
  manager._ownedPid = fakeProc.pid;

  // Collapse the real 5000ms grace period.
  const origSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn, _delay) => origSetTimeout(fn, 0);
    await manager.stop();
  } finally {
    global.setTimeout = origSetTimeout;
  }

  assert.deepEqual(fakeProc._killCalls, ['SIGTERM'],
    'only SIGTERM may be sent to the direct child; escalation goes through the tree kill');
  assert.deepEqual(treeKills, [{ pid: 22222, options: { force: true } }],
    'expected exactly one forced process-tree kill for the owned pid');
  assert.deepEqual(waits.map((entry) => entry.pid), [22222],
    'exit must be verified via waitForProcessExit before claiming a stop');

  const stopped = logs.find((l) => l.event === 'vllm.stopped');
  assert.ok(stopped, 'expected vllm.stopped log');
  assert.equal(stopped.level, 'INFO');
  assert.equal(stopped.details.confirmed, true);
  assert.ok(store._calls.deletes.length >= 1, 'confirmed exit must clear the owned record');
});

// ── stop() unconfirmed-exit branch ────────────────────────────────────────────
// F2d: this previously logged a flat INFO "vllm.stopped" AND cleared ownership
// BEFORE the kill was even attempted. Both were wrong: the record must survive
// an unconfirmed exit so the next launch's stale-state sweep can reap it.

test('stop() retains the owned record and WARNs when the exit is never confirmed', async () => {
  const logs = [];
  const store = makeStateStore({ pid: 33333, app_owned: true, command: 'vllm' });

  // This proc never emits exit, and throws on every kill (stuck process).
  const throwingProc = new EventEmitter();
  throwingProc.pid = 33333;
  throwingProc.stderr = new EventEmitter();
  throwingProc._killCalls = [];
  throwingProc.kill = function (signal) {
    this._killCalls.push(signal || 'SIGTERM');
    throw new Error('dummy: cannot kill process');
  };

  const manager = new VLLMProcessManager({
    logger: (level, event, details) => logs.push({ level, event, details }),
    model: 'example-model',
    port: 8103,
    stateStore: store,
    spawnImpl: () => throwingProc,
    isProcessAliveImpl: () => true,
    pidMatchesVllmImpl: () => false,
    killProcessTreeImpl: async () => { throw new Error('taskkill exploded'); },
    waitForProcessExitImpl: async () => false,
  });

  manager._process = throwingProc;
  manager._ownedProcess = true;
  manager._ownedPid = throwingProc.pid;

  const origSetTimeout = global.setTimeout;
  let stopped;
  try {
    global.setTimeout = (fn, _delay) => origSetTimeout(fn, 0);
    // Must resolve (not throw) even though every kill path throws.
    await manager.stop();
    stopped = true;
  } finally {
    global.setTimeout = origSetTimeout;
  }

  assert.equal(stopped, true, 'stop() must resolve without throwing even when the kills throw');
  const stoppedLog = logs.find((l) => l.event === 'vllm.stopped');
  assert.ok(stoppedLog, 'vllm.stopped must be logged');
  assert.equal(stoppedLog.level, 'WARN', 'an unconfirmed exit must not report a clean INFO stop');
  assert.equal(stoppedLog.details.confirmed, false);
  assert.equal(stoppedLog.details.retained, true);
  assert.deepEqual(store._calls.deletes, [],
    'the owned-state record must be RETAINED when the exit is unconfirmed');
  assert.deepEqual(store._stored(), { pid: 33333, app_owned: true, command: 'vllm' });
});

// ── _pidMatchesVllm: invalid pid -> false (line 326-328) ─────────────────────

test('_pidMatchesVllm returns false for non-integer pid when no impl injected', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    // no pidMatchesVllmImpl -> falls through to the local execFileSync path
  });

  // SAFETY + STRENGTH: patch execFileSync so (a) no REAL subprocess can ever
  // fire for these garbage pids, and (b) if the early-return guard (line 326-328)
  // is removed, the method would (i) call execFileSync — caught by callCount — and
  // (ii) match the injected 'vllm' output — caught by the false assertion flipping.
  // The guard MUST short-circuit before any subprocess seam is reached.
  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;
  const calls = [];
  try {
    childProcess.execFileSync = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      // Whatever pid was queried, pretend it IS a vllm process. This guarantees
      // that if the guard is gone, the result becomes `true` (RED), not false.
      return 'python -m vllm serve some-model\n';
    };

    // Zero: Number(0) is integer but not > 0
    const resultZero = manager._pidMatchesVllm(0);
    assert.equal(resultZero, false, 'pid=0 must return false');

    // Negative
    const resultNeg = manager._pidMatchesVllm(-1);
    assert.equal(resultNeg, false, 'pid=-1 must return false');

    // Non-numeric string
    const resultStr = manager._pidMatchesVllm('notapid');
    assert.equal(resultStr, false, 'pid=string must return false');

    // NaN
    const resultNaN = manager._pidMatchesVllm(NaN);
    assert.equal(resultNaN, false, 'pid=NaN must return false');

    // The guard must reject all four BEFORE reaching the subprocess seam.
    // If the guard is removed, this is non-zero (RED) — and proves no real
    // process is ever spawned for invalid pids in the unmutated code.
    assert.equal(
      calls.length,
      0,
      `invalid pids must never reach the subprocess seam; execFileSync was called with: ${JSON.stringify(calls)}`,
    );
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

// ── _pidMatchesVllm: non-win32 path via execFileSync mock ────────────────────
// Lines 353-359: the 'else' branch (non-win32) that runs `ps`

test('_pidMatchesVllm returns true on non-win32 when ps output contains vllm', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'linux',
    // No pidMatchesVllmImpl — use the fallback path
  });

  // We cannot inject execFileSync directly, so we exercise the method via
  // the pidMatchesVllmImpl seam, which is what the code defers to first.
  // To reach lines 328-362, pidMatchesVllmImpl must be null (or not injected).
  // On a Windows runner, the 'else' branch won't be taken. We test it by
  // temporarily patching child_process.execFileSync through the require cache.
  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  const calls = [];
  try {
    childProcess.execFileSync = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      // Simulate ps output containing 'vllm'
      return '/usr/bin/python -m vllm serve my-model\n';
    };

    const result = manager._pidMatchesVllm(9876);

    assert.equal(result, true, 'must return true when ps output contains vllm');
    assert.equal(calls.length, 1, 'execFileSync must be called exactly once');
    assert.equal(calls[0].cmd, 'ps', 'must call ps');
    assert.deepEqual(calls[0].args, ['-p', '9876', '-o', 'args='], 'must pass pid and args= format');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

test('_pidMatchesVllm returns false on non-win32 when ps output does not contain vllm', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'linux',
  });

  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  try {
    childProcess.execFileSync = () => '/usr/bin/python some-other-process\n';
    const result = manager._pidMatchesVllm(9876);
    assert.equal(result, false, 'must return false when ps output does not mention vllm');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

test('_pidMatchesVllm returns false on non-win32 when ps throws', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'linux',
  });

  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  try {
    childProcess.execFileSync = () => { throw new Error('dummy: ps not found'); };
    const result = manager._pidMatchesVllm(9876);
    assert.equal(result, false, 'must return false when execFileSync throws');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

// ── _pidMatchesVllm: win32 primary path (powershell) ─────────────────────────
// Lines 333-341

test('_pidMatchesVllm returns true on win32 when powershell output contains vllm', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'win32',
  });

  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  const calls = [];
  try {
    childProcess.execFileSync = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      return 'python.exe vllm serve example-model\r\n';
    };

    const result = manager._pidMatchesVllm(4321);

    assert.equal(result, true, 'must return true when powershell output contains vllm');
    assert.equal(calls.length, 1, 'powershell must be called once');
    assert.equal(calls[0].cmd, 'powershell', 'must call powershell first');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

// ── _pidMatchesVllm: win32 fallback path (wmic) ──────────────────────────────
// Lines 342-350: powershell throws, wmic succeeds

test('_pidMatchesVllm falls back to wmic when powershell throws and wmic returns vllm', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'win32',
  });

  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  const calls = [];
  try {
    childProcess.execFileSync = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'powershell') {
        throw new Error('dummy: powershell not available');
      }
      // wmic succeeds
      return 'CommandLine=python.exe vllm serve example-model\r\n';
    };

    const result = manager._pidMatchesVllm(5678);

    assert.equal(result, true, 'must return true when wmic output contains vllm');
    assert.equal(calls.length, 2, 'must try powershell then wmic');
    assert.equal(calls[0].cmd, 'powershell', 'first attempt must be powershell');
    assert.equal(calls[1].cmd, 'wmic', 'fallback must be wmic');
    // Verify the wmic args include the pid
    assert.ok(calls[1].args.some((a) => a.includes('5678')), 'wmic args must include the pid');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

// Lines 348-350: both powershell and wmic throw -> returns false

test('_pidMatchesVllm returns false on win32 when both powershell and wmic throw', () => {
  const manager = new VLLMProcessManager({
    model: 'example-model',
    platform: 'win32',
  });

  const childProcess = require('child_process');
  const origExecFileSync = childProcess.execFileSync;

  try {
    childProcess.execFileSync = (cmd) => {
      throw new Error(`dummy: ${cmd} not found`);
    };
    const result = manager._pidMatchesVllm(9999);
    assert.equal(result, false, 'must return false when both tools throw');
  } finally {
    childProcess.execFileSync = origExecFileSync;
  }
});

// ── _resolveCommand: lines 368-383 ───────────────────────────────────────────
// The real _resolveCommand uses execFile (async), memoizes in _resolveCommandPromise.
// We test it by patching child_process.execFile in the require cache.

test('_resolveCommand resolves to first line of stdout on success', async () => {
  const childProcess = require('child_process');
  const origExecFile = childProcess.execFile;

  const calls = [];
  try {
    childProcess.execFile = (cmd, args, _opts, cb) => {
      calls.push({ cmd, args });
      // Simulate `where vllm` returning a path
      process.nextTick(() => cb(null, 'C:\\Python\\Scripts\\vllm.exe\r\nC:\\Other\\vllm.exe\r\n', ''));
    };

    const manager = new VLLMProcessManager({ model: 'example-model' });
    const command = await manager._resolveCommand();

    assert.equal(command, 'C:\\Python\\Scripts\\vllm.exe', 'must return first non-empty line');
    assert.equal(calls.length, 1, 'execFile must be called exactly once');
    assert.equal(calls[0].args[0], 'vllm', 'must search for vllm');
  } finally {
    childProcess.execFile = origExecFile;
  }
});

test('_resolveCommand resolves to null when execFile errors', async () => {
  const childProcess = require('child_process');
  const origExecFile = childProcess.execFile;

  try {
    childProcess.execFile = (_cmd, _args, _opts, cb) => {
      process.nextTick(() => cb(new Error('dummy: not found'), '', ''));
    };

    const manager = new VLLMProcessManager({ model: 'example-model' });
    const command = await manager._resolveCommand();

    assert.equal(command, null, 'must return null when execFile errors');
  } finally {
    childProcess.execFile = origExecFile;
  }
});

test('_resolveCommand resolves to null when stdout is empty', async () => {
  const childProcess = require('child_process');
  const origExecFile = childProcess.execFile;

  try {
    childProcess.execFile = (_cmd, _args, _opts, cb) => {
      process.nextTick(() => cb(null, '\n\n', ''));
    };

    const manager = new VLLMProcessManager({ model: 'example-model' });
    const command = await manager._resolveCommand();

    assert.equal(command, null, 'must return null when stdout has no path');
  } finally {
    childProcess.execFile = origExecFile;
  }
});

test('_resolveCommand memoizes: execFile called only once on repeated calls', async () => {
  const childProcess = require('child_process');
  const origExecFile = childProcess.execFile;

  let callCount = 0;
  try {
    childProcess.execFile = (_cmd, _args, _opts, cb) => {
      callCount++;
      process.nextTick(() => cb(null, '/usr/bin/vllm\n', ''));
    };

    const manager = new VLLMProcessManager({ model: 'example-model' });
    const first = await manager._resolveCommand();
    const second = await manager._resolveCommand();
    const third = await manager._resolveCommand();

    assert.equal(first, '/usr/bin/vllm', 'first call must resolve correctly');
    assert.equal(second, '/usr/bin/vllm', 'second call must return same value');
    assert.equal(third, '/usr/bin/vllm', 'third call must return same value');
    assert.equal(callCount, 1, 'execFile must only be called once due to memoization');
  } finally {
    childProcess.execFile = origExecFile;
  }
});

// ── _waitForReady: lines 404-410 ─────────────────────────────────────────────
// The real _waitForReady polls _isRunning in a loop. We test it by overriding
// _isRunning and the STARTUP_POLL_MS delay (we replace the internal setTimeout).

test('_waitForReady returns true immediately when _isRunning returns true on first poll', async () => {
  const manager = new VLLMProcessManager({ model: 'example-model' });

  let isRunningCalls = 0;
  manager._isRunning = async () => {
    isRunningCalls++;
    return true;
  };

  const result = await manager._waitForReady();

  assert.equal(result, true, 'must return true when _isRunning is true');
  assert.equal(isRunningCalls, 1, '_isRunning must be called exactly once');
});

test('_waitForReady returns true after a failed first poll and successful second poll', async (t) => {
  const manager = new VLLMProcessManager({ model: 'example-model' });

  // Collapse the STARTUP_POLL_MS (2000ms) delay so the test runs fast
  const origSetTimeout = global.setTimeout;
  let isRunningCalls = 0;
  try {
    global.setTimeout = (fn, _delay) => origSetTimeout(fn, 0);

    manager._isRunning = async () => {
      isRunningCalls++;
      return isRunningCalls >= 2; // fails first, succeeds second
    };

    const result = await manager._waitForReady();

    assert.equal(result, true, 'must return true after second poll succeeds');
    assert.equal(isRunningCalls, 2, '_isRunning must be called twice');
  } finally {
    global.setTimeout = origSetTimeout;
  }
});

test('_waitForReady returns false after deadline passes', async () => {
  const manager = new VLLMProcessManager({ model: 'example-model' });

  // Simulate expired deadline by making Date.now() already past the deadline
  // _waitForReady does: const deadline = Date.now() + STARTUP_MAX_WAIT_MS; while (Date.now() < deadline)
  // We push Date.now() forward past the deadline after the first check.
  const origDateNow = Date.now;
  let callCount = 0;
  try {
    Date.now = () => {
      callCount++;
      if (callCount === 1) {
        // First call: sets the deadline — return a base time
        return 0;
      }
      // Subsequent calls: return past the deadline (STARTUP_MAX_WAIT_MS = 180000)
      return 200000;
    };

    manager._isRunning = async () => false;

    const result = await manager._waitForReady();

    assert.equal(result, false, 'must return false when deadline has passed');
  } finally {
    Date.now = origDateNow;
  }
});
