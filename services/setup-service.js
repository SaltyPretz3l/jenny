const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const fs = require('fs');

const { normalizeString } = require('./backend/path-utils');
const { SETUP_ERROR_CODES } = require('./backend/error-codes');
const { parsePullLine } = require('./ollama-pull-progress');
const { detectOllama: detectOllamaWithDeps } = require('./ollama-detection');
const { OllamaPullService } = require('./ollama-pull-service');
const {
  LOCAL_ENDPOINT_ENGINES,
  SetupEndpointService,
  endpointUrlFor,
  normalizeEngineType,
} = require('./setup-endpoint-service');
const {
  DEFAULT_ASSISTANT_IDENTITY,
  computeSetupHealth,
  normalizeAssistantIdentity,
} = require('./shell-config-setup-state');
const {
  toSnakeSetupSteps,
  toSnakeSetupState,
  normalizeWorkspaceRootStatus,
  toCamelSetupSteps,
  normalizeReadinessProbe,
  withTimeout,
  stepsEqual,
  createRequestId,
  publicPullState,
  createUnavailableSetupState,
} = require('./setup-service-helpers');

const DEFAULT_ENDPOINT_TIMEOUT_MS = 5_000;
const DEFAULT_READINESS_TIMEOUT_MS = 15_000;
const MAX_ENDPOINT_TIMEOUT_MS = 30_000;
function normalizeEndpointTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_ENDPOINT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(parsed), 1), MAX_ENDPOINT_TIMEOUT_MS);
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeBaseUrl(value, fallback) {
  const raw = normalizeString(value) || fallback;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_error) {
    return '';
  }
}

function isLocalRuntimeEngine(value) {
  const engine = normalizeEngineType(value);
  return Boolean(engine);
}

function hasCurrentMinimumReadiness(readiness = {}) {
  return readiness.workspace_root?.ready === true
    && (readiness.local_model?.ready === true || readiness.endpoint?.ready === true);
}

class SetupService extends EventEmitter {
  constructor({
    configService,
    toolsListProvider = null,
    fetchImpl = globalThis.fetch,
    spawnImpl = defaultSpawn,
    commandLookupImpl = null,
    platform = process.platform,
    env = process.env,
    fileExists = fs.existsSync,
    requestIdProvider = createRequestId,
    endpointTimeoutMs = DEFAULT_ENDPOINT_TIMEOUT_MS,
    readinessProvider = null,
    readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
    mcpToolsDiscoveredProvider = null,
    workspaceRootCoordinatorProvider = null,
    nowProvider = () => new Date(),
    logger = null,
    refreshManagedConfig = null,
    killProcessTreeImpl = null,
    getLlamaServerManager = () => null,
  } = {}) {
    super();
    this.configService = configService || null;
    this.toolsListProvider = typeof toolsListProvider === 'function' ? toolsListProvider : null;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.commandLookupImpl = typeof commandLookupImpl === 'function' ? commandLookupImpl : null;
    this.platform = normalizeString(platform) || process.platform;
    this.env = env && typeof env === 'object' ? env : process.env;
    this.fileExists = typeof fileExists === 'function' ? fileExists : fs.existsSync;
    this.requestIdProvider = typeof requestIdProvider === 'function' ? requestIdProvider : createRequestId;
    this.endpointTimeoutMs = normalizeEndpointTimeoutMs(endpointTimeoutMs);
    this.readinessProvider = typeof readinessProvider === 'function' ? readinessProvider : null;
    this.readinessTimeoutMs = normalizeEndpointTimeoutMs(readinessTimeoutMs);
    this.mcpToolsDiscoveredProvider = typeof mcpToolsDiscoveredProvider === 'function'
      ? mcpToolsDiscoveredProvider
      : null;
    this.workspaceRootCoordinatorProvider = typeof workspaceRootCoordinatorProvider === 'function'
      ? workspaceRootCoordinatorProvider
      : null;
    this.nowProvider = typeof nowProvider === 'function' ? nowProvider : () => new Date();
    this.logger = typeof logger === 'function' ? logger : null;
    this.refreshManagedConfig = typeof refreshManagedConfig === 'function' ? refreshManagedConfig : null;
    this.endpointService = new SetupEndpointService({
      configService: this.configService,
      fetchImpl: this.fetchImpl,
      timeoutMs: this.endpointTimeoutMs,
      logger: this.logger,
      getLlamaServerManager,
    });
    this.pullService = new OllamaPullService({
      spawnImpl: this.spawnImpl,
      requestIdProvider: this.requestIdProvider,
      nowProvider: this.nowProvider,
      platform: this.platform,
      env: this.env,
      fileExists: this.fileExists,
      logger: this.logger,
      ...(typeof killProcessTreeImpl === 'function' ? { killProcessTreeImpl } : {}),
    });
    this.pullService.on('progress', (payload) => this.emit('model-pull-progress', payload));
    this.runtimeReadiness = null;
    this.readinessRefreshPromise = null;
    this.readinessGeneration = 0;
  }

