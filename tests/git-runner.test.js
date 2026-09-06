'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { runGit, runGitStreamed, buildPluginFetchProfile } = require('../services/git-runner');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// A fake execFile that records the (file, args, options) it was called with and
// resolves a scripted (error, stdout, stderr) via the node-style callback.
function fakeExec({ error = null, stdout = '', stderr = '' } = {}) {
  const calls = [];
  const impl = (file, args, options, callback) => {
    calls.push({ file, args, options });
    callback(error, stdout, stderr);
  };
  return { impl, calls };
}

function fakeSpawnChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('runGit — options & env wiring (injected exec)', () => {
  test('forwards argv + spawn options and inherits env when scrubEnv is false', async () => {
    const { impl, calls } = fakeExec({ stdout: 'ok' });
    const result = await runGit('/tmp/work', ['status', '--porcelain'], {
      timeoutMs: 1234,
      maxBuffer: 4096,
      execFileImpl: impl,
    });

    assert.equal(calls.length, 1);
    const { file, args, options } = calls[0];
    assert.equal(file, 'git');
    assert.deepEqual(args, ['status', '--porcelain']);
    assert.equal(options.cwd, '/tmp/work');
    assert.equal(options.windowsHide, true);
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'timeout'), false);
    assert.equal(options.maxBuffer, 4096);
    assert.equal(options.encoding, 'utf8');
    assert.equal(options.signal, undefined);
    assert.equal(options.detached, process.platform !== 'win32');
    // scrubEnv:false → no env override (child inherits process.env).
    assert.equal(Object.prototype.hasOwnProperty.call(options, 'env'), false);

    assert.deepEqual(result, {
      success: true, reason: '', stdout: 'ok', stderr: '', message: '',
    });
  });

  test('scrubEnv drops JENNY_*, credentials and dangerous GIT_* vars, pins C locale, keeps PATH', async () => {
    const restore = {
      JENNY_TEST_SECRET: process.env.JENNY_TEST_SECRET,
      MY_API_KEY: process.env.MY_API_KEY,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_ASKPASS: process.env.GIT_ASKPASS,
    };
    process.env.JENNY_TEST_SECRET = 'flag-value';
    process.env.MY_API_KEY = 'sk-shouldnotleak';
    process.env.GIT_EXTERNAL_DIFF = 'C:/evil.exe';
    process.env.GIT_ASKPASS = 'C:/evil-askpass.exe';
    try {
      const { impl, calls } = fakeExec({ stdout: '' });
      await runGit('/tmp/work', ['rev-parse', 'HEAD'], { scrubEnv: true, execFileImpl: impl });
      const { env } = calls[0].options;
      assert.ok(env && typeof env === 'object', 'env override present');
      assert.equal('JENNY_TEST_SECRET' in env, false, 'JENNY_* dropped');
      assert.equal('MY_API_KEY' in env, false, 'credential key dropped');
      assert.equal('GIT_EXTERNAL_DIFF' in env, false, 'GIT_EXTERNAL_DIFF dropped (code-exec vector)');
      assert.equal('GIT_ASKPASS' in env, false, 'GIT_ASKPASS dropped');
      assert.equal(env.LC_ALL, 'C', 'C locale pinned');
      assert.equal(env.LANG, 'C', 'LANG pinned');
      assert.ok('PATH' in env || 'Path' in env, 'PATH preserved');
      // WIDE-028 (b): reads must never take the optional index lock - the IDE
      // watcher treats .git/index as a git-meta signal, and a status re-pull
      // that rewrote the index would feed the watcher its own echo in a loop.
      assert.equal(env.GIT_OPTIONAL_LOCKS, '0', 'optional index locks disabled');
    } finally {
      for (const [key, value] of Object.entries(restore)) {
        if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
      }
    }
  });
});

