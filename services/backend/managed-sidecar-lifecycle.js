const { SidecarClient } = require('./sidecar-client');
const {
  handleMonitorNotification,
} = require('./monitor-event-service');
const {
  inferEngineTypeFromModel,
  normalizeModelCapabilities,
  getManagedReasoningEffortSupport,
} = require('./backend-service-utils');
const {
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  getConfiguredTelemetrySettings,
  getConfiguredToolsWorkspaceRoot,
} = require('./managed-sidecar-config');
const {
  buildManagedStatusSnapshot,
  normalizeToolsStatus,
  toolsAvailableFromStatus,
  normalizeLocalRuntime,
  deriveActiveModelCapabilitiesFromLocalRuntime,
} = require('./managed-sidecar-status');

function detachSidecarClientErrorListener(service, client = service.sidecarClient) {
  if (!client) {
    service._sidecarClientErrorListener = null;
    service._sidecarClientLateNotificationListener = null;
    service._sidecarClientMonitorNotificationListener = null;
    return;
  }
  if (service._sidecarClientErrorListener) {
    if (typeof client.off === 'function') {
      client.off('error', service._sidecarClientErrorListener);
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('error', service._sidecarClientErrorListener);
    }
  }
  if (service._sidecarClientLateNotificationListener) {
    if (typeof client.off === 'function') {
      client.off('late-notification', service._sidecarClientLateNotificationListener);
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('late-notification', service._sidecarClientLateNotificationListener);
    }
  }
  if (service._sidecarClientMonitorNotificationListener) {
    if (typeof client.off === 'function') {
      client.off('notification', service._sidecarClientMonitorNotificationListener);
    } else if (typeof client.removeListener === 'function') {
      client.removeListener('notification', service._sidecarClientMonitorNotificationListener);
    }
  }
}

function disposeSidecarClient(service) {
  if (!service.sidecarClient) {
    service._sidecarClientErrorListener = null;
    service._sidecarClientLateNotificationListener = null;
    service._sidecarClientMonitorNotificationListener = null;
    return;
  }
  const client = service.sidecarClient;
  detachSidecarClientErrorListener(service, client);
  service.sidecarClient = null;
  service._sidecarClientErrorListener = null;
  service._sidecarClientLateNotificationListener = null;
  service._sidecarClientMonitorNotificationListener = null;
  client.dispose();
}

function createSidecarClient(service) {
  const client = new SidecarClient();
  const errorListener = (error) => {
    service._emitServiceLog('ERROR', 'sidecar.client_error', {
      message: String(error && error.message || error),
    });
  };
  const lateNotificationListener = (message) => {
    if (typeof service._recordLateSidecarEvent === 'function') {
      service._recordLateSidecarEvent(message);
    }
  };
  const monitorNotificationListener = (message) => {
    if (message && message.method === 'monitor.event') {
      handleMonitorNotification(service, message);
    }
  };
  service._sidecarClientErrorListener = errorListener;
  service._sidecarClientLateNotificationListener = lateNotificationListener;
  service._sidecarClientMonitorNotificationListener = monitorNotificationListener;
  client.on('error', errorListener);
  client.on('late-notification', lateNotificationListener);
  client.on('notification', monitorNotificationListener);
  return client;
}

function ensureSidecarClientAttached(service) {
  if (!service.sidecarClient) {
    service.sidecarClient = createSidecarClient(service);
  }
  if (!service.sidecarManager.process) {
    throw new Error('Managed sidecar process is unavailable.');
  }
  const needsAttach =
    service.sidecarClient.process !== service.sidecarManager.process
    || service.sidecarClient.connected !== true;
  if (needsAttach) {
    service.sidecarClient.attachProcess(service.sidecarManager.process);
  }
}

async function initializeManagedSidecar(
  service,
  { signal = null, timeoutMs = null, onProgress = null, applyResult = true } = {}
) {
  ensureSidecarClientAttached(service);
  const telemetrySettings = getConfiguredTelemetrySettings(service);
  const payload = await service.sidecarClient.initialize({
    config: buildManagedSidecarConfig(service, { telemetrySettings }),
    secrets: buildManagedSidecarSecrets(service, { telemetrySettings }),
    clientVersion: service.appVersion,
  }, {
    signal,
    timeoutMs,
    onProgress,
  });
  return applyResult ? applyManagedInitializePayload(service, payload) : payload;
}