  _nowIso() {
    const value = this.nowProvider();
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
  }

  _log(level, event, details = {}) {
    try {
      this.logger?.(String(level || 'INFO').toUpperCase(), event, details);
    } catch (_error) {
      // Diagnostics must not change setup state transitions.
    }
  }

  _getSetupState() {
    if (this.configService && typeof this.configService.getSetupState === 'function') {
      return this.configService.getSetupState();
    }
    const state = this.configService && typeof this.configService.getState === 'function'
      ? this.configService.getState()
      : {};
    return state.setup || {};
  }

  _getAssistantIdentity() {
    if (this.configService && typeof this.configService.getAssistantIdentity === 'function') {
      return this.configService.getAssistantIdentity();
    }
    const state = this.configService && typeof this.configService.getState === 'function'
      ? this.configService.getState()
      : {};
    return state.assistantIdentity || {};
  }

  _getToolsWorkspaceRoot() {
    if (this.configService && typeof this.configService.getToolsWorkspaceRoot === 'function') {
      return normalizeString(this.configService.getToolsWorkspaceRoot());
    }
    const state = this.configService && typeof this.configService.getState === 'function'
      ? this.configService.getState()
      : {};
    return normalizeString(state.toolsWorkspaceRoot || state.tools_workspace_root);
  }

  _getWorkspaceRootStatus(toolsWorkspaceRoot) {
    if (this.configService && typeof this.configService.getWorkspaceRootStatus === 'function') {
      try {
        return normalizeWorkspaceRootStatus(
          this.configService.getWorkspaceRootStatus(),
          Boolean(toolsWorkspaceRoot)
        );
      } catch (_error) {
        return normalizeWorkspaceRootStatus(null, Boolean(toolsWorkspaceRoot));
      }
    }
    return normalizeWorkspaceRootStatus(
      toolsWorkspaceRoot
        ? { state: 'ready', message: 'Workspace root is configured.' }
        : { state: 'missing', message: 'No workspace root is configured.' },
      Boolean(toolsWorkspaceRoot)
    );
  }

  _getMcpToolsDiscovered() {
    if (this.mcpToolsDiscoveredProvider) {
      try {
        return this.mcpToolsDiscoveredProvider() === true;
      } catch (_error) {
        return false;
      }
    }
    const tools = this._listTools();
    return Array.isArray(tools)
      && tools.some((tool) => normalizeString(tool?.name).startsWith('mcp__'));
  }

  _listTools() {
    try {
      return this.toolsListProvider ? this.toolsListProvider() : [];
    } catch (_error) {
      return [];
    }
  }

  _clearRuntimeReadiness() {
    this.readinessGeneration += 1;
    this.runtimeReadiness = null;
    this.readinessRefreshPromise = null;
  }

