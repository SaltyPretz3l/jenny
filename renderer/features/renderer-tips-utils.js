(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererTipsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function createTipsManager(deps) {
    const { state } = deps;
    const {
      renderPrompts,
    } = deps.callbacks;

    function normalizeTip(tip) {
      if (!tip || typeof tip !== 'object' || Array.isArray(tip)) {
        return null;
      }
      return {
        id: String(tip.id || '').trim(),
        title: String(tip.title || '').trim(),
        body: String(tip.body || '').trim(),
        actionLabel: String(tip.actionLabel || '').trim(),
        settingsSection: String(tip.settingsSection || 'home').trim() || 'home',
      };
    }

    function normalizeTipsState(payload) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
        ? source.settings
        : {};
      return {
        loaded: true,
        featureEnabled: source.featureEnabled === true,
        settings: {
          enabled: settings.enabled !== false,
          sessionCount: Number(settings.sessionCount || 0) || 0,
          historyByTipId: settings.historyByTipId && typeof settings.historyByTipId === 'object' && !Array.isArray(settings.historyByTipId)
            ? { ...settings.historyByTipId }
            : {},
        },
        relevantTips: Array.isArray(source.relevantTips)
          ? source.relevantTips.map((tip) => normalizeTip(tip)).filter(Boolean)
          : [],
        activeTip: normalizeTip(source.activeTip),
      };
    }

    function applyTipsPayload(payload) {
      state.tips = normalizeTipsState(payload);
      return state.tips;
    }

    async function refreshTipsState() {
      const payload = await windowRef.jennyShell.tips.getState();
      applyTipsPayload(payload);
      return state.tips;
    }

    function bindShellEvents() {
      if (!windowRef.jennyShell?.tips?.onChanged) {
        return () => {};
      }
      return windowRef.jennyShell.tips.onChanged((payload) => {
        applyTipsPayload(payload);
        renderPrompts();
      });
    }

    return {
      applyTipsPayload,
      refreshTipsState,
      bindShellEvents,
    };
  }

  return { createTipsManager };
});
