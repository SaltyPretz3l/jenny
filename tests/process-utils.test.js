'use strict';

// Direct-import so the existence-gate static graph can reach this file.
// exports: wait, getFreePort, isPortOpen, waitForPortToClose, isProcessAlive,
//          getProcessCommandLine, killProcessTree, waitForProcessExit
const procUtils = require('../services/backend/process-utils');

const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// wait(ms)
// ---------------------------------------------------------------------------
describe('wait', () => {
  test('resolves after at least the requested number of milliseconds', async () => {
    const ms = 40;
    const before = Date.now();
    await procUtils.wait(ms);
    const elapsed = Date.now() - before;
    // Allow generous slack for slow CI: must be >= ms - 20ms but not an
    // unreasonable cliff. The key oracle is that it does NOT resolve instantly.
    assert.ok(
      elapsed >= ms - 20,
      `expected elapsed (${elapsed}ms) >= ${ms - 20}ms`
    );
  });

  test('resolves after 0 ms without blocking indefinitely', async () => {
    const before = Date.now();
    await procUtils.wait(0);
    const elapsed = Date.now() - before;
    // Genuine timing test (wait wraps setTimeout): the only honest oracle is that
    // it resolves without hanging. Keep a generous upper bound so a loaded/GC-
    // paused CI worker does not flake it; the lower bound (does not resolve
    // synchronously) is covered by the wait(40) test above.
    assert.ok(elapsed < 1000, `expected elapsed (${elapsed}ms) < 1000ms`);
  });
});

