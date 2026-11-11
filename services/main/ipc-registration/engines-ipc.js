const path = require('path');
const { ExclusiveGpuCoordinator } = require('../../backend/exclusive-gpu-coordinator');
const { registerLlamaServerIpcHandlers } = require('../llama-server-ipc-handlers');
const { resolveBinaryPath } = require('../../llama-server-lifecycle');
const { registerCloudModelsWithTransfer } = require('../conversation-transfer-registration');
const { registerChatGptPlanUsageIpc } = require('../chatgpt-plan-usage-ipc');
const { registerIpcInvokeHandlers } = require('../../ipc-contract');
const { t } = require('../../i18n-main');
const { loadAccelerationCatalog } = require('../../backend/llama-server-acceleration');
const { writeManagedPatch } = require('../llama-server-runtime');
const { buildFeatureFlags } = require('../../feature-flags');
const { normalizePreferredEngineType } = require('../../shell-config-state');
const { triggerProviderSidecarReinit } = require('../../provider-auth-runtime');

// Engines domain IPC: the local engines (Ollama daemon and tray remediation,
// managed llama-server, the exclusive-GPU coordinator), the ChatGPT cloud
// catalog and plan usage, the models.* library channels and the Settings →
// Offline engines snapshot. The CLI-on-PATH installer registers between the
// Ollama daemon and tray channels, so registerEngineIpcHandlers carries it to
// keep the registration order.

// ollamaTray.* namespace: owner-triggered remediation for the Ollama
// tray-app conflict (see ollama-tray-conflict.js for detection and
// ollama-tray-remediation.js for the remediation actions). Gated by the
// ollama_tray_remediation feature flag; a disabled flag or missing
// backendService means nothing is registered (channels stay unhandled).
// Every handler is fail-soft — it never throws across the IPC boundary.
//
// detectImpl/quitImpl/disableImpl are injectable seams purely for
// determinism in tests; production callers omit them and get the real
// detection/remediation module functions.
function registerOllamaTrayRemediationIpcHandlers(ipcMainLike, {
  backendService,
  log,
  enabled = false,
  authorization = {},
  detectImpl,
  quitImpl,
  disableImpl,
} = {}) {
  if (!enabled || !backendService) {
    return [];
  }

  const logEvent = typeof log === 'function' ? log : () => {};
  const {
    detectOllamaTrayConflictAsync,
  } = require('../../backend/ollama-tray-conflict');
  const {
    quitOllamaTrayAppSync,
    disableOllamaStartupShortcutsSync,
  } = require('../../backend/ollama-tray-remediation');

  // Async default: the sync scan's PowerShell process list (~1 s) blocked the
  // main process, and the renderer asks for this status during boot.
  const detect = detectImpl || detectOllamaTrayConflictAsync;
  const quit = quitImpl || quitOllamaTrayAppSync;
  const disable = disableImpl || disableOllamaStartupShortcutsSync;

  return registerIpcInvokeHandlers(ipcMainLike, {
    'ollamaTray.status': async () => {
      try {
        const { detected, trayProcesses, startupShortcuts } = await detect({
          platform: process.platform,
          env: process.env,
          logger: undefined,
        }) || {};
        return {
          ok: true,
          supported: process.platform === 'win32',
          platform: process.platform,
          detected: Boolean(detected),
          trayProcesses: Array.isArray(trayProcesses) ? trayProcesses : [],
          startupShortcuts: Array.isArray(startupShortcuts) ? startupShortcuts : [],
        };
      } catch (error) {
        return { ok: false, reason: String((error && error.message) || error) };
      }
    },
    'ollamaTray.quitTrayApp': () => {
      let result;
      try {
        result = quit({});
      } catch (error) {
        result = { ok: false, killedPids: [], reason: String((error && error.message) || error) };
      }
      logEvent(result.ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_quit', {
        killedPids: result.killedPids,
        reason: result.reason,
      });
      return result;
    },
    'ollamaTray.disableStartupShortcut': () => {
      let result;
      try {
        result = disable({});
      } catch (error) {
        result = { ok: false, disabled: [], skipped: [], reason: String((error && error.message) || error) };
      }
      logEvent(result.ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_disable_startup', {
        disabled: result.disabled,
        skipped: result.skipped,
        reason: result.reason,
      });
      return result;
    },
    'ollamaTray.restartEngine': async () => {
      try {
        const manager = backendService.ollamaManager;
        await manager.stop();
        const startResult = await manager.start();
        let running = Boolean(startResult && startResult.started);
        if (!running && typeof manager._isRunning === 'function') {
          running = Boolean(await manager._isRunning());
        }
        const ok = running;
        const result = {
          ok,
          running,
          ...(ok ? {} : { reason: (startResult && startResult.failure && startResult.failure.remediation)
            || 'engine_not_running' }),
        };
        logEvent(ok ? 'INFO' : 'WARN', 'ollama.tray_remediation_restart', {
          running: result.running,
          reason: result.reason,
        });
        return result;
      } catch (error) {
        const result = { ok: false, running: false, reason: String((error && error.message) || error) };
        logEvent('WARN', 'ollama.tray_remediation_restart', {
          running: result.running,
          reason: result.reason,
        });
        return result;
      }
    },
  }, authorization);
}

