/**
 * renderer/services/renderer-setup-service.js
 *
 * Thin renderer-side wrapper around the Phase 7A `window.jennyShell.setup.*`
 * preload bridge. Normalizes payloads, hides the global window reference, and
 * exposes a single subscribe API for model-pull progress.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSetupService = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function clone(value) {
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(clone);
    }
    var out = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i += 1) {
      out[keys[i]] = clone(value[keys[i]]);
    }
    return out;
  }

  function nonNegNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function clampPercent(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) {
      return 0;
    }
    return Math.min(Math.max(Math.round(n), 0), 100);
  }

  function normalizeReadinessEntry(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      ready: source.ready === true,
      skipped: source.skipped === true,
      source: String(source.source || ''),
      status: String(source.status || ''),
      configured: source.configured === true,
      message: String(source.message || ''),
      modelCount: Number(source.model_count || source.modelCount) || 0,
      engineType: String(source.engine_type || source.engineType || ''),
    };
  }

  function normalizeReadiness(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      workspaceRoot: normalizeReadinessEntry(source.workspace_root || source.workspaceRoot),
      localModel: normalizeReadinessEntry(source.local_model || source.localModel),
      endpoint: normalizeReadinessEntry(source.endpoint),
      personality: normalizeReadinessEntry(source.personality),
      skills: normalizeReadinessEntry(source.skills),
      capabilities: normalizeReadinessEntry(source.capabilities),
    };
  }

  function normalizeWorkspaceRootStatus(value) {
    var source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return {
      state: String(source.state || 'missing'),
      message: String(source.message || ''),
    };
  }

  function normalizeSetupPayload(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    var setupState = source.setup_state && typeof source.setup_state === 'object'
      && !Array.isArray(source.setup_state)
      ? source.setup_state
      : {};
    var steps = setupState.steps && typeof setupState.steps === 'object' && !Array.isArray(setupState.steps)
      ? setupState.steps
      : {};
    var assistantIdentity = setupState.assistant_identity && typeof setupState.assistant_identity === 'object'
      && !Array.isArray(setupState.assistant_identity)
      ? setupState.assistant_identity
      : {};
    var readiness = normalizeReadiness(setupState.readiness);
    var workspaceRootStatus = normalizeWorkspaceRootStatus(
      setupState.workspace_root_status || {
        state: readiness.workspaceRoot.status,
        message: readiness.workspaceRoot.message,
      }
    );
    return {
      setupComplete: source.setup_complete === true || setupState.setup_complete === true,
      firstRunCompleted: setupState.first_run_completed === true || setupState.firstRunCompleted === true,
      raw: clone(setupState),
      seen: setupState.seen === true,
      dismissed: setupState.dismissed === true,
      completedAt: String(setupState.completed_at || ''),
      updatedAt: String(setupState.updated_at || ''),
      steps: {
        workspaceRoot: String(steps.workspace_root || 'pending'),
        localModel: String(steps.local_model || 'pending'),
        endpoint: String(steps.endpoint || 'pending'),
        personality: String(steps.personality || 'pending'),
        skills: String(steps.skills || 'pending'),
        capabilities: String(steps.capabilities || 'pending'),
      },
      assistantIdentity: {
        agentName: String(assistantIdentity.agentName || assistantIdentity.agent_name || 'Jenny'),
        profile: String(assistantIdentity.profile || 'balanced'),
        customText: String(assistantIdentity.customText || assistantIdentity.custom_text || ''),
        updatedAt: String(assistantIdentity.updatedAt || assistantIdentity.updated_at || ''),
      },
      mcpToolsDiscovered: setupState.mcp_tools_discovered === true,
      toolsWorkspaceRootConfigured: setupState.tools_workspace_root_configured === true
        || readiness.workspaceRoot.configured === true,
      toolsWorkspaceRoot: String(setupState.tools_workspace_root || ''),
      workspaceRootStatus,
      readiness,
      factoryResetResult: source.factoryResetResult && typeof source.factoryResetResult === 'object'
        ? {
            completed: source.factoryResetResult.completed === true,
            code: String(source.factoryResetResult.code || '').slice(0, 64),
          }
        : null,
    };
  }

  function normalizeValidationResult(result) {
    var source = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    return {
      ok: source.ok === true,
      engineType: String(source.engineType || source.engine_type || ''),
      checkedUrl: String(source.checkedUrl || source.checked_url || ''),
      status: Number(source.status) || 0,
      code: String(source.code || ''),
      message: String(source.message || ''),
      errorCode: String(source.error_code || source.errorCode || ''),
      retryable: source.retryable === true,
    };
  }

  function normalizePullPayload(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      requestId: String(source.requestId || source.request_id || ''),
      model: String(source.model || ''),
      status: String(source.status || 'pending'),
      summary: String(source.summary || ''),
      startedAt: String(source.startedAt || source.started_at || ''),
      updatedAt: String(source.updatedAt || source.updated_at || ''),
      exitCode: source.exitCode == null ? null : Number(source.exitCode),
      error: String(source.error || ''),
      percent: clampPercent(source.percent),
      bytes: nonNegNumber(source.bytes),
      totalBytes: nonNegNumber(source.totalBytes || source.total_bytes),
      label: String(source.label || ''),
      code: String(source.code || ''),
      terminationConfirmed: source.terminationConfirmed === true || source.termination_confirmed === true,
    };
  }

  function normalizeDetectPayload(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      installed: source.installed === true,
      running: source.running === true,
      version: String(source.version || ''),
      installPath: String(source.installPath || source.install_path || ''),
      source: String(source.source || 'none'),
      versionSupported: source.versionSupported === true,
      upgradeRequired: source.upgradeRequired === true,
      versionStatus: String(source.versionStatus || ''),
      minimumVersion: String(source.minimumVersion || ''),
    };
  }

  function normalizeInstallPlan(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      available: source.available === true,
      url: String(source.url || ''),
      version: String(source.version || ''),
      sizeBytes: nonNegNumber(source.sizeBytes || source.size_bytes),
      sha256: String(source.sha256 || ''),
      license: String(source.license || ''),
      manualFallbackUrl: String(source.manualFallbackUrl || source.manual_fallback_url || ''),
    };
  }

  function normalizeInstallPayload(payload) {
    var source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      requestId: String(source.requestId || source.request_id || ''),
      status: String(source.status || 'idle'),
      phase: String(source.phase || ''),
      percent: clampPercent(source.percent),
      downloadedBytes: nonNegNumber(source.downloadedBytes || source.downloaded_bytes),
      totalBytes: nonNegNumber(source.totalBytes || source.total_bytes),
      summary: String(source.summary || ''),
      code: String(source.code || ''),
      error: String(source.error || ''),
      manualFallbackUrl: String(source.manualFallbackUrl || source.manual_fallback_url || ''),
    };
  }

  function createSetupService(options) {
    var deps = options || {};
    var windowRef = deps.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    var appendClientLog = typeof deps.appendClientLog === 'function' ? deps.appendClientLog : function noop() {};
    var toErrorMessage = typeof deps.toErrorMessage === 'function'
      ? deps.toErrorMessage
      : function fallbackToErrorMessage(error) {
          return String(error && error.message || error || '');
        };

    function bridge() {
      return windowRef && windowRef.jennyShell && windowRef.jennyShell.setup
        ? windowRef.jennyShell.setup
        : null;
    }

    async function getState() {
      var b = bridge();
      if (!b || typeof b.getState !== 'function') {
        return null;
      }
      try {
        var payload = await b.getState();
        return normalizeSetupPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'setup.get_state_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function updateState(patch) {
      var b = bridge();
      if (!b || typeof b.updateState !== 'function') {
        return null;
      }
      try {
        var payload = await b.updateState(patch && typeof patch === 'object' ? patch : {});
        return normalizeSetupPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'setup.update_state_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function complete() {
      var b = bridge();
      if (!b || typeof b.complete !== 'function') {
        return null;
      }
      try {
        var payload = await b.complete();
        return normalizeSetupPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'setup.complete_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function reset() {
      var b = bridge();
      if (!b || typeof b.reset !== 'function') {
        return null;
      }
      try {
        var payload = await b.reset();
        return normalizeSetupPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'setup.reset_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function factoryReset() {
      var b = bridge();
      if (!b || typeof b.factoryReset !== 'function') {
        return null;
      }
      try {
        var payload = await b.factoryReset();
        return normalizeSetupPayload(payload);
      } catch (error) {
        appendClientLog('WARN', 'setup.factory_reset_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function validateEndpoint(payload) {
      var b = bridge();
      if (!b || typeof b.validateEndpoint !== 'function') {
        return {
          ok: false,
          engineType: '',
          checkedUrl: '',
          status: 0,
          code: 'bridge_unavailable',
          message: 'Setup bridge is unavailable.',
        };
      }
      try {
        var result = await b.validateEndpoint(payload && typeof payload === 'object' ? payload : {});
        return normalizeValidationResult(result);
      } catch (error) {
        appendClientLog('WARN', 'setup.validate_endpoint_failed', { message: toErrorMessage(error) });
        return {
          ok: false,
          engineType: String((payload && payload.engineType) || ''),
          checkedUrl: '',
          status: 0,
          code: 'request_failed',
          message: toErrorMessage(error) || 'Endpoint validation failed.',
        };
      }
    }

    async function saveEndpoint(payload) {
      var b = bridge();
      if (!b || typeof b.saveEndpoint !== 'function') {
        return {
          result: normalizeValidationResult({
            ok: false,
            code: 'bridge_unavailable',
            error_code: 'CMP-SETUP-0001',
            message: 'Setup bridge is unavailable.',
            retryable: true,
          }),
          snapshot: null,
        };
      }
      try {
        var response = await b.saveEndpoint(payload && typeof payload === 'object' ? payload : {});
        return {
          result: normalizeValidationResult(response && response.endpoint_result),
          snapshot: normalizeSetupPayload(response),
        };
      } catch (error) {
        appendClientLog('WARN', 'setup.save_endpoint_failed', { message: toErrorMessage(error) });
        return {
          result: normalizeValidationResult({
            ok: false,
            code: 'request_failed',
            message: 'Endpoint settings could not be saved.',
            retryable: true,
          }),
          snapshot: null,
        };
      }
    }

    async function startOllamaPull(payload) {
      var b = bridge();
      if (!b || typeof b.startOllamaPull !== 'function') {
        throw new Error('Setup bridge unavailable for Ollama pull.');
      }
      try {
        var result = await b.startOllamaPull(payload && typeof payload === 'object' ? payload : {});
        return normalizePullPayload(result);
      } catch (error) {
        appendClientLog('WARN', 'setup.start_ollama_pull_failed', { message: toErrorMessage(error) });
        throw error;
      }
    }

    async function cancelOllamaPull(payload) {
      var b = bridge();
      if (!b || typeof b.cancelOllamaPull !== 'function') {
        return { cancelled: false, code: 'bridge_unavailable', terminationConfirmed: false };
      }
      try {
        var result = await b.cancelOllamaPull(payload && typeof payload === 'object' ? payload : {});
        var normalized = normalizePullPayload(result);
        normalized.cancelled = result && result.cancelled === true;
        normalized.terminationConfirmed = result && result.termination_confirmed === true;
        normalized.code = String((result && result.code) || '');
        normalized.errorCode = String((result && result.error_code) || '');
        return normalized;
      } catch (error) {
        appendClientLog('WARN', 'setup.cancel_ollama_pull_failed', { message: toErrorMessage(error) });
        return { cancelled: false, code: 'request_failed', terminationConfirmed: false };
      }
    }

    function subscribePullProgress(listener) {
      var b = bridge();
      if (!b || typeof b.onModelPullProgress !== 'function' || typeof listener !== 'function') {
        return function noopUnsubscribe() {};
      }
      var unsubscribe = b.onModelPullProgress(function progressHandler(payload) {
        try {
          listener(normalizePullPayload(payload));
        } catch (error) {
          appendClientLog('WARN', 'setup.pull_progress_listener_failed', {
            message: toErrorMessage(error),
          });
        }
      });
      return typeof unsubscribe === 'function' ? unsubscribe : function noopUnsubscribe() {};
    }

    async function detectOllama(payload) {
      var b = bridge();
      var fallback = { installed: false, running: false, version: '', installPath: '', source: 'none' };
      if (!b || typeof b.detectOllama !== 'function') {
        return fallback;
      }
      try {
        return normalizeDetectPayload(await b.detectOllama(payload && typeof payload === 'object' ? payload : {}));
      } catch (error) {
        appendClientLog('WARN', 'setup.detect_ollama_failed', { message: toErrorMessage(error) });
        return fallback;
      }
    }

    async function getOllamaInstallPlan() {
      var b = bridge();
      var fallback = {
        available: false, url: '', version: '', sizeBytes: 0, sha256: '', license: '', manualFallbackUrl: '',
      };
      if (!b || typeof b.getOllamaInstallPlan !== 'function') {
        return fallback;
      }
      try {
        return normalizeInstallPlan(await b.getOllamaInstallPlan());
      } catch (error) {
        appendClientLog('WARN', 'setup.get_ollama_install_plan_failed', { message: toErrorMessage(error) });
        return fallback;
      }
    }

    async function installOllama(payload) {
      var b = bridge();
      if (!b || typeof b.installOllama !== 'function') {
        return { status: 'failed', code: 'bridge_unavailable', manualFallbackUrl: '' };
      }
      try {
        return normalizeInstallPayload(
          await b.installOllama(payload && typeof payload === 'object' ? payload : {})
        );
      } catch (error) {
        appendClientLog('WARN', 'setup.install_ollama_failed', { message: toErrorMessage(error) });
        return { status: 'failed', code: 'request_failed', error: toErrorMessage(error), manualFallbackUrl: '' };
      }
    }

    async function cancelOllamaInstall(payload) {
      var b = bridge();
      if (!b || typeof b.cancelOllamaInstall !== 'function') {
        return { cancelled: false, code: 'bridge_unavailable', terminationConfirmed: false };
      }
      try {
        var result = await b.cancelOllamaInstall(payload && typeof payload === 'object' ? payload : {});
        return {
          cancelled: result && result.cancelled === true,
          terminationConfirmed: result && result.termination_confirmed === true,
          requestId: String((result && (result.requestId || result.request_id)) || ''),
          status: String((result && result.status) || ''),
          code: String((result && result.code) || ''),
          errorCode: String((result && result.error_code) || ''),
        };
      } catch (error) {
        appendClientLog('WARN', 'setup.cancel_ollama_install_failed', { message: toErrorMessage(error) });
        return { cancelled: false, code: 'request_failed', terminationConfirmed: false };
      }
    }

    function subscribeOllamaInstallProgress(listener) {
      var b = bridge();
      if (!b || typeof b.onOllamaInstallProgress !== 'function' || typeof listener !== 'function') {
        return function noopUnsubscribe() {};
      }
      var unsubscribe = b.onOllamaInstallProgress(function installHandler(payload) {
        try {
          listener(normalizeInstallPayload(payload));
        } catch (error) {
          appendClientLog('WARN', 'setup.install_progress_listener_failed', {
            message: toErrorMessage(error),
          });
        }
      });
      return typeof unsubscribe === 'function' ? unsubscribe : function noopUnsubscribe() {};
    }

    return {
      getState,
      updateState,
      complete,
      reset,
      factoryReset,
      validateEndpoint,
      saveEndpoint,
      startOllamaPull,
      cancelOllamaPull,
      subscribePullProgress,
      detectOllama,
      getOllamaInstallPlan,
      installOllama,
      cancelOllamaInstall,
      subscribeOllamaInstallProgress,
    };
  }

  return {
    createSetupService: createSetupService,
    normalizeSetupPayload: normalizeSetupPayload,
    normalizeValidationResult: normalizeValidationResult,
    normalizePullPayload: normalizePullPayload,
    normalizeInstallPayload: normalizeInstallPayload,
    normalizeDetectPayload: normalizeDetectPayload,
    normalizeInstallPlan: normalizeInstallPlan,
  };
});
