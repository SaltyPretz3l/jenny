const {
  getLocalRuntimeCapability,
  getLocalRuntimeReasoningSupport,
  getManagedReasoningEffortSupport,
  normalizeLocalRuntimeCapabilityEntry,
  normalizeModelCapabilities,
} = require('./backend-service-utils');
const {
  normalizeSchemaVersionEntries,
} = require('./schema-version-registry');
const {
  getConfiguredToolsWorkspaceRoot,
} = require('./managed-sidecar-config');

const WORKTREE_TOOL_STATUS_NAMES = new Set([
  'worktree_list',
  'worktree_create',
  'worktree_select',
  'worktree_delete',
]);

function normalizeContextLength(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function normalizeNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function normalizeWorktreeStatusMetrics(value, { defaultKind = '' } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const metrics = {};
  const kind = String(value.kind || defaultKind).trim();
  const registryCount = normalizeNonNegativeInteger(value.registry_count ?? value.registryCount);
  const staleCount = normalizeNonNegativeInteger(value.stale_count ?? value.staleCount);
  const missingCount = normalizeNonNegativeInteger(value.missing_count ?? value.missingCount);
  if (kind) metrics.kind = kind;
  if (registryCount !== null) metrics.registry_count = registryCount;
  if (staleCount !== null) metrics.stale_count = staleCount;
  if (missingCount !== null) metrics.missing_count = missingCount;
  if (typeof value.active_root_configured === 'boolean') {
    metrics.active_root_configured = value.active_root_configured;
  }
  if (typeof value.registry_readable === 'boolean') {
    metrics.registry_readable = value.registry_readable;
  }
  return metrics;
}

function normalizeToolsStatus(rawToolsStatus, fallbackToolsAvailable = []) {
  const normalized = {};
  if (rawToolsStatus && typeof rawToolsStatus === 'object' && !Array.isArray(rawToolsStatus)) {
    for (const [toolName, value] of Object.entries(rawToolsStatus)) {
      const normalizedName = String(toolName || '').trim();
      if (!normalizedName) {
        continue;
      }
      const valueObject = value && typeof value === 'object' ? value : null;
      const available = valueObject ? valueObject.available === true : value === true;
      const reason = typeof valueObject?.reason === 'string' ? valueObject.reason.trim() : '';
      const displayName = String(valueObject?.display_name || valueObject?.displayName || normalizedName).trim();
      const sourceKind = String(valueObject?.source_kind || valueObject?.sourceKind || '').trim();
      const toolFamily = String(valueObject?.tool_family || valueObject?.toolFamily || '').trim();
      const serverName = String(valueObject?.server_name || valueObject?.serverName || '').trim();
      const worktreeMetrics = normalizeWorktreeStatusMetrics(valueObject);
      normalized[normalizedName] = {
        available,
        reason: reason || null,
        display_name: displayName || normalizedName,
      };
      if (sourceKind) normalized[normalizedName].source_kind = sourceKind;
      if (toolFamily) normalized[normalizedName].tool_family = toolFamily;
      if (serverName) normalized[normalizedName].server_name = serverName;
      Object.assign(normalized[normalizedName], worktreeMetrics);
    }
  }
  for (const toolName of Array.isArray(fallbackToolsAvailable) ? fallbackToolsAvailable : []) {
    const normalizedName = String(toolName || '').trim();
    if (!normalizedName) {
      continue;
    }
    if (normalized[normalizedName]) {
      normalized[normalizedName].available = true;
      normalized[normalizedName].reason = null;
      continue;
    }
    normalized[normalizedName] = {
      available: true,
      reason: null,
      display_name: normalizedName,
    };
  }
  return normalized;
}

function normalizeMcpServerFailures(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const name = String(entry.name || '').trim();
      const code = String(entry.code || '').trim();
      const message = String(entry.message || '').trim();
      if (!name && !code && !message) {
        return null;
      }
      return { name, code, message };
    })
    .filter(Boolean);
}

function normalizeMcpServerNames(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry || '').trim()).filter(Boolean);
}

function normalizeMcpServers(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const name = String(entry.name || '').trim();
      const transport = String(entry.transport || 'stdio').trim() || 'stdio';
      return name ? { name, transport } : null;
    })
    .filter(Boolean);
}