  _buildReadiness({ toolsWorkspaceRoot, workspaceRootStatus, mcpToolsDiscovered, assistantIdentity }) {
    const identity = normalizeAssistantIdentity(assistantIdentity || DEFAULT_ASSISTANT_IDENTITY);
    const probe = this.runtimeReadiness ? normalizeReadinessProbe(this.runtimeReadiness) : normalizeReadinessProbe();
    const localRuntimeModelLoaded = probe.runtime_model_loaded === true && isLocalRuntimeEngine(probe.runtime_engine);
    const localModelReady = probe.local_model_available === true || localRuntimeModelLoaded;
    // A cloud engine is a valid model route but never a local model: only the
    // endpoint signal widens, so _deriveReadinessSteps still marks `endpoint`
    // done and leaves `local_model` alone.
    const endpointReady = probe.local_endpoint_available === true
      || probe.remote_endpoint_available === true
      || probe.catalog_available === true
      || localRuntimeModelLoaded;
    return {
      workspace_root: {
        ready: workspaceRootStatus.state === 'ready',
        source: workspaceRootStatus.state === 'ready' ? 'workspace_root_status' : 'config',
        status: workspaceRootStatus.state,
        configured: Boolean(toolsWorkspaceRoot),
        message: workspaceRootStatus.message,
      },
      local_model: {
        ready: localModelReady,
        source: localModelReady ? 'runtime_probe' : 'runtime_probe_unavailable',
        model_count: probe.local_model_count,
        catalog_pending: probe.catalog_pending,
        catalog_source: probe.catalog_source,
        catalog_cached: probe.catalog_cached,
        catalog_stale: probe.catalog_stale,
      },
      endpoint: {
        ready: endpointReady,
        source: endpointReady ? 'runtime_probe' : 'runtime_probe_unavailable',
        engine_type: probe.runtime_engine,
        catalog_pending: probe.catalog_pending,
      },
      personality: {
        // Personality v3 retired `profile`: the name is the whole identity.
        ready: Boolean(identity.agentName),
        source: 'assistant_identity',
      },
      skills: {
        ready: mcpToolsDiscovered === true,
        skipped: mcpToolsDiscovered !== true,
        source: mcpToolsDiscovered === true ? 'mcp_tools' : 'no_mcp_config_required',
      },
      // Optional for minimum readiness, but never auto-completed: the step is
      // the durable record that the user explicitly reviewed consequence-based
      // tool and memory choices.
      capabilities: { ready: false, required: false, source: 'explicit_choice' },
    };
  }

  _deriveReadinessSteps(steps, readiness) {
    const next = toSnakeSetupSteps(steps);
    if (readiness.workspace_root.ready === true && next.workspace_root !== 'done') {
      next.workspace_root = 'done';
    }
    if (readiness.local_model.ready === true && next.local_model !== 'done') {
      next.local_model = 'done';
    }
    if (readiness.endpoint.ready === true && next.endpoint !== 'done') {
      next.endpoint = 'done';
    }
    if (readiness.personality.ready === true && next.personality !== 'done') {
      next.personality = 'done';
    }
    if (readiness.skills.ready === true && next.skills !== 'done') {
      next.skills = 'done';
    } else if (readiness.skills.skipped === true && next.skills !== 'done') {
      next.skills = 'skipped';
    }
    return next;
  }

  _persistReadinessSteps(previousSteps, nextSteps) {
    if (
      stepsEqual(previousSteps, nextSteps)
      || !this.configService
      || typeof this.configService.updateSetupState !== 'function'
    ) {
      return;
    }
    const changedSteps = Object.keys(nextSteps).filter((key) => previousSteps[key] !== nextSteps[key]);
    this.configService.updateSetupState({ steps: toCamelSetupSteps(nextSteps) });
    this._log('INFO', 'setup.readiness_backfilled', { steps: changedSteps });
  }

