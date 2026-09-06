const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { API_VERSION } = require('./sidecar-client');

const MANIFEST_NAME = 'manifest.json';
const DEFAULT_VERSION_TIMEOUT_MS = 45000;
const HASH_BUFFER_BYTES = 1024 * 1024;

function buildFailureSpec(message, extras = {}) {
  const detail = String(message || '').trim() || 'Packaged sidecar launch is unavailable.';
  return {
    ok: false,
    launchCommand: '',
    launchArgs: [],
    launchSource: 'packaged-binary',
    packagedLaunchDetail: detail,
    failureReason: detail,
    ...extras,
  };
}

function normalizeFilename(value) {
  return String(value || '').trim();
}

function normalizeManifestText(value) {
  return String(value || '').trim();
}

function sha256File(filePath, fsImpl = fs) {
  const handle = fsImpl.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  try {
    while (true) {
      const bytesRead = fsImpl.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fsImpl.closeSync(handle);
  }
  return hash.digest('hex');
}

// Streamed, non-blocking variant of sha256File. Hashing a multi-hundred-MB
// PyInstaller binary on the main thread stalls first paint when done eagerly;
// streaming keeps the event loop responsive during the (awaited) start() phase.
function sha256FileAsync(filePath, fsImpl = fs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(filePath, { highWaterMark: HASH_BUFFER_BYTES });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// Async, timeout-bounded `--version` probe. Mirrors the spawnSync result shape
// ({status, stdout, stderr} | {error}) so the validation logic below is shared.
function spawnVersionProbeAsync(command, {
  versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child = null;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch (_error) {
        // best-effort kill; the timeout result still propagates as an error
      }
      finish({ error: new Error(`Packaged sidecar --version probe timed out after ${versionTimeoutMs}ms.`) });
    }, versionTimeoutMs);
    try {
      child = spawnImpl(command, ['--version'], { windowsHide: true });
    } catch (error) {
      finish({ error });
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => finish({ error }));
    child.once('close', (status) => finish({ status, stdout, stderr }));
  });
}

// Shared manifest validation: everything up to (but not including) the
// expensive artifact hash + version probe. Returns either a failure spec or a
// validated context the sync and async resolvers finish off differently.
function validatePackagedManifest({
  resourcesPath,
  fsImpl = fs,
  apiVersion = API_VERSION,
}) {
  const normalizedResourcesPath = String(resourcesPath || '').trim();
  if (!normalizedResourcesPath) {
    return { ok: false, spec: buildFailureSpec('Packaged resources path is unavailable.') };
  }

  const sidecarDir = path.resolve(normalizedResourcesPath, 'sidecar');
  const manifestPath = path.join(sidecarDir, MANIFEST_NAME);
  if (!fsImpl.existsSync(sidecarDir)) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar directory is missing.', { manifestPath, sidecarDir }),
    };
  }
  if (!fsImpl.existsSync(manifestPath)) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar manifest is missing.', { manifestPath, sidecarDir }),
    };
  }

  let manifest;
  try {
    manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      spec: buildFailureSpec(
        `Packaged sidecar manifest is invalid: ${String(error?.message || error)}`,
        { manifestPath, sidecarDir }
      ),
    };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar manifest is invalid.', { manifestPath, sidecarDir }),
    };
  }

  const artifactName = normalizeFilename(manifest.artifact_name);
  if (!artifactName) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar manifest missing artifact_name.', { manifestPath, sidecarDir }),
    };
  }
  if (path.basename(artifactName) !== artifactName) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar manifest artifact_name must be a filename.', { manifestPath, sidecarDir }),
    };
  }

  const manifestApiVersion = normalizeFilename(manifest.api_version);
  if (manifestApiVersion !== apiVersion) {
    return {
      ok: false,
      spec: buildFailureSpec(
        `Packaged sidecar manifest api_version mismatch: ${manifestApiVersion || 'missing'} != ${apiVersion}.`,
        { manifestPath, sidecarDir }
      ),
    };
  }

  const manifestSha256 = normalizeFilename(manifest.sha256).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar manifest sha256 is invalid.', { manifestPath, sidecarDir }),
    };
  }

  const resolvedSidecarDir = path.resolve(sidecarDir);
  const artifactPath = path.resolve(sidecarDir, artifactName);
  if (path.dirname(artifactPath) !== resolvedSidecarDir) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar artifact_name escapes the sidecar directory.', {
        manifestPath,
        sidecarDir,
        artifactPath,
      }),
    };
  }
  if (!fsImpl.existsSync(artifactPath)) {
    return {
      ok: false,
      spec: buildFailureSpec('Packaged sidecar artifact is missing.', {
        manifestPath,
        sidecarDir,
        artifactPath,
      }),
    };
  }

  return {
    ok: true,
    context: {
      manifestPath,
      sidecarDir: resolvedSidecarDir,
      artifactPath,
      artifactName,
      manifestSha256,
      apiVersion,
      manifestGeneratedAtUtc: normalizeManifestText(manifest.generated_at_utc),
    },
  };
}

