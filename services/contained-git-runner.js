'use strict';

const { maskTokensInText } = require('./backend/sanitize-spawn-env');

const DEFAULT_MAX_MESSAGE_CHARS = 800;
const WORKSPACE_GIT_TIMEOUT_MS = 10000;
const WORKSPACE_GIT_MAXBUFFER_BYTES = 8 * 1024 * 1024;
const runners = new WeakSet();

function clipMessage(value, limit = DEFAULT_MAX_MESSAGE_CHARS) {
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function createContainedGitRunner({ containedProcessRunner } = {}) {
  if (!containedProcessRunner || typeof containedProcessRunner.runGit !== 'function') {
    throw new TypeError('Contained Git runner requires a contained process runner.');
  }
  const run = async (cwd, args, {
    signal = null,
    timeoutMs = WORKSPACE_GIT_TIMEOUT_MS,
    maxBuffer,
    maxOutputBytes,
    maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
    input = null,
    scrubEnv = true,
  } = {}) => {
    const outputLimit = maxBuffer ?? maxOutputBytes ?? WORKSPACE_GIT_MAXBUFFER_BYTES;
    const result = await containedProcessRunner.runGit({
      cwd,
      args,
      input,
      timeoutMs,
      maxBuffer: outputLimit,
      scrubEnv,
      abortSignal: signal,
    });
    const stdout = String(result?.stdout || '');
    const stderr = String(result?.stderr || '');
    const outputExceeded = result?.reason === 'output_limit_exceeded'
      || Buffer.byteLength(stdout, 'utf8') + Buffer.byteLength(stderr, 'utf8') > outputLimit;
    const success = result?.status === 'passed' && !outputExceeded;
    const reason = success ? '' : result?.status === 'aborted' ? 'aborted' : 'git_failed';
    const detail = outputExceeded
      ? 'Git output exceeded the configured limit.'
      : result?.cleanupReason || result?.reason || '';
    return {
      success,
      reason,
      stdout,
      stderr,
      message: success ? '' : maskTokensInText(clipMessage(
        (outputExceeded ? detail : '') || stderr || stdout || detail || 'Git command failed.',
        maxMessageChars,
      )),
      cleanupConfirmed: result?.cleanupConfirmed === true,
      ...(typeof result?.retryCleanup === 'function'
        ? { retryCleanup: result.retryCleanup }
        : {}),
    };
  };
  runners.add(run);
  return run;
}

function isContainedGitRunner(value) {
  return typeof value === 'function' && runners.has(value);
}

module.exports = { createContainedGitRunner, isContainedGitRunner };
