'use strict';
// UIUX-014: the headless spawn primitive for the Workspace IDE "Run scripts"
// feature. Own isolated process per task (NOT the shared interactive
// workspace-terminal session): main observes the real child-process 'close'
// event for completion, so there is no textual completion marker for a
// pathological script to spoof by printing it to stdout. Modeled on
// services/backend/workspace-test-runner-runner.js's runTestCommand, but
// (a) streams output live via onData instead of only a post-hoc tail and
// (b) spawns an explicit shell (matching workspace-terminal-service.js's
// PowerShell/bash choice) with the composed command as ONE argument, so the
// caller's existing single-quote injection-safe quoting (renderer-ide-run-
// scripts.js quoteArg) keeps working unchanged — no shell:true re-wrapping.

const { spawn: defaultSpawn } = require('node:child_process');
const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');
const { killProcessTree: killProcessTreeByPid } = require('./process-utils');
const { RUN_TASK_ERROR_CODES } = require('./error-codes');

const JENNY_ENV_DENY = [/^JENNY_/i];
const DEFAULT_TERMINATION_TIMEOUT_MS = 4000;

function shellFor(platform) {
  return platform === 'win32'
    ? { shell: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-Command'] }
    : { shell: 'bash', args: ['-c'] };
}

/**
 * Spawn `command` through an explicit shell and stream its output. Returns
 * synchronously (spawn is fire-and-forget) so the caller can track/kill the
 * task before it settles.
 * @returns {{ done: Promise<object>, kill: () => Promise<{terminated:boolean}> }}
 */
function startRunTask({
  command,
  cwd,
  env = process.env,
  spawnImpl = defaultSpawn,
  onData = () => {},
  platform = process.platform,
  killProcessTree = null,
  terminationTimeoutMs = DEFAULT_TERMINATION_TIMEOUT_MS,
} = {}) {
  let settled = false;
  let terminationPending = false;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });

  function finish(payload) {
    if (settled) {
      return;
    }
    settled = true;
    resolveDone(payload);
  }

  const terminateTree = typeof killProcessTree === 'function'
    ? killProcessTree
    : async (ownedChild) => {
      const pid = ownedChild && ownedChild.pid;
      if (!pid) {
        return { terminated: true };
      }
      return killProcessTreeByPid(pid, {
        force: true,
        processGroup: platform !== 'win32',
        confirmExit: true,
        timeoutMs: terminationTimeoutMs,
        platform,
      });
    };

  const { shell, args: shellArgs } = shellFor(platform);
  let child;
  try {
    child = spawnImpl(shell, [...shellArgs, String(command || '')], {
      cwd,
      detached: platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv(env, { extraDeny: JENNY_ENV_DENY }),
    });
  } catch (_error) {
    finish({ status: 'error', exitCode: null, signal: null, errorCode: RUN_TASK_ERROR_CODES.SPAWN_FAILED });
    return { done, kill: async () => ({ terminated: true }) };
  }
  if (!child || typeof child.on !== 'function') {
    finish({ status: 'error', exitCode: null, signal: null, errorCode: RUN_TASK_ERROR_CODES.SPAWN_FAILED });
    return { done, kill: async () => ({ terminated: true }) };
  }

  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on?.('data', (chunk) => onData('stdout', String(chunk ?? '')));
  child.stderr?.on?.('data', (chunk) => onData('stderr', String(chunk ?? '')));
  child.on('error', () => {
    if (terminationPending) {
      return;
    }
    finish({ status: 'error', exitCode: null, signal: null, errorCode: RUN_TASK_ERROR_CODES.SPAWN_FAILED });
  });
  child.on('close', (exitCode, exitSignal) => {
    if (settled || terminationPending) {
      return;
    }
    // A null exit code (killed by an OS/crash signal, not a clean exit) is not
    // conflated with a real 0. typeof, not Number(): Number(null) === 0.
    const code = typeof exitCode === 'number' ? exitCode : null;
    finish({ status: 'exited', exitCode: code, signal: exitSignal || null });
  });

  async function kill() {
    if (settled) {
      return { terminated: true };
    }
    if (terminationPending) {
      await done;
      return { terminated: true };
    }
    terminationPending = true;
    let confirmed = false;
    try {
      confirmed = (await terminateTree(child))?.terminated === true;
    } catch (_error) {
      /* confirmed stays false */
    }
    finish({ status: 'killed', exitCode: null, signal: 'SIGTERM', terminationConfirmed: confirmed });
    return { terminated: confirmed };
  }

  return { done, kill };
}

module.exports = {
  startRunTask,
};