function registerEngineIpcHandlers(ipcMain, {
  app,
  backendService,
  shellConfigService,
  processRef,
  dialog,
  getMainWindow,
  getLlamaServerManager,
  attachmentAssetStore,
  sendBridgeEvent,
  log,
  getMainLifecycle,
  workspaceAuthorization,
}) {
  require('../ollama-daemon-ipc').registerOllamaDaemonIpcHandlers(ipcMain, {
    getManager: () => backendService?.ollamaManager, authorization: workspaceAuthorization,
  });
  require('../cli-path-ipc-handlers').registerCliPathIpcHandlers(ipcMain, {
    service: require('../../cli-path-service').createCliPathService({
      platform: processRef.platform, isPackaged: app.isPackaged === true,
      resourcesPath: processRef.resourcesPath, env: processRef.env,
    }),
    authorization: workspaceAuthorization,
  });
  registerOllamaTrayRemediationIpcHandlers(ipcMain, {
    backendService,
    log,
    authorization: workspaceAuthorization,
    enabled: backendService?.featureFlags?.ollama_tray_remediation === true,
  });
  registerLlamaServerIpcHandlers(ipcMain, {
    getManager: getLlamaServerManager, authorization: workspaceAuthorization,
    userDataPath: app.getPath('userData'),
    repoRoot: processRef.cwd(),
    getMainWindow,
    dialogImpl: dialog,
    log,
    getPersistedModels: () => Object.values(
      shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.perModel || {}
    ).map((entry) => ({ tag: entry?.tag || '', modelPath: entry?.modelPath || '' })),
    getLibraryRoots: () => (
      shellConfigService?.getLocalEngines?.()?.openaiCompatible?.managed?.libraryRoots || []
    ),
    getOllamaTags: async () => {
      const payload = await backendService.listModelsForEngine('ollama');
      return payload?.available === false ? [] : (Array.isArray(payload?.data) ? payload.data : [])
        .map((entry) => String(entry?.id || '').trim()).filter(Boolean);
    },
    getOllamaBlob: (tag) => backendService.getOllamaModelBlob(tag),
    // The env override launches instead of the bundled build, so its verdict
    // would be about the wrong binary: none then.
    resolveBundledRuntime: () => (String(processRef.env?.JENNY_LLAMA_SERVER_BINARY || '').trim() ? '' : resolveBinaryPath({
      repoRoot: processRef.cwd(),
      resourcesPath: processRef.resourcesPath,
    }) || ''),
  });
  const exclusiveGpuCoordinator = backendService.exclusiveGpuCoordinator
    || new ExclusiveGpuCoordinator({ logger: log });
  backendService.exclusiveGpuCoordinator = exclusiveGpuCoordinator;
  const disposeExclusiveGpu = () => exclusiveGpuCoordinator.dispose?.();
  const gpuLifecycle = getMainLifecycle?.();
  if (typeof gpuLifecycle?.registerShutdownTask === 'function') {
    gpuLifecycle.registerShutdownTask(disposeExclusiveGpu);
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', disposeExclusiveGpu);
  }
  // Remote Control was removed (owner, 2026-10-02): drop the pairing record it
  // left in the secure store. A store that is unreadable now is tried again on
  // the next start.
  try {
    const purged = backendService?.secureStore?.purgeRetiredSecrets?.() || [];
    if (purged.length > 0) log('INFO', 'secure_store.retired_secrets_purged', { count: purged.length });
  } catch (_error) { /* best effort */ }
  // Core owner of the ChatGPT catalog and the cloudModels.* IPC.
  registerCloudModelsWithTransfer(ipcMain, { app, backendService, shellConfigService, sendBridgeEvent,
    processRef, attachmentAssetStore, authorization: workspaceAuthorization, log, getMainLifecycle });
  // Composed AFTER registerCloudModels so backendService.chatgptAuthService
  // (the core ChatGPT auth owner) already exists to attach the sign-out clear.
  const teardownChatgptPlanUsageIpc = registerChatGptPlanUsageIpc(ipcMain, {
    authorization: workspaceAuthorization,
    app,
    backendService,
    shellConfigService,
    sendBridgeEvent,
    log,
  });
  const chatgptPlanUsageLifecycle = getMainLifecycle?.();
  if (typeof chatgptPlanUsageLifecycle?.registerShutdownTask === 'function') {
    chatgptPlanUsageLifecycle.registerShutdownTask(teardownChatgptPlanUsageIpc);
  } else if (typeof app?.once === 'function') {
    app.once('will-quit', teardownChatgptPlanUsageIpc);
  }
}