// ---------------------------------------------------------------------------
// getFreePort()
// ---------------------------------------------------------------------------
describe('getFreePort', () => {
  test('returns an integer port in the valid range', async () => {
    const port = await procUtils.getFreePort();
    assert.ok(Number.isInteger(port), `expected integer, got ${port}`);
    assert.ok(port > 0 && port <= 65535, `port ${port} out of range`);
  });

  test('returned port is actually bindable (not already taken)', async (t) => {
    const port = await procUtils.getFreePort();
    // Prove the port is free by binding a real server to it.
    const server = net.createServer();
    t.after(() => {
      if (server.listening) {
        server.close();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object', 'server.address() must be an object');
    assert.equal(addr.port, port, 'server must be listening on the port getFreePort returned');
  });
});

// ---------------------------------------------------------------------------
// isPortOpen(port)
// ---------------------------------------------------------------------------
describe('isPortOpen', () => {
  test('returns true when a server is listening on the port', async (t) => {
    const server = net.createServer();
    t.after(() => {
      if (server.listening) {
        server.close();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    const result = await procUtils.isPortOpen(port);
    assert.equal(result, true, `expected isPortOpen(${port}) === true with a live server`);
  });

  test('returns false for a port nothing is listening on', async () => {
    // getFreePort closes its temp server before resolving, so the port is closed.
    const port = await procUtils.getFreePort();
    // Brief wait to avoid OS race where the ephemeral port is still in TIME_WAIT.
    await procUtils.wait(50);
    const result = await procUtils.isPortOpen(port);
    assert.equal(result, false, `expected isPortOpen(${port}) === false for a closed port`);
  });

  test('returns false for a low port with nothing listening', async (t) => {
    // The old comment claimed port 1 "is privileged and will always refuse a
    // connection in test envs". That is a POSIX fact, not a Windows one: Windows
    // does not reserve ports below 1024, and an unprivileged process binds
    // 127.0.0.1:1 here successfully (measured). So prove the premise rather than
    // assume it -- take the port, release it, and only then probe.
    const probe = net.createServer();
    const bound = await new Promise((resolve) => {
      probe.once('error', () => resolve(false));
      probe.listen(1, '127.0.0.1', () => resolve(true));
    });
    if (!bound) {
      t.skip('port 1 is already in use on this host');
      return;
    }
    await new Promise((resolve) => probe.close(resolve));
    const result = await procUtils.isPortOpen(1);
    assert.equal(result, false, 'expected isPortOpen(1) === false');
  });
});

// ---------------------------------------------------------------------------
// waitForPortToClose(port)
// ---------------------------------------------------------------------------
describe('waitForPortToClose', () => {
  test('resolves true once the server is closed', async (t) => {
    const server = net.createServer();
    t.after(() => {
      if (server.listening) {
        server.close();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();

    // Confirm the port is open first.
    assert.equal(await procUtils.isPortOpen(port), true);

    // Close the server after a short delay so waitForPortToClose has to poll.
    setTimeout(() => {
      server.close();
    }, 100);

    const result = await procUtils.waitForPortToClose(port, '127.0.0.1', 3000);
    assert.equal(result, true, 'expected waitForPortToClose to return true after server closed');
  });

  test('returns false when port remains open until timeout', async (t) => {
    const server = net.createServer();
    t.after(() => {
      if (server.listening) {
        server.close();
      }
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();

    // Use a very short timeout so the test stays fast; the server stays open.
    const result = await procUtils.waitForPortToClose(port, '127.0.0.1', 350);
    assert.equal(result, false, 'expected waitForPortToClose to return false when port never closed');
  });
});

// ---------------------------------------------------------------------------
// isProcessAlive(pid)
// ---------------------------------------------------------------------------
describe('isProcessAlive', () => {
  test('returns true for the current process pid', () => {
    const result = procUtils.isProcessAlive(process.pid);
    assert.equal(result, true, `expected isProcessAlive(${process.pid}) === true`);
  });

  test('returns false for a pid that cannot exist (2^31-1)', () => {
    // PID 2147483647 is astronomically large and cannot exist on any real OS.
    const impossiblePid = 2147483647;
    const result = procUtils.isProcessAlive(impossiblePid);
    assert.equal(result, false, `expected isProcessAlive(${impossiblePid}) === false`);
  });

  test('returns false for zero', () => {
    // pid=0 means "broadcast to process group" on POSIX; guard validates <= 0.
    const result = procUtils.isProcessAlive(0);
    assert.equal(result, false, 'expected isProcessAlive(0) === false');
  });

  test('returns false for negative pid', () => {
    const result = procUtils.isProcessAlive(-1);
    assert.equal(result, false, 'expected isProcessAlive(-1) === false');
  });

  test('returns false for non-integer pid', () => {
    const result = procUtils.isProcessAlive(3.7);
    assert.equal(result, false, 'expected isProcessAlive(3.7) === false');
  });

  test('returns false for a real child that has already exited', async (t) => {
    // Spawn a short-lived child and wait for it to exit.
    const child = spawn(process.execPath, ['--eval', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    t.after(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
    });
    const childPid = child.pid;
    await new Promise((resolve) => child.once('exit', resolve));
    // Give the OS a moment to reap the process.
    await procUtils.wait(50);
    const result = procUtils.isProcessAlive(childPid);
    assert.equal(result, false, `expected isProcessAlive(${childPid}) === false after child exited`);
  });
});

// ---------------------------------------------------------------------------
// killProcessTree(pid) + waitForProcessExit(pid)
// ---------------------------------------------------------------------------
describe('killProcessTree + waitForProcessExit', () => {
  test('wide-016: detached POSIX children target the process group, Windows targets the pid', () => {
    assert.equal(typeof procUtils.resolveProcessTreeTarget, 'function');
    assert.equal(procUtils.resolveProcessTreeTarget(4242, { platform: 'linux', processGroup: true }), -4242);
    assert.equal(procUtils.resolveProcessTreeTarget(4242, { platform: 'darwin', processGroup: true }), -4242);
    assert.equal(procUtils.resolveProcessTreeTarget(4242, { platform: 'win32', processGroup: true }), 4242);
    assert.equal(procUtils.resolveProcessTreeTarget(4242, { platform: 'linux', processGroup: false }), 4242);
  });

  test('kills a live child process and waitForProcessExit returns true', async (t) => {
    // Spawn a process that sleeps long enough not to exit on its own.
    const child = spawn(process.execPath, ['--eval', 'setTimeout(() => {}, 60000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    t.after(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already dead
      }
    });
    // Wait for the child to start.
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const childPid = child.pid;
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'child must have a valid pid');
    assert.equal(procUtils.isProcessAlive(childPid), true, 'child should be alive before kill');

    await procUtils.killProcessTree(childPid, { force: true });
    const exited = await procUtils.waitForProcessExit(childPid, 5000);
    assert.equal(exited, true, 'expected waitForProcessExit to return true after killProcessTree');
    assert.equal(procUtils.isProcessAlive(childPid), false, 'child should be dead after kill');
  });

  test('wide-016: tree termination kills a real grandchild before it confirms', async (t) => {
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 60000)'], { stdio: 'ignore' });",
      "process.stdout.write(String(child.pid) + '\\n');",
      'setInterval(() => {}, 60000);',
    ].join('');
    const parent = spawn(process.execPath, ['--eval', parentScript], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let grandchildPid = 0;
    t.after(async () => {
      await procUtils.killProcessTree(parent.pid, {
        force: true,
        processGroup: process.platform !== 'win32',
      }).catch(() => {});
      if (grandchildPid) {
        await procUtils.killProcessTree(grandchildPid, { force: true }).catch(() => {});
      }
    });
    const line = await new Promise((resolve, reject) => {
      let output = '';
      parent.once('error', reject);
      parent.stdout.on('data', (chunk) => {
        output += String(chunk);
        const newline = output.indexOf('\n');
        if (newline !== -1) resolve(output.slice(0, newline));
      });
    });
    grandchildPid = Number(line);
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0);
    assert.equal(procUtils.isProcessAlive(parent.pid), true);
    assert.equal(procUtils.isProcessAlive(grandchildPid), true);

    const outcome = await procUtils.killProcessTree(parent.pid, {
      force: true,
      processGroup: process.platform !== 'win32',
      confirmExit: true,
      timeoutMs: 5000,
    });
    assert.equal(outcome.terminated, true, 'tree owner confirms the group leader exited');
    assert.equal(await procUtils.waitForProcessExit(grandchildPid, 5000), true,
      'the descendant is dead before termination is reported');
  });

  test('wide-016: a hung Windows taskkill helper is bounded by the termination deadline', async () => {
    assert.equal(typeof procUtils.waitForChildExitBounded, 'function');
    const taskkill = new EventEmitter();
    taskkill.killCalls = 0;
    taskkill.kill = () => { taskkill.killCalls += 1; };
    let fireDeadline = null;
    let waitForTargetCalls = 0;
    const pending = procUtils.killProcessTree(2147483647, {
      platform: 'win32',
      force: true,
      confirmExit: true,
      timeoutMs: 25,
      spawnImpl: () => taskkill,
      waitForProcessExitImpl: async () => { waitForTargetCalls += 1; return true; },
      setTimeoutImpl: (callback) => { fireDeadline = callback; return 1; },
      clearTimeoutImpl: () => {},
    });
    await Promise.resolve();
    assert.equal(typeof fireDeadline, 'function');
    fireDeadline();
    assert.deepEqual(await pending, { terminated: false });
    assert.equal(taskkill.killCalls, 1, 'the stuck helper is best-effort terminated');
    assert.equal(waitForTargetCalls, 0, 'no second unbounded phase starts after the deadline');
  });

  test('waitForProcessExit returns true immediately for an already-dead pid', async () => {
    // Use a pid that does not exist.
    const impossiblePid = 2147483647;
    const result = await procUtils.waitForProcessExit(impossiblePid, 1000);
    assert.equal(result, true, 'expected waitForProcessExit(dead pid) === true immediately');
  });

  test('waitForProcessExit returns true for pid 0 / falsy without polling', async () => {
    const result = await procUtils.waitForProcessExit(0, 500);
    assert.equal(result, true, 'expected waitForProcessExit(0) === true (early guard)');
  });

  test('killProcessTree with no pid is a no-op (does not throw)', async () => {
    // pid = 0 is falsy; the function guards at the top and returns early.
    await assert.doesNotReject(
      async () => procUtils.killProcessTree(0),
      'expected killProcessTree(0) to resolve without throwing'
    );
    // Strong oracle: the early-return guard resolves to undefined (no kill attempted).
    const result = await procUtils.killProcessTree(0);
    assert.equal(result, undefined, 'expected killProcessTree(0) to resolve to undefined via the early-return guard');
  });
});

// ---------------------------------------------------------------------------
// getProcessCommandLine(pid)
// ---------------------------------------------------------------------------
describe('getProcessCommandLine', () => {
  test('returns empty string for pid 0 (guard path)', async () => {
    const result = await procUtils.getProcessCommandLine(0);
    assert.equal(result, '', 'expected empty string for pid 0');
  });

  test('returns empty string for negative pid (guard path)', async () => {
    const result = await procUtils.getProcessCommandLine(-5);
    assert.equal(result, '', 'expected empty string for negative pid');
  });

  test('returns empty string for a non-existent pid (best-effort lookup)', async () => {
    // An astronomically large pid cannot exist; the OS lookup returns nothing.
    const result = await procUtils.getProcessCommandLine(2147483647);
    // Must be a string (possibly empty or whitespace-trimmed).
    assert.equal(typeof result, 'string', 'expected a string');
    // For a non-existent pid the contract says to return '' — treat a blank
    // result as conformant.
    assert.equal(result.trim(), '', 'expected blank/empty for a non-existent pid');
  });

  test('returns a non-empty string for the current process pid', async () => {
    const result = await procUtils.getProcessCommandLine(process.pid);
    assert.equal(typeof result, 'string', 'expected a string');
    // The result must be non-empty; it contains the node executable path.
    assert.ok(result.length > 0, `expected non-empty command line for pid ${process.pid}, got: "${result}"`);
  });
});

describe('synchronous process identity helpers', () => {
  test('getProcessCommandLineSync uses a bounded platform query', () => {
    const calls = [];
    const result = procUtils.getProcessCommandLineSync(321, {
      platform: 'win32',
      spawnSyncImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return { status: 0, stdout: '"python"   -m sidecar\r\n' };
      },
      timeoutMs: 5_000,
    });

    assert.equal(result, '"python"   -m sidecar');
    assert.equal(calls[0].command, 'powershell.exe');
    assert.match(calls[0].args.at(-1), /ProcessId=321/);
    assert.equal(calls[0].options.timeout, 1000);
  });

  test('processCommandMatchesStored normalizes quoting, whitespace, and case', () => {
    assert.equal(
      procUtils.processCommandMatchesStored('"PYTHON"   -m sidecar --flag', 'python -m sidecar'),
      true,
    );
    assert.equal(
      procUtils.processCommandMatchesStored('C:\\Windows\\notepad.exe', 'python -m sidecar'),
      false,
    );
    assert.equal(procUtils.processCommandMatchesStored('python -m sidecar', ''), false);
  });
});