describe('runGit — result classification (injected exec)', () => {
  test('git failure → structured git_failed with single-line clipped message', async () => {
    const { impl } = fakeExec({
      error: Object.assign(new Error('spawn failed'), { code: 128 }),
      stdout: '',
      stderr: 'fatal: not a git repository\n(line two)\n',
    });
    const result = await runGit('/tmp', ['status'], { execFileImpl: impl });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'git_failed');
    assert.equal(/[\r\n]/.test(result.message), false, 'message is single-line');
    assert.match(result.message, /not a git repository/);
    assert.equal(typeof result.stdout, 'string');
    assert.equal(typeof result.stderr, 'string');
  });

  test('long failure output is clipped to maxMessageChars with an ellipsis', async () => {
    const { impl } = fakeExec({
      error: new Error('boom'),
      stderr: 'x'.repeat(500),
    });
    const result = await runGit('/tmp', ['status'], { maxMessageChars: 20, execFileImpl: impl });
    assert.ok(result.message.length <= 20, `message length ${result.message.length} <= 20`);
    assert.ok(result.message.endsWith('...'), 'clipped with ellipsis');
  });

  test('AbortError from exec is classified as aborted', async () => {
    const { impl } = fakeExec({ error: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }) });
    const result = await runGit('/tmp', ['status'], { execFileImpl: impl });
    assert.equal(result.success, false);
    assert.equal(result.reason, 'aborted');
  });

  test('already-aborted signal short-circuits without spawning', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fakeExec({ stdout: 'should not run' });
    const result = await runGit('/tmp', ['status'], { signal: controller.signal, execFileImpl: impl });
    assert.equal(calls.length, 0, 'exec never invoked');
    assert.deepEqual(result, {
      success: false, reason: 'aborted', stdout: '', stderr: '', message: 'Git command aborted.',
    });
  });

  test('timeout tears down the detached process group before resolving', async () => {
    const killCalls = [];
    let fireTimeout;
    let execOptions;
    const resultPromise = runGit('/tmp', ['status'], {
      timeoutMs: 1234,
      platform: 'linux',
      execFileImpl: (_file, _args, options, _callback) => {
        execOptions = options;
        return { pid: 4321, exitCode: null, signalCode: null };
      },
      killProcessTreeImpl: async (pid, options) => {
        killCalls.push({ pid, options });
        return { terminated: true };
      },
      setTimeoutImpl: (callback, delay) => {
        assert.equal(delay, 1234);
        fireTimeout = callback;
        return { unref() {} };
      },
      clearTimeoutImpl() {},
    });

    assert.equal(execOptions.detached, true);
    fireTimeout();
    const result = await resultPromise;
    assert.deepEqual(result, {
      success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'Git command timed out.',
      terminationConfirmed: true,
    });
    assert.deepEqual(killCalls, [{
      pid: 4321,
      options: {
        force: true, processGroup: true, confirmExit: true, timeoutMs: 4000, platform: 'linux',
      },
    }]);
  });
});

describe('runGit — real git subprocess', () => {
  test('git --version succeeds end-to-end', async () => {
    const dir = createTrackedTempDir('jenny-git-runner-version-');
    const result = await runGit(dir, ['--version']);
    assert.equal(result.success, true);
    assert.equal(result.reason, '');
    assert.match(result.stdout, /git version/i);
    assert.equal(result.message, '');
  });

  test('a non-repo failure surfaces as git_failed (not a throw)', async () => {
    const dir = createTrackedTempDir('jenny-git-runner-norepo-');
    const result = await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    // Outside a repo, rev-parse exits non-zero; runGit must resolve, never reject.
    assert.equal(result.success, false);
    assert.equal(result.reason, 'git_failed');
  });
});

test('wide-037: streamed git output retains a bounded prefix and reports dropped bytes', async () => {
  const child = fakeSpawnChild();
  const pending = runGitStreamed('/tmp', ['status'], {
    maxOutputBytes: 16,
    spawnImpl: () => child,
  });
  child.stdout.emit('data', Buffer.from('a'.repeat(40)));
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(Buffer.byteLength(result.stdout), 16);
  assert.equal(result.truncated, true);
  assert.equal(result.droppedBytes, 24);
});

