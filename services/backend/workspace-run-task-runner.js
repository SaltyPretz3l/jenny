'use strict';
// UIUX-014: the headless spawn primitive for the Workspace IDE "Run scripts"
// feature. Own isolated process per task (NOT the shared interactive
// workspace terminal session): main observes the real child-process 'close'
// event for completion, so there is no textual completion marker for a
// pathological script to spoof by printing it to stdout. Modeled on
// services/backend/workspace-test-runner-runner.js's runTestCommand, but
// (a) streams output live via onData instead of only a post-hoc tail and
// (b) spawns an explicit shell (PowerShell on win32, bash elsewhere, the
// family the IDE terminal uses) with the composed command as ONE argument, so
// the caller's existing single-quote injection-safe quoting (renderer-ide-run-
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

// `powershell -Command` reports a failing native command as exit 1; hand back its real code.
// The command stays one line of its own, so its quoting is untouched.
function shellScriptFor(platform, command) {
  if (platform !== 'win32') return command;
  return `$LASTEXITCODE = 0\n${command}\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }\nexit 0`;
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
  let terminationConfirmed = false;
  let killAttempt = null;
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
    child = spawnImpl(shell, [...shellArgs, shellScriptFor(platform, String(command || ''))], {
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

  // Once the shell has exited, Windows can hand its pid to an unrelated process:
  // `taskkill /T /F` would take that tree down and never confirm, leaving the
  // task owned for good. A POSIX group id stays reserved while the group has
  // members, so the group kill there still reaches only this task.
  const shellExited = () => typeof child.exitCode === 'number' || Boolean(child.signalCode);

  async function runTerminationAttempt() {
    let confirmed = false;
    if (platform === 'win32' && shellExited()) {
      confirmed = true;
    } else {
      try {
        confirmed = (await terminateTree(child))?.terminated === true;
      } catch (_error) {
        /* confirmed stays false */
      }
    }
    terminationConfirmed = confirmed;
    // Only the first attempt settles `done`; a retry just reports its outcome.
    finish({ status: 'killed', exitCode: null, signal: 'SIGTERM', terminationConfirmed: confirmed });
    return { terminated: confirmed };
  }

  // Every caller gets the REAL outcome: concurrent callers share the in-flight
  // attempt, and after an unconfirmed attempt the next call retries the tree
  // kill instead of reporting a success nobody observed.
  function kill() {
    if (terminationConfirmed || (settled && !terminationPending)) {
      return Promise.resolve({ terminated: true });
    }
    if (killAttempt) {
      return killAttempt;
    }
    terminationPending = true;
    const attempt = runTerminationAttempt();
    killAttempt = attempt;
    void attempt.then(() => {
      if (killAttempt === attempt) {
        killAttempt = null;
      }
    });
    return attempt;
  }

  return { done, kill };
}

module.exports = {
  startRunTask,
};
