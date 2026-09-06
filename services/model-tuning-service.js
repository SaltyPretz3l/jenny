'use strict';

const {
  GENERATION_PROFILE_BOUNDS,
  normalizeGenerationProfile,
  normalizeModelId,
  normalizeStreamInactivitySeconds,
} = require('./shell-config-model-tuning');
const {
  CONTEXT_LENGTH_STEPS,
  CUSTOM_PROMPT_MAX_CHARS,
  RATIO_MAX,
  RATIO_MIN,
  normalizeContextLength,
  normalizeRatio,
} = require('./shell-config-compaction-tuning');
const { estimateModelFit } = require('./model-fit-estimator');

const SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE = 32_768;
const MODEL_TUNING_REFRESH_TIMEOUT_MS = 30_000;
const SUPPORTED_GENERATION_ENGINES = new Set(['ollama', 'vllm', 'openai-compatible']);
const CONTEXT_CONTROL_ENGINES = new Set(['ollama', 'openai-compatible']);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function canonicalModelId(value) {
  const modelId = normalizeModelId(value).toLowerCase();
  if (!modelId) return '';
  const lastSegment = modelId.slice(modelId.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? modelId : `${modelId}:latest`;
}

function matchesModel(left, right) {
  return canonicalModelId(left) === canonicalModelId(right);
}

function validateGenerationProfile(value) {
  if (value == null) return { ok: true, profile: {} };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'malformed_generation_profile' };
  }
  if (Object.keys(value).some((field) => !hasOwn(GENERATION_PROFILE_BOUNDS, field))) {
    return { ok: false, reason: 'malformed_generation_profile' };
  }
  const normalized = normalizeGenerationProfile(value);
  const suppliedFields = Object.keys(value).filter((field) => value[field] != null && value[field] !== '');
  if (Object.keys(normalized).length !== suppliedFields.length) {
    return { ok: false, reason: 'malformed_generation_profile' };
  }
  return { ok: true, profile: normalized };
}

class ModelTuningService {
  constructor({ shellConfigService, backendService, offlineIntelligenceService, log = null } = {}) {
    this.shellConfigService = shellConfigService || null;
    this.backendService = backendService || null;
    this.offlineIntelligenceService = offlineIntelligenceService || null;
    this.log = typeof log === 'function' ? log : null;
    this.pending = false;
    this.disposed = false;
  }

  dispose() {
    this.disposed = true;
  }

  _readState() {
    let tuning = {};
    let compaction = {};
    let ok = true;
    try {
      tuning = this.shellConfigService?.getModelTuning?.() || {};
      compaction = this.shellConfigService?.getCompactionTuning?.() || {};
    } catch (_error) {
      ok = false;
      this._emit('WARN', 'model_tuning.state_read_failed', {
        status: 'degraded',
        reason: 'config_read_failed',
      });
    }
    return { ok, state: {
      ...tuning,
      ratioByModel: { ...(compaction.ratioByModel || {}) },
      contextLengthByModel: { ...(compaction.contextLengthByModel || {}) },
      customPrompt: String(compaction.customPrompt || ''),
      contextLengthSteps: [...CONTEXT_LENGTH_STEPS],
      generationProfileBounds: GENERATION_PROFILE_BOUNDS,
      ratioBounds: { min: RATIO_MIN, max: RATIO_MAX },
      pending: this.pending,
    } };
  }

  getState() {
    return this._readState().state;
  }

  _emit(level, event, details = {}) {
    const bounded = {
      event,
      modelId: String(details.modelId || '').slice(0, 240),
      status: String(details.status || '').slice(0, 32),
      reason: String(details.reason || '').slice(0, 80),
      requestedContextLength: Number(details.requestedContextLength) || null,
      contextLimit: Number(details.contextLimit) || null,
    };
    // Additive, event-specific fields: only attached when the caller supplies
    // them, so the fixed shape asserted by existing preflight log tests is
    // unaffected.
    if (hasOwn(details, 'estimatedVramMb')) {
      bounded.estimatedVramMb = Number(details.estimatedVramMb) || 0;
    }
    if (hasOwn(details, 'confidence')) {
      bounded.confidence = String(details.confidence || '').slice(0, 16);
    }
    try {
      if (this.backendService && typeof this.backendService._emitServiceLog === 'function') {
        this.backendService._emitServiceLog(level, event, bounded);
      } else if (this.log) {
        this.log(level, event, bounded);
      }
    } catch (_error) {
      // Diagnostics must never change the tuning result contract.
    }
  }

