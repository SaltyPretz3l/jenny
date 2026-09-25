'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { createContainedProcessRunner } = require('../services/backend/contained-process-runner');
const { encodeFrame } = require('../services/backend/sidecar-client-transport-codec');

function fakeHelper(onRequest) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    const marker = text.indexOf('\r\n\r\n');
    if (marker >= 0) onRequest(JSON.parse(text.slice(marker + 4)), child);
  });
  child.finish = (message, code = 0) => {
    child.stdout.write(encodeFrame(message).frame);
    child.close(code);
  };
  child.close = (code = 0) => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit('close', code, null));
  };
  return child;
}

function observableFakeHelper(onRequest) {
  const child = fakeHelper(onRequest);
  const end = child.stdin.end.bind(child.stdin);
  child.stdinEnded = false;
  child.killCalls = 0;
  child.stdin.end = (...args) => {
    child.stdinEnded = true;
    return end(...args);
  };
  child.kill = () => {
    child.killCalls += 1;
    return true;
  };
  return child;
}

function response(id, status, cleanup = 'confirmed') {
  return { jsonrpc: '2.0', api_version: '2026-08-17', id, result: {
    api_version: '2026-08-17', schema_version: 1, operation_id: 'operation-1',
    status, exit_code: status === 'passed' ? 0 : -1, duration_ms: 4,
    stdout_tail: 'ok\n', stderr_tail: '', cleanup: {
      cleanup,
      process_tree_terminated: cleanup === 'confirmed',
      output_readers_terminated: cleanup === 'confirmed',
      reason: cleanup === 'confirmed' ? null : 'cleanup_pending',
    },
  } };
}

function runner(spawnImpl, options = {}) {
  return createContainedProcessRunner({
    platform: 'win32',
    createOperationId: () => 'operation-1',
    launchSpecProvider: () => ({ hostMode: 'desktop', launchCommand: 'python',
      launchArgs: ['-m', 'sidecar'], cwd: 'C:\\app' }),
    spawnImpl,
    ...options,
  });
}

function realWindowsRunner() {
  const python = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
  return createContainedProcessRunner({
    platform: 'win32',
    launchSpecProvider: () => ({
      hostMode: 'desktop',
      launchCommand: python,
      launchArgs: ['-m', 'sidecar'],
      cwd: path.join(__dirname, '..'),
    }),
  });
}

function quoteCmd(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

function processIsLive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_error) {
    return false;
  }
}

test('the desktop helper launch appends only the private mode and requires helper exit proof', async () => {
  let launch = null;
  const result = await runner((command, args, options) => {
    launch = { command, args, options };
    return fakeHelper((request, child) => {
      if (request.method === 'workspace_test.run') {
        child.stdout.write(encodeFrame(response(request.id, 'passed')).frame);
      } else if (request.method === 'workspace_test.close') child.close();
    });
  }).runShell({ command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000 });

  assert.equal(result.status, 'passed');
  assert.equal(result.terminationConfirmed, true);
  assert.deepEqual(launch.args, ['-m', 'sidecar', '--workspace-test-runner-helper']);
  assert.equal(launch.options.cwd, 'C:\\app');
  assert.equal(launch.options.windowsHide, true);
});