function normalizeMcpServerCooldowns(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const name = String(entry.name || '').trim();
      if (!name) {
        return null;
      }
      const remainingSeconds = Number(entry.remaining_seconds ?? entry.remainingSeconds ?? 0);
      return {
        name,
        remaining_seconds: Number.isFinite(remainingSeconds) ? Math.max(0, remainingSeconds) : 0,
        reason: String(entry.reason || '').trim(),
      };
    })
    .filter(Boolean);
}

function normalizeWorktreeStatusSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return normalizeWorktreeStatusMetrics(value, { defaultKind: 'worktree' });
}

function enrichToolsStatusWithSummary(
  service,
  toolsStatus,
  toolNames,
  buildSummary,
  failureEvent
) {
  if (!toolsStatus || typeof toolsStatus !== 'object' || Array.isArray(toolsStatus)) {
    return toolsStatus;
  }
  if (!Object.keys(toolsStatus).some((toolName) => toolNames.has(toolName))) {
    return toolsStatus;
  }

  let summary;
  try {
    summary = buildSummary();
  } catch (error) {
    if (typeof service?._emitServiceLog === 'function') {
      service._emitServiceLog('WARN', failureEvent, {
        message: error?.message || String(error),
      });
    }
    return toolsStatus;
  }
  if (!summary) {
    return toolsStatus;
  }
  for (const toolName of toolNames) {
    if (toolsStatus[toolName]) {
      toolsStatus[toolName] = {
        ...toolsStatus[toolName],
        ...summary,
      };
    }
  }
  return toolsStatus;
}

function enrichWorktreeToolsStatus(service, toolsStatus = {}) {
  return enrichToolsStatusWithSummary(
    service,
    toolsStatus,
    WORKTREE_TOOL_STATUS_NAMES,
    () => {
      const worktreeService = service?.worktreeService;
      if (!worktreeService || typeof worktreeService.describeStatus !== 'function') {
        return null;
      }
      return normalizeWorktreeStatusSummary(worktreeService.describeStatus({
        workspaceRoot: getConfiguredToolsWorkspaceRoot(service),
      }));
    },
    'worktree.status_summary_failed'
  );
}

function toolsAvailableFromStatus(toolsStatus = {}, fallbackToolsAvailable = []) {
  const entries = Object.entries(
    toolsStatus && typeof toolsStatus === 'object' && !Array.isArray(toolsStatus)
      ? toolsStatus
      : {}
  );
  if (entries.length) {
    return entries
      .filter(([, value]) => value && typeof value === 'object' && value.available === true)
      .map(([toolName]) => toolName);
  }
  return Array.isArray(fallbackToolsAvailable) ? [...fallbackToolsAvailable] : [];
}

function normalizeLocalRuntimeFallback(value, fallback = null) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback
      : {};
  const requestedEngine = String(
    source.requested_engine
    || source.requestedEngine
    || ''
  ).trim().toLowerCase();
  const reason = String(source.reason || '').trim();
  const active = source.active === true || Boolean(requestedEngine && reason);
  return {
    active,
    requested_engine: requestedEngine || null,
    reason: reason || null,
  };
}

function normalizeLocalRuntimeContext(value, fallback = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : fallback && typeof fallback === 'object' && !Array.isArray(fallback)
      ? fallback
      : {};
  const configuredContextLength = normalizeContextLength(
    source.configured_context_length ?? source.configuredContextLength
  );
  const nativeContextLength = normalizeContextLength(
    source.native_context_length ?? source.nativeContextLength
  );
  const explicitEffectiveContextLength = normalizeContextLength(
    source.effective_context_length ?? source.effectiveContextLength
  );
  const effectiveContextLength =
    explicitEffectiveContextLength
    ?? (configuredContextLength && nativeContextLength
      ? Math.min(configuredContextLength, nativeContextLength)
      : configuredContextLength || nativeContextLength || null);
  return {
    configured_context_length: configuredContextLength,
    native_context_length: nativeContextLength,
    effective_context_length: effectiveContextLength,
  };
}