test('wide-037: stdout and stderr share one aggregate output budget', async () => {
  const child = fakeSpawnChild();
  const pending = runGitStreamed('/tmp', ['status'], { maxOutputBytes: 16, spawnImpl: () => child });
  child.stdout.emit('data', Buffer.from('a'.repeat(10)));
  child.stderr.emit('data', Buffer.from('b'.repeat(10)));
  child.emit('close', 1);
  const result = await pending;
  assert.equal(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr), 16);
  assert.equal(result.stderr, 'b'.repeat(6));
  assert.equal(result.droppedBytes, 4);
});

test('wide-037: abort owns the detached process tree and waits for confirmed termination', async () => {
  const child = fakeSpawnChild();
  const controller = new AbortController();
  const killResult = deferred();
  const killCalls = [];
  let spawnOptions = null;
  let resolved = false;
  const pending = runGitStreamed('/tmp', ['status'], {
    signal: controller.signal,
    platform: 'linux',
    spawnImpl: (_command, _args, options) => { spawnOptions = options; return child; },
    killProcessTreeImpl: (pid, options) => {
      killCalls.push({ pid, options });
      return killResult.promise;
    },
  });
  pending.then(() => { resolved = true; });

  controller.abort();
  child.emit('close', 1); // a root close alone must not bypass tree confirmation
  await Promise.resolve();
  assert.equal(resolved, false, 'result remains pending while descendant termination is unconfirmed');
  assert.equal(spawnOptions.detached, true, 'POSIX git owns a process group');
  assert.equal(killCalls.length, 1);
  assert.equal(killCalls[0].pid, child.pid);
  assert.equal(killCalls[0].options.processGroup, true);
  assert.equal(killCalls[0].options.confirmExit, true);

  killResult.resolve({ terminated: true });
  const result = await pending;
  assert.equal(result.reason, 'aborted');
  assert.equal(result.terminationConfirmed, true);
  child.stdout.emit('data', Buffer.from('late output'));
  child.emit('close', 0);
  assert.equal(result.stdout, '', 'late events cannot mutate the settled result');
});