  // Estimated fits require a real hardware reading to scale against; with no
  // vram/unified-memory/RAM numbers at all, an estimate must never unlock a
  // context the SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE floor would otherwise
  // reject, so callers fall through to the existing unverified/degraded path.
  _hardwareDetected(diagnostics) {
    const gpu = diagnostics?.hardwareProfile?.gpu || {};
    const vramMb = Number(gpu.vram_mb ?? gpu.vramMb) || 0;
    const unifiedMb = Number(gpu.unified_memory_mb ?? gpu.unifiedMemoryMb) || 0;
    const totalMb = Number(diagnostics?.memory?.totalMb) || 0;
    return vramMb > 0 || unifiedMb > 0 || totalMb > 0;
  }

  // Non-catalog fit path: diagnostics.modelFitEstimates is already gated by
  // the model_fit_estimates flag upstream (offline-intelligence-service /
  // model-fit-diagnostics.js return [] when the flag is off), so an empty or
  // missing entry here naturally falls through to the unverified/degraded
  // branches below without a second flag check.
  _estimatedPreflight(diagnostics, modelId, contextLength, nativeContext) {
    const entry = (diagnostics?.modelFitEstimates || []).find((candidate) => (
      matchesModel(candidate?.modelId, modelId)
    ));
    if (!entry || !this._hardwareDetected(diagnostics)) return null;
    const scaled = estimateModelFit({
      sizeBytes: entry.sizeBytes,
      params: entry.params,
      quant: entry.quant,
      contextLength,
      hardware: diagnostics?.hardwareProfile,
      memory: diagnostics?.memory,
    });
    if (!scaled) return null;
    // A 'medium'-confidence estimate (real parsed param count) that fails on
    // VRAM, accelerator AND CPU is trustworthy enough to hard-reject. A
    // 'low'-confidence non-fit (unparsed/MoE params — the estimate itself is
    // shaky) instead falls through to the same accept-with-warning path as a
    // fit: Ollama's mmap paging can still make the load succeed, and a shaky
    // estimate should not be the thing that blocks the user.
    if (scaled.fits !== true && scaled.confidence === 'medium') {
      return {
        status: 'rejected',
        checked: true,
        reason: 'insufficient_memory',
        contextLimit: nativeContext || null,
        fit: 'estimated',
      };
    }
    this._emit('WARN', 'model_tuning.preflight_estimated_fit', {
      modelId,
      status: 'accepted',
      reason: 'hardware_fit_estimated',
      requestedContextLength: contextLength,
      contextLimit: nativeContext || null,
      estimatedVramMb: scaled.vramRequiredMb,
      confidence: scaled.confidence,
    });
    return {
      status: 'accepted',
      checked: true,
      reason: '',
      contextLimit: nativeContext || null,
      fit: 'estimated',
      warning: 'hardware_fit_estimated',
    };
  }

