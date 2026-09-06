'use strict';
// Backend composition-seam lane: the headless test-command spawn primitive for
// the Workspace IDE Test Runner. Own isolated process per run, run THROUGH a
// shell (so `npm test`/`pytest`/`&&`/venv work as typed) while still yielding a
// real exit code + AbortSignal + process-tree kill.
// Composed via the service; not a directly-importable product module.

const { spawn: defaultSpawn } = require('node:child_process');
const { sanitizeSpawnEnv, maskTokensInText } = require('./sanitize-spawn-env');
const { killProcessTree: killProcessTreeByPid } = require('./process-utils');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('./error-codes');
const { MAX_TEST_TIMEOUT_MS } = require('../workspace-test-runner-config');

const DEFAULT_OUTPUT_LIMIT = 12_000;
// Belt-and-braces: the user-config env is merged AFTER this sanitize pass, so an
// explicit user JENNY_* key still survives — this only strips inherited ones.
const JENNY_ENV_DENY = [/^JENNY_/i];

function isoNow(now) {
  const value = typeof now === 'function' ? now() : new Date();
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function appendTail(current, chunk, limit) {
  const next = `${current || ''}${String(chunk || '')}`;
  return next.length > limit ? next.slice(next.length - limit) : next;
}

function buildChildEnv(baseEnv, userEnv) {
  const merged = { ...sanitizeSpawnEnv(baseEnv || {}, { extraDeny: JENNY_ENV_DENY }) };
  if (userEnv && typeof userEnv === 'object' && !Array.isArray(userEnv)) {
    for (const key of Object.keys(userEnv)) {
      if (typeof userEnv[key] === 'string') {
        merged[key] = userEnv[key];
      }
    }
  }
  return merged;
}

/**
 * Run a single test command headlessly through a shell.
 * @returns {Promise<{status,exitCode,signal,errorCode?,durationMs,startedAt,finishedAt,stdoutTail,stderrTail}>}
 *   status ∈ {passed,failed,error,aborted,timeout}
 */
function runTestCommand({
  command,
  cwd,
  env = process.env,
  userEnv = {},
  spawn = defaultSpawn,
  abortSignal = null,
  now = () => new Date(),
  timeoutMs = 0,
  outputLimit = DEFAULT_OUTPUT_LIMIT,
  platform = process.platform,
  killProcessTree = null,
  terminationTimeoutMs = 4000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = isoNow(now);
    const startMs = Date.parse(startedAt);
    const cap = Math.max(Number(outputLimit) || DEFAULT_OUTPUT_LIMIT, 1);
    let stdoutTail = '';
    let stderrTail = '';
    let settled = false;
    let child = null;
    let timeoutHandle = null;
    let abortListener = null;
    let terminationPending = false;
    const terminateTree = typeof killProcessTree === 'function'
      ? killProcessTree
      : async (ownedChild) => {
        const pid = ownedChild && ownedChild.pid;
        if (!pid) return { terminated: true };
        return killProcessTreeByPid(pid, {
          force: true,
          processGroup: platform !== 'win32',
          confirmExit: true,
          timeoutMs: terminationTimeoutMs,
          platform,
        });
      };

    function finish(payload) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeoutImpl(timeoutHandle);
        timeoutHandle = null;
      }
      if (abortSignal && abortListener) {
        abortSignal.removeEventListener('abort', abortListener);
      }
      const finishedAt = isoNow(now);
      const result = {
        status: payload.status,
        exitCode: payload.exitCode ?? null,
        signal: payload.signal ?? null,
        durationMs: Math.max(0, Date.parse(finishedAt) - startMs),
        startedAt,
        finishedAt,
        stdoutTail: maskTokensInText(stdoutTail),
        stderrTail: maskTokensInText(stderrTail),
      };
      if (payload.errorCode) {
        result.errorCode = payload.errorCode;
      }
      if (typeof payload.terminationConfirmed === 'boolean') {
        result.terminationConfirmed = payload.terminationConfirmed;
      }
      if (payload.terminationWarning) {
        result.terminationWarning = payload.terminationWarning;
      }
      if (typeof payload.retryTermination === 'function') {
        result.retryTermination = payload.retryTermination;
      }
      resolve(result);
    }

    async function attemptTermination() {
      try {
        const outcome = await terminateTree(child);
        return { confirmed: outcome?.terminated === true };
      } catch (_error) {
        return { confirmed: false, warning: 'kill_failed' };
      }
    }

    function requestTermination(status) {
      if (settled || terminationPending) return;
      terminationPending = true;
      void attemptTermination().then((outcome) => {
        const confirmed = outcome.confirmed === true;
        finish({
          status,
          exitCode: null,
          signal: 'SIGTERM',
          terminationConfirmed: confirmed,
          terminationWarning: outcome.warning || (confirmed ? '' : 'kill_unconfirmed'),
          retryTermination: confirmed ? null : attemptTermination,
        });
      });
    }

    if (abortSignal && abortSignal.aborted) {
      finish({ status: 'aborted', exitCode: null, signal: 'SIGTERM' });
      return;
    }

    try {
      child = spawn(command, [], {
        cwd,
        env: buildChildEnv(env, userEnv),
        shell: true,
        windowsHide: true,
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (_error) {
      finish({
        status: 'error',
        exitCode: null,
        signal: null,
        errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED,
      });
      return;
    }

    const timeout = Number(timeoutMs);
    if (Number.isInteger(timeout) && timeout > 0) {
      const safeTimeout = Math.min(timeout, MAX_TEST_TIMEOUT_MS);
      timeoutHandle = setTimeoutImpl(() => {
        if (settled) {
          return;
        }
        requestTermination('timeout');
      }, safeTimeout);
      if (typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    }

    if (abortSignal) {
      abortListener = () => {
        if (settled) {
          return;
        }
        requestTermination('aborted');
      };
      abortSignal.addEventListener('abort', abortListener, { once: true });
    }

    child.stdout?.on?.('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, chunk, cap);
    });
    child.stderr?.on?.('data', (chunk) => {
      stderrTail = appendTail(stderrTail, chunk, cap);
    });
    child.once?.('error', () => {
      if (terminationPending) return;
      finish({
        status: 'error',
        exitCode: null,
        signal: null,
        errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED,
      });
    });
    child.once?.('close', (exitCode, exitSignal) => {
      if (settled || terminationPending) {
        return;
      }
      // A null exit code means the child was terminated by a signal (crash / OS
      // kill / OOM) rather than exiting cleanly — that is NOT a pass. Use typeof,
      // NOT Number(): `Number(null) === 0` would mis-map a signal-kill to 'passed'.
      // Only a real numeric 0 passes; a null code collapses to 'failed'.
      const code = typeof exitCode === 'number' ? exitCode : null;
      finish({
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code,
        signal: exitSignal || null,
      });
    });
  });
}

module.exports = {
  runTestCommand,
};
