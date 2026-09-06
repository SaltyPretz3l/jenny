'use strict';

/**
 * services/ollama-detection.js
 *
 * Ollama presence + run-state detection for the onboarding scan, extracted
 * from setup-service.js to keep that file under the file-size ceiling.
 * Tries the HTTP /api/version probe first (gives version + running), then a
 * PATH lookup (`where`/`which ollama`), then the known absolute install
 * location (a freshly winget-installed Ollama may not be on this process's
 * stale PATH yet; mirrors scripts/setup/ollama-step.js::detectOllama).
 *
 * All effects are injected via `deps` (fetchImpl, commandLookupImpl,
 * spawnImpl, platform, env, fileExists) so callers and tests control IO.
 */

const { normalizeString } = require('./backend/path-utils');
const { ollamaBinaryPath } = require('./ollama-runtime-paths');
const installManifest = require('../config/ollama-install-manifest.json');
const { evaluateOllamaVersion } = require('./ollama-version-policy');

function lookupOllamaPath(deps) {
  if (typeof deps.commandLookupImpl === 'function') {
    return Promise.resolve()
      .then(() => deps.commandLookupImpl())
      .then((value) => normalizeString(value))
      .catch(() => '');
  }
  return new Promise((resolve) => {
    const command = deps.platform === 'win32' ? 'where' : 'which';
    let child;
    try {
      child = deps.spawnImpl(command, ['ollama'], { windowsHide: true });
    } catch (_error) {
      resolve('');
      return;
    }
    let output = '';
    if (child && child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => {
        output += String(chunk || '');
      });
    }
    const timer = setTimeout(() => {
      try {
        if (child && typeof child.kill === 'function') {
          child.kill();
        }
      } catch (_error) {
        // ignore
      }
      resolve('');
    }, 3000);
    if (child && typeof child.once === 'function') {
      child.once('error', () => {
        clearTimeout(timer);
        resolve('');
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? normalizeString(String(output).split(/\r?\n/)[0]) : '');
      });
    } else {
      clearTimeout(timer);
      resolve('');
    }
  });
}

/**
 * @param {object} deps - { fetchImpl, commandLookupImpl, spawnImpl, platform, env, fileExists }
 * @param {object} options - { baseUrl, timeout } (already normalized by the caller)
 */
async function detectOllama(deps, { baseUrl, timeout }) {
  let running = false;
  let version = '';
  let installed = false;
  let installPath = '';
  let source = 'none';

  if (deps.fetchImpl) {
    let controller = null;
    let timeoutHandle = null;
    if (typeof AbortController === 'function') {
      controller = new AbortController();
      timeoutHandle = setTimeout(() => controller.abort(), timeout);
    }
    try {
      const response = await deps.fetchImpl(`${baseUrl}/api/version`, {
        method: 'GET',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (response && response.ok === true) {
        running = true;
        installed = true;
        source = 'api';
        try {
          const data = typeof response.json === 'function' ? await response.json() : null;
          version = normalizeString(data && data.version);
        } catch (_error) {
          // version is best-effort
        }
      }
    } catch (_error) {
      // not running / unreachable
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  if (!installed) {
    const resolvedPath = await lookupOllamaPath(deps);
    if (resolvedPath) {
      installed = true;
      installPath = resolvedPath;
      source = 'path';
    }
  }

  if (!installed) {
    const fallbackPath = ollamaBinaryPath(deps.platform || process.platform, deps.env, deps.fileExists);
    if (fallbackPath) {
      installed = true;
      installPath = fallbackPath;
      source = 'path-fallback';
    }
  }

  const versionPolicy = evaluateOllamaVersion(
    version,
    normalizeString(installManifest.minimumSupportedVersion),
    { serving: running }
  );
  return Object.freeze({
    installed,
    running,
    version,
    installPath,
    source,
    ...versionPolicy,
  });
}

module.exports = { detectOllama, lookupOllamaPath };
