(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleFormatUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Pure, stateless lifecycle formatting helpers. */

  const DEFAULT_CONTEXT_PREFERENCES = Object.freeze({
    historyScope: 'session',
    includePersonality: true,
    includeMemory: true,
  });

  function escapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function getSessionMonogram(title) {
    const normalized = String(title || '').trim();
    if (!normalized) {
      return 'J';
    }

    const words = normalized
      .split(/\s+/)
      .map((word) => word.replace(/[^a-z0-9]/gi, ''))
      .filter(Boolean);

    if (words.length >= 2) {
      return `${words[0].charAt(0)}${words[1].charAt(0)}`.toUpperCase();
    }

    const compact = (words[0] || normalized.replace(/[^a-z0-9]/gi, '')).slice(0, 2);
    return (compact || 'J').toUpperCase();
  }

  function normalizeModelToken(value) {
    return String(value || '').trim();
  }

  function normalizeContextHistoryScope(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
      return DEFAULT_CONTEXT_PREFERENCES.historyScope;
    }
    if (normalized === 'session' || normalized === 'recent' || normalized === 'fresh') {
      return normalized;
    }
    return 'fresh';
  }

  function normalizeContextPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const historyScope = Object.prototype.hasOwnProperty.call(source, 'history_scope')
      ? source.history_scope
      : source.historyScope;
    const includePersonality = Object.prototype.hasOwnProperty.call(source, 'include_personality')
      ? source.include_personality
      : source.includePersonality;
    const includeMemory = Object.prototype.hasOwnProperty.call(source, 'include_memory')
      ? source.include_memory
      : source.includeMemory;
    return {
      historyScope: normalizeContextHistoryScope(historyScope),
      includePersonality: includePersonality === false ? false : DEFAULT_CONTEXT_PREFERENCES.includePersonality,
      includeMemory: includeMemory === false ? false : DEFAULT_CONTEXT_PREFERENCES.includeMemory,
    };
  }

  // Shared descriptor builder behind buildModelOptionMarkup (below) AND any
  // consumer that renders model options through an inventory primitive
  // instead of raw <option> markup (e.g. renderer-quick-settings-modal.js's
  // selectField-based model row) -- both read the exact same
  // state.modelList.data-shaped source list through one code path so the
  // "available models" set can never drift between the two UIs.
  function buildModelOptionsArray(models, selectedValue, config = {}) {
    const normalizedSelected = normalizeModelToken(selectedValue);
    const autoLabel = config.compact ? 'Use default' : 'Auto (backend default)';
    const optionList = Array.isArray(models) ? models : [];
    const hasSelectedModel = normalizedSelected
      ? optionList.some((model) => String(model?.id || '').trim() === normalizedSelected)
      : false;
    const options = [{ value: '', label: autoLabel, disabled: false, selected: false }];
    if (normalizedSelected && !hasSelectedModel) {
      // "(selected)" flags a chosen model missing from the live catalog. The
      // Home ask popover opts out (annotateMissingSelected: false): its closed
      // select IS the selection display, so the state suffix is just noise
      // there. Settings keeps the annotation byte-identical by default.
      options.push({
        value: normalizedSelected,
        label: config.annotateMissingSelected === false
          ? normalizedSelected
          : `${normalizedSelected} (selected)`,
        disabled: false,
        selected: true,
      });
    }
    for (const model of optionList) {
      const modelId = String(model?.id || '').trim();
      if (!modelId) {
        continue;
      }
      const available = model.available !== false;
      const reason = String(model?.reason || '').trim();
      const label = available
        ? modelId
        : `${modelId} (unavailable${reason ? `: ${reason}` : ''})`;
      options.push({
        value: modelId,
        label,
        disabled: !available,
        selected: modelId === normalizedSelected,
        engineType: String(model?.engine_type || model?.engineType || '').trim().toLowerCase(),
      });
    }
    return options;
  }

  // handleCreateSession normally reads the LIVE runtime pair. The Home ask
  // pill is the one caller that already knows the pair it wants (its own
  // mini-composer draft), so it passes session-shaped keys through
  // options.preferences. Absent keys fall through to `current`, which keeps
  // every existing caller byte-identical to reading the live pair.
  function mergeRequestedRuntimePreferences(current, requested, normalizeReasoningEffort) {
    const source = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : null;
    if (!source) return current;
    const has = (key) => Object.prototype.hasOwnProperty.call(source, key);
    const normalizeEffort = typeof normalizeReasoningEffort === 'function'
      ? normalizeReasoningEffort
      : (value) => value;
    return {
      ...current,
      preferredModel: has('preferred_model') ? normalizeModelToken(source.preferred_model) : current.preferredModel,
      reasoningEffort: has('reasoning_effort') ? normalizeEffort(source.reasoning_effort) : current.reasoningEffort,
    };
  }

  function buildModelOptionMarkup(models, selectedValue, config = {}) {
    const options = buildModelOptionsArray(models, selectedValue, config);
    return options
      .map((opt) => {
        const selected = opt.selected ? ' selected' : '';
        const disabled = opt.disabled ? ' disabled' : '';
        const engineType = opt.engineType ? ` data-engine-type="${escapeHtml(opt.engineType)}"` : '';
        return `<option value="${escapeHtml(opt.value)}"${engineType}${selected}${disabled}>${escapeHtml(opt.label)}</option>`;
      })
      .join('');
  }

  return {
    DEFAULT_CONTEXT_PREFERENCES,
    escapeHtml,
    getSessionMonogram,
    normalizeModelToken,
    normalizeContextHistoryScope,
    normalizeContextPreferences,
    buildModelOptionsArray,
    buildModelOptionMarkup,
    mergeRequestedRuntimePreferences,
  };
});
