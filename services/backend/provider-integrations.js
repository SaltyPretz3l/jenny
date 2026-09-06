function createProviderIntegrationRegistry(integrations = []) {
  const active = integrations.filter(Boolean);

  function cloneValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => cloneValue(item));
    }
    if (value && typeof value === 'object') {
      const cloned = {};
      for (const [key, item] of Object.entries(value)) {
        cloned[key] = cloneValue(item);
      }
      return cloned;
    }
    return value;
  }

  return {
    getManagedConfigPatch() {
      const featureFlags = {};
      const patch = {};
      for (const integration of active) {
        if (typeof integration.getManagedConfigPatch !== 'function') {
          continue;
        }
        const candidate = integration.getManagedConfigPatch() || {};
        if (candidate.feature_flags && typeof candidate.feature_flags === 'object' && !Array.isArray(candidate.feature_flags)) {
          Object.assign(featureFlags, candidate.feature_flags);
        }
        for (const [key, value] of Object.entries(candidate)) {
          if (key === 'feature_flags') {
            continue;
          }
          patch[key] = cloneValue(value);
        }
      }
      if (Object.keys(featureFlags).length) {
        patch.feature_flags = featureFlags;
      }
      return patch;
    },
    appendModelEntries(entries = [], options = {}) {
      const merged = Array.isArray(entries) ? entries.map((entry) => cloneValue(entry)) : [];
      const desiredEngineType = String(options.engineType || '').trim().toLowerCase();
      const seen = new Set(merged.map((entry) => String(entry?.id || '').trim()).filter(Boolean));
      for (const integration of active) {
        if (typeof integration.getModelCatalog !== 'function') {
          continue;
        }
        const catalog = integration.getModelCatalog() || [];
        for (const model of catalog) {
          const id = String(model?.id || '').trim();
          const provider = String(model?.provider || '').trim().toLowerCase();
          if (
            !id
            || seen.has(id)
            || (desiredEngineType && provider && provider !== desiredEngineType)
          ) {
            continue;
          }
          seen.add(id);
          merged.push(cloneValue(model));
        }
      }
      return merged;
    },
    resolveModelAvailability(modelId) {
      for (const integration of active) {
        if (typeof integration.isModelAvailable !== 'function') {
          continue;
        }
        const result = integration.isModelAvailable(modelId);
        if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'available')) {
          return cloneValue(result);
        }
      }
      return { available: true, reason: '' };
    },
  };
}

module.exports = {
  createProviderIntegrationRegistry,
};
