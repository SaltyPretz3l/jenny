/* renderer/shell/renderer-settings-refresh-utils.js - Isolated Settings refresh batches. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsRefreshUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function ensureRefreshState(state) {
    if (!state.settingsRefresh || typeof state.settingsRefresh !== 'object') {
      state.settingsRefresh = {};
    }
    if (!state.settingsRefresh.degradedBySection || typeof state.settingsRefresh.degradedBySection !== 'object') {
      state.settingsRefresh.degradedBySection = {};
    }
    return state.settingsRefresh;
  }

  function toErrorMessage(error) {
    return error && typeof error === 'object' && error.message
      ? String(error.message)
      : String(error || 'Refresh failed.');
  }

  async function runSettingsRefreshBatch(options) {
    const sectionId = String(options?.sectionId || '').trim() || 'models';
    const tasks = Array.isArray(options?.tasks) ? options.tasks : [];
    const state = options?.state && typeof options.state === 'object' ? options.state : {};
    const appendClientLog = typeof options?.appendClientLog === 'function'
      ? options.appendClientLog
      : function noopAppendClientLog() {};

    if (!tasks.length) {
      const refreshState = ensureRefreshState(state);
      delete refreshState.degradedBySection[sectionId];
      return [];
    }

    const settled = await Promise.allSettled(tasks.map((task) => {
      if (!task || typeof task.run !== 'function') {
        return Promise.resolve(undefined);
      }
      try {
        return Promise.resolve(task.run());
      } catch (error) {
        return Promise.reject(error);
      }
    }));
    const failures = [];
    for (let index = 0; index < settled.length; index += 1) {
      const task = tasks[index] || {};
      const result = settled[index];
      if (result.status !== 'rejected') {
        continue;
      }
      const source = String(task.name || `source_${index + 1}`);
      const message = toErrorMessage(result.reason);
      failures.push({ source, message });
      appendClientLog('WARN', 'settings.section_refresh_source_failed', {
        section: sectionId,
        source,
        message,
      });
    }
    const refreshState = ensureRefreshState(state);
    if (failures.length) {
      refreshState.degradedBySection[sectionId] = failures;
    } else {
      delete refreshState.degradedBySection[sectionId];
    }
    return settled;
  }

  return {
    ensureRefreshState,
    runSettingsRefreshBatch,
  };
});
