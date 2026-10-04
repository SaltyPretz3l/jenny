const { buildFeatureFlags } = require('./feature-flags');
const { WEB_SEARCH_PROVIDER_KEY_IDS } = require('./backend/secure-store');
const { getBridgeChannel, registerIpcInvokeHandlers } = require('./ipc-contract');
const {
  TOOL_CONFIG_SCHEMA_VERSION,
  getToolConfigFields,
  normalizeToolSettings,
} = require('./tool-config-schema');

function buildEffectiveFeatureFlags({ shellConfigService, env = process.env } = {}) {
  const configState = shellConfigService?.getState?.() || {};
  return buildFeatureFlags(env, configState.featureOverrides || {});
}

function resolveConfiguredTools(configState = {}) {
  return normalizeToolSettings(configState.tools, configState);
}

const TOOL_AVAILABILITY_OVERRIDES = Object.freeze({
  pythonRuntime: Object.freeze({ platforms: Object.freeze(['win32', 'linux']) }),
  lsp: Object.freeze({ workspaceRootRequired: true }),
  todo: Object.freeze({ workspaceRootRequired: true }),
  browser: Object.freeze({
    electronOnly: true,
    managedSidecarRequired: false,
    workspaceRootRequired: true,
  }),
  worktree: Object.freeze({
    electronOnly: true,
    managedSidecarRequired: false,
    workspaceRootRequired: true,
  }),
  richFiles: Object.freeze({ workspaceRootRequired: true }),
  subagents: Object.freeze({ workspaceRootRequired: true }),
});

function buildConfiguredToolAvailability(
  fields,
  { managedSidecarActive, hasWorkspaceRoot, platform }
) {
  const availability = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = typeof field?.key === 'string' ? field.key.trim() : '';
    if (!key) {
      continue;
    }
    const override = TOOL_AVAILABILITY_OVERRIDES[key] || {};
    const requiresWorkspaceRoot = override.workspaceRootRequired === true;
    const electronOnly = override.electronOnly === true;
    availability[key] = {
      managedSidecarRequired: true,
      ...override,
      enabled:
        (electronOnly || managedSidecarActive)
        && (!override.platforms || override.platforms.includes(platform))
        && (!requiresWorkspaceRoot || hasWorkspaceRoot),
    };
  }
  return availability;
}

function buildFeatureStatePayload({
  shellConfigService,
  backendService,
  env = process.env,
  platform = process.platform,
} = {}) {
  const configState = shellConfigService?.getState?.() || {};
  const workspaceRootStatus = shellConfigService?.getWorkspaceRootStatus?.() || {
    state: 'missing',
    message: 'No workspace root is configured.',
  };
  const hasWorkspaceRoot = workspaceRootStatus.state === 'ready';
  const managedSidecarActive = true;
  const features = buildEffectiveFeatureFlags({ shellConfigService, env });
  const windowsOnly = platform === 'win32';
  const toolConfigFields = getToolConfigFields();

  return {
    tools: resolveConfiguredTools(configState),
    memory: {
      captureSuggestions: configState.memory?.captureSuggestions !== false,
    },
    webSearch: {
      provider: String(configState.webSearch?.provider || 'duckduckgo'),
      searxngUrl: String(configState.webSearch?.searxngUrl || ''),
    },
    toolConfig: {
      schemaVersion: TOOL_CONFIG_SCHEMA_VERSION,
      fields: toolConfigFields,
    },
    featureFlags: features,
    featureOverrides: {
      ...(configState.featureOverrides || {}),
    },
    availability: {
      runtime: {
        managedSidecarActive,
        platform,
        windowsOnly,
        workspaceRootStatus,
      },
      tools: {
        ...buildConfiguredToolAvailability(toolConfigFields, {
          managedSidecarActive,
          hasWorkspaceRoot,
          platform,
        }),
        workspaceRoot: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: hasWorkspaceRoot,
        },
        glob_files: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
        grep_search: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
        edit_file: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
        shell: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
        background_shell: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
        checkpoint_backups: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          electronOnly: true,
          enabled: hasWorkspaceRoot,
        },
      },
      featureFlags: {
        token_budget: { managedSidecarRequired: true, enabled: managedSidecarActive },
        context_compaction: { managedSidecarRequired: true, enabled: managedSidecarActive },
        api_retry: { managedSidecarRequired: true, enabled: managedSidecarActive },
        skills_system: { managedSidecarRequired: true, enabled: managedSidecarActive },
        shell_security: { managedSidecarRequired: true, enabled: managedSidecarActive },
        git_tracking: {
          managedSidecarRequired: true,
          workspaceRootRequired: true,
          enabled: managedSidecarActive && hasWorkspaceRoot,
        },
      },
    },
  };
}