  _buildState({ persistReadiness = true, deriveReadiness = true } = {}) {
    const setupState = toSnakeSetupState(this._getSetupState());
    const toolsWorkspaceRoot = this._getToolsWorkspaceRoot();
    const workspaceRootStatus = this._getWorkspaceRootStatus(toolsWorkspaceRoot);
    const mcpToolsDiscovered = this._getMcpToolsDiscovered();
    const assistantIdentity = this._getAssistantIdentity();
    const readiness = this._buildReadiness({
      toolsWorkspaceRoot,
      workspaceRootStatus,
      mcpToolsDiscovered,
      assistantIdentity,
    });
    const derivedSteps = deriveReadiness
      ? this._deriveReadinessSteps(setupState.steps, readiness)
      : setupState.steps;
    if (deriveReadiness && persistReadiness) {
      this._persistReadinessSteps(setupState.steps, derivedSteps);
    }
    const minimumReady = computeSetupHealth({ steps: toCamelSetupSteps(derivedSteps) }).state === 'complete';
    const currentMinimumReady = hasCurrentMinimumReadiness(readiness);
    const derivedComplete = setupState.setup_complete || (minimumReady && currentMinimumReady);
    const setup_state = {
      ...setupState,
      setup_complete: derivedComplete,
      steps: derivedSteps,
      tools_workspace_root_configured: Boolean(toolsWorkspaceRoot),
      mcp_tools_discovered: mcpToolsDiscovered,
      assistant_identity: assistantIdentity,
      readiness,
    };
    return {
      setup_complete: derivedComplete,
      setup_state,
    };
  }

  getState() {
    return this._buildState({ persistReadiness: true });
  }

  refreshReadiness() {
    if (!this.readinessProvider) {
      return Promise.resolve(this.getState());
    }
    if (this.readinessRefreshPromise) {
      return this.readinessRefreshPromise;
    }
    const generation = this.readinessGeneration;
    const refreshPromise = (async () => {
      try {
        const payload = await withTimeout(
          Promise.resolve(this.readinessProvider()),
          this.readinessTimeoutMs
        );
        if (generation === this.readinessGeneration) {
          this.runtimeReadiness = normalizeReadinessProbe(payload);
        }
      } catch (error) {
        if (generation === this.readinessGeneration) {
          this.runtimeReadiness = null;
          this._log('WARN', 'setup.readiness_probe_failed', {
            message: String(error?.message || error || 'Setup readiness probe failed.'),
          });
        }
      }
      return this.getState();
    })();
    const coalescedPromise = refreshPromise.finally(() => {
      if (this.readinessRefreshPromise === coalescedPromise) {
        this.readinessRefreshPromise = null;
      }
    });
    this.readinessRefreshPromise = coalescedPromise;
    return coalescedPromise;
  }

  updateState(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    if (!this.configService || typeof this.configService.updateSetupState !== 'function') {
      return this.getState();
    }
    const identityPatch = source.assistantIdentity || source.assistant_identity;
    if (
      isPlainObject(identityPatch)
      && typeof this.configService.updateAssistantIdentity === 'function'
    ) {
      this.configService.updateAssistantIdentity(identityPatch);
    }
    const setupPatch = { ...source };
    delete setupPatch.assistantIdentity;
    delete setupPatch.assistant_identity;
    this.configService.updateSetupState(setupPatch);
    return this.getState();
  }

  async complete() {
    if (!this.configService || typeof this.configService.markSetupComplete !== 'function') {
      return this.getState();
    }
    const persisted = toSnakeSetupState(this._getSetupState());
    if (persisted.setup_complete === true) {
      return this.getState();
    }
    const current = await this.refreshReadiness();
    const health = computeSetupHealth({ steps: toCamelSetupSteps(current.setup_state?.steps || {}) });
    const readiness = current.setup_state?.readiness || {};
    const currentMinimumReady = hasCurrentMinimumReadiness(readiness);
    if (health.state !== 'complete' || !currentMinimumReady) {
      this._log('WARN', 'setup.complete_rejected', {
        pending_steps: health.pendingSteps,
        skipped_steps: health.skippedSteps,
        current_readiness: currentMinimumReady,
      });
      return current;
    }
    this.configService.markSetupComplete();
    return this.getState();
  }