function registerModelIpcHandlers(ipcMain, { backendService, setupService, workspaceAuthorization }) {
  registerIpcInvokeHandlers(ipcMain, {
    'models.list': () => backendService.listModels(),
    // Raw installed Ollama tags for the Model Library. Scoped to the ollama
    // engine regardless of the chat engine, so it reuses the sidecar's raw Ollama
    // catalog directly instead of the unified chat picker catalog and its
    // provider entries.
    'models.listOllamaTags': () => backendService.listModelsForEngine('ollama'),
    // No ownStreamId: a user-driven activation excludes no stream, so ANY live
    // response refuses the switch (see loadModel).
    'models.load': (_, model) => backendService.loadModel(model),
    'models.unload': () => backendService.unloadModel({ stopManagedServer: true }),
    'models.delete': (_, payload) => {
      if (!setupService) {
        return {
          status: 'failed',
          code: 'setup_unavailable',
          message: t('main.setup.unavailable', 'Setup service is unavailable.'),
        };
      }
      const model = String((payload && payload.model) || '').trim();
      // Ollama tags are case-insensitive and a bare name means `:latest`, so
      // the loaded model ("gemma3") must match its list id ("gemma3:latest")
      // or the guard is defeatable. Mirrors renderer-model-library-format-utils.js.
      const canonicalTag = (value) => {
        const tag = String(value || '').trim().toLowerCase();
        if (!tag) return '';
        const lastSegment = tag.slice(tag.lastIndexOf('/') + 1);
        return lastSegment.includes(':') ? tag : `${tag}:latest`;
      };
      if (model && canonicalTag(model) === canonicalTag(backendService.currentModel)) {
        return {
          status: 'failed',
          code: 'model_in_use',
          message: t('main.models.loadedModelDeleteBlocked', '"{model}" is the currently loaded model. Unload it before deleting.', { model }),
        };
      }
      return setupService.deleteOllamaModel(payload);
    },
  }, workspaceAuthorization);
}

