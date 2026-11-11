/* renderer/chat/renderer-render-pipeline-pane-runtime.js
 * What the render pipeline reads per pane: the pane id, the session, transcript
 * view and selection ownership this pane shows, its message getters, and its
 * subagent monitor. Split out of renderer-render-pipeline-utils.js, which
 * composes it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererRenderPipelinePaneRuntime = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createPaneAccessors(deps) {
    const {
      state,
      uiRuntime,
      paneVisibilityUtils,
      getVisibleSessionMessages: _getVisibleSessionMessages,
      getSessionMessages: _getSessionMessages,
      getCurrentVisibleMessages,
      getCurrentSessionMessages,
    } = deps;
    // Split view W1-4a: the session THIS pane shows (renderer-pane-visibility-utils.js
    // resolvePaneSessionId). A bag without an integer paneId is pane 0, as in
    // createPaneRuntime; a blank layout makes pane 0 exactly currentSessionId.
    const paneId = Number.isInteger(uiRuntime?.paneId) && uiRuntime.paneId >= 0 ? uiRuntime.paneId : 0;
    const getPaneSessionId = typeof paneVisibilityUtils?.resolvePaneSessionId === 'function'
      ? () => paneVisibilityUtils.resolvePaneSessionId(state, paneId)
      : () => String(state.currentSessionId || '').trim();
    // Transcript view (answers | thinking | everything) of the session THIS pane
    // shows (renderer-transcript-view-utils.js). Threaded through render
    // options because the row builders are shared single instances and two
    // panes can show two views; absent-safe so a missing module renders
    // 'thinking', today's behaviour.
    const getPaneTranscriptView = () => {
      const utils = globalThis.rendererTranscriptViewUtils;
      return typeof utils?.resolveTranscriptView === 'function'
        ? utils.resolveTranscriptView(state, getPaneSessionId())
        : 'thinking';
    };
    // Split view W3-1: this pane renders selection chrome only while it owns the mode.
    // (renderer-chat-selection-utils.js: state.ui.selectionModePaneId, null = off).
    const isPaneSelecting = () => state.ui?.selectionModePaneId === paneId;
    // Per-session message getters, read with getPaneSessionId(); a composition
    // that injects only the current-session getters keeps working unchanged.
    const getVisibleSessionMessages = typeof _getVisibleSessionMessages === 'function'
      ? _getVisibleSessionMessages : () => (typeof getCurrentVisibleMessages === 'function' ? getCurrentVisibleMessages() : []);
    const getSessionMessages = typeof _getSessionMessages === 'function'
      ? _getSessionMessages : () => (typeof getCurrentSessionMessages === 'function' ? getCurrentSessionMessages() : []);
    return {
      paneId,
      getPaneSessionId,
      getPaneTranscriptView,
      isPaneSelecting,
      getVisibleSessionMessages,
      getSessionMessages,
    };
  }

  function createPaneSubagentMonitor(deps) {
    const {
      state,
      chatTimeline,
      chatThreadStage,
      paneId,
      getPaneSessionId,
      getSessionMessages,
      appendClientLog,
    } = deps;
    const monitorDocument = chatTimeline?.ownerDocument || null;
    const monitorWindow = monitorDocument?.defaultView || null;
    // Split view W3-2: one monitor per pane, each showing its pane's session.
    // In Chat the monitor is the artifact panel's `subagents` rail mode; the
    // pane thread stage's own aside (pane 0's #subagentInspector, the
    // template's for pane 1) hosts it only in the IDE dock. A trigger belongs
    // to the pane whose root holds it (pane 0's when docked in the IDE), so the
    // two monitors' document-level listeners never both handle one click.
    const subagentInspector = chatThreadStage?.querySelector?.(':scope > [data-chat-node="subagentInspector"]') || null;
    const subagentMonitorController = paneId !== 0 && !subagentInspector ? null : globalThis.rendererSubagentMonitorController?.createSubagentMonitorController?.({
      state,
      documentRef: monitorDocument,
      windowRef: monitorWindow,
      inspector: subagentInspector,
      idSuffix: paneId === 0 ? '' : `-pane${paneId}`,
      getSessionId: getPaneSessionId,
      ownsTrigger: (trigger) => {
        const paneRoot = trigger?.closest?.('.chat-pane[data-pane-id]');
        return (paneRoot ? Number(paneRoot.dataset.paneId) : 0) === paneId;
      },
      getMessages: () => getSessionMessages(getPaneSessionId()),
      appendClientLog,
    }) || null;
    subagentMonitorController?.bind?.();
    return subagentMonitorController;
  }

  return { createPaneAccessors, createPaneSubagentMonitor };
});
