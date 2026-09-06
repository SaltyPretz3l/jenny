'use strict';

/**
 * git-runner — the single, domain-neutral primitive for spawning `git`.
 *
 * Why this exists
 * ---------------
 * Several surfaces shell out to git: worktree management
 * (`worktree-service.js`), chat context (`git-context-utils.js`), and the
 * Workspace-IDE SCM layer (`workspace-git-*`). Each historically grew its own
 * `execFile('git', ...)` wrapper with subtly different timeout / buffer /
 * abort / result-shape behaviour. This module is the one place that knows how
 * to safely run git: `windowsHide`, a bounded timeout + output buffer, abort
 * handling, an optional env scrub, and a single structured result shape.
 *
 * Posture
 * -------
 * - Pure spawn. NO logging (each consumer logs in its own vocabulary), NO
 *   not-a-repo interpretation (that is the caller's policy — a worktree miss
 *   and an IDE "not a repo" are different products), NO token masking
 *   (consumers that surface git output to users opt into masking themselves).
 * - The result shape is byte-compatible with what `worktree-service._runGit`
 *   produced before it delegated here, so that refactor is behaviour-neutral.
 *
 * Returned shape (always resolves, never rejects):
 *   { success, stdout, stderr, message, reason }
 *   reason ∈ '' (success) | 'aborted' | 'git_failed'
 *   message = '' on success, else a single-line clipped tail of stderr/stdout.
 *   On a timeout or abort the whole process tree is killed (never the pid of
 *   a child that has already exited) and `terminationConfirmed` reports
 *   whether the kill was confirmed. A git that exited but whose descendant
 *   kept its output pipes open past the timeout resolves as 'git_failed'
 *   with a message saying so — the output never arrived, so it is not a
 *   success a caller may parse.
 */

const { execFile, spawn } = require('child_process');

const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { killProcessTree } = require('./backend/process-utils');
const { normalizeString } = require('./shared/normalize');

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAXBUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGE_CHARS = 800;
// Env policy for a sanitized git child (scrubEnv). JENNY_* feature-flag env and
// credential-shaped keys (via sanitizeSpawnEnv) must never reach a child whose
// output a user might see. Additionally deny git's command-exec / config-redirect
// vectors: GIT_EXTERNAL_DIFF runs an arbitrary binary on `git diff`, GIT_ASKPASS /
// GIT_SSH / GIT_PROXY_COMMAND run binaries on remote ops, GIT_CONFIG_* redirect
// the config git reads. None of these are needed by the local workspace ops, and
// dropping them keeps a compromised parent env from steering the child.
const SCRUB_EXTRA_DENY = [
  /^JENNY_/i,
  /^GIT_(EXTERNAL_DIFF|ASKPASS|SSH|PROXY_COMMAND|PAGER|CONFIG)/i,
];

