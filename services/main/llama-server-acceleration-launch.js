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
const { resolveGgufPath } = require('../llama-server-lifecycle');
const { readGgufHeader } = require('../gguf-header');

function offResult(reason) {
  return {
    mode: 'off',
    extraArgs: [],
    vramHeadroomMb: 0,
    reason,
    drafter: '',
  };
}

// `<arch>.nextn_predict_layers` of the model GGUF: 0 when the header has no
// such key, null when the header cannot be read (the resolver then keeps its
// pre-header behavior). The tokenizer arrays sit in the header, so the read
// budget is larger than the architecture-only probe's (Qwen3.8 needs ~10 MB;
// one synchronous read per launch, ~40 ms).
function readEmbeddedMtpLayers(modelPath, { readHeader = readGgufHeader } = {}) {
  if (!modelPath) {
    return null;
  }
  try {
    const { architecture, kv } = readHeader(modelPath, { maxBytes: 32 * 1024 * 1024 });
    const layers = architecture ? kv[`${architecture}.nextn_predict_layers`] : undefined;
    return Number.isInteger(layers) && layers >= 0 ? layers : 0;
  } catch (_error) {
    return null;
  }
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
  // The executable this launch spawns, resolved once by the manager
  // (llama-server-runtime.js), so the probe and the spawn can never disagree.
  // Empty means none was found: the probe fails and acceleration stays off.
  binaryPath = '',
  profile = null,
  featureFlags = {},
  shellAcceleration = null,
  repoRoot = process.cwd(),
  userDataPath = '',
  probeCapabilitiesImpl = probeCapabilities,
  loadAccelerationCatalogImpl = loadAccelerationCatalog,
  resolveAccelerationArgsImpl = resolveAccelerationArgs,
  resolveGgufPathImpl = resolveGgufPath,
  readEmbeddedMtpLayersImpl = readEmbeddedMtpLayers,
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
      embeddedMtpLayers: readEmbeddedMtpLayersImpl(resolvedModel && resolvedModel.path),
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
  // accel args ARE a plausible cause of those. So does model_unsupported: the
  // file the build cannot read may be the MTP drafter, which the retry leaves out.
  const deterministic = message.startsWith('llama_server_binary_not_found')
    || message.startsWith('llama_server_model_not_found:');
  return Array.isArray(accelExtraArgs)
    && accelExtraArgs.length > 0
    && aborted !== true
    && !deterministic
    && message !== 'readiness_aborted';
}

module.exports = {
  readEmbeddedMtpLayers,
  resolveLaunchAcceleration,
  shouldRetryWithoutAcceleration,
};
