'use strict';

// Remembers a successful packaged-sidecar `--version` probe so a steady-state
// launch can skip it. The probe costs a full PyInstaller onefile extraction +
// interpreter start (~1 s warm, ~3 s first run) inside the awaited backend
// start. The manifest SHA-256 check still runs on every launch; a cache hit
// only stands in for the probe when the exact same verified bytes (hash, size,
// mtime) already answered the same expected api version under the same app
// version. Every read/write is best-effort: any cache problem is a miss and the
// launch probes as before, so the cache can never turn a failure into success.

const fs = require('fs');
const path = require('path');

const PROBE_CACHE_FILENAME = 'packaged-sidecar-probe-cache.json';
const PROBE_CACHE_SCHEMA_VERSION = 1;
const KEY_FIELDS = ['artifactPath', 'artifactSha256', 'artifactSize', 'artifactMtimeMs', 'apiVersion', 'appVersion'];

function buildProbeCacheKey({ artifactPath, artifactSha256, stat, apiVersion, appVersion }) {
  const size = Number(stat?.size);
  const mtimeMs = Number(stat?.mtimeMs);
  if (!artifactPath || !/^[a-f0-9]{64}$/.test(String(artifactSha256 || ''))
    || !Number.isFinite(size) || !Number.isFinite(mtimeMs) || !apiVersion || !appVersion) {
    return null;
  }
  return {
    artifactPath: String(artifactPath),
    artifactSha256: String(artifactSha256),
    artifactSize: size,
    artifactMtimeMs: mtimeMs,
    apiVersion: String(apiVersion),
    appVersion: String(appVersion),
  };
}

function readProbeCacheHit(cachePath, key, fsImpl = fs) {
  if (!cachePath || !key) {
    return false;
  }
  try {
    const entry = JSON.parse(fsImpl.readFileSync(cachePath, 'utf8'));
    if (!entry || entry.schemaVersion !== PROBE_CACHE_SCHEMA_VERSION) {
      return false;
    }
    return KEY_FIELDS.every((field) => entry[field] === key[field]);
  } catch (_error) {
    return false;
  }
}

function recordProbeSuccess(cachePath, key, fsImpl = fs, now = () => new Date()) {
  if (!cachePath || !key) {
    return false;
  }
  const tempPath = `${cachePath}.${process.pid}.tmp`;
  try {
    fsImpl.mkdirSync(path.dirname(cachePath), { recursive: true });
    const entry = { schemaVersion: PROBE_CACHE_SCHEMA_VERSION, ...key, probedAtUtc: now().toISOString() };
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(entry)}\n`, 'utf8');
    fsImpl.renameSync(tempPath, cachePath);
    return true;
  } catch (_error) {
    try { fsImpl.unlinkSync(tempPath); } catch (_cleanupError) { /* best-effort */ }
    return false;
  }
}

function invalidatePackagedProbeCache(cachePath, fsImpl = fs) {
  if (!cachePath) {
    return false;
  }
  try {
    fsImpl.unlinkSync(cachePath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

// A cache hit skipped the probe, so a binary that cannot start must not stay
// trusted: if the manager reports a spawn error or an exit before its first
// ready status (the window the probe covered: bootloader, interpreter and the
// protocol import), the entry is dropped and the next launch probes again. An
// initialize api mismatch needs no hook: the cache key pins the hash that
// already printed this api version, and initialize compares the same constant.
const STARTUP_FAILURE_STAGES = new Set(['spawn_error', 'spawn_exit']);

function invalidateProbeCacheOnStartupFailure(manager, cachePath, { log = () => {}, fsImpl = fs } = {}) {
  if (!cachePath || typeof manager?.on !== 'function') {
    return () => {};
  }
  const detach = () => {
    if (typeof manager.off === 'function') manager.off('status', onStatus);
    else manager.removeListener?.('status', onStatus);
  };
  function onStatus(status) {
    const phase = String(status?.phase || '');
    if (phase === 'failed' && STARTUP_FAILURE_STAGES.has(String(status?.startupStage || ''))) {
      detach();
      invalidatePackagedProbeCache(cachePath, fsImpl);
      log('WARN', 'sidecar.packaged_probe_cache_invalidated', {
        reason: String(status.startupStage),
        cachePath,
      });
    } else if (phase === 'ready' || phase === 'failed' || phase === 'stopped') {
      detach();
    }
  }
  manager.on('status', onStatus);
  return detach;
}

module.exports = {
  PROBE_CACHE_FILENAME,
  PROBE_CACHE_SCHEMA_VERSION,
  buildProbeCacheKey,
  invalidatePackagedProbeCache,
  invalidateProbeCacheOnStartupFailure,
  readProbeCacheHit,
  recordProbeSuccess,
};
