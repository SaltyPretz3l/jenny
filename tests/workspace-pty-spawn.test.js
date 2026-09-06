'use strict';

/* Headless real-ConPTY smoke test: spawns an actual pty via @lydell/node-pty,
 * writes a command, and verifies output (including a VT escape sequence)
 * arrives on the pty's onData stream (not process stdout). Also exercises
 * resize + kill. This intentionally spawns a real shell process - it is a
 * smoke test for the native ConPTY binding, not a unit test with a fake.
 *
 * Known quirk: this package reports pty.pid === 0, so pid is never asserted
 * on - only onData output is used as evidence the process is alive. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pty = require('@lydell/node-pty');

const SETTLE_MS = 300;
const POLL_INTERVAL_MS = 100;
const POLL_DEADLINE_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate, { intervalMs = POLL_INTERVAL_MS, deadlineMs = POLL_DEADLINE_MS } = {}) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

function spawnShell() {
  try {
    return {
      proc: pty.spawn('powershell.exe', ['-NoProfile', '-NoLogo'], {
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      }),
      shell: 'powershell.exe',
    };
  } catch (err) {
    // Fixture branch: powershell.exe unavailable in this environment, fall
    // back to cmd.exe rather than skipping the test.
    return {
      proc: pty.spawn('cmd.exe', [], {
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
      }),
      shell: 'cmd.exe',
    };
  }
}

// spawnShell() only knows powershell.exe and cmd.exe, and ConPTY is the thing
// under test, so this has no meaning off Windows. ci-heavy's ubuntu-node-tests
// job runs `npm run test:safe`, which does not pass --parallel-only, so the
// stable-lane exclusion list does not keep this file out of it.
test('real ConPTY spawn: onData carries shell output with VT escapes', {
  skip: process.platform !== 'win32' ? 'ConPTY smoke: Windows only' : false,
}, async () => {
  const { proc } = spawnShell();
  let collected = '';
  const disposable = proc.onData((chunk) => {
    collected += chunk;
  });

  try {
    // Let the shell finish its startup banner/prompt before writing.
    await sleep(SETTLE_MS);

    proc.write('echo PTY_OK\r');

    const gotOutput = await pollUntil(() => collected.includes('PTY_OK'));
    assert.equal(gotOutput, true, `expected PTY_OK in collected output, got: ${JSON.stringify(collected.slice(-500))}`);
    // eslint-disable-next-line no-control-regex -- deliberately matching a raw VT escape byte from ConPTY output
    assert.match(collected, /\x1b\[/, 'expected at least one VT escape sequence in ConPTY output');

    proc.resize(120, 40);
    await sleep(SETTLE_MS);
  } finally {
    if (disposable && typeof disposable.dispose === 'function') {
      disposable.dispose();
    }
    proc.kill();
  }
});