function deriveActiveModelCapabilitiesFromLocalRuntime(localRuntime) {
  const thinking = getLocalRuntimeCapability(localRuntime, 'thinking');
  const vision = getLocalRuntimeCapability(localRuntime, 'vision');
  const text = getLocalRuntimeCapability(localRuntime, 'text');
  const toolCalling = getLocalRuntimeCapability(localRuntime, 'tool_calling');
  const capabilities = {};
  if (text.available === true) capabilities.text = true;
  if (thinking.available === true) capabilities.thinking = true;
  if (vision.available === true) capabilities.vision = true;
  if (toolCalling.available === true) capabilities.tool_calling = true;
  return capabilities;
}

function normalizeLocalRuntime(rawLocalRuntime, fallback = {}) {
  const source = rawLocalRuntime && typeof rawLocalRuntime === 'object' && !Array.isArray(rawLocalRuntime)
    ? rawLocalRuntime
    : {};
  const fallbackCapabilities = normalizeModelCapabilities(fallback.activeModelCapabilities);
  const rawCapabilities =
    source.capabilities && typeof source.capabilities === 'object' && !Array.isArray(source.capabilities)
      ? source.capabilities
      : {};
  const capabilities = {
    text: normalizeLocalRuntimeCapabilityEntry(
      rawCapabilities.text,
      fallbackCapabilities.text === true,
      fallbackCapabilities.text === true ? 'engine_default' : 'unsupported'
    ),
    vision: normalizeLocalRuntimeCapabilityEntry(
      rawCapabilities.vision,
      fallbackCapabilities.vision === true
    ),
    tool_calling: normalizeLocalRuntimeCapabilityEntry(
      rawCapabilities.tool_calling,
      fallbackCapabilities.tool_calling === true,
      fallbackCapabilities.tool_calling === true ? 'engine_default' : 'unsupported'
    ),
    thinking: normalizeLocalRuntimeCapabilityEntry(
      rawCapabilities.thinking,
      fallbackCapabilities.thinking === true
    ),
  };
  const rawReasoning =
    source.reasoning && typeof source.reasoning === 'object' && !Array.isArray(source.reasoning)
      ? source.reasoning
      : {};
  const derivedSupport = getLocalRuntimeReasoningSupport(source)
    || String(fallback.activeModelReasoningSupport || '').trim().toLowerCase()
    || 'unsupported';
  const derivedMode = String(rawReasoning.mode || '').trim().toLowerCase()
    || (capabilities.thinking.available === true
      ? 'native'
      : derivedSupport === 'supported'
        ? 'parser_fallback'
        : 'unsupported');
  const derivedSource = String(rawReasoning.source || '').trim().toLowerCase()
    || (capabilities.thinking.available === true
      ? capabilities.thinking.source
      : derivedSupport === 'supported'
        ? 'app_profile_reasoning_parser'
        : 'unsupported');
  const rawModel = source.model && typeof source.model === 'object' && !Array.isArray(source.model)
    ? source.model
    : {};
  const rawEngine = source.engine && typeof source.engine === 'object' && !Array.isArray(source.engine)
    ? source.engine
    : {};
  const rawReadiness = source.readiness && typeof source.readiness === 'object' && !Array.isArray(source.readiness)
    ? source.readiness
    : {};
  const context = normalizeLocalRuntimeContext(source.context, fallback.context);
  const readinessStatus = String(
    rawReadiness.status
    || (rawReadiness.ready === true ? 'ready' : '')
    || (rawReadiness.model_loaded === true || rawReadiness.modelLoaded === true || rawModel.loaded === true || fallback.modelLoaded === true
      ? 'ready'
      : 'idle')
  ).trim().toLowerCase() || 'idle';
  const readinessReady = rawReadiness.ready === true || readinessStatus === 'ready';
  const readinessModelLoaded =
    rawReadiness.model_loaded === true
    || rawReadiness.modelLoaded === true
    || rawModel.loaded === true
    || fallback.modelLoaded === true
    || readinessReady;
  const templateDiagnostics =
    source.template_diagnostics && typeof source.template_diagnostics === 'object' && !Array.isArray(source.template_diagnostics)
      ? { ...source.template_diagnostics }
      : fallback.templateDiagnostics && typeof fallback.templateDiagnostics === 'object' && !Array.isArray(fallback.templateDiagnostics)
        ? { ...fallback.templateDiagnostics }
        : null;
  return {
    contract_version: String(source.contract_version || source.contractVersion || fallback.contractVersion || '2').trim() || '2',
    engine: {
      type: String(rawEngine.type || fallback.engine || '').trim().toLowerCase() || 'mock',
    },
    model: {
      id: String(rawModel.id || fallback.model || '').trim() || '',
      loaded: rawModel.loaded === true || fallback.modelLoaded === true,
    },
    readiness: {
      status: readinessStatus,
      ready: readinessReady,
      model_loaded: readinessModelLoaded,
    },
    fallback: normalizeLocalRuntimeFallback(source.fallback, fallback.engineFallback),
    capabilities,
    reasoning: {
      support: derivedSupport === 'supported' ? 'supported' : 'unsupported',
      mode: derivedMode,
      source: derivedSource,
    },
    context,
    template_diagnostics: templateDiagnostics,
  };
}

