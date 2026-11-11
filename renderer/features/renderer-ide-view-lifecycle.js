/* renderer/features/renderer-ide-view-lifecycle.js - the Workspace IDE view lifecycle behind
 * renderer-ide-controller.js: the activation / disposal flags and epoch, the listener binding
 * and teardown list, the first-activation hydrate, the root-commit reset, and the layout +
 * tab render. Split out of the controller for the file-size ceiling; the controller builds the
 * components and hands this module a lazy `parts` accessor over them. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeViewLifecycle = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}

  // deps: state, getDom, windowRef, registerCleanup, appendClientLog, getIde, ideStateUtils,
  // editorPrefsUtils, commandsUtils, parts (lazy getters over the controller's components).
  function createIdeViewLifecycle(deps) {
    const {
      state, getDom, windowRef, registerCleanup, appendClientLog, getIde, ideStateUtils,
      editorPrefsUtils, commandsUtils, parts: p,
    } = deps;
    let activated = false, firstActivation = null, bound = false, disposed = false, lifecycleEpoch = 0; registerCleanup(() => { disposed = true; lifecycleEpoch += 1; });
    const lifecycleCurrent = (epoch) => !disposed && epoch === lifecycleEpoch;

    function bindEvents() {
      if (bound || disposed) {
        return;
      }
      const dom = getDom();
      if (!dom.ideView) {
        return;
      }
      bound = true;
      p.tabsController?.bindEvents();
      p.welcome?.bindEvents();
      // Capture-phase so the save shortcut wins even when focus sits in the
      // tree or a panel; Monaco's own Ctrl+S command covers editor focus.
      const unbindViewKeys = commandsUtils.bindViewKeydown(dom.ideView, p.handleViewKeydown);
      p.explorer?.bindAll(); p.stageSwitch?.bindEvents(); p.editorGroups?.bindEvents();
      p.searchPanel?.bindEvents();
      p.diffController?.bindEvents(); p.terminals?.bindEvents();
      p.statusBar?.bindEvents(); p.gitFeature?.bindEvents();
      p.problemsPanel?.bindEvents();
      p.runScripts?.bindEvents(); p.testRunnerWiring?.bindEvents(); if(state.features?.featureFlags?.activity_monitor === true) p.activityView?.bind();
      p.ideChatDock?.bindEvents();
      p.symbolNav?.bindEvents(); p.qol?.bindAll();
      p.chipPicker?.initHandlers();
      // Flush the pending debounced persist before a hard window close (mirrors
      // the dashboard scratchpad beforeunload flush) so edits are not lost.
      const flushOnUnload = () => { p.persistence?.flushIfPending(); };
      windowRef.addEventListener?.('beforeunload', flushOnUnload);
      // Debounced re-render on resize: the workbench solver re-fits the stacks.
      let resizeTimer = null;
      const onWindowResize = () => {
        if (resizeTimer) { clearTimeout(resizeTimer); }
        // Hidden Workspace: skip; activateIde() always re-renders when it is shown again.
        resizeTimer = setTimeout(() => { resizeTimer = null; if (state.ui?.activeView === 'ide') renderIde(); }, 120);
      };
      windowRef.addEventListener?.('resize', onWindowResize);
      registerCleanup(function disposeIdeBindings() {
        disposed = true; lifecycleEpoch += 1;
        bound = false;
        p.welcome?.dispose();
        p.confirmDialog?.dispose();
        p.ideCommands?.disposeHelp();
        p.chipPicker?.dispose();
        unbindViewKeys();
        // Flush any pending persist before teardown (clears the timer internally).
        p.persistence?.flushIfPending();
        p.persistence?.dispose();
        windowRef.removeEventListener?.('beforeunload', flushOnUnload);
        windowRef.removeEventListener?.('resize', onWindowResize);
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        p.watchController?.stop(); p.fileLifecycle?.dispose();
        p.debugInspector?.dispose();
        p.quickOpen?.dispose(); p.branchSwitcher?.dispose();
        p.tabsController?.dispose(); p.statusBar?.dispose();
        p.gitFeature?.dispose(); p.problemsPanel?.dispose(); p.workspaceChats?.dispose();
        p.runScripts?.dispose(); p.testRunnerWiring?.dispose(); p.activityView?.dispose();
        p.workbenchWiring?.dispose(); p.stageSwitch?.dispose(); p.editorGroups?.dispose();
        p.ideChatDock?.dispose();
        p.terminals?.dispose(); p.testOutputPanel?.dispose();
        p.diffController?.dispose();
        p.searchPanel?.dispose();
        p.explorer?.disposeAll();
        p.themeBridge?.dispose();
        p.autoSave?.dispose();
        p.gutterDecorations?.dispose();
        p.navBookmarks?.dispose();
        p.symbolNav?.dispose(); p.qol?.disposeAll();
        p.editorHost?.dispose();
      });
    }

    // Layout lives in renderer-ide-layout.js; renderTabs stays in the controller.
    function renderIde() {
      p.editorGroups?.reconcile(); // editor stacks follow the tabs' groups before the workbench renders
      p.workspaceChats?.reconcileLayout(); // and Chat 2 / Changes 2 join it once a second chat exists
      p.layout?.render();
      p.renderTabs();
      p.stageSwitch?.render();
      // The stage-surface controller alone shows/hides the stage hosts.
      p.qol?.stageSurface?.sync();
    }

    async function activateIde() {
      if (disposed) return;
      const epoch = lifecycleEpoch;
      bindEvents();
      if (!activated) {
        activated = true;
        appendClientLog('INFO', 'ide.view_first_activation', {});
        // Quiet window for missing files: from hydrate until the first render settles.
        firstActivation = (p.tabRestore ? p.tabRestore.runRestore : (action) => action())(async () => {
          await p.hydratePersistedState();
          if (!lifecycleCurrent(epoch)) return;
          await p.welcome?.render();
          if (!lifecycleCurrent(epoch)) return;
          renderIde();
          p.watchController?.start();
          if (getIde().activeTabPath) await p.openRestoredTab(getIde().activeTabPath); p.qol?.noteHydrated?.(); // hot exit restores after the tabs
        });
        return firstActivation;
      }
      renderIde();
      // Re-apply editor prefs so a change made in the Settings "Editor" section
      // (which mutates the shared ide slice) takes effect on return to the IDE.
      editorPrefsUtils.applyEditorPrefs?.(getIde(), p.editorHost, p.chipPicker);
      // Re-arm after a failed start (e.g. the root was configured since).
      p.watchController?.start();
    }

    async function handleWorkspaceRootCommitted({ context } = {}) { if (disposed) return;
      const epoch = ++lifecycleEpoch;
      // Root-owned UI clears synchronously, before the hydrate await (and even if it throws).
      p.fileLifecycle?.resetForRoot(context); ideStateUtils.resetIdeRootState?.(getIde()); p.tree?.resetForRoot?.(); p.searchPanel?.resetForRoot?.(); p.diffController?.resetForRoot?.(); p.quickOpen?.invalidate(); p.ideMru?.clear?.(); p.navBookmarks?.resetForRoot?.(); p.tabsController?.resetForRoot?.(); p.editorGroups?.resetForRoot(); p.testRunnerWiring?.resetForRoot?.(); p.activityView?.clearOutput(); p.runScripts?.resetForRoot?.(); p.gitFeature?.resetForRoot?.(); // Git presentation must not survive a root switch.
      p.welcome?.clearRecent(); p.qol?.handleWorkspaceRootCommitted?.({ context });
      // Decoupled singletons (@-mention, active-file consent) hear root commits only via this event.
      try { windowRef.dispatchEvent?.(new windowRef.CustomEvent('ide:workspace-root-committed', { detail: { context } })); } catch (_error) { /* stub windows without CustomEvent */ }
      // keepLive: a tab opened in the new root while the hydrate awaited keeps its tab.
      await p.persistence?.hydrateForContext(context, { keepLive: true }); if (!lifecycleCurrent(epoch)) return; p.watchController?.start();
      await Promise.resolve(p.welcome?.render({ hasRoot: Boolean(context?.rootPath) })).catch(noop);
      if (!lifecycleCurrent(epoch)) return;
      renderIde(); if (getIde().activeTabPath) await p.openRestoredTab(getIde().activeTabPath); if (lifecycleCurrent(epoch)) p.qol?.noteHydrated?.();
    }

    // The persistence late-hydrate hook only renders while the view is live.
    const isLive = () => activated && !disposed;

    // The first hydrate restores the saved layout: open panels only after it.
    return { renderIde, activateIde, handleWorkspaceRootCommitted, isLive, whenActivated: async () => (activated ? firstActivation : activateIde()) };
  }

  return { createIdeViewLifecycle };
});