function registerEngineSettingsIpcHandlers(ipcMainLike, {
  backendService,
  shellConfigService,
  offlineIntelligenceService,
  processRef,
  log,
  ipcAuthorization,
}) {
  registerIpcInvokeHandlers(ipcMainLike, {
    'offline.getState': () => offlineIntelligenceService.getState(),
    // Bounded engine-settings snapshot for the Settings → Offline engines panel;
    // reads shell config only (no secrets — tokens stay in SecureStore).
    'engines.getSettings': () => {
      const flags = buildFeatureFlags(processRef?.env || process.env,
        shellConfigService?.getState?.()?.featureOverrides || {});
      // Anchor the catalog to the repo root (the services/ parent), not cwd — a
      // packaged app launches with an arbitrary working directory.
      const catalog = flags.llama_server_acceleration === true
        ? loadAccelerationCatalog({ repoRoot: path.join(__dirname, '..', '..', '..') }).catalog : null;
      const accelerationCatalog = catalog && {
        defaults: { vramHeadroomMb: catalog.defaults.vramHeadroomMb },
        families: catalog.families.map(({ family, matchPrefixes, mtp, vramHeadroomMb }) => ({
          family,
          matchPrefixes,
          mtp,
          ...(Number.isFinite(vramHeadroomMb) && vramHeadroomMb >= 0 ? { vramHeadroomMb } : {}),
        })),
      };
      return {
        localEngines: shellConfigService?.getLocalEngines?.() || null,
        preferredEngineType: String(shellConfigService?.getState?.()?.preferredEngineType || ''),
        ...(flags.llama_server_acceleration === true ? { accelerationCatalog } : {}),
      };
    },
    'engines.updateSettings': (_, payload) => {
      const currentSettings = () => ({
        localEngines: shellConfigService?.getLocalEngines?.() || null,
        preferredEngineType: String(shellConfigService?.getState?.()?.preferredEngineType || ''),
      });
      if (Object.prototype.hasOwnProperty.call(payload || {}, 'preferredEngineType')) {
        const requested = String(payload.preferredEngineType || '').trim().toLowerCase();
        const preferredEngineType = normalizePreferredEngineType(requested);
        if (preferredEngineType === requested) {
          shellConfigService?.updatePreferredEngineType?.(preferredEngineType);
          if (preferredEngineType === 'chatgpt') {
            triggerProviderSidecarReinit(backendService, shellConfigService, log, 'engine_switched');
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload || {}, 'startupModelLoad')) {
        const enabled = Boolean(payload.startupModelLoad);
        shellConfigService?.updateStartupModelLoad?.(enabled);
        log?.('INFO', 'engines.startup_model_load_updated', { enabled });
      }
      const hasAcceleration = Object.prototype.hasOwnProperty.call(payload || {}, 'acceleration');
      const hasManaged = Object.prototype.hasOwnProperty.call(payload || {}, 'managed');
      const keys = hasManaged ? Object.keys(payload.managed?.perModel || {})
        .filter((key) => typeof key === 'string').map((key) => key.slice(0, 128)).slice(0, 64).sort() : [];
      const roots = hasManaged && Array.isArray(payload.managed?.libraryRoots)
        ? payload.managed.libraryRoots.length : 0;
      if (hasAcceleration || hasManaged) {
        const flags = buildFeatureFlags(
          processRef?.env || process.env,
          shellConfigService?.getState?.()?.featureOverrides || {}
        );
        if (flags.llama_server_acceleration === true) {
          if (hasAcceleration) {
            shellConfigService?.updateLocalEngineAcceleration?.(payload.acceleration);
          }
          if (hasManaged) {
            // Per-model runtime paths only land when this session's picker recorded them.
            writeManagedPatch({
              shellConfigService,
              patch: payload.managed,
              picks: backendService?.options?.getLlamaServerManager?.()?.runtimePicks || null,
              log: (level, event, details) => log?.(level, event, details),
            });
            log?.('INFO', 'engines.managed_updated', { keys, roots });
          }
        } else if (hasManaged) {
          log?.('WARN', 'engines.managed_dropped_flag_off', { keys, roots });
        }
      }
      return currentSettings();
    },
    'offline.getDiagnostics': () => offlineIntelligenceService.getDiagnostics(),
    'offline.updateSettings': (_, patch) => offlineIntelligenceService.updateSettings(patch),
  }, ipcAuthorization);
}

module.exports = {
  registerEngineIpcHandlers,
  registerEngineSettingsIpcHandlers,
  registerModelIpcHandlers,
  registerOllamaTrayRemediationIpcHandlers,
};
