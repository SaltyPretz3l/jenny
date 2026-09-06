(function exposePersonalityUiUtils(globalScope) {
  function normalizePersonalityMessage(value) {
    return String(value || '').trim();
  }

  function buildPersonalityStatusText(state, activeFileLabel) {
    const actionStatus = normalizePersonalityMessage(
      state && (state.actionStatus || state.statusMessage)
    );
    if (actionStatus) {
      return actionStatus;
    }

    const loadStatus = normalizePersonalityMessage(state && state.loadStatus);
    if (loadStatus) {
      return loadStatus;
    }

    if (!activeFileLabel) {
      return 'No personality file selected.';
    }

    if (state && state.loading) {
      return `Loading ${activeFileLabel}...`;
    }

    if (state && state.dirty) {
      return `${activeFileLabel} has unsaved changes.`;
    }

    return `${activeFileLabel} is ready to edit.`;
  }

  function resolvePreferredPersonalityTab(files, preferredActiveTab) {
    const list = Array.isArray(files) ? files : [];
    const target = String(preferredActiveTab || '').trim().toUpperCase();
    if (target && list.some((file) => String(file && file.name || '').toUpperCase() === target)) {
      return target;
    }
    return list[0] && list[0].name ? String(list[0].name).toUpperCase() : '';
  }

  const personalityUiUtils = {
    buildPersonalityStatusText,
    resolvePreferredPersonalityTab,
  };

  if (globalScope && typeof globalScope === 'object') {
    globalScope.personalityUiUtils = personalityUiUtils;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = personalityUiUtils;
  }
})(typeof window !== 'undefined' ? window : globalThis);
