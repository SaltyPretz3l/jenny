'use strict';

const { randomUUID } = require('node:crypto');
const { spawn: defaultSpawn } = require('node:child_process');
const path = require('node:path');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('./error-codes');
const { maskTokensInText, sanitizeSpawnEnv } = require('./sanitize-spawn-env');
const { encodeFrame, parseContentLength } = require('./sidecar-client-transport-codec');

const API_VERSION = '2026-08-17';
const HELPER_FLAG = '--workspace-test-runner-helper';
const MAX_FRAME_BYTES = 1024 * 1024;
const HELPER_EXIT_TIMEOUT_MS = 5000;

function boundedWait(promise, timeoutMs = HELPER_EXIT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(finish, () => finish(null));
  });
}

function createFrameReader(onMessage, onError) {
  let buffered = Buffer.alloc(0);
  let expected = null;
  return (chunk) => {
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.length > MAX_FRAME_BYTES + 64 * 1024) return onError(new Error('Helper frame exceeds its bound.'));
    while (true) {
      if (expected === null) {
        const marker = buffered.indexOf('\r\n\r\n');
        if (marker < 0) return;
        expected = parseContentLength(buffered.subarray(0, marker).toString('utf8'));
        buffered = buffered.subarray(marker + 4);
        if (!expected || expected > MAX_FRAME_BYTES) return onError(new Error('Helper frame header is invalid.'));
      }
      if (buffered.length < expected) return;
      const body = buffered.subarray(0, expected);
      buffered = buffered.subarray(expected);
      expected = null;
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (error) {
        onError(error);
        return;
      }
    }
  };
}

function validLaunchSpec(spec, platform) {
  return platform === 'win32' && spec?.hostMode !== 'server'
    && typeof spec?.launchCommand === 'string' && !!spec.launchCommand.trim()
    && Array.isArray(spec.launchArgs) && spec.launchArgs.every((value) => typeof value === 'string')
    && typeof spec.cwd === 'string' && path.isAbsolute(spec.cwd);
}

function confirmedCleanup(value) {
  return value?.cleanup === 'confirmed'
    && value.process_tree_terminated === true
    && value.output_readers_terminated === true;
}