  reset() {
    if (!this.configService || typeof this.configService.resetSetupState !== 'function') {
      return this.getState();
    }
    this._clearRuntimeReadiness();
    this.configService.resetSetupState();
    return this._buildState({ persistReadiness: false, deriveReadiness: false });
  }

  async factoryReset() {
    if (!this.configService) {
      return this.getState();
    }
    if (typeof this.configService.resetOnboarding !== 'function') {
      return {
        ...this.getState(),
        factoryResetResult: { completed: false, code: 'onboarding_reset_unavailable' },
      };
    }
    try {
      this.configService.resetOnboarding();
      this._clearRuntimeReadiness();
      return {
        ...this._buildState({ persistReadiness: false, deriveReadiness: false }),
        factoryResetResult: { completed: true },
      };
    } catch (error) {
      this._log('WARN', 'setup.onboarding_reset_failed', {
        code: String(error?.code || 'write_failed').slice(0, 64),
      });
      return {
        ...this._buildState({ persistReadiness: false, deriveReadiness: false }),
        factoryResetResult: {
          completed: false,
          code: String(error?.code || 'write_failed').slice(0, 64),
        },
      };
    }
  }

  async validateEndpoint(payload = {}) {
    return this.endpointService.validate(payload);
  }

  async saveEndpoint(payload = {}) {
    const result = await this.endpointService.save(payload);
    if (!result.ok) return { ...this.getState(), endpoint_result: result };
    this._clearRuntimeReadiness();
    try {
      if (this.refreshManagedConfig) {
        await this.refreshManagedConfig('setup_endpoint_saved');
      }
    } catch (_error) {
      return {
        ...this.getState(),
        endpoint_result: {
          ok: false,
          engineType: result.engineType,
          code: 'config_refresh_failed',
          error_code: SETUP_ERROR_CODES.CONFIG_REFRESH_FAILED,
          message: 'Endpoint was saved, but the runtime could not be refreshed.',
          retryable: true,
        },
      };
    }
    const refreshed = await this.refreshReadiness();
    if (refreshed.setup_state?.readiness?.endpoint?.ready !== true) {
      const catalogPending = refreshed.setup_state?.readiness?.endpoint?.catalog_pending === true;
      return {
        ...refreshed,
        endpoint_result: {
          ok: false,
          engineType: result.engineType,
          checkedUrl: result.checkedUrl,
          code: catalogPending ? 'catalog_pending' : 'readiness_unavailable',
          error_code: SETUP_ERROR_CODES.CONFIG_REFRESH_FAILED,
          message: catalogPending
            ? 'Endpoint was saved, but the model catalog is still starting.'
            : 'Endpoint was saved, but Jenny could not confirm a usable model route.',
          retryable: true,
        },
      };
    }
    if (this.configService && typeof this.configService.updateSetupState === 'function') {
      this.configService.updateSetupState({ steps: { endpoint: 'done' } });
    }
    return { ...this.getState(), endpoint_result: result };
  }

  startOllamaPull(payload = {}) {
    return this.pullService.start(payload);
  }

  startOllamaPullPublic(payload = {}) {
    return publicPullState(this.pullService.start(payload));
  }

  deleteOllamaModel(payload = {}) {
    return this.pullService.delete(payload);
  }

  cancelOllamaPull(payload = {}) {
    return this.pullService.cancel(payload);
  }

  signalActivePulls() {
    return this.pullService.signalActive();
  }

  disposeActivePulls() {
    return this.pullService.drainActive();
  }

  /** Delegates to services/ollama-detection.js (extracted for the size cap). */
  detectOllama({ host, timeoutMs } = {}) {
    return detectOllamaWithDeps(this, {
      baseUrl: normalizeBaseUrl(host, 'http://127.0.0.1:11434') || 'http://127.0.0.1:11434',
      timeout: normalizeEndpointTimeoutMs(timeoutMs || 3000),
    });
  }

}

module.exports = {
  createUnavailableSetupState,
  LOCAL_ENDPOINT_ENGINES,
  SetupService,
  endpointUrlFor,
  normalizeEngineType,
  parsePullLine,
};