test('request abort is forwarded while the contained producer is running', async () => {
  const controller = new AbortController();
  let sawCancel = false;
  const pending = runner(() => fakeHelper((request, child) => {
    if (request.method === 'workspace_test.cancel') {
      sawCancel = true;
      child.stdout.write(encodeFrame(response('operation-1', 'aborted')).frame);
    } else if (request.method === 'workspace_test.close') {
      child.close();
    }
  })).runShell({ command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000,
    abortSignal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(sawCancel, true);
  assert.equal(result.status, 'aborted');
  assert.equal(result.terminationConfirmed, true);
});

test('uncertain target cleanup retains the helper for an exact retry', async () => {
  let cleanupRequests = 0;
  const contained = runner(() => fakeHelper((request, child) => {
    if (request.method === 'workspace_test.run') {
      child.stdout.write(encodeFrame(response(request.id, 'passed', 'uncertain')).frame);
    } else if (request.method === 'workspace_test.cleanup') {
      cleanupRequests += 1;
      child.stdout.write(encodeFrame({ jsonrpc: '2.0', api_version: '2026-08-17', id: request.id,
        result: { api_version: '2026-08-17', schema_version: 1,
          operation_id: 'operation-1', cleanup: response('', '', 'confirmed').result.cleanup } }).frame);
    } else if (request.method === 'workspace_test.close') {
      child.close();
    }
  }));
  const result = await contained.runShell({ command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000 });
  assert.equal(result.terminationConfirmed, false);
  assert.equal(typeof result.retryTermination, 'function');
  assert.deepEqual(await result.retryTermination(), { confirmed: true, warning: '' });
  assert.equal(cleanupRequests, 1);
});

test('hosted and non-Windows callers cannot acquire the private helper', async () => {
  for (const spec of [
    { platform: 'linux', hostMode: 'desktop' },
    { platform: 'win32', hostMode: 'server' },
  ]) {
    const contained = createContainedProcessRunner({ platform: spec.platform,
      launchSpecProvider: () => ({ ...spec, launchCommand: 'python', launchArgs: [], cwd: 'C:\\app' }) });
    await assert.rejects(contained.runShell({ command: 'npm test', cwd: '/work', timeoutMs: 1000 }),
      /unavailable/);
  }
});

test('unknown helper response identities fail closed without unbounded caching', async () => {
  let childRef;
  const result = await runner(() => {
    childRef = observableFakeHelper((request, child) => {
      if (request.method === 'workspace_test.run') {
        child.stdout.write(encodeFrame(response('unknown-operation', 'passed')).frame);
      }
    });
    return childRef;
  }, { helperExitTimeoutMs: 5 }).runShell({
    command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.terminationWarning, 'contained_helper_lost');
  assert.equal(childRef.stdinEnded, true);
  assert.equal(typeof result.retryTermination, 'function');
  childRef.close();
  assert.deepEqual(await result.retryTermination(), { confirmed: true, warning: '' });
});

test('invalid helper result identities force termination and retain an exact retry', async () => {
  let childRef;
  const result = await runner(() => {
    childRef = observableFakeHelper((request, child) => {
      if (request.method === 'workspace_test.run') {
        const message = response(request.id, 'passed');
        message.result.operation_id = 'wrong-operation';
        child.stdout.write(encodeFrame(message).frame);
      }
    });
    return childRef;
  }, { helperExitTimeoutMs: 5 }).runShell({
    command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000,
  });
  assert.equal(result.status, 'error');
  assert.equal(result.terminationConfirmed, false);
  assert.equal(result.terminationWarning, 'contained_helper_invalid_result');
  assert.equal(childRef.stdinEnded, true);
  assert.equal(typeof result.retryTermination, 'function');
  childRef.close();
  assert.deepEqual(await result.retryTermination(), { confirmed: true, warning: '' });
});

test('a helper that never processes the run is cancelled on a bounded transport timeout', async () => {
  let childRef;
  let sawCancel = false;
  const contained = createContainedProcessRunner({
    platform: 'win32', transportGraceMs: 5, helperExitTimeoutMs: 5,
    createOperationId: () => 'operation-1',
    launchSpecProvider: () => ({ hostMode: 'desktop', launchCommand: 'python',
      launchArgs: ['-m', 'sidecar'], cwd: 'C:\\app' }),
    spawnImpl: () => {
      childRef = observableFakeHelper((request) => {
        if (request.method === 'workspace_test.cancel') sawCancel = true;
      });
      return childRef;
    },
  });
  const result = await contained.runShell({ command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1 });
  assert.equal(sawCancel, true);
  assert.equal(childRef.stdinEnded, true);
  assert.equal(childRef.killCalls, 1);
  assert.equal(result.terminationConfirmed, false);
  assert.equal(typeof result.retryTermination, 'function');
});

test('a valid result whose helper ignores close is force-terminated without cancellation', async () => {
  let childRef;
  let cancelRequests = 0;
  const result = await runner(() => {
    childRef = observableFakeHelper((request, child) => {
      if (request.method === 'workspace_test.run') {
        child.stdout.write(encodeFrame(response(request.id, 'passed')).frame);
      } else if (request.method === 'workspace_test.cancel') {
        cancelRequests += 1;
      }
    });
    childRef.kill = () => {
      childRef.killCalls += 1;
      childRef.close();
      return true;
    };
    return childRef;
  }, { helperExitTimeoutMs: 5 }).runShell({
    command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000,
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.terminationConfirmed, true);
  assert.equal(childRef.killCalls, 1);
  assert.equal(cancelRequests, 0);
});

test('confirmed cleanup is retained when helper exit needs a later exact retry', async () => {
  let cleanupRequests = 0;
  let childRef;
  const contained = createContainedProcessRunner({
    platform: 'win32', helperExitTimeoutMs: 5, createOperationId: () => 'operation-1',
    launchSpecProvider: () => ({ hostMode: 'desktop', launchCommand: 'python',
      launchArgs: ['-m', 'sidecar'], cwd: 'C:\\app' }),
    spawnImpl: () => {
      childRef = fakeHelper((request, child) => {
        if (request.method === 'workspace_test.run') {
          child.stdout.write(encodeFrame(response(request.id, 'passed', 'uncertain')).frame);
        } else if (request.method === 'workspace_test.cleanup') {
          cleanupRequests += 1;
          child.stdout.write(encodeFrame({ jsonrpc: '2.0', api_version: '2026-08-17', id: request.id,
            result: { api_version: '2026-08-17', schema_version: 1,
              operation_id: 'operation-1', cleanup: response('', '', 'confirmed').result.cleanup } }).frame);
        }
      });
      return childRef;
    },
  });
  const result = await contained.runShell({ command: 'npm test', cwd: 'C:\\workspace', timeoutMs: 1000 });
  assert.deepEqual(await result.retryTermination(), {
    confirmed: false, warning: 'contained_helper_exit_unconfirmed',
  });
  childRef.close();
  assert.deepEqual(await result.retryTermination(), { confirmed: true, warning: '' });
  assert.equal(cleanupRequests, 1);
});

test('the real Windows helper preserves output and nonzero exit through the production transport',
  { skip: process.platform !== 'win32' }, async () => {
    const python = path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe');
    assert.equal(fs.existsSync(python), true, 'the worktree Python launch spec must exist');
    const result = await realWindowsRunner().runShell({
      command: 'echo actual-helper-output& echo actual-helper-error 1>&2& exit /b 7',
      cwd: path.join(__dirname, '..'),
      timeoutMs: 5000,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 7);
    assert.match(result.stdoutTail, /actual-helper-output/);
    assert.match(result.stderrTail, /actual-helper-error/);
    assert.equal(result.terminationConfirmed, true);
  });

test('the real Windows helper cancellation confirms Job cleanup of an identified descendant',
  { skip: process.platform !== 'win32' }, async (t) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-contained-helper-'));
    assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
    const childScript = path.join(tempRoot, 'owned-descendant.js');
    const pidFile = path.join(tempRoot, 'descendant.pid');
    fs.writeFileSync(childScript, [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'],",
      "  { detached: true, stdio: 'ignore' });",
      "fs.writeFileSync(process.argv[2], String(child.pid));",
      "setInterval(() => {}, 1000);",
    ].join('\n'));
    let descendantPid = null;
    t.after(() => {
      if (descendantPid && processIsLive(descendantPid)) process.kill(descendantPid, 'SIGKILL');
      fs.rmSync(tempRoot, { recursive: true, force: true });
    });

    const controller = new AbortController();
    const pending = realWindowsRunner().runShell({
      command: `${quoteCmd(process.execPath)} ${quoteCmd(childScript)} ${quoteCmd(pidFile)}`,
      cwd: tempRoot,
      timeoutMs: 10_000,
      abortSignal: controller.signal,
    });
    assert.equal(await waitFor(() => fs.existsSync(pidFile)), true,
      'the contained target must identify its descendant before cancellation');
    descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(Number.isInteger(descendantPid) && descendantPid > 0, true);
    assert.equal(processIsLive(descendantPid), true);
    controller.abort();

    const result = await pending;
    assert.equal(result.status, 'aborted');
    assert.equal(result.terminationConfirmed, true);
    assert.equal(await waitFor(() => !processIsLive(descendantPid)), true,
      'the positively identified descendant must be gone when cleanup is confirmed');
  });