function createContainedProcessRunner({
  launchSpecProvider,
  spawnImpl = defaultSpawn,
  platform = process.platform,
  createOperationId = randomUUID,
  transportGraceMs = HELPER_EXIT_TIMEOUT_MS,
  helperExitTimeoutMs = HELPER_EXIT_TIMEOUT_MS,
} = {}) {
  async function runShell({
    command, cwd, userEnv = {}, timeoutMs, outputLimit = 12_000,
    abortSignal = null,
  } = {}) {
    if (abortSignal?.aborted) {
      return { status: 'aborted', exitCode: null, signal: 'SIGTERM', durationMs: 0,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        stdoutTail: '', stderrTail: '', terminationConfirmed: true };
    }
    const spec = typeof launchSpecProvider === 'function' ? launchSpecProvider() : null;
    if (!validLaunchSpec(spec, platform)) {
      throw new Error('Contained workspace test runner is unavailable.');
    }
    const operationId = String(createOperationId());
    const startedAt = new Date().toISOString();
    let child;
    try {
      child = spawnImpl(spec.launchCommand, [...spec.launchArgs, HELPER_FLAG], {
        cwd: spec.cwd, env: sanitizeSpawnEnv(process.env), windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_error) {
      return { status: 'error', exitCode: null, signal: null, durationMs: 0, startedAt,
        finishedAt: new Date().toISOString(), stdoutTail: '', stderrTail: '',
        errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED, terminationConfirmed: true };
    }
    let terminalError = null;
    let helperClosed = false;
    let closeResult;
    const closePromise = new Promise((resolve) => { closeResult = resolve; });
    const waiters = new Map();
    const rejectTransport = (error) => {
      if (terminalError) return;
      terminalError = error instanceof Error ? error : new Error(String(error));
      for (const waiter of waiters.values()) waiter.reject(terminalError);
      waiters.clear();
    };
    const acceptMessage = (message) => {
      const id = message?.id;
      if (message?.jsonrpc !== '2.0' || message?.api_version !== API_VERSION
        || (typeof id !== 'string' && typeof id !== 'number')
        || (!message.result && !message.error)) {
        rejectTransport(new Error('Contained helper returned an invalid JSON-RPC response.'));
        return;
      }
      const waiter = waiters.get(id);
      if (!waiter) {
        rejectTransport(new Error('Contained helper returned an unknown or duplicate response.'));
        return;
      }
      waiters.delete(id);
      message.error ? waiter.reject(new Error('Contained helper rejected the request.'))
        : waiter.resolve(message.result);
    };
    child.stdout?.on?.('data', createFrameReader(acceptMessage, rejectTransport));
    child.stderr?.on?.('data', () => {});
    child.stdin?.on?.('error', rejectTransport);
    child.once?.('error', rejectTransport);
    child.once?.('close', (code, signal) => {
      helperClosed = true;
      closeResult({ code, signal });
      if (Number(code) !== 0 || waiters.size) {
        rejectTransport(new Error('Contained helper exited unexpectedly.'));
      }
    });
    const request = (id, method, params, timeoutMs = HELPER_EXIT_TIMEOUT_MS, onTimeout = null) => {
      if (terminalError || helperClosed || !child.stdin?.write) {
        return Promise.reject(terminalError || new Error('Contained helper is closed.'));
      }
      if (waiters.has(id)) {
        return Promise.reject(new Error('Contained helper request identity is already pending.'));
      }
      let timer;
      const response = new Promise((resolve, reject) => {
        const finish = (callback) => (value) => {
          clearTimeout(timer);
          callback(value);
        };
        waiters.set(id, { resolve: finish(resolve), reject: finish(reject) });
        timer = setTimeout(() => {
          waiters.delete(id);
          try { onTimeout?.(); } catch (_error) { /* timeout still fails closed */ }
          reject(new Error('Contained helper request timed out.'));
        }, Math.max(1, Number(timeoutMs) || 1));
        timer.unref?.();
      });
      const { frame, bodyLength } = encodeFrame({ jsonrpc: '2.0', api_version: API_VERSION,
        id, method, params });
      if (bodyLength > MAX_FRAME_BYTES) {
        waiters.get(id)?.reject(new Error('Contained helper request exceeds its bound.'));
        waiters.delete(id);
        return response;
      }
      child.stdin.write(frame);
      return response;
    };
    const sendCancel = () => {
      if (terminalError || helperClosed || child.stdin?.writableEnded
        || child.stdin?.destroyed || !child.stdin?.write) return;
      child.stdin.write(encodeFrame({ jsonrpc: '2.0', api_version: API_VERSION,
        method: 'workspace_test.cancel', params: { operation_id: operationId } }).frame);
    };
    let runRequestMayBeInFlight = false;
    const forceTerminate = async (warning) => {
      if (runRequestMayBeInFlight) {
        try { sendCancel(); } catch (_error) { /* EOF still forces helper cancellation */ }
      }
      const input = child?.stdin;
      if (!input?.writableEnded && !input?.destroyed) {
        try {
          if (typeof input?.end === 'function') input.end();
          else input?.destroy?.();
        } catch (_error) {
          try { input?.destroy?.(); } catch (_destroyError) { /* continue to process kill */ }
        }
      }
      if (!helperClosed) await boundedWait(closePromise, helperExitTimeoutMs);
      if (!helperClosed) {
        try { child?.kill?.(); } catch (_error) { /* an absent close remains unconfirmed */ }
        await boundedWait(closePromise, helperExitTimeoutMs);
      }
      return { confirmed: helperClosed, warning: helperClosed ? '' : warning };
    };
    let terminalSent = false;
    const finishHelper = async () => {
      if (!terminalSent && !terminalError && !helperClosed && child.stdin?.end) {
        terminalSent = true;
        child.stdin.end(encodeFrame({ jsonrpc: '2.0', api_version: API_VERSION,
          method: 'workspace_test.close', params: { operation_id: operationId } }).frame);
      }
      const close = helperClosed ? await closePromise : await boundedWait(closePromise, helperExitTimeoutMs);
      if (!close) return forceTerminate('contained_helper_exit_unconfirmed');
      return { confirmed: Boolean(close && Number(close.code) === 0),
        warning: close && Number(close.code) === 0 ? '' : 'contained_helper_exit_unconfirmed' };
    };
    abortSignal?.addEventListener?.('abort', sendCancel, { once: true });
    let result;
    try {
      const requestedTimeoutMs = Math.max(1, Math.trunc(Number(timeoutMs) || 1));
      runRequestMayBeInFlight = true;
      result = await request(operationId, 'workspace_test.run', {
        accept_version: API_VERSION,
        operation_id: operationId,
        command: String(command || ''),
        cwd: String(cwd || ''),
        user_env: userEnv && typeof userEnv === 'object' && !Array.isArray(userEnv) ? userEnv : {},
        timeout_ms: requestedTimeoutMs,
        output_limit: Math.max(1, Math.min(Math.trunc(Number(outputLimit) || 12_000), 64 * 1024)),
      }, requestedTimeoutMs + Math.max(1, Number(transportGraceMs) || 1), sendCancel);
      runRequestMayBeInFlight = false;
    } catch (_error) {
      const retryTermination = async () => {
        const termination = await forceTerminate('contained_helper_lost');
        if (termination.confirmed) abortSignal?.removeEventListener?.('abort', sendCancel);
        return termination;
      };
      const termination = await retryTermination();
      return { status: 'error', exitCode: null, signal: null, durationMs: 0, startedAt,
        finishedAt: new Date().toISOString(), stdoutTail: '', stderrTail: '',
        errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED,
        terminationConfirmed: termination.confirmed,
        ...(!termination.confirmed ? {
          terminationWarning: 'contained_helper_lost', retryTermination,
        } : {}) };
    }
    if (result?.schema_version !== 1 || result.operation_id !== operationId
      || !['passed', 'failed', 'aborted', 'timeout', 'error'].includes(result.status)) {
      rejectTransport(new Error('Contained helper result identity is invalid.'));
      const retryTermination = async () => {
        const termination = await forceTerminate('contained_helper_invalid_result');
        if (termination.confirmed) abortSignal?.removeEventListener?.('abort', sendCancel);
        return termination;
      };
      const termination = await retryTermination();
      return { status: 'error', exitCode: null, signal: null, durationMs: 0, startedAt,
        finishedAt: new Date().toISOString(), stdoutTail: '', stderrTail: '',
        errorCode: WORKSPACE_TEST_RUNNER_ERROR_CODES.SPAWN_FAILED,
        terminationConfirmed: termination.confirmed,
        ...(!termination.confirmed ? {
          terminationWarning: 'contained_helper_invalid_result', retryTermination,
        } : {}) };
    }
    let retainedCleanup = result.cleanup;
    const retryTermination = async () => {
      let cleanup = retainedCleanup;
      if (!confirmedCleanup(cleanup)) {
        try {
          const retried = await request(`${operationId}:cleanup`, 'workspace_test.cleanup', {
            operation_id: operationId,
          });
          if (retried?.schema_version !== 1 || retried.operation_id !== operationId) {
            throw new Error('Contained helper cleanup identity is invalid.');
          }
          cleanup = retried?.cleanup;
          if (confirmedCleanup(cleanup)) retainedCleanup = cleanup;
        } catch (_error) {
          return { confirmed: false, warning: 'contained_helper_lost' };
        }
      }
      if (!confirmedCleanup(cleanup)) return { confirmed: false,
        warning: cleanup?.reason || 'process_tree_containment_unconfirmed' };
      return finishHelper();
    };
    const cleanupResult = confirmedCleanup(result.cleanup) ? await retryTermination() : null;
    const terminationConfirmed = cleanupResult?.confirmed === true;
    if (terminationConfirmed) abortSignal?.removeEventListener?.('abort', sendCancel);
    return {
      status: String(result.status || 'error'),
      exitCode: Number.isInteger(result.exit_code) ? result.exit_code : null,
      signal: result.status === 'aborted' ? 'SIGTERM' : null,
      durationMs: Math.max(0, Number(result.duration_ms) || 0),
      startedAt,
      finishedAt: new Date().toISOString(),
      stdoutTail: maskTokensInText(String(result.stdout_tail || '')),
      stderrTail: maskTokensInText(String(result.stderr_tail || '')),
      terminationConfirmed,
      ...(!terminationConfirmed ? {
        terminationWarning: result.cleanup?.reason || cleanupResult?.warning || 'cleanup_unconfirmed',
        retryTermination,
      } : {}),
    };
  }

  return Object.freeze({ runShell });
}

module.exports = { createContainedProcessRunner };
