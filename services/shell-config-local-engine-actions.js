/* services/shell-config-local-engine-actions.js - ShellConfigService methods for the
 * local-engine settings (llama-server, NInfer, embedding, acceleration), the
 * preferred engine, the ChatGPT model choices and the setup endpoint save.
 *
 * Extracted from shell-config-service.js as a behavior-preserving move and
 * installed on ShellConfigService.prototype the same way as the other
 * shell-config-*-actions bags; every method keeps its `this` contract
 * (state, getState, _writeState, _commitState).
 */
const { normalizeLastChatgptModel, normalizeLocalEngines, normalizePreferredEngineType } = require('./shell-config-engines');

const localEngineActionMethods = {
  getLocalEngines() { return normalizeLocalEngines(this.state.localEngines); },

  updateStartupModelLoad(enabled) {
    const current = this.getLocalEngines();
    const startupModelLoad = Boolean(enabled);
    if (startupModelLoad === current.startupModelLoad) return current;
    const localEngines = normalizeLocalEngines({ ...this.state.localEngines, startupModelLoad });
    return this._writeState({ ...this.state, localEngines }, 'startup_model_load_updated').localEngines;
  },

  updateLocalEngineAcceleration(patch) {
    const localEngines = normalizeLocalEngines({
      ...this.state.localEngines,
      openaiCompatible: { ...this.state.localEngines?.openaiCompatible, acceleration: patch },
    });
    const current = this.getLocalEngines().openaiCompatible.acceleration;
    if (JSON.stringify(localEngines.openaiCompatible.acceleration) === JSON.stringify(current)) return this.getState();
    return this._writeState({ ...this.state, localEngines }, 'local_engine_acceleration_updated');
  },

  // Semantic catalog embedding model choice (row 41). The normalizer drops a
  // path that is not a local absolute .gguf, so the result is the source of truth.
  updateEmbeddingSettings(patch) { return this._updateLocalEngineSlice('embedding', patch, 'embedding_settings_updated'); },

  // NInfer (row 54): `watchdog` merges one level deeper so a toggle write cannot drop the thresholds.
  updateNinferSettings(patch) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const watchdog = { ...this.getLocalEngines().ninfer.watchdog, ...(source.watchdog || {}) };
    return this._updateLocalEngineSlice('ninfer', { ...source, watchdog }, 'ninfer_settings_updated');
  },

  _updateLocalEngineSlice(key, patch, reason) {
    const current = this.getLocalEngines()[key];
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const localEngines = normalizeLocalEngines({ ...this.state.localEngines, [key]: { ...current, ...source } });
    if (JSON.stringify(localEngines[key]) === JSON.stringify(current)) return current;
    return this._writeState({ ...this.state, localEngines }, reason).localEngines[key];
  },

  updateManagedLlamaServer(patch) {
    const current = this.getLocalEngines().openaiCompatible.managed;
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const perModel = { ...current.perModel };
    if (source.perModel && typeof source.perModel === 'object' && !Array.isArray(source.perModel)) {
      for (const [key, value] of Object.entries(source.perModel)) {
        if (value === null) {
          delete perModel[key];
        } else {
          perModel[key] = value;
        }
      }
    }
    const openaiCompatible = {
      ...this.state.localEngines?.openaiCompatible,
      managed: { ...current, ...source, perModel },
    };
    const localEngines = normalizeLocalEngines({ ...this.state.localEngines, openaiCompatible });
    if (JSON.stringify(localEngines.openaiCompatible.managed) === JSON.stringify(current)) {
      return this.getState();
    }
    return this._writeState({ ...this.state, localEngines }, 'managed_llama_server_updated');
  },

  updatePreferredEngineType(value) {
    const preferredEngineType = normalizePreferredEngineType(value);
    if (preferredEngineType === this.state.preferredEngineType) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        preferredEngineType,
      },
      'preferred_engine_type_updated'
    );
  },

  // Written by a successful ChatGPT model load only; startup reads it back.
  updateLastChatgptModel(value) {
    const lastChatgptModel = normalizeLastChatgptModel(value);
    if (!lastChatgptModel || lastChatgptModel === this.state.lastChatgptModel) {
      return this.getState();
    }
    return this._writeState({ ...this.state, lastChatgptModel }, 'last_chatgpt_model_updated');
  },

  // Cloud models group: the user's "Show ChatGPT models in Composer" choice.
  updateChatgptModelsEnabled(value) {
    if (typeof value !== 'boolean' || value === this.state.chatgptModelsEnabled) {
      return this.getState();
    }
    return this._writeState({ ...this.state, chatgptModelsEnabled: value },
      'chatgpt_models_enabled_updated');
  },

  getPreferredEngineType() { return this.state.preferredEngineType; },

  saveSetupEndpoint({ engineType, port, apiUrl } = {}) {
    const preferredEngineType = normalizePreferredEngineType(engineType);
    if (!['ollama', 'vllm', 'openai-compatible'].includes(preferredEngineType)) {
      return { saved: false, reason: 'unsupported_engine' };
    }
    const localEngines = normalizeLocalEngines({
      ...this.state.localEngines,
      ...(preferredEngineType === 'vllm' ? {
        vllm: { ...this.state.localEngines?.vllm, port },
      } : {}),
      ...(preferredEngineType === 'openai-compatible' ? {
        openaiCompatible: { ...this.state.localEngines?.openaiCompatible, port, apiUrl },
      } : {}),
    });
    const nextState = {
      ...this.state,
      preferredEngineType,
      localEngines,
    };
    const committed = this._commitState(nextState, 'setup_endpoint_saved');
    return { saved: committed.persisted, state: committed.snapshot };
  },
};

module.exports = { localEngineActionMethods };
