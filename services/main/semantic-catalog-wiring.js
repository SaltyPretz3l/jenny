'use strict';

// Composition for the semantic catalog (roadmap row 41): the managed embedding
// server, model validation and profile resolution, and the idle-gated
// scheduler, attached to the backend service so the managed-sidecar config
// and the shutdown controller can reach them (main.js is at its line ceiling).

const fs = require('fs');
const path = require('path');

const { SemanticCatalogService } = require('../semantic-catalog-service');
const { createEmbeddingServerManager } = require('./embedding-server-manager');
const { resolveLaunchRuntime } = require('./llama-server-runtime');
const { resolveBinaryPath } = require('../llama-server-lifecycle');
const { probeCapabilitiesAsync } = require('../backend/llama-server-capabilities');
const { managedModelKey } = require('../shell-config-engines');
const {
  loadEmbeddingProfiles,
  resolveEmbeddingDims,
  resolveEmbeddingProfile,
  validateEmbeddingModel,
} = require('../embedding-model-profiles');

function embeddingSettings(shellConfigService) {
  try {
    return shellConfigService?.getLocalEngines?.()?.embedding || {};
  } catch (_error) {
    return {};
  }
}

// Probing an unrecorded build spawns the binary, so at most this many per resolve.
const MAX_BUILD_PROBES = 4;

// The build number a runtime reports (0 when unknown). The non-blocking probe
// is cached per unchanged binary, so it spawns at most once per build.
async function probedBuild(binaryPath) {
  try {
    return Number((await probeCapabilitiesAsync({ binaryPath })).build) || 0;
  } catch (_error) {
    return 0;
  }
}

// The llama.cpp builds the user picked for chat models, deduplicated by path:
// the last-used model's first, each with the build recorded when it was picked
// (0 when the entry predates that record).
function savedRuntimes(shellConfigService) {
  try {
    const managed = shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed;
    const perModel = managed?.perModel && typeof managed.perModel === 'object' ? managed.perModel : {};
    const lastUsed = managed?.lastUsedTag ? perModel[managedModelKey(managed.lastUsedTag)] : null;
    const byPath = new Map();
    for (const entry of [lastUsed, ...Object.values(perModel)]) {
      const runtimePath = typeof entry?.runtimePath === 'string' ? entry.runtimePath : '';
      if (!runtimePath) continue;
      const build = Number.isSafeInteger(entry.runtimeBuild) && entry.runtimeBuild > 0 ? entry.runtimeBuild : 0;
      byPath.set(runtimePath, Math.max(byPath.get(runtimePath) || 0, build));
    }
    const lastUsedPath = typeof lastUsed?.runtimePath === 'string' ? lastUsed.runtimePath : '';
    return { lastUsed: lastUsedPath, entries: [...byPath].map(([runtimePath, build]) => ({ runtimePath, build })) };
  } catch (_error) {
    return { lastUsed: '', entries: [] };
  }
}

// The executable the embedder runs: JENNY_LLAMA_SERVER_BINARY; else the newest
// build saved for any chat model when it is newer than the bundled one (an
// embedding architecture can be younger than the bundled engine: EmbeddingGemma
// 2 needs b11454+); else the bundled build; with no bundled build, the newest
// saved build (or the last-used model's, so a missing one is reported).
// Asynchronous: a cold probe never blocks the main process.
function createRuntimeResolver({
  shellConfigService,
  env = process.env,
  appRoot,
  resourcesPath,
  resolveBundled = () => resolveBinaryPath({ repoRoot: appRoot, resourcesPath }),
  resolveRuntime = resolveLaunchRuntime,
  probeBuild = probedBuild,
}) {
  return async () => {
    const bundled = String(resolveBundled() || '');
    const saved = savedRuntimes(shellConfigService);
    let runtimePath;
    if (env.JENNY_LLAMA_SERVER_BINARY) {
      runtimePath = bundled ? '' : saved.lastUsed;
    } else {
      let newest = '';
      let newestBuild = 0;
      let probes = 0;
      for (const { runtimePath: candidate, build: recorded } of saved.entries) {
        let build = recorded;
        if (!build && probes < MAX_BUILD_PROBES) {
          probes += 1;
          build = await probeBuild(candidate);
        }
        if (build > newestBuild) { newest = candidate; newestBuild = build; }
      }
      if (bundled) runtimePath = newest && newestBuild > (await probeBuild(bundled)) ? newest : '';
      else runtimePath = newest || saved.lastUsed || saved.entries[0]?.runtimePath || '';
    }
    return resolveRuntime({
      binaryOverride: String(env.JENNY_LLAMA_SERVER_BINARY || ''),
      runtimePath,
      resolveBundledPath: () => bundled,
    });
  };
}

