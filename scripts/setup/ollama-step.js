'use strict';

// Ollama lifecycle for the setup orchestrator: detect, (optionally) install via
// the platform package manager, ensure the server is serving, and pull the
// default model with a live progress bar. Standalone + Electron-free so the CLI
// can use it directly; the app's GUI onboarding keeps its own SHA-pinned
// installer (services/ollama-install-service.js).
//
// Pure I/O is dependency-injected (fetchImpl/run/spawnImpl/sleepImpl) for tests.

const { spawn } = require('child_process');
const fs = require('fs');
const { defaultRun } = require('./prereqs');
const {
  parsePullLine,
  aggregatePullStats,
  stripAnsi,
} = require('../../services/ollama-pull-progress');
const {
  ollamaInstallDirs,
  ollamaBinaryPath,
  resolveOllamaCommand,
} = require('../../services/ollama-runtime-paths');
const installManifest = require('../../config/ollama-install-manifest.json');
const { evaluateOllamaVersion } = require('../../services/ollama-version-policy');
const { killProcessTree } = require('../../services/backend/process-utils');

const DEFAULT_HOST = 'http://127.0.0.1:11434';
const MINIMUM_VERSION = installManifest.minimumSupportedVersion || '0.30.10';
const OUTPUT_TAIL_CHARS = 4000;
const PULL_INACTIVITY_MS = 5 * 60 * 1000;
const TERMINATION_TIMEOUT_MS = 5000;