const RUNTIME_SETTINGS_KEYS = ['tools', 'webSearch', 'featureOverrides'];
const FEATURE_SETTINGS_KEYS = [...RUNTIME_SETTINGS_KEYS, 'memory'];
const transactionTails = new WeakMap();
let awaitedCommitService = null;

// True only while a transaction's own commit emits 'changed'. Every commit
// reason the shell-config listener refreshes for changes tools or overrides,
// so that transaction already awaits a refresh and the listener must not race it.
function isAwaitedFeatureSettingsCommit(shellConfigService) {
  return awaitedCommitService !== null && awaitedCommitService === shellConfigService;
}

function commitFeatureSettings(shellConfigService, patch) {
  awaitedCommitService = shellConfigService;
  try {
    return shellConfigService.updateFeatureSettings(patch);
  } finally {
    awaitedCommitService = null;
  }
}

// The revision lives on the backend: its initialize flight records the revision
// it built from and publishes it on success (local-engine-status.js).
function bumpFeatureSettingsRevision(backendService) {
  if (!backendService) {
    return 0;
  }
  backendService._featureSettingsRevision = (Number(backendService._featureSettingsRevision) || 0) + 1;
  return backendService._featureSettingsRevision;
}

// A refresh can join an initialize flight built before this revision; refresh
// again until one built from it has completed. null means the save is persisted
// and no initialize ran now: there is no managed sidecar, or a GPU lease holds
// the refresh and replays it on release (the same deferred success engine
// tuning reports; rolling back would block every toggle while an image
// generates). A backend that does not track the published
// revision reads NaN and stops after one refresh. The commit precedes the first
// refresh, so only that first flight can predate it: a third unpublished
// refresh means the flight is not reporting, and the save fails instead of spinning.
const MAX_PUBLISH_REFRESHES = 3;
async function refreshUntilPublished(backendService, revision) {
  for (let attempt = 0; attempt < MAX_PUBLISH_REFRESHES; attempt += 1) {
    const result = await backendService.refreshManagedConfig('feature_settings_updated');
    if (result === null || !(Number(backendService._publishedFeatureSettingsRevision) < revision)) {
      return;
    }
  }
  throw new Error('Feature settings were saved but the runtime did not confirm them.');
}

function collectWrittenSettings(previousState, nextState) {
  const written = [];
  for (const key of FEATURE_SETTINGS_KEYS) {
    const before = previousState?.[key] || {};
    const after = nextState?.[key] || {};
    for (const subKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[subKey]) !== JSON.stringify(after[subKey])) {
        written.push({ key, subKey, before: before[subKey], after: after[subKey], existed: Object.hasOwn(before, subKey) });
      }
    }
  }
  return written;
}

// Puts back only sub-keys that still hold this transaction's value, so a commit
// that landed after it (another section or another sub-key) survives.
function restoreWrittenSettings(shellConfigService, written) {
  const restored = shellConfigService.getState();
  let changed = false;
  for (const { key, subKey, before, after, existed } of written) {
    const section = { ...(restored[key] || {}) };
    if (JSON.stringify(section[subKey]) !== JSON.stringify(after)) {
      continue;
    }
    if (existed) {
      section[subKey] = before;
    } else {
      delete section[subKey];
    }
    restored[key] = section;
    changed = true;
  }
  if (changed) {
    shellConfigService.replaceState(restored, 'feature_settings_reverted');
  }
  return shellConfigService.getState();
}

// Transactions run one at a time per config service, in submission order, so
// one save's flags, refresh and rollback never interleave with another's.
async function applyFeatureSettingsPatch(options = {}) {
  const { shellConfigService } = options;
  const run = (transactionTails.get(shellConfigService) || Promise.resolve())
    .then(() => runFeatureSettingsTransaction(options));
  transactionTails.set(shellConfigService, run.catch(() => {}));
  return run;
}

