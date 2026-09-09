(function exposePersonalityUiUtils(globalScope) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
      return jt('personality.status.noFileSelected', 'No personality file selected.');
    }

    if (state && state.loading) {
      return jt('personality.status.loadingFile', 'Loading {file}...', { file: activeFileLabel });
    }

    if (state && state.dirty) {
      return jt('personality.status.unsavedChanges', '{file} has unsaved changes.', { file: activeFileLabel });
    }

    return jt('personality.status.readyToEdit', '{file} is ready to edit.', { file: activeFileLabel });
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