function resolveManagedContextMetadata(service, overrides = {}, snapshot = {}) {
  const model = String(overrides.model != null ? overrides.model : service.currentModel || '').trim();
  const modelLoaded = overrides.model_loaded != null
    ? Boolean(overrides.model_loaded)
    : Boolean(service.currentModel);
  const engine = String(overrides.engine || service.currentEngineType || 'mock').trim().toLowerCase() || 'mock';
  const engineFallback =
    Object.prototype.hasOwnProperty.call(overrides, 'engine_fallback')
      ? overrides.engine_fallback
      : snapshot.engine_fallback;
  const fallbackRequestedEngine = String(engineFallback?.requested_engine || '').trim().toLowerCase();
  const fallbackAppliesToModel = !model
    || !service.currentModel
    || String(service.currentModel || '').trim() === model;
  const hasMockFallback = engine === 'mock'
    || (fallbackRequestedEngine && fallbackRequestedEngine === engine && fallbackAppliesToModel);
  if (!modelLoaded || !model || hasMockFallback) {
    return {
      native_context_length: null,
      configured_context_length: null,
      effective_context_length: null,
    };
  }

  const candidateModel = model;
  const snapshotModel = String(snapshot.model || '').trim();
  const canReuseSnapshot = snapshotModel && snapshotModel === candidateModel;

  const nativeContextLength = normalizeContextLength(
    Object.prototype.hasOwnProperty.call(overrides, 'native_context_length')
      ? overrides.native_context_length
      : canReuseSnapshot
        ? snapshot.native_context_length
        : null
  );
  const configuredContextLength = normalizeContextLength(
    Object.prototype.hasOwnProperty.call(overrides, 'configured_context_length')
      ? overrides.configured_context_length
      : canReuseSnapshot
        ? snapshot.configured_context_length
        : null
  );
  const effectiveContextLength = normalizeContextLength(
    Object.prototype.hasOwnProperty.call(overrides, 'effective_context_length')
      ? overrides.effective_context_length
      : canReuseSnapshot
        ? snapshot.effective_context_length
        : null
  );

  return {
    native_context_length: nativeContextLength,
    configured_context_length: configuredContextLength,
    effective_context_length: effectiveContextLength,
  };
}

