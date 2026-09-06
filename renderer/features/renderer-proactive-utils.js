(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererProactiveUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function createProactiveManager(deps) {
    const { state } = deps;
    const { chatInput } = deps.dom;
    const {
      renderComposerState,
      syncComposerInputHeight,
      getCurrentMessageById,
      setActiveView,
    } = deps.callbacks;

    function normalizeProactiveState(payload) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const proactive = source.proactive && typeof source.proactive === 'object' && !Array.isArray(source.proactive)
        ? source.proactive
        : {};
      return {
        loaded: true,
        workspaceRoot: String(source.toolsWorkspaceRoot || '').trim(),
        workspaceRootStatus:
          source.workspaceRootStatus && typeof source.workspaceRootStatus === 'object' && !Array.isArray(source.workspaceRootStatus)
            ? {
                state: String(source.workspaceRootStatus.state || 'missing').trim() || 'missing',
                message: String(source.workspaceRootStatus.message || '').trim(),
              }
            : {
                state: 'missing',
                message: 'Workspace-dependent proactive behaviors are blocked until a workspace root is configured.',
              },
        reminders: Array.isArray(proactive.reminders)
          ? proactive.reminders.map((reminder) => ({
              id: String(reminder?.id || '').trim(),
              label: String(reminder?.label || '').trim(),
              prompt: String(reminder?.prompt || '').trim(),
              enabled: reminder?.enabled !== false,
              createdAt: String(reminder?.createdAt || '').trim(),
            }))
          : [],
      };
    }

    function applyProactivePayload(payload) {
      state.proactive = normalizeProactiveState(payload);
      return state.proactive;
    }

    async function refreshProactiveState() {
      const payload = await windowRef.jennyShell.proactive.getState();
      applyProactivePayload(payload);
      return state.proactive;
    }

    async function handleUseProactiveSuggestionMessage(messageId) {
      const message = getCurrentMessageById(messageId);
      const promptSuggestion = String(message?.proactive_suggestion?.promptSuggestion || '').trim();
      if (!promptSuggestion) {
        return;
      }
      setActiveView('chat');
      chatInput.value = promptSuggestion;
      syncComposerInputHeight();
      renderComposerState();
      chatInput.focus();
    }

    return {
      normalizeProactiveState,
      applyProactivePayload,
      refreshProactiveState,
      handleUseProactiveSuggestionMessage,
    };
  }

  return { createProactiveManager };
});
