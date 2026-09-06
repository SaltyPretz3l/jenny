'use strict';

const fs = require('fs');
const path = require('path');

const {
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('../backend/backend-config');
const {
  loadAccelerationCatalog,
  resolveAccelerationArgs,
} = require('../backend/llama-server-acceleration');
const { probeCapabilities } = require('../backend/llama-server-capabilities');
const {
  resolveBinaryPath,
  resolveGgufPath,
} = require('../llama-server-lifecycle');

function offResult(reason) {
  return {
    mode: 'off',
    extraArgs: [],
    vramHeadroomMb: 0,
    reason,
    drafter: '',
  };
}

function normalizeResult(result) {
  return {
    mode: ['off', 'mtp', 'ngram'].includes(result && result.mode) ? result.mode : 'off',
    extraArgs: Array.isArray(result && result.extraArgs) ? result.extraArgs : [],
    vramHeadroomMb: Number.isFinite(result && result.vramHeadroomMb)
      ? result.vramHeadroomMb
      : 0,
    reason: String(result && result.reason || 'resolve_error'),
    drafter: String(result && result.drafter || ''),
  };
}

function resolveLaunchAcceleration({
  settings = {},
  profile = null,
  featureFlags = {},
  shellAcceleration = null,
  repoRoot = process.cwd(),
  resourcesPath = '',
  userDataPath = '',
  probeCapabilitiesImpl = probeCapabilities,
  loadAccelerationCatalogImpl = loadAccelerationCatalog,
  resolveAccelerationArgsImpl = resolveAccelerationArgs,
  resolveBinaryPathImpl = resolveBinaryPath,
  resolveGgufPathImpl = resolveGgufPath,
  fsImpl = fs,
} = {}) {
  try {
    if (featureFlags.llama_server_acceleration !== true) {
      return offResult('flag_off');
    }
    const requested = profile && profile.acceleration
      ? profile.acceleration
      : (shellAcceleration || { mode: 'off' });
    if (requested.mode === 'off') {
      return offResult('disabled');
    }

    const modelTag = profile ? profile.modelTag : DEFAULT_MANAGED_SHELL_MODEL;
    const binaryPath = settings.binaryOverride
      || resolveBinaryPathImpl({ repoRoot, resourcesPath });
    const capabilities = probeCapabilitiesImpl({ binaryPath });
    const loadedCatalog = loadAccelerationCatalogImpl({ repoRoot });
    const catalog = loadedCatalog && !loadedCatalog.error ? loadedCatalog.catalog : null;
    const resolvedModel = settings.modelPathOverride
      ? { path: settings.modelPathOverride }
      : resolveGgufPathImpl({ modelTag, userDataPath, repoRoot });
    const modelDir = resolvedModel && resolvedModel.path
      ? path.dirname(resolvedModel.path)
      : '';

    const result = normalizeResult(resolveAccelerationArgsImpl({
      modelTag,
      mode: requested.mode,
      draftNMax: requested.draftNMax || undefined,
      allowUnverified: requested.allowUnverified,
      catalog,
      capabilities,
      profileExtraArgs: profile ? profile.extraArgs : [],
      modelDir,
      fsImpl,
    }));
    // A projector's residency is not an acceleration cost.
    // No free-VRAM measurement exists at this point.
    return result;
  } catch (_error) {
    return offResult('resolve_error');
  }
}

function shouldRetryWithoutAcceleration({ error, accelExtraArgs, aborted } = {}) {
  const message = String(error && error.message || error);
  // Deterministic pre-spawn failures (missing binary / missing model) cannot be
  // caused by the acceleration args, so retrying without them just doubles the
  // failure. Child-exit and readiness-timeout failures stay retryable — bad
  // accel args ARE a plausible cause of those.
  const deterministic = message.startsWith('llama_server_binary_not_found')
    || message.startsWith('llama_server_model_not_found:');
  return Array.isArray(accelExtraArgs)
    && accelExtraArgs.length > 0
    && aborted !== true
    && !deterministic
    && message !== 'readiness_aborted';
}

module.exports = {
  resolveLaunchAcceleration,
  shouldRetryWithoutAcceleration,
};
