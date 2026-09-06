(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererFallbackWorkspaceRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createWorkspaceStateFallback() {
    return {
      createWorkspaceStateController(deps) {
        const onStateChanged = typeof deps?.onStateChanged === 'function' ? deps.onStateChanged : () => {};
        const state = { activeSessionId: '', openSessionIds: [] };
        const emit = () => onStateChanged({ ...state, openSessionIds: state.openSessionIds.slice() });
        return {
          getState: () => ({ ...state, openSessionIds: state.openSessionIds.slice() }),
          openSession(sessionId) {
            const id = String(sessionId || '').trim();
            if (!id) return this.getState();
            if (!state.openSessionIds.includes(id)) {
              const activeIdx = state.openSessionIds.indexOf(state.activeSessionId);
              const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.openSessionIds.length;
              state.openSessionIds.splice(insertIdx, 0, id);
              while (state.openSessionIds.length > 8) {
                const evictIdx = state.openSessionIds.findIndex((entry) => entry !== id);
                if (evictIdx < 0) { break; }
                state.openSessionIds.splice(evictIdx, 1);
              }
            }
            state.activeSessionId = id;
            emit();
            return this.getState();
          },
          closeSession(sessionId) {
            const id = String(sessionId || '').trim();
            if (!id) return false;
            state.openSessionIds = state.openSessionIds.filter((entry) => entry !== id);
            if (state.activeSessionId === id) {
              state.activeSessionId = state.openSessionIds[0] || '';
            }
            emit();
            return true;
          },
          cycleNext() { return this.getState(); },
          cyclePrev() { return this.getState(); },
          commitCycle() { return null; },
          async reorderSession() { return this.getState(); },
          async closeOtherSessions() { return { closed: 0, skipped: 0 }; },
          async closeSessionsToRight() { return { closed: 0, skipped: 0 }; },
          async closeAllSessions() { return { closed: 0, skipped: 0 }; },
          async restore() { emit(); return this.getState(); },
          dispose() {},
        };
      },
    };
  }

  function createWorkspaceChromeFallback() {
    return {
      createWorkspaceChromeController() {
        return {
          renderRail() {},
          renderSidebarBadges() {},
          showLinkedSessionPopover() {},
          hideLinkedSessionPopover() {},
          dispose() {},
        };
      },
    };
  }

  function createSessionCacheFallback() {
    return {
      createSessionCacheController() {
        return {
          collectSessionStreamIds() { return new Set(); },
          getPinnedSessionIds() { return new Set(); },
          async evictColdSessionCaches() {},
          async clearSessionStreamState() {},
        };
      },
    };
  }

  function createSessionLifecycleFallback() {
    return {
      createSessionLifecycleController() {
        return {
          async reconcileSessionCaches() {},
          async refreshSessionSummaries() { return { currentSessionId: '', validSessionIds: new Set() }; },
          async loadSessions() {},
          async openSession() {},
        };
      },
    };
  }

  function buildFallbacks(win) {
    return {
      workspaceStateUtils: win.rendererWorkspaceStateUtils || createWorkspaceStateFallback(),
      workspaceChromeUtils: win.rendererWorkspaceChromeUtils || createWorkspaceChromeFallback(),
      sessionCacheUtils: win.rendererSessionCacheUtils || createSessionCacheFallback(),
      sessionLifecycleUtils: win.rendererSessionLifecycleUtils || createSessionLifecycleFallback(),
    };
  }

  return { buildFallbacks };
});