function buildManagedStatusSnapshot(service, overrides = {}) {
  const engine = String(overrides.engine || service.currentEngineType || 'mock');
  const existingSnapshot =
    service.currentStatus && typeof service.currentStatus === 'object' ? service.currentStatus : {};
  const pick = (key) => (Object.prototype.hasOwnProperty.call(overrides, key)
    ? overrides[key]
    : existingSnapshot[key]);
  const providerCapabilities =
    overrides.provider_capabilities && typeof overrides.provider_capabilities === 'object'
      ? overrides.provider_capabilities
      : existingSnapshot.provider_capabilities;
  const providerCapabilityProfiles = Array.isArray(overrides.provider_capability_profiles)
    ? overrides.provider_capability_profiles
    : (Array.isArray(existingSnapshot.provider_capability_profiles)
      ? existingSnapshot.provider_capability_profiles
      : []);
  const model = String(overrides.model != null ? overrides.model : service.currentModel || '');
  const activeModelCapabilities = normalizeModelCapabilities(
    pick('active_model_capabilities')
  );
  const synthesizedLocalRuntime = normalizeLocalRuntime(
    pick('local_runtime'),
    {
      engine,
      model,
      modelLoaded: overrides.model_loaded != null
        ? Boolean(overrides.model_loaded)
        : Boolean(service.currentModel),
      activeModelCapabilities,
      activeModelReasoningSupport: overrides.active_model_reasoning_support,
      engineFallback: pick('engine_fallback'),
      context: resolveManagedContextMetadata(service, overrides, existingSnapshot),
      templateDiagnostics: pick('template_diagnostics'),
    }
  );
  const mergedActiveModelCapabilities = normalizeModelCapabilities(
    Object.keys(activeModelCapabilities).length
      ? activeModelCapabilities
      : deriveActiveModelCapabilitiesFromLocalRuntime(synthesizedLocalRuntime)
  );
  const activeModelReasoningSupport = String(
    overrides.active_model_reasoning_support
    || getManagedReasoningEffortSupport(engine, providerCapabilities, {
      activeModelCapabilities: mergedActiveModelCapabilities,
      modelId: model,
      localRuntime: synthesizedLocalRuntime,
    })
  ).trim().toLowerCase() || 'unsupported';
  const localRuntime = normalizeLocalRuntime(synthesizedLocalRuntime, {
    engine,
    model,
    modelLoaded: overrides.model_loaded != null
      ? Boolean(overrides.model_loaded)
      : Boolean(service.currentModel),
    activeModelCapabilities: mergedActiveModelCapabilities,
    activeModelReasoningSupport: activeModelReasoningSupport,
    engineFallback: pick('engine_fallback'),
    context: resolveManagedContextMetadata(service, overrides, existingSnapshot),
    templateDiagnostics: pick('template_diagnostics'),
  });
  const contextMetadata = normalizeLocalRuntimeContext(localRuntime.context);
  const toolsStatus = enrichWorktreeToolsStatus(
    service,
    normalizeToolsStatus(
      pick('tools_status'),
      pick('tools_available')
    )
  );
  const toolsAvailable = toolsAvailableFromStatus(
    toolsStatus,
    pick('tools_available')
  );
  const mcpServersConnected = normalizeMcpServerNames(
    pick('mcp_servers_connected')
  );
  const mcpServersFailed = normalizeMcpServerFailures(
    pick('mcp_servers_failed')
  );
  const mcpServers = normalizeMcpServers(
    pick('mcp_servers')
  );
  const mcpServerCooldowns = normalizeMcpServerCooldowns(
    pick('mcp_server_cooldowns')
  );
  const schemaVersions = normalizeSchemaVersionEntries(
    pick('schema_versions')
  );
  const legacyEngineFallback = localRuntime.fallback.active === true
    ? {
      requested_engine: localRuntime.fallback.requested_engine,
      reason: localRuntime.fallback.reason,
    }
    : undefined;
  return {
    status: 'running',
    model,
    model_loaded: overrides.model_loaded != null
      ? Boolean(overrides.model_loaded)
      : Boolean(service.currentModel),
    engine,
    local_runtime: localRuntime,
    memory_stats: {},
    native_context_length: contextMetadata.native_context_length,
    configured_context_length: contextMetadata.configured_context_length,
    effective_context_length: contextMetadata.effective_context_length,
    reasoning_effort_support: activeModelReasoningSupport,
    provider_capabilities: providerCapabilities,
    provider_capability_profiles: providerCapabilityProfiles,
    active_model_capabilities: mergedActiveModelCapabilities,
    active_model_reasoning_support: activeModelReasoningSupport,
    tools_status: Object.keys(toolsStatus).length ? toolsStatus : undefined,
    tools_available: toolsAvailable,
    mcp_servers: mcpServers,
    mcp_servers_connected: mcpServersConnected,
    mcp_servers_failed: mcpServersFailed,
    mcp_server_cooldowns: mcpServerCooldowns,
    schema_versions: schemaVersions,
    memory: overrides.memory || undefined,
    engine_fallback: legacyEngineFallback,
    template_diagnostics: localRuntime.template_diagnostics || undefined,
  };
}

module.exports = {
  buildManagedStatusSnapshot,
  deriveActiveModelCapabilitiesFromLocalRuntime,
  normalizeLocalRuntime,
  normalizeToolsStatus,
  toolsAvailableFromStatus,
};