function withVersionPolicy(state) {
  return {
    ...state,
    ...evaluateOllamaVersion(state.version, MINIMUM_VERSION, { serving: state.running === true }),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Probe the local Ollama daemon + PATH. Returns { installed, running, version }.
async function detectOllama({
  fetchImpl = globalThis.fetch,
  run = defaultRun,
  host = DEFAULT_HOST,
  timeoutMs = 3000,
  fileExists = fs.existsSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  let running = false;
  let version = '';
  if (typeof fetchImpl === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${host.replace(/\/$/, '')}/api/version`, {
        signal: controller.signal,
      });
      if (response && response.ok) {
        running = true;
        try {
          const body = await response.json();
          version = (body && body.version) || '';
        } catch {
          /* version is best-effort */
        }
      }
    } catch {
      /* not running */
    } finally {
      clearTimeout(timer);
    }
  }
  if (running) {
    return withVersionPolicy({ installed: true, running: true, version });
  }
  // Not responding on the port — is the binary at least on PATH?
  const probe = platform === 'win32'
    ? run('where', ['ollama'])
    : run('which', ['ollama']);
  const onPath = probe.status === 0 && Boolean((probe.stdout || '').trim());
  if (onPath) {
    return withVersionPolicy({ installed: true, running: false, version: '' });
  }
  // PATH probe failed. A freshly winget-installed Ollama may not be on this
  // process's stale PATH yet, so fall back to its known absolute location.
  if (ollamaBinaryPath(platform, env, fileExists)) {
    return withVersionPolicy({ installed: true, running: false, version: '' });
  }
  return withVersionPolicy({ installed: false, running: false, version: '' });
}

// `ollama show <tag>` exits 0 only when the model is already present locally.
function modelExists(tag, {
  run = defaultRun,
  platform = process.platform,
  env = process.env,
  fileExists = fs.existsSync,
} = {}) {
  const result = run(resolveOllamaCommand({ platform, env, fileExists }), ['show', tag]);
  return result.status === 0;
}

// How a friend installs Ollama, per platform. winget/brew are trusted package
// managers; we only run them with explicit consent and always print a manual URL.
function installPlan(platform, { upgrade = false } = {}) {
  if (platform === 'win32') {
    return {
      manager: 'winget',
      command: ['winget', [
        upgrade ? 'upgrade' : 'install', '--id', 'Ollama.Ollama', '-e', '--source', 'winget',
        '--accept-package-agreements', '--accept-source-agreements', '--silent',
      ]],
      manualUrl: 'https://ollama.com/download/windows',
    };
  }
  if (platform === 'darwin') {
    return {
      manager: 'brew',
      command: ['brew', [upgrade ? 'upgrade' : 'install', 'ollama']],
      manualUrl: 'https://ollama.com/download/mac',
    };
  }
  return {
    manager: 'manual',
    command: null,
    manualUrl: 'https://ollama.com/download/linux',
  };
}

// Start the daemon if it is installed but not serving, then re-probe. On macOS
// `ollama serve` works when the CLI is on PATH; the menubar app also serves.
async function ensureServing({
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  run = defaultRun,
  host = DEFAULT_HOST,
  attempts = 10,
  intervalMs = 700,
  sleepImpl = sleep,
  initialDetect = null,
  platform = process.platform,
  env = process.env,
  fileExists = fs.existsSync,
} = {}) {
  const doSleep = typeof sleepImpl === 'function' ? sleepImpl : sleep;
  // Reuse the caller's detection when supplied — the orchestrator already
  // probed /api/version in its Ollama phase, so don't round-trip a second time.
  const initial = initialDetect || await detectOllama({ fetchImpl, run, host, platform, env, fileExists });
  if (initial.running) {
    return { running: true, started: false };
  }
  if (!initial.installed) {
    return { running: false, started: false, reason: 'not_installed' };
  }
  try {
    const child = spawnImpl(resolveOllamaCommand({ platform, env, fileExists }), ['serve'], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    if (child && typeof child.unref === 'function') {
      child.unref();
    }
  } catch {
    return { running: false, started: false, reason: 'serve_spawn_failed' };
  }
  for (let i = 0; i < attempts; i += 1) {
    await doSleep(intervalMs);
    const probe = await detectOllama({ fetchImpl, run, host, platform, env, fileExists });
    if (probe.running) {
      return { running: true, started: true };
    }
  }
  return { running: false, started: true, reason: 'serve_timeout' };
}

// Spawn `ollama pull <tag>`, translating per-layer redraws into 0-100 progress.
function pullModel(tag, {
  spawnImpl = spawn,
  onProgress = () => {},
  platform = process.platform,
  env = process.env,
  fileExists = fs.existsSync,
  isTTY = Boolean(process.stdout.isTTY),
  nowProvider = Date.now,
  inactivityMs = PULL_INACTIVITY_MS,
  killProcessTreeImpl = killProcessTree,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let inactivityTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (inactivityTimer) clearTimeout(inactivityTimer);
      resolve(result);
    };
    const boundedError = (value) => stripAnsi(String(value || ''))
      .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:"']+[\\/])+[^\s:"']*/g, '[path]')
      .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
      .slice(0, OUTPUT_TAIL_CHARS)
      .trim();
    let child;
    try {
      child = spawnImpl(resolveOllamaCommand({ platform, env, fileExists }), ['pull', tag], { windowsHide: true });
    } catch (error) {
      finish({ ok: false, code: null, error: boundedError((error && error.message) || error) });
      return;
    }
    const layers = new Map();
    let buffer = '';
    let stderrTail = '';
    let lastProgressAt = 0;
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        const pid = Number(child?.pid);
        let terminate = Promise.resolve(false);
        if (Number.isInteger(pid) && pid > 0) {
          try {
            terminate = Promise.resolve(killProcessTreeImpl(pid, {
              force: true,
              confirmExit: true,
              timeoutMs: TERMINATION_TIMEOUT_MS,
              platform,
            })).then((result) => result?.terminated === true, () => false);
          } catch (_error) {
            terminate = Promise.resolve(false);
          }
        }
        void terminate.then((terminationConfirmed) => finish({
          ok: false,
          code: null,
          reason: 'pull_inactivity',
          terminationConfirmed,
          error: terminationConfirmed
            ? 'Model pull stalled and was stopped.'
            : 'Model pull stalled and process termination could not be confirmed.',
        }));
      }, Math.max(1, Number(inactivityMs) || PULL_INACTIVITY_MS));
      inactivityTimer.unref?.();
    };
    const captureStderr = (chunk) => {
      const clean = stripAnsi(chunk);
      stderrTail = (stderrTail + clean).slice(-OUTPUT_TAIL_CHARS);
    };

    const consume = (chunk) => {
      resetInactivity();
      buffer += chunk.toString();
      const parts = buffer.split(/\r?\n|\r/);
      buffer = (parts.pop() || '').slice(-OUTPUT_TAIL_CHARS);
      for (const line of parts) {
        const token = parsePullLine(line);
        if (!token) {
          continue;
        }
        if (token.kind === 'layer' && token.digest) {
          layers.set(token.digest, token);
        }
        const stats = aggregatePullStats(layers);
        const now = nowProvider();
        if (!isTTY && now - lastProgressAt < 1000) continue;
        lastProgressAt = now;
        onProgress({
          percent: stats.percent,
          bytes: stats.bytes,
          totalBytes: stats.totalBytes,
          label: token.label || 'Downloading',
        });
      }
    };

    if (child.stdout) {
      child.stdout.on('data', consume);
    }
    resetInactivity();
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        captureStderr(chunk);
        consume(chunk);
      });
    }
    child.on('error', (error) => {
      finish({ ok: false, code: null, error: boundedError((error && error.message) || error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      // Flush any trailing line that arrived without a newline — ollama's final
      // `success` / 100% line often lacks a trailing \n on piped stdio.
      if (buffer.trim()) {
        consume('\n');
      }
      if (code === 0) {
        // Guarantee the progress bar reaches 100% so its in-place line is closed.
        const stats = aggregatePullStats(layers);
        onProgress({
          percent: 100,
          bytes: stats.totalBytes || stats.bytes,
          totalBytes: stats.totalBytes,
          label: 'Complete',
        });
      }
      const error = code === 0 ? '' : boundedError(stderrTail);
      const statusMatch = error.match(/\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*(4\d\d|5\d\d)\b/i);
      finish({
        ok: code === 0,
        code,
        ...(error ? { error } : {}),
        ...(statusMatch ? { httpStatus: Number(statusMatch[1]) } : {}),
      });
    });
  });
}

module.exports = {
  DEFAULT_HOST,
  detectOllama,
  modelExists,
  installPlan,
  ensureServing,
  pullModel,
  ollamaInstallDirs,
  ollamaBinaryPath,
};