function buildSuccessSpec(context, artifactSha256, validationTimings) {
  const buildDetail = context.manifestGeneratedAtUtc
    ? `built ${context.manifestGeneratedAtUtc}`
    : 'build time unavailable';
  return {
    ok: true,
    launchCommand: context.artifactPath,
    launchArgs: [],
    launchSource: 'packaged-binary',
    packagedLaunchDetail:
      `Packaged sidecar validated via manifest integrity and version probe (${buildDetail}).`,
    manifestPath: context.manifestPath,
    sidecarDir: context.sidecarDir,
    artifactPath: context.artifactPath,
    artifactName: context.artifactName,
    manifestGeneratedAtUtc: context.manifestGeneratedAtUtc,
    manifestSha256: context.manifestSha256,
    artifactSha256,
    // Async path only: how long integrity validation cost (cold-start audit
    // input for deciding whether the --version probe is worth its spawn).
    ...(validationTimings ? { validationTimings } : {}),
  };
}

function evaluateVersionProbeResult(probeResult, context, apiVersion) {
  if (probeResult?.error) {
    return buildFailureSpec(
      `Packaged sidecar --version probe failed: ${String(probeResult.error.message || probeResult.error)}`,
      { manifestPath: context.manifestPath, sidecarDir: context.sidecarDir, artifactPath: context.artifactPath }
    );
  }
  if (Number(probeResult?.status) !== 0) {
    return buildFailureSpec(
      `Packaged sidecar --version probe failed with exit code ${probeResult?.status ?? 'unknown'}.`,
      { manifestPath: context.manifestPath, sidecarDir: context.sidecarDir, artifactPath: context.artifactPath }
    );
  }
  // sidecar/__main__.py prints exactly the API version on its own line; a
  // substring match would accept a different version that merely contains it.
  const versionLines = `${String(probeResult?.stdout || '')}\n${String(probeResult?.stderr || '')}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!versionLines.includes(String(apiVersion))) {
    return buildFailureSpec(
      `Packaged sidecar --version output missing expected api version ${apiVersion}.`,
      { manifestPath: context.manifestPath, sidecarDir: context.sidecarDir, artifactPath: context.artifactPath }
    );
  }
  return null;
}

function resolvePackagedSidecarLaunch({
  resourcesPath = process.resourcesPath,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  apiVersion = API_VERSION,
  versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  probeVersion = true,
} = {}) {
  const validation = validatePackagedManifest({ resourcesPath, fsImpl, apiVersion });
  if (!validation.ok) {
    return validation.spec;
  }
  const context = validation.context;

  let actualSha256;
  try {
    actualSha256 = sha256File(context.artifactPath, fsImpl);
  } catch (error) {
    return buildFailureSpec(
      `Unable to hash packaged sidecar artifact: ${String(error?.message || error)}`,
      { manifestPath: context.manifestPath, sidecarDir: context.sidecarDir, artifactPath: context.artifactPath }
    );
  }
  if (actualSha256 !== context.manifestSha256) {
    return buildFailureSpec('Packaged sidecar artifact sha256 does not match manifest.', {
      manifestPath: context.manifestPath,
      sidecarDir: context.sidecarDir,
      artifactPath: context.artifactPath,
    });
  }

  if (probeVersion) {
    const probeResult = spawnSyncImpl(context.artifactPath, ['--version'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: versionTimeoutMs,
    });
    const probeFailure = evaluateVersionProbeResult(probeResult, context, context.apiVersion);
    if (probeFailure) {
      return probeFailure;
    }
  }

  return buildSuccessSpec(context, actualSha256);
}

// Async counterpart streams hashing and probes `--version` asynchronously to
// avoid blocking the main thread; validation logic is shared.
async function resolvePackagedSidecarLaunchAsync({
  resourcesPath = process.resourcesPath,
  fsImpl = fs,
  spawnImpl = spawn,
  apiVersion = API_VERSION,
  versionTimeoutMs = DEFAULT_VERSION_TIMEOUT_MS,
  probeVersion = true,
} = {}) {
  const validation = validatePackagedManifest({ resourcesPath, fsImpl, apiVersion });
  if (!validation.ok) {
    return validation.spec;
  }
  const context = validation.context;

  let actualSha256;
  const hashStartedAt = Date.now();
  try {
    actualSha256 = await sha256FileAsync(context.artifactPath, fsImpl);
  } catch (error) {
    return buildFailureSpec(
      `Unable to hash packaged sidecar artifact: ${String(error?.message || error)}`,
      { manifestPath: context.manifestPath, sidecarDir: context.sidecarDir, artifactPath: context.artifactPath }
    );
  }
  if (actualSha256 !== context.manifestSha256) {
    return buildFailureSpec('Packaged sidecar artifact sha256 does not match manifest.', {
      manifestPath: context.manifestPath,
      sidecarDir: context.sidecarDir,
      artifactPath: context.artifactPath,
    });
  }

  const hashMs = Math.max(Date.now() - hashStartedAt, 0);

  let probeMs = null;
  if (probeVersion) {
    const probeStartedAt = Date.now();
    const probeResult = await spawnVersionProbeAsync(context.artifactPath, {
      versionTimeoutMs,
      spawnImpl,
    });
    probeMs = Math.max(Date.now() - probeStartedAt, 0);
    const probeFailure = evaluateVersionProbeResult(probeResult, context, context.apiVersion);
    if (probeFailure) {
      return probeFailure;
    }
  }

  return buildSuccessSpec(context, actualSha256, { hashMs, probeMs });
}

module.exports = {
  DEFAULT_VERSION_TIMEOUT_MS,
  MANIFEST_NAME,
  resolvePackagedSidecarLaunch,
  resolvePackagedSidecarLaunchAsync,
  sha256File,
  sha256FileAsync,
};