  async _preflight(modelId, contextLength) {
    if (contextLength == null) {
      return { status: 'not_requested', checked: false, contextLimit: null };
    }
    let status = {};
    try {
      status = this.backendService?.getBackendStatus?.() || this.backendService?.currentStatus || {};
    } catch (_error) {
      this._emit('WARN', 'model_tuning.preflight_degraded', {
        modelId,
        status: 'degraded',
        reason: 'backend_status_unavailable',
        requestedContextLength: contextLength,
      });
    }
    let nativeContext = matchesModel(modelId, this.backendService?.currentModel)
      ? Number(status.native_context_length || status.nativeContextLength) || 0
      : 0;
    let inspectionReason = '';
    if (!nativeContext) {
      try {
        const inspectedModels = await this.backendService?.listModelsForEngine?.('ollama', {
          inspectModelId: modelId,
        });
        const inspection = inspectedModels?.modelInspection;
        if (inspection?.available === true && matchesModel(inspection.modelId, modelId)) {
          nativeContext = Number(inspection.nativeContextLength) || 0;
        } else {
          inspectionReason = String(inspection?.reason || 'model_inspection_unavailable');
        }
      } catch (_error) {
        inspectionReason = 'model_inspection_unavailable';
      }
    }
    if (this.disposed) return { status: 'rejected', checked: false, reason: 'disposed' };
    if (nativeContext && contextLength > nativeContext) {
      return {
        status: 'rejected',
        checked: true,
        reason: 'exceeds_native_context',
        contextLimit: nativeContext,
      };
    }
    let diagnostics = null;
    try {
      diagnostics = await this.offlineIntelligenceService?.getDiagnostics?.();
    } catch (_error) {
      this._emit('WARN', 'model_tuning.preflight_degraded', {
        modelId,
        status: 'degraded',
        reason: 'diagnostics_unavailable',
        requestedContextLength: contextLength,
      });
    }
    if (this.disposed) return { status: 'rejected', checked: false, reason: 'disposed' };
    const recommendation = (diagnostics?.modelRecommendations || []).find((entry) => (
      matchesModel(entry?.modelId || entry?.pullTag, modelId)
    ));
    if (recommendation) {
      const catalogContext = Number(recommendation.contextLength) || 0;
      if (recommendation.fits !== true) {
        return {
          status: 'rejected',
          checked: true,
          reason: 'insufficient_memory',
          contextLimit: catalogContext || nativeContext || null,
        };
      }
      if (catalogContext && contextLength > catalogContext) {
        return {
          status: 'rejected',
          checked: true,
          reason: 'exceeds_profile_context',
          contextLimit: catalogContext,
        };
      }
      return {
        status: 'accepted',
        checked: true,
        contextLimit: catalogContext || nativeContext || null,
        fit: recommendation.fitsInVram ? 'vram' : recommendation.fitsOnCpu ? 'ram' : 'accelerator',
      };
    }
    const estimatedResult = this._estimatedPreflight(diagnostics, modelId, contextLength, nativeContext);
    if (estimatedResult) return estimatedResult;
    if (nativeContext) {
      this._emit('WARN', 'model_tuning.preflight_unverified_fit', {
        modelId,
        status: 'accepted',
        reason: 'hardware_fit_unverified',
        requestedContextLength: contextLength,
        contextLimit: nativeContext,
      });
      return {
        status: 'accepted',
        checked: true,
        reason: '',
        contextLimit: nativeContext,
        fit: 'unverified',
        warning: 'hardware_fit_unverified',
      };
    }
    if (inspectionReason) {
      this._emit('WARN', 'model_tuning.preflight_degraded', {
        modelId,
        status: 'degraded',
        reason: inspectionReason,
        requestedContextLength: contextLength,
        contextLimit: SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE,
      });
    }
    if (contextLength > SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE) {
      return {
        status: 'rejected',
        checked: false,
        reason: 'hardware_profile_unavailable',
        contextLimit: SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE,
      };
    }
    return {
      status: 'degraded',
      checked: false,
      reason: 'hardware_profile_unavailable',
      contextLimit: SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE,
    };
  }

  async _refreshOrThrow(reason) {
    if (!this.backendService || typeof this.backendService.refreshManagedConfig !== 'function') {
      throw new Error('managed_runtime_unavailable');
    }
    const result = await this.backendService.refreshManagedConfig(reason, {
      inactivityTimeoutMs: MODEL_TUNING_REFRESH_TIMEOUT_MS,
      absoluteTimeoutMs: MODEL_TUNING_REFRESH_TIMEOUT_MS,
    });
    if (result == null) throw new Error('managed_runtime_unavailable');
    return result;
  }