function clipText(value, limit = DEFAULT_MAX_MESSAGE_CHARS) {
  const text = normalizeString(value).replace(/[\r\n]+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit - 3).trim()}...` : text;
}

function errorWasAborted(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || /aborted/i.test(String(error?.message || ''));
}

/**
 * Run a git command and resolve a structured result.
 *
 * @param {string} cwd - working directory for the git process
 * @param {string[]} args - git argv (callers MUST pre-validate any path/ref)
 * @param {Object} [opts]
 * @param {AbortSignal|null} [opts.signal] - abort signal
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxBuffer]
 * @param {number} [opts.maxMessageChars]
 * @param {string|Buffer|null} [opts.input] - bounded stdin payload (for pathspec-from-file)
 * @param {boolean} [opts.scrubEnv] - produce a sanitized, C-locale child env (drops JENNY_*, credentials, and dangerous GIT_* vars)
 * @param {Function} [opts.execFileImpl] - injectable for tests (defaults to execFile)
 * @returns {Promise<{success:boolean, stdout:string, stderr:string, message:string, reason:string}>}
 */
function runGit(cwd, args, {
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAXBUFFER_BYTES,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
  input = null,
  scrubEnv = false,
  execFileImpl = execFile,
  killProcessTreeImpl = killProcessTree,
  terminationTimeoutMs = 4000,
  platform = process.platform,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({
      success: false,
      reason: 'aborted',
      stdout: '',
      stderr: '',
      message: 'Git command aborted.',
    });
  }
  const options = {
    cwd,
    windowsHide: true,
    maxBuffer,
    encoding: 'utf8',
    detached: platform !== 'win32',
  };
  if (scrubEnv) {
    options.env = buildScrubbedGitEnv();
  }
  return new Promise((resolve) => {
    let settled = false;
    let termination = null;
    let lateOutput = null;
    let timer = null;
    let child;
    const onAbort = () => { void requestTermination('aborted', 'Git command aborted.'); };
    const cleanup = () => {
      if (timer !== null) clearTimeoutImpl(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const finish = (error, stdout, stderr, extra = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        const aborted = errorWasAborted(error);
        const message = clipText(stderr || stdout || error.message || String(error), maxMessageChars);
        resolve({
          success: false,
          reason: aborted ? 'aborted' : 'git_failed',
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          message,
          ...(extra || {}),
        });
        return;
      }
      resolve({
        success: true,
        reason: '',
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        message: '',
      });
    };
    // Only a child that has not exited is a kill target: once git has exited,
    // libuv has released its handle and the pid may already belong to an
    // unrelated process tree, which `taskkill /T /F` would take down.
    const childAlive = () => Boolean(child) && child.exitCode === null && child.signalCode === null;
    const requestTermination = async (reason, message) => {
      if (settled || termination) return;
      termination = { reason, message };
      const alive = childAlive();
      let confirmed = true;
      if (alive) {
        try {
          const outcome = await killProcessTreeImpl(child.pid, {
            force: true,
            processGroup: platform !== 'win32',
            confirmExit: true,
            timeoutMs: terminationTimeoutMs,
            platform,
          });
          confirmed = outcome?.terminated !== false;
        } catch (_error) {
          // Preserve runGit's always-resolve contract after the bounded attempt.
          confirmed = false;
        }
      }
      const { stdout = '', stderr = '' } = lateOutput || {};
      let text = message;
      if (!alive) {
        // git itself is done; a descendant kept its output pipes open past
        // the deadline, so the output never reached us. Report that rather
        // than a success with empty stdout a caller might parse.
        text = `${message} Git had already exited (code ${child?.exitCode ?? 'unknown'}) but its output was not received in time.`;
      } else if (!confirmed) {
        text = `${message} Process termination could not be confirmed.`;
      }
      const error = reason === 'aborted'
        ? Object.assign(new Error(text), { name: 'AbortError' })
        : new Error(text);
      finish(error, stdout, stderr, alive ? { terminationConfirmed: confirmed } : null);
    };
    child = execFileImpl('git', args, options, (error, stdout, stderr) => {
      if (termination) {
        lateOutput = { stdout, stderr };
        return;
      }
      finish(error, stdout, stderr);
    });
    if (input !== null && child?.stdin && typeof child.stdin.end === 'function') {
      child.stdin.on?.('error', () => {});
      child.stdin.end(input);
    }
    if (settled) return;
    // Abort is a tree kill too (a pager, credential helper or external diff
    // outlives a lone SIGTERM to git), and it is the common cancel path.
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (settled || termination) return;
    timer = setTimeoutImpl(
      () => { void requestTermination('git_failed', 'Git command timed out.'); },
      Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    );
    timer?.unref?.();
  });
}

function buildScrubbedGitEnv() {
  const env = sanitizeSpawnEnv(process.env, { extraDeny: SCRUB_EXTRA_DENY });
  env.LC_ALL = 'C';
  env.LANG = 'C';
  // WIDE-028 (b): reads like `git status` must never take the OPTIONAL index
  // lock (an opportunistic on-disk index refresh). The IDE watcher now treats
  // `.git/index` as a git-meta signal so external stage/reset refresh the SCM
  // view; without this, our own status re-pull would rewrite the index and
  // feed the watcher its own echo in a refresh loop. Mandatory locks for real
  // mutations (add/commit/reset) are unaffected.
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function buildPluginFetchProfile({ proxyUrl, nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null' } = {}) {
  if (typeof proxyUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(proxyUrl)) {
    throw new TypeError('plugin fetch requires an exact loopback proxy URL');
  }
  const env = buildScrubbedGitEnv();
  for (const key of Object.keys(env)) {
    if (/^(?:GIT_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$)/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice, GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_LFS_SKIP_SMUDGE: '1',
  });
  const argsPrefix = [
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'http.followRedirects=false', '-c', 'credential.helper=', '-c', 'core.askPass=',
    '-c', `core.hooksPath=${nullDevice}`, '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'submodule.recurse=false',
    '-c', 'core.alternateRefsCommand=', '-c', `http.proxy=${proxyUrl}`,
  ];
  return Object.freeze({ env: Object.freeze(env), argsPrefix: Object.freeze(argsPrefix) });
}

function createBoundedCollector(maxBytes, sharedBudget = null) {
  const cap = Math.max(1, Math.trunc(Number(maxBytes)) || DEFAULT_MAXBUFFER_BYTES);
  const budget = sharedBudget || { retainedBytes: 0 };
  const buffers = [];
  let retainedBytes = 0;
  let droppedBytes = 0;
  return {
    push(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ''), 'utf8');
      const remaining = cap - budget.retainedBytes;
      if (remaining > 0) {
        const kept = data.length > remaining ? data.subarray(0, remaining) : data;
        buffers.push(kept);
        retainedBytes += kept.length;
        budget.retainedBytes += kept.length;
      }
      droppedBytes += Math.max(0, data.length - Math.max(0, remaining));
    },
    text: () => Buffer.concat(buffers, retainedBytes).toString('utf8'),
    droppedBytes: () => droppedBytes,
  };
}

function runGitStreamed(cwd, args, {
  signal = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAXBUFFER_BYTES,
  maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS,
  scrubEnv = false,
  spawnImpl = spawn,
  killProcessTreeImpl = killProcessTree,
  terminationTimeoutMs = 4000,
  platform = process.platform,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  pluginFetchProfile = null,
} = {}) {
  if (signal?.aborted) {
    return Promise.resolve({
      success: false, reason: 'aborted', stdout: '', stderr: '', message: 'Git command aborted.',
      truncated: false, droppedBytes: 0,
    });
  }
  return new Promise((resolve) => {
    const outputBudget = { retainedBytes: 0 };
    const stdout = createBoundedCollector(maxOutputBytes, outputBudget);
    const stderr = createBoundedCollector(maxOutputBytes, outputBudget);
    let settled = false;
    let timer = null;
    let termination = null;
    let child;
    const cleanup = () => {
      if (timer !== null) clearTimeoutImpl(timer);
      signal?.removeEventListener?.('abort', onAbort);
      child?.stdout?.removeListener?.('data', onStdout);
      child?.stderr?.removeListener?.('data', onStderr);
      child?.removeListener?.('error', onError);
      child?.removeListener?.('close', onClose);
    };
    const finish = ({ success, reason = '', fallback = '', terminationConfirmed = null }) => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdoutText = stdout.text();
      const stderrText = stderr.text();
      const droppedBytes = stdout.droppedBytes() + stderr.droppedBytes();
      const result = {
        success,
        reason,
        stdout: stdoutText,
        stderr: stderrText,
        message: success ? '' : clipText(stderrText || stdoutText || fallback, maxMessageChars),
        truncated: droppedBytes > 0,
        droppedBytes,
      };
      if (typeof terminationConfirmed === 'boolean') result.terminationConfirmed = terminationConfirmed;
      resolve(result);
    };
    const requestTermination = async (reason, fallback) => {
      if (settled || termination) return;
      termination = { reason, fallback };
      let outcome;
      try {
        outcome = await killProcessTreeImpl(child?.pid, {
          force: true,
          processGroup: platform !== 'win32',
          confirmExit: true,
          timeoutMs: terminationTimeoutMs,
          platform,
        });
      } catch (_error) {
        outcome = null;
      }
      const confirmed = outcome?.terminated === true;
      finish({
        success: false,
        reason,
        fallback: confirmed ? fallback : `${fallback} Process termination could not be confirmed.`,
        terminationConfirmed: confirmed,
      });
    };
    const onAbort = () => {
      requestTermination('aborted', 'Git command aborted.');
    };
    const onStdout = (chunk) => stdout.push(chunk);
    const onStderr = (chunk) => stderr.push(chunk);
    const onError = (error) => {
      if (termination) return;
      finish({
        success: false,
        reason: errorWasAborted(error) ? 'aborted' : 'git_failed',
        fallback: error?.message || String(error),
      });
    };
    const onClose = (code) => {
      if (termination) return;
      finish({
        success: code === 0,
        reason: code === 0 ? '' : 'git_failed',
        fallback: `Git exited with code ${code}.`,
      });
    };
    try {
      child = spawnImpl('git', pluginFetchProfile ? [...pluginFetchProfile.argsPrefix, ...args] : args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        ...(pluginFetchProfile ? { env: pluginFetchProfile.env }
          : (scrubEnv ? { env: buildScrubbedGitEnv() } : {})),
      });
    } catch (error) {
      finish({ success: false, reason: 'git_failed', fallback: error?.message || String(error) });
      return;
    }
    child.stdout?.on?.('data', onStdout);
    child.stderr?.on?.('data', onStderr);
    child.once?.('error', onError);
    if (settled) return;
    child.once?.('close', onClose);
    if (settled) return;
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (settled || termination) return;
    timer = setTimeoutImpl(
      () => requestTermination('git_failed', 'Git command timed out.'),
      Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
    );
    timer?.unref?.();
  });
}

module.exports = {
  runGit,
  runGitStreamed,
  buildPluginFetchProfile,
};
