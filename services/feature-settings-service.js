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
  pythonRuntime: Object.freeze({ windowsOnly: true }),
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
  { managedSidecarActive, hasWorkspaceRoot, windowsOnly }
) {
  const availability = {};
  for (const field of Array.isArray(fields) ? fields : []) {
    const key = typeof field?.key === 'string' ? field.key.trim() : '';
    if (!key) {
      continue;
    }
    const override = TOOL_AVAILABILITY_OVERRIDES[key] || {};
    const requiresWindows = override.windowsOnly === true;
    const requiresWorkspaceRoot = override.workspaceRootRequired === true;
    const electronOnly = override.electronOnly === true;
    availability[key] = {
      managedSidecarRequired: true,
      ...override,
      enabled:
        (electronOnly || managedSidecarActive)
        && (!requiresWindows || windowsOnly)
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
        windowsOnly,
        workspaceRootStatus,
      },
      tools: {
        ...buildConfiguredToolAvailability(toolConfigFields, {
          managedSidecarActive,
          hasWorkspaceRoot,
          windowsOnly,
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

async function applyFeatureSettingsPatch({
  patch = {},
  shellConfigService,
  backendService,
  sendToWindow,
  env = process.env,
  platform = process.platform,
} = {}) {
  const previousConfigState = shellConfigService.getState();
  const previousFlags = buildFeatureFlags(env, previousConfigState.featureOverrides || {});
  const nextConfigState = shellConfigService.updateFeatureSettings(patch);
  const nextFlags = buildFeatureFlags(env, nextConfigState.featureOverrides || {});
  const runtimeSettingsChanged = ['tools', 'webSearch', 'featureOverrides'].some(
    (key) => JSON.stringify(previousConfigState[key]) !== JSON.stringify(nextConfigState[key])
  );
  try {
    if (runtimeSettingsChanged) {
      await Promise.resolve(backendService?.setFeatureFlags?.(nextFlags));
      await backendService.refreshManagedConfig('feature_settings_updated');
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
    shellConfigService.replaceState(previousConfigState, 'feature_settings_reverted');
    if (runtimeSettingsChanged) {
      await Promise.resolve(backendService?.setFeatureFlags?.(previousFlags));
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
  registerIpcInvokeHandlers(ipcMainLike, handlers);
}

module.exports = {
  applyFeatureSettingsPatch,
  applyWebSearchSecret,
  buildEffectiveFeatureFlags,
  buildFeatureStatePayload,
  buildWebSearchSecretStatus,
  registerFeatureIpcHandlers,
};