// settings -> { ok, name, profileId, dims, queryTemplate, documentTemplate }.
// Validation reads up to 16 MiB of GGUF header synchronously, and the scheduler
// asks before every step, so the verdict is cached per file identity + choice.
function createModelResolver({
  profilesPath,
  validateModel = validateEmbeddingModel,
  loadProfiles = loadEmbeddingProfiles,
  statImpl = (filePath) => fs.statSync(filePath),
}) {
  let cached = { key: '', value: null };
  return (settings) => {
    let identity = 'missing';
    try {
      const stat = statImpl(settings.modelPath);
      identity = `${stat.size}|${stat.mtimeMs}`;
    } catch (_error) { /* validateModel reports the unreadable file */ }
    const key = [settings.modelPath, identity, settings.profileId, settings.dims].join('|');
    if (cached.key !== key) cached = { key, value: resolveModel(settings) };
    return cached.value;
  };

  function resolveModel(settings) {
    const validation = validateModel(settings.modelPath);
    if (!validation || validation.ok !== true) {
      return { ok: false, reason: String(validation?.reason || 'unreadable') };
    }
    const profiles = loadProfiles({ filePath: profilesPath });
    const profile = resolveEmbeddingProfile({
      architecture: validation.architecture,
      name: validation.name,
      fileName: path.basename(settings.modelPath),
      overrideId: settings.profileId,
      profiles,
    });
    return {
      ok: true,
      name: String(validation.name || path.basename(settings.modelPath, path.extname(settings.modelPath))).slice(0, 120),
      profileId: profile.id,
      dims: resolveEmbeddingDims(profile, settings.dims),
      queryTemplate: profile.query,
      documentTemplate: profile.document,
    };
  }
}

function wireSemanticCatalog({
  backendService,
  shellConfigService,
  knowledgeService,
  buildEffectiveFeatureFlags,
  userDataPath,
  resourcesPath = '',
  appRoot,
  log,
  sendBridgeEvent = null,
  createManager = createEmbeddingServerManager,
  ServiceClass = SemanticCatalogService,
} = {}) {
  const embeddingManager = createManager({
    userDataPath,
    resourcesPath,
    repoRoot: appRoot,
    logger: log,
    onStateChange: () => service.notifyChanged('engine'),
    resolveRuntime: createRuntimeResolver({ shellConfigService, appRoot, resourcesPath }),
  });
  const service = new ServiceClass({
    userDataPath,
    getBackend: () => backendService,
    getSettings: () => embeddingSettings(shellConfigService),
    isFeatureEnabled: () => buildEffectiveFeatureFlags?.()?.semantic_catalog === true,
    embeddingManager,
    resolveModel: createModelResolver({ profilesPath: path.join(appRoot, 'config', 'embedding-prompt-profiles.json') }),
    listRootPaths: () => knowledgeService?.getAllRootPaths?.() || [],
    refreshSidecarConfig: (reason) => backendService.refreshManagedConfig?.(reason),
    logger: log,
  });
  backendService.semanticCatalogService = service;

  knowledgeService?.on?.('changed', () => service.notifyChanged('roots'));
  let lastSettingsKey = JSON.stringify(embeddingSettings(shellConfigService));
  shellConfigService?.on?.('changed', () => {
    const key = JSON.stringify(embeddingSettings(shellConfigService));
    if (key === lastSettingsKey) return;
    lastSettingsKey = key;
    service.notifyChanged('settings');
  });
  if (typeof sendBridgeEvent === 'function') {
    service.on('status', (status) => sendBridgeEvent('catalog.onStatus', status));
  }
  service.start();
  return service;
}

module.exports = { createModelResolver, createRuntimeResolver, wireSemanticCatalog };