  async update(patch = {}) {
    if (this.disposed) return { status: 'rejected', reason: 'disposed', state: this.getState() };
    if (this.pending) return { status: 'rejected', reason: 'update_in_progress', state: this.getState() };
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const hasStreamTimeout = hasOwn(source, 'streamInactivitySeconds');
    const hasGenerationProfile = hasOwn(source, 'generationProfile');
    const resetGenerationProfile = source.resetGenerationProfile === true;
    const hasContextLength = hasOwn(source, 'contextLength');
    const hasRatio = hasOwn(source, 'ratio');
    const hasCustomPrompt = hasOwn(source, 'customPrompt');
    const hasModelChange = hasStreamTimeout || hasGenerationProfile || resetGenerationProfile
      || hasContextLength || hasRatio;
    if (!hasModelChange && !hasCustomPrompt) {
      return { status: 'rejected', reason: 'no_changes', state: this.getState() };
    }
    const needsModelConfig = hasModelChange;
    const needsCompactionConfig = hasContextLength || hasRatio || hasCustomPrompt;
    if (!this.shellConfigService
      || (needsModelConfig && typeof this.shellConfigService.updateModelTuning !== 'function')
      || (needsCompactionConfig && typeof this.shellConfigService.setCompactionTuning !== 'function')) {
      return { status: 'rejected', reason: 'config_service_unavailable', state: this.getState() };
    }
    const modelId = hasModelChange && typeof source.modelId === 'string'
      ? normalizeModelId(source.modelId)
      : '';
    if (hasModelChange && !modelId) {
      return { status: 'rejected', reason: 'invalid_model_id', state: this.getState() };
    }
    const currentEngineType = String(this.backendService?.currentEngineType || '').trim().toLowerCase();
    if (hasModelChange && currentEngineType && matchesModel(modelId, this.backendService?.currentModel)
      && !SUPPORTED_GENERATION_ENGINES.has(currentEngineType)) {
      return { status: 'rejected', reason: 'unsupported_engine', state: this.getState() };
    }
    // Ollama takes the window per request; the managed llama-server takes it as
    // -c on relaunch. Both are ours to set, so both accept a context change.
    if (hasContextLength
      && currentEngineType && matchesModel(modelId, this.backendService?.currentModel)
      && !CONTEXT_CONTROL_ENGINES.has(currentEngineType)) {
      return { status: 'rejected', reason: 'unsupported_context_control', state: this.getState() };
    }
    const streamInactivitySeconds = source.streamInactivitySeconds == null
      ? null
      : normalizeStreamInactivitySeconds(source.streamInactivitySeconds);
    if (hasStreamTimeout && source.streamInactivitySeconds != null && streamInactivitySeconds == null) {
      return { status: 'rejected', reason: 'invalid_stream_timeout', state: this.getState() };
    }
    const profileResult = validateGenerationProfile(
      hasGenerationProfile ? source.generationProfile : null
    );
    if (!profileResult.ok) return { status: 'rejected', reason: profileResult.reason, state: this.getState() };
    const contextLength = !hasContextLength || source.contextLength == null
      ? null
      : normalizeContextLength(source.contextLength);
    if (hasContextLength && source.contextLength != null && contextLength == null) {
      return { status: 'rejected', reason: 'invalid_context_length', state: this.getState() };
    }
    const ratio = !hasRatio || source.ratio == null ? null : normalizeRatio(source.ratio);
    if (hasRatio && source.ratio != null && ratio == null) {
      return { status: 'rejected', reason: 'invalid_compaction_ratio', state: this.getState() };
    }
    if (hasCustomPrompt && source.customPrompt != null && typeof source.customPrompt !== 'string') {
      return { status: 'rejected', reason: 'malformed_custom_prompt', state: this.getState() };
    }
    if (hasCustomPrompt && typeof source.customPrompt === 'string'
      && source.customPrompt.length > CUSTOM_PROMPT_MAX_CHARS) {
      return { status: 'rejected', reason: 'custom_prompt_too_long', state: this.getState() };
    }
    const customPrompt = typeof source.customPrompt === 'string' ? source.customPrompt : '';
    const requiresRuntimeRefresh = hasGenerationProfile || resetGenerationProfile
      || hasContextLength || hasRatio || hasCustomPrompt;
    if (!requiresRuntimeRefresh) {
      try {
        this.shellConfigService.updateModelTuning({ modelId, streamInactivitySeconds });
        return {
          status: 'applied',
          reason: 'saved_for_next_runtime',
          runtimeAcknowledged: false,
          state: this.getState(),
        };
      } catch (_error) {
        this._emit('ERROR', 'model_tuning.apply_failed', {
          modelId,
          status: 'rejected',
          reason: 'config_write_failed',
        });
        return { status: 'rejected', reason: 'config_write_failed', state: this.getState() };
      }
    }
    if (this.backendService?.activeStreams?.size) {
      return { status: 'rejected', reason: 'active_stream', state: this.getState() };
    }
    const previousRead = this._readState();
    if (!previousRead.ok) {
      return { status: 'rejected', reason: 'config_read_failed', state: previousRead.state };
    }
    this.pending = true;
    const previous = previousRead.state;
    let applyStage = 'config_write';
    try {
      const preflight = await this._preflight(modelId, contextLength);
      if (preflight.status === 'rejected') {
        this._emit('WARN', 'model_tuning.preflight_rejected', {
          modelId,
          status: preflight.status,
          reason: preflight.reason,
          requestedContextLength: contextLength,
          contextLimit: preflight.contextLimit,
        });
        return { status: 'rejected', reason: preflight.reason, preflight, state: this.getState() };
      }
      if (this.disposed) return { status: 'rejected', reason: 'disposed', preflight, state: this.getState() };
      if (this.backendService?.activeStreams?.size) {
        return { status: 'rejected', reason: 'active_stream', preflight, state: this.getState() };
      }
      if (hasStreamTimeout || resetGenerationProfile || hasGenerationProfile) {
        const modelPatch = { modelId };
        if (hasStreamTimeout) modelPatch.streamInactivitySeconds = streamInactivitySeconds;
        if (hasGenerationProfile) modelPatch.generationProfile = profileResult.profile;
        if (resetGenerationProfile) modelPatch.resetGenerationProfile = true;
        this.shellConfigService.updateModelTuning(modelPatch);
      }
      if (hasContextLength || hasRatio || hasCustomPrompt) {
        const compactionPatch = {};
        if (hasContextLength || hasRatio) compactionPatch.modelId = modelId;
        if (hasContextLength) compactionPatch.contextLength = contextLength;
        if (hasRatio) compactionPatch.ratio = ratio;
        if (hasCustomPrompt) compactionPatch.customPrompt = customPrompt;
        this.shellConfigService.setCompactionTuning(compactionPatch);
      }
      applyStage = 'runtime_refresh';
      await this._refreshOrThrow('model_tuning_transaction');
      if (this.disposed) {
        return { status: 'applied', reason: 'disposed_after_apply', preflight, state: this.getState() };
      }
      this._emit('INFO', 'model_tuning.applied', {
        modelId,
        status: 'applied',
        requestedContextLength: contextLength,
        contextLimit: preflight.contextLimit,
      });
      if (hasContextLength) {
        // Wave 4 model-fit self-catalog: a context-length change alters the
        // model's real VRAM footprint, so the last-observed measurement for
        // this model is stale — invalidate it so the observer re-measures on
        // the next load rather than waiting for an unrelated engine restart.
        // Optional hook carried on backendService (see
        // services/main/backend-service-wiring.js); never throws.
        try {
          this.backendService?.modelFitObserver?.invalidate?.(modelId);
        } catch (_) {
          // best-effort only
        }
      }
      return { status: 'applied', preflight, state: this.getState() };
    } catch (_error) {
      try {
        if (hasStreamTimeout || resetGenerationProfile || hasGenerationProfile) {
          const previousProfile = previous.generationProfilesByModel?.[modelId];
          const rollbackModelPatch = { modelId };
          if (hasStreamTimeout) {
            rollbackModelPatch.streamInactivitySeconds = previous.streamInactivitySecondsByModel?.[modelId] ?? null;
          }
          if (resetGenerationProfile || hasGenerationProfile) {
            rollbackModelPatch.generationProfile = previousProfile || {};
            rollbackModelPatch.resetGenerationProfile = !previousProfile;
          }
          this.shellConfigService.updateModelTuning(rollbackModelPatch);
        }
        if (hasContextLength || hasRatio || hasCustomPrompt) {
          const rollbackCompactionPatch = {};
          if (hasContextLength || hasRatio) rollbackCompactionPatch.modelId = modelId;
          if (hasContextLength) {
            rollbackCompactionPatch.contextLength = previous.contextLengthByModel?.[modelId] ?? null;
          }
          if (hasRatio) rollbackCompactionPatch.ratio = previous.ratioByModel?.[modelId] ?? null;
          if (hasCustomPrompt) rollbackCompactionPatch.customPrompt = previous.customPrompt;
          this.shellConfigService.setCompactionTuning(rollbackCompactionPatch);
        }
      } catch (_rollbackError) {
        this._emit('ERROR', 'model_tuning.rollback_failed', {
          modelId,
          status: 'degraded',
          reason: 'rollback_persistence_failed',
        });
        return { status: 'degraded', reason: 'rollback_persistence_failed', state: this.getState() };
      }
      try {
        await this._refreshOrThrow('model_tuning_rollback');
      } catch (_rollbackError) {
        this._emit('ERROR', 'model_tuning.rollback_failed', {
          modelId,
          status: 'degraded',
          reason: 'rollback_refresh_failed',
        });
        return { status: 'degraded', reason: 'rollback_refresh_failed', state: this.getState() };
      }
      this._emit('ERROR', 'model_tuning.apply_failed', {
        modelId,
        status: 'rolled_back',
        reason: applyStage === 'runtime_refresh' ? 'runtime_refresh_failed' : 'config_write_failed',
      });
      return {
        status: 'rolled_back',
        reason: applyStage === 'runtime_refresh' ? 'runtime_refresh_failed' : 'config_write_failed',
        state: this.getState(),
      };
    } finally {
      this.pending = false;
    }
  }

  async updateCustomPrompt(customPrompt) {
    return this.update({ customPrompt });
  }
}

module.exports = {
  ModelTuningService,
  MODEL_TUNING_REFRESH_TIMEOUT_MS,
  SAFE_CONTEXT_WITHOUT_HARDWARE_PROFILE,
  SUPPORTED_GENERATION_ENGINES,
  canonicalModelId,
  validateGenerationProfile,
};