function applyManagedInitializePayload(service, payload = {}) {
  const requestedEngineType = String(
    service.currentEngineType
    || inferEngineTypeFromModel(service.currentModel || service.defaultModel)
    || 'mock'
  );
  const requestedModel = String(service._managedPendingModel || service.currentModel || '').trim();
  const defaultModel = String(service.defaultModel || '').trim();
  const payloadEngine = String(payload.active_engine || '').trim() || requestedEngineType || 'mock';
  const payloadModel = String(payload.active_model || '').trim();
  const startupVllmFallbackToOllama =
    (!requestedModel || requestedModel === defaultModel)
    && payloadEngine === 'mock'
    && requestedEngineType === 'vllm';
  const ignoreStartupMockFallback =
    !requestedModel
    && payloadEngine === 'mock'
    && requestedEngineType !== 'mock'
    && !startupVllmFallbackToOllama;
  const effectiveEngine = String(
    startupVllmFallbackToOllama
      ? 'ollama'
      : ignoreStartupMockFallback
        ? requestedEngineType
        : payloadEngine || requestedEngineType || 'mock'
  ).trim().toLowerCase() || 'mock';
  const providerCapabilities =
    payload.provider_capabilities && typeof payload.provider_capabilities === 'object'
      ? payload.provider_capabilities
      : {};
  const providerCapabilityProfiles = Array.isArray(payload.provider_capability_profiles)
    ? payload.provider_capability_profiles
    : [];
  const activeModelCapabilities = normalizeModelCapabilities(
    payload.active_model_capabilities
    || deriveActiveModelCapabilitiesFromLocalRuntime(payload.local_runtime)
  );
  const activeModelReasoningSupport = String(
    payload.active_model_reasoning_support
    || getManagedReasoningEffortSupport(effectiveEngine, providerCapabilities, {
      activeModelCapabilities,
      modelId: (ignoreStartupMockFallback || startupVllmFallbackToOllama) ? '' : payloadModel,
      localRuntime: payload.local_runtime,
    })
  ).trim().toLowerCase() || 'unsupported';
  const toolsStatus = normalizeToolsStatus(payload.tools_status, payload.tools_available || []);
  const toolsAvailable = toolsAvailableFromStatus(toolsStatus, payload.tools_available || []);
  const clearedContext = {
    native_context_length: null,
    configured_context_length: null,
    effective_context_length: null,
  };
  const contextMetadata =
    (ignoreStartupMockFallback || startupVllmFallbackToOllama)
      ? clearedContext
      : {
        native_context_length: payload.native_context_length,
        configured_context_length: payload.configured_context_length,
        effective_context_length: payload.effective_context_length,
      };
  const localRuntime = normalizeLocalRuntime(payload.local_runtime, {
    engine: effectiveEngine,
    model: (ignoreStartupMockFallback || startupVllmFallbackToOllama) ? '' : payloadModel,
    modelLoaded: (ignoreStartupMockFallback || startupVllmFallbackToOllama) ? false : Boolean(payloadModel),
    activeModelCapabilities,
    activeModelReasoningSupport,
    engineFallback: payload.engine_fallback || null,
    context: contextMetadata,
    templateDiagnostics: payload.template_diagnostics || null,
  });

  service._lastEngineFallback = localRuntime.fallback.active === true
    ? {
      requested_engine: localRuntime.fallback.requested_engine,
      reason: localRuntime.fallback.reason,
    }
    : null;
  service.reasoningEffortSupport = localRuntime.reasoning.support || activeModelReasoningSupport;
  service.currentEngineType = String(localRuntime.engine?.type || effectiveEngine).trim().toLowerCase() || effectiveEngine;
  service.currentModel = (ignoreStartupMockFallback || startupVllmFallbackToOllama)
    ? ''
    : String(localRuntime.model?.id || payloadModel || '').trim();

  service.currentStatus = buildManagedStatusSnapshot(service, {
    engine: effectiveEngine,
    model: (ignoreStartupMockFallback || startupVllmFallbackToOllama) ? '' : payloadModel,
    model_loaded: (ignoreStartupMockFallback || startupVllmFallbackToOllama) ? false : Boolean(payloadModel),
    provider_capabilities: providerCapabilities,
    provider_capability_profiles: providerCapabilityProfiles,
    local_runtime: localRuntime,
    active_model_capabilities: activeModelCapabilities,
    tools_status: toolsStatus,
    tools_available: toolsAvailable,
    memory: payload.memory || {},
    mcp_servers_connected: payload.mcp_servers_connected,
    mcp_servers_failed: payload.mcp_servers_failed,
    mcp_servers: payload.mcp_servers,
    mcp_server_cooldowns: payload.mcp_server_cooldowns,
    schema_versions: payload.schema_versions,
  });
  if (typeof service._normalizeManagedReasoningEfforts === 'function') {
    service._normalizeManagedReasoningEfforts();
  }
  return payload;
}