async function runFeatureSettingsTransaction({
  patch = {},
  shellConfigService,
  backendService,
  sendToWindow,
  env = process.env,
  platform = process.platform,
} = {}) {
  const previousConfigState = shellConfigService.getState();
  const nextConfigState = commitFeatureSettings(shellConfigService, patch);
  const nextFlags = buildFeatureFlags(env, nextConfigState.featureOverrides || {});
  const runtimeSettingsChanged = RUNTIME_SETTINGS_KEYS.some(
    (key) => JSON.stringify(previousConfigState[key]) !== JSON.stringify(nextConfigState[key])
  );
  const revision = runtimeSettingsChanged ? bumpFeatureSettingsRevision(backendService) : 0;
  try {
    if (runtimeSettingsChanged) {
      await Promise.resolve(backendService?.setFeatureFlags?.(nextFlags));
      await refreshUntilPublished(backendService, revision);
    }
    const payload = buildFeatureStatePayload({
      shellConfigService,
      backendService,
      env,
      platform,
    });
    sendToWindow?.(getBridgeChannel('features.onChanged', 'subscribe'), payload);
    return payload;
  } catch (error) {
    const restoredState = restoreWrittenSettings(
      shellConfigService,
      collectWrittenSettings(previousConfigState, nextConfigState)
    );
    if (runtimeSettingsChanged) {
      bumpFeatureSettingsRevision(backendService);
      await Promise.resolve(
        backendService?.setFeatureFlags?.(buildFeatureFlags(env, restoredState.featureOverrides || {}))
      );
      try {
        await backendService.refreshManagedConfig('feature_settings_rollback');
      } catch (rollbackError) {
        // Best-effort diagnostic; the original failure below is what the caller sees.
        backendService._emitServiceLog?.('ERROR', 'feature_settings.rollback_failed', {
          status: 'degraded',
          reason: 'rollback_refresh_failed',
          errorName: rollbackError?.name || 'Error',
        });
      }
    }
    sendToWindow?.(
      getBridgeChannel('features.onChanged', 'subscribe'),
      buildFeatureStatePayload({
        shellConfigService,
        backendService,
        env,
        platform,
      })
    );
    throw error;
  }
}

// Presence-only status for the web-search provider credentials: booleans per
// key id, NEVER the stored values (this payload crosses into the renderer).
function buildWebSearchSecretStatus({ backendService } = {}) {
  const secureStore = backendService?.secureStore;
  const configured = {};
  for (const keyId of WEB_SEARCH_PROVIDER_KEY_IDS) {
    let present = false;
    if (secureStore && typeof secureStore.getWebSearchProviderKey === 'function') {
      try {
        present = Boolean(String(secureStore.getWebSearchProviderKey(keyId) || '').trim());
      } catch (_error) {
        present = false;
      }
    }
    configured[keyId] = present;
  }
  return {
    configured,
    storeStatus: typeof backendService?.secureStore?.getStatus === 'function'
      ? backendService.secureStore.getStatus()
      : null,
  };
}

// Save (or clear, with an empty value) one provider credential, then push the
// refreshed key map to the sidecar over the existing managed-config channel.
// A failed SecureStore write is a real failure and rejects. A refresh failure
// AFTER a successful write does not: the key already persisted, so we log the
// refresh failure (WARN, keyId/error name only - NEVER the key value) and
// still resolve success, flagging that the sidecar hasn't picked it up yet.
async function applyWebSearchSecret({ backendService, payload } = {}) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const keyId = String(source.keyId || '').trim().toLowerCase();
  if (!WEB_SEARCH_PROVIDER_KEY_IDS.includes(keyId)) {
    throw new Error('Unknown web search provider key id.');
  }
  const secureStore = backendService?.secureStore;
  if (!secureStore || typeof secureStore.setWebSearchProviderKey !== 'function') {
    throw new Error('Credential storage is unavailable.');
  }
  secureStore.setWebSearchProviderKey(keyId, String(source.value || ''));
  let configRefreshed = true;
  try {
    await backendService.refreshManagedConfig('web_search_provider_keys_updated');
  } catch (error) {
    configRefreshed = false;
    try {
      console.warn(
        'applyWebSearchSecret: managed config refresh failed after key save.',
        { keyId, errorName: error?.name || 'Error' }
      );
    } catch (_logError) {
      void _logError;
    }
  }
  const status = await buildWebSearchSecretStatus({ backendService });
  return { ...status, configRefreshed };
}

function registerFeatureIpcHandlers({
  ipcMainLike,
  getState,
  updateSettings,
  getWebSearchSecretStatus = null,
  setWebSearchSecret = null,
  authorization = {},
} = {}) {
  const handlers = {
    'features.getState': () => getState(),
    'features.updateSettings': (_, patch) => updateSettings(patch),
  };
  if (typeof getWebSearchSecretStatus === 'function') {
    handlers['features.getWebSearchSecretStatus'] = () => getWebSearchSecretStatus();
  }
  if (typeof setWebSearchSecret === 'function') {
    handlers['features.setWebSearchSecret'] = (_, payload) => setWebSearchSecret(payload);
  }
  registerIpcInvokeHandlers(ipcMainLike, handlers, authorization);
}

module.exports = {
  applyFeatureSettingsPatch,
  applyWebSearchSecret,
  buildEffectiveFeatureFlags,
  buildFeatureStatePayload,
  buildWebSearchSecretStatus,
  isAwaitedFeatureSettingsCommit,
  registerFeatureIpcHandlers,
};