test('wide-037: timeout waits for the bounded tree-kill attempt and reports unconfirmed exit', async () => {
  const child = fakeSpawnChild();
  const killResult = deferred();
  let fireTimeout = null;
  let resolved = false;
  const pending = runGitStreamed('/tmp', ['status'], {
    platform: 'win32',
    spawnImpl: () => child,
    killProcessTreeImpl: () => killResult.promise,
    setTimeoutImpl: (callback) => {
      fireTimeout = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {},
  });
  pending.then(() => { resolved = true; });

  fireTimeout();
  child.emit('close', 1);
  await Promise.resolve();
  assert.equal(resolved, false, 'root close does not settle before the tree-kill attempt returns');
  killResult.resolve({ terminated: false });
  const result = await pending;
  assert.equal(result.reason, 'git_failed');
  assert.equal(result.terminationConfirmed, false);
  assert.match(result.message, /timed out/i);
  assert.match(result.message, /could not be confirmed/i);
});

test('wide-037: a synchronous injected close installs no timer or abort tail', async () => {
  const child = fakeSpawnChild();
  const baseOnce = child.once.bind(child);
  child.once = (event, listener) => {
    if (event === 'close') {
      listener(0);
      return child;
    }
    return baseOnce(event, listener);
  };
  let timerCalls = 0;
  let killCalls = 0;
  const controller = new AbortController();
  const result = await runGitStreamed('/tmp', ['status'], {
    signal: controller.signal,
    spawnImpl: () => child,
    killProcessTreeImpl: async () => { killCalls += 1; return { terminated: true }; },
    setTimeoutImpl: () => { timerCalls += 1; return { unref() {} }; },
  });
  controller.abort();
  assert.equal(result.success, true);
  assert.equal(timerCalls, 0, 'post-close timeout is never installed');
  assert.equal(killCalls, 0, 'post-close abort listener is never installed');
});

test('plugin fetch profile closes credentials, config, protocols, filters, hooks, and redirects', async () => {
  const inherited = { GIT_DIR: process.env.GIT_DIR, HTTPS_PROXY: process.env.HTTPS_PROXY };
  process.env.GIT_DIR = 'attacker.git'; process.env.HTTPS_PROXY = 'http://attacker.test:8080';
  try {
  const profile = buildPluginFetchProfile({ proxyUrl: 'http://127.0.0.1:4567', nullDevice: '/dev/null' });
  const args = profile.argsPrefix.join(' ');
  assert.match(args, /protocol\.allow=never/); assert.match(args, /protocol\.https\.allow=always/);
  assert.match(args, /credential\.helper=/); assert.match(args, /http\.followRedirects=false/);
  assert.match(args, /filter\.lfs\.process=/); assert.match(args, /core\.hooksPath=\/dev\/null/);
  assert.equal(profile.env.GIT_TERMINAL_PROMPT, '0'); assert.equal(profile.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(profile.env.GIT_DIR, undefined); assert.equal(profile.env.HTTPS_PROXY, undefined);
  } finally {
    if (inherited.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = inherited.GIT_DIR;
    if (inherited.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = inherited.HTTPS_PROXY;
  }
});

describe('runGit — termination liveness and receipts', () => {
  function pendingExec(child) {
    let execCallback = null;
    const impl = (_file, _args, _options, callback) => { execCallback = callback; return child; };
    return { impl, fire: (...args) => execCallback?.(...args) };
  }

  test('the timeout never kills the pid of a git that already exited', async () => {
    // git exited (code 0) but a descendant kept the pipes open, so exec's
    // callback never ran. Its pid may now belong to someone else.
    const child = { pid: 4321, exitCode: 0, signalCode: null };
    const { impl } = pendingExec(child);
    const killCalls = [];
    let fireTimeout;
    const pending = runGit('/tmp', ['commit', '-m', 'x'], {
      execFileImpl: impl,
      killProcessTreeImpl: async (pid) => { killCalls.push(pid); return { terminated: true }; },
      setTimeoutImpl: (callback) => { fireTimeout = callback; return { unref() {} }; },
      clearTimeoutImpl() {},
    });
    fireTimeout();
    const result = await pending;
    assert.deepEqual(killCalls, [], 'an exited child is never a kill target');
    assert.equal(result.success, false, 'output never arrived, so this is not a parseable success');
    assert.equal(result.reason, 'git_failed');
    assert.match(result.message, /already exited \(code 0\)/);
    assert.equal('terminationConfirmed' in result, false);
  });

  test('an unconfirmed tree kill is reported, not laundered into a clean timeout', async () => {
    const child = { pid: 4321, exitCode: null, signalCode: null };
    const { impl } = pendingExec(child);
    let fireTimeout;
    const pending = runGit('/tmp', ['status'], {
      execFileImpl: impl,
      killProcessTreeImpl: async () => ({ terminated: false }),
      setTimeoutImpl: (callback) => { fireTimeout = callback; return { unref() {} }; },
      clearTimeoutImpl() {},
    });
    fireTimeout();
    const result = await pending;
    assert.equal(result.reason, 'git_failed');
    assert.equal(result.terminationConfirmed, false);
    assert.match(result.message, /could not be confirmed/);
  });

  test('abort kills the process tree instead of signalling git alone', async () => {
    const child = { pid: 4321, exitCode: null, signalCode: null };
    const { impl, fire } = pendingExec(child);
    const controller = new AbortController();
    const killCalls = [];
    let cleared = 0;
    const pending = runGit('/tmp', ['status'], {
      signal: controller.signal,
      platform: 'linux',
      execFileImpl: impl,
      killProcessTreeImpl: async (pid, options) => { killCalls.push({ pid, options }); return { terminated: true }; },
      setTimeoutImpl: () => ({ unref() {} }),
      clearTimeoutImpl() { cleared += 1; },
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.reason, 'aborted');
    assert.equal(result.success, false);
    assert.equal(result.terminationConfirmed, true);
    assert.deepEqual(killCalls.map((call) => call.pid), [4321]);
    assert.equal(killCalls[0].options.processGroup, true);
    assert.equal(cleared, 1, 'the timeout is cleared once the abort settles');
    // exec's late callback (git killed) must not re-settle or throw.
    fire(Object.assign(new Error('killed'), { killed: true }), '', '');
  });
});