async function restartManagedSidecar(service, reason) {
  service._emitServiceLog('INFO', 'sidecar.restart_requested', { reason });
  try {
    service.currentStatus = null;
    service._modelLifecycle = {
      ...(service._modelLifecycle || {}),
      state: 'unloaded',
      status: 'Sidecar restarting',
      percent: 0,
      completed_bytes: 0,
      total_bytes: 0,
      error_code: '',
      ready_at: null,
    };
    const status = await service.sidecarManager.retryStart();
    if (String(status?.phase || '').trim() !== 'ready') {
      throw new Error(`Managed sidecar restart did not reach ready phase: ${String(status?.phase || 'unknown')}`);
    }
    await service._initializeManagedSidecar({ reason: 'restart' });
    await service.refreshStatusSnapshot().catch(() => null);
    return true;
  } catch (error) {
    service._emitServiceLog('ERROR', 'sidecar.restart_failed', {
      reason,
      message: String(error && error.message || error),
    });
    return false;
  }
}

async function refreshManagedConfig(service, reason = 'config_updated', {
  requestedEngineType = '',
  // Callers that block a user gesture on the refresh (sign-out reconfiguration)
  // need a tighter bound than the flight defaults (300s / 615s).
  // normalizePositiveTimeout in local-engine-status.js validates them; null
  // means "keep the default", so they are only forwarded when set.
  inactivityTimeoutMs = null,
  absoluteTimeoutMs = null,
} = {}) {
  if (!service.sidecarClient || !service.sidecarManager.process) {
    return null;
  }
  service._emitServiceLog('INFO', 'sidecar.config_refresh_requested', { reason });
  // Snapshot state before the RPC so we can roll back on failure.
  const prevModel = service.currentModel;
  const prevEngineType = service.currentEngineType;
  const prevReasoningSupport = service.reasoningEffortSupport;
  const prevStatus = service.currentStatus;
  const prevEngineFallback = service._lastEngineFallback;
  const prevPendingModel = service._managedPendingModel;
  const prevModelLifecycle = service._modelLifecycle;
  try {
    const payload = await service._initializeManagedSidecar({
      reason,
      // Re-target the refresh (e.g. recovering from a mock fallback once
      // chatgpt credentials arrive) instead of re-initializing the fallback.
      ...(requestedEngineType ? { requestedEngineType } : {}),
      ...(inactivityTimeoutMs != null ? { inactivityTimeoutMs } : {}),
      ...(absoluteTimeoutMs != null ? { absoluteTimeoutMs } : {}),
    });
    await service.refreshStatusSnapshot().catch(() => null);
    service._emitServiceLog('INFO', 'sidecar.config_refresh_completed', {
      reason,
      toolsWorkspaceRoot: getConfiguredToolsWorkspaceRoot(service) || '',
    });
    return payload;
  } catch (error) {
    // Restore previous state so a failed refresh does not leave the
    // service in a half-applied configuration.
    service.currentModel = prevModel;
    service.currentEngineType = prevEngineType;
    service.reasoningEffortSupport = prevReasoningSupport;
    service.currentStatus = prevStatus;
    service._lastEngineFallback = prevEngineFallback;
    service._managedPendingModel = prevPendingModel;
    service._modelLifecycle = prevModelLifecycle;
    service._emitServiceLog('ERROR', 'sidecar.config_refresh_failed', {
      reason,
      message: String(error && error.message || error),
    });
    throw error;
  }
}

module.exports = {
  createSidecarClient,
  disposeSidecarClient,
  getConfiguredToolsWorkspaceRoot,
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  initializeManagedSidecar,
  applyManagedInitializePayload,
  buildManagedStatusSnapshot,
  restartManagedSidecar,
  refreshManagedConfig,
};
