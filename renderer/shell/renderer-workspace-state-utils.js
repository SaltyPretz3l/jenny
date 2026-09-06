(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceStateUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_OPEN_SESSIONS = 8;

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function normalizeIdList(values, validIds, cap) {
    const seen = new Set();
    const allowed = validIds instanceof Set ? validIds : null;
    const list = (Array.isArray(values) ? values : [])
      .map(normalizeId)
      .filter((value) => value && !seen.has(value) && (!allowed || allowed.has(value)) && seen.add(value));
    return Number.isFinite(cap) ? list.slice(0, cap) : list;
  }

  function createWorkspaceBridge(jennyShell) {
    const workspace = jennyShell && typeof jennyShell === 'object' ? jennyShell.workspace : null;
    return {
      async getState() {
        return typeof workspace?.getState === 'function'
          ? workspace.getState()
          : { activeSessionId: '', openSessionIds: [] };
      },
      async updateState(patch) {
        return typeof workspace?.updateState === 'function' ? workspace.updateState(patch) : patch;
      },
    };
  }

  function createWorkspaceStateController(deps) {
    const bridge = createWorkspaceBridge(deps?.jennyShell);
    const onStateChanged = typeof deps?.onStateChanged === 'function' ? deps.onStateChanged : () => {};
    const onPersistenceError = typeof deps?.onPersistenceError === 'function'
      ? deps.onPersistenceError
      : () => {};
    const isSessionBusy = typeof deps?.isSessionBusy === 'function' ? deps.isSessionBusy : () => false;
    const state = { activeSessionId: '', openSessionIds: [], mruStack: [] };
    let disposed = false;
    let lastValidSessionIds = [];
    let mutationChain = Promise.resolve();
    // Alt+Tab-style MRU cycling. While the user holds Ctrl and taps Tab we walk a
    // frozen snapshot of mruStack WITHOUT promoting anything; the single MRU
    // promotion is deferred to commitCycle() (fired on Ctrl release). This keeps
    // repeated presses walking the full stack instead of oscillating between the
    // two most-recent tabs. cycleSnapshot is null / cycleCursor is -1 when no
    // cycle is in flight.
    let cycleSnapshot = null;
    let cycleCursor = -1;

    function snapshot() {
      return { activeSessionId: state.activeSessionId, openSessionIds: state.openSessionIds.slice() };
    }

    function captureInternalState() {
      return {
        activeSessionId: state.activeSessionId,
        openSessionIds: state.openSessionIds.slice(),
        mruStack: state.mruStack.slice(),
        cycleSnapshot: cycleSnapshot ? cycleSnapshot.slice() : null,
        cycleCursor,
      };
    }

    function restoreInternalState(previous) {
      state.activeSessionId = previous.activeSessionId;
      state.openSessionIds = previous.openSessionIds.slice();
      state.mruStack = previous.mruStack.slice();
      cycleSnapshot = previous.cycleSnapshot ? previous.cycleSnapshot.slice() : null;
      cycleCursor = previous.cycleCursor;
    }

    async function persist() {
      if (!disposed) {
        await bridge.updateState(snapshot());
      }
      return snapshot();
    }

    function publish() {
      if (!disposed) {
        try {
          onStateChanged(snapshot());
        } catch (_error) {
          reportPersistenceError('workspace_state_publish_failed');
        }
      }
      return snapshot();
    }

    function reportPersistenceError(code) {
      try {
        onPersistenceError({ code });
      } catch (_error) {
        /* diagnostics must never corrupt the mutation queue */
      }
    }

    function queueMutation(task) {
      mutationChain = mutationChain.catch(() => {}).then(async () => {
        if (disposed) return snapshot();
        const previous = captureInternalState();
        try {
          return await task();
        } catch (error) {
          restoreInternalState(previous);
          publish();
          reportPersistenceError('workspace_state_persist_failed');
          throw error;
        }
      });
      return mutationChain;
    }

    function resetCycle() {
      cycleSnapshot = null;
      cycleCursor = -1;
    }

    function mruPush(id) {
      // Any real promotion (open / activate / commitCycle) ends an in-flight
      // cycle so the next Ctrl+Tab snapshots a fresh, up-to-date MRU order.
      resetCycle();
      state.mruStack = [id].concat(state.mruStack.filter((e) => e !== id));
    }

    function mruRemove(id) {
      state.mruStack = state.mruStack.filter((e) => e !== id);
    }

    async function commitState() {
      await persist();
      return publish();
    }

    function advanceCycle(direction) {
      if (state.mruStack.length < 2) return snapshot();
      if (!cycleSnapshot) {
        // First press of a new gesture: freeze the current MRU order and start
        // the cursor at the active tab's position within that frozen order.
        cycleSnapshot = state.mruStack.slice();
        cycleCursor = Math.max(cycleSnapshot.indexOf(state.activeSessionId), 0);
      }
      const len = cycleSnapshot.length;
      cycleCursor = (((cycleCursor + direction) % len) + len) % len;
      const targetId = cycleSnapshot[cycleCursor];
      return queueMutation(async () => {
        // Move focus only — the MRU promotion is deferred to commitCycle() so
        // the frozen order is not reshuffled mid-gesture.
        if (state.openSessionIds.includes(targetId)) {
          state.activeSessionId = targetId;
        }
        return commitState();
      });
    }

    // Open `id` as a NEW tab after the active one, evicting the least-recently-used
    // idle tab at the cap. Returns snapshot() (no-op) when the rail is full of busy
    // tabs — the coordinator's "Session Rail Full" guard depends on that. Assumes
    // `id` is normalized and not already open; must run inside queueMutation().
    function openAsNewTab(id) {
      if (state.openSessionIds.length >= MAX_OPEN_SESSIONS) {
        const evictId = state.mruStack.slice().reverse()
          .find((e) => e !== state.activeSessionId && !isSessionBusy(e));
        if (!evictId) return snapshot();
        state.openSessionIds = state.openSessionIds.filter((e) => e !== evictId);
        mruRemove(evictId);
      }
      const activeIdx = state.openSessionIds.indexOf(state.activeSessionId);
      const insertIdx = activeIdx >= 0 ? activeIdx + 1 : state.openSessionIds.length;
      state.openSessionIds.splice(insertIdx, 0, id);
      state.activeSessionId = id;
      mruPush(id);
      return commitState();
    }

    return {
      getState: snapshot,

      getRollbackSnapshot: captureInternalState,

      async openSession(sessionId) {
        const id = normalizeId(sessionId);
        if (!id) return snapshot();
        return queueMutation(async () => {
          if (state.openSessionIds.includes(id)) {
            state.activeSessionId = id;
            mruPush(id);
            return commitState();
          }
          return openAsNewTab(id);
        });
      },

      // Like openSession but REPLACES the active tab in place instead of adding a
      // new one (the sidebar/history default once the new-tab preference is off).
      async replaceActiveSession(sessionId) {
        const id = normalizeId(sessionId);
        if (!id) return snapshot();
        return queueMutation(async () => {
          // Already open elsewhere → just activate it (never duplicate a tab).
          if (state.openSessionIds.includes(id)) {
            state.activeSessionId = id;
            mruPush(id);
            return commitState();
          }
          const activeIdx = state.openSessionIds.indexOf(state.activeSessionId);
          // No active slot, or the active tab is busy (streaming / pending
          // approval) → never discard in-flight work; fall back to a new tab.
          if (activeIdx < 0 || isSessionBusy(state.activeSessionId)) {
            return openAsNewTab(id);
          }
          // Replace in place: swap the active slot, drop the old session from MRU.
          const replacedId = state.activeSessionId;
          state.openSessionIds.splice(activeIdx, 1, id);
          mruRemove(replacedId);
          state.activeSessionId = id;
          mruPush(id);
          return commitState();
        });
      },

      async restoreSnapshot(value) {
        const source = value && typeof value === 'object' ? value : {};
        return queueMutation(async () => {
          const validSet = lastValidSessionIds.length ? new Set(lastValidSessionIds) : null;
          state.openSessionIds = normalizeIdList(source.openSessionIds, validSet, MAX_OPEN_SESSIONS);
          const requestedActiveId = normalizeId(source.activeSessionId);
          state.activeSessionId = state.openSessionIds.includes(requestedActiveId)
            ? requestedActiveId
            : (state.openSessionIds[0] || '');
          const openSet = new Set(state.openSessionIds);
          const restoredMru = Array.isArray(source.mruStack)
            ? normalizeIdList(source.mruStack, openSet, MAX_OPEN_SESSIONS)
            : [];
          state.mruStack = restoredMru.length
            ? [...restoredMru, ...state.openSessionIds.filter((id) => !restoredMru.includes(id))]
            : state.activeSessionId
              ? [state.activeSessionId, ...state.openSessionIds.filter((id) => id !== state.activeSessionId)]
              : state.openSessionIds.slice();
          const restoredCycle = Array.isArray(source.cycleSnapshot)
            ? normalizeIdList(source.cycleSnapshot, openSet, MAX_OPEN_SESSIONS)
            : [];
          const restoredCursor = source.cycleCursor;
          if (restoredCycle.length && Number.isInteger(restoredCursor)
            && restoredCursor >= 0 && restoredCursor < restoredCycle.length) {
            cycleSnapshot = restoredCycle;
            cycleCursor = restoredCursor;
          } else {
            resetCycle();
          }
          return commitState();
        });
      },

      async closeSession(sessionId) {
        const id = normalizeId(sessionId);
        if (!id) return false;
        return queueMutation(async () => {
          if (isSessionBusy(id)) return false;
          resetCycle(); // closing a tab (e.g. Ctrl+W mid-gesture) abandons any cycle
          state.openSessionIds = state.openSessionIds.filter((e) => e !== id);
          mruRemove(id);
          if (state.activeSessionId === id) {
            state.activeSessionId = state.mruStack.find((e) => state.openSessionIds.includes(e)) || '';
          }
          await commitState();
          return true;
        });
      },

      async cycleNext() {
        return advanceCycle(1);
      },

      async cyclePrev() {
        return advanceCycle(-1);
      },

      async commitCycle() {
        // Ctrl released: promote the tab the user landed on to the MRU front,
        // exactly once. Returns null when no gesture was in flight so the
        // global keyup handler can skip re-applying state on every Ctrl-up.
        // mruStack is in-memory only (rebuilt from active+open on restore), so
        // the persisted/observable {active, open} shape is unchanged here — no
        // redundant persist/publish is needed.
        if (!cycleSnapshot) return null;
        resetCycle();
        return queueMutation(async () => {
          const finalId = state.activeSessionId;
          if (finalId && state.openSessionIds.includes(finalId)) {
            mruPush(finalId);
          }
          return snapshot();
        });
      },

      async reorderSession(sessionId, newIndex) {
        const id = normalizeId(sessionId);
        if (!id) return snapshot();
        return queueMutation(async () => {
          const curIdx = state.openSessionIds.indexOf(id);
          if (curIdx < 0) return snapshot();
          const clamped = Math.max(0, Math.min(newIndex, state.openSessionIds.length - 1));
          if (clamped === curIdx) return snapshot();
          state.openSessionIds.splice(curIdx, 1);
          state.openSessionIds.splice(clamped, 0, id);
          return commitState();
        });
      },

      async closeOtherSessions(keepId) {
        const id = normalizeId(keepId);
        return queueMutation(async () => {
          let closed = 0;
          let skipped = 0;
          const keep = new Set([id]);
          for (const sid of state.openSessionIds) {
            if (sid === id) continue;
            if (isSessionBusy(sid)) { skipped++; keep.add(sid); }
            else { closed++; }
          }
          state.openSessionIds = state.openSessionIds.filter((e) => keep.has(e));
          state.mruStack = state.mruStack.filter((e) => keep.has(e));
          if (!state.openSessionIds.includes(state.activeSessionId)) {
            state.activeSessionId = id && state.openSessionIds.includes(id) ? id : (state.mruStack[0] || '');
          }
          await commitState();
          return { closed, skipped };
        });
      },

      async closeSessionsToRight(anchorId) {
        const id = normalizeId(anchorId);
        return queueMutation(async () => {
          const anchorIdx = state.openSessionIds.indexOf(id);
          if (anchorIdx < 0 || anchorIdx === state.openSessionIds.length - 1) return { closed: 0, skipped: 0 };
          let closed = 0;
          let skipped = 0;
          const toClose = new Set();
          for (let i = anchorIdx + 1; i < state.openSessionIds.length; i++) {
            const sid = state.openSessionIds[i];
            if (isSessionBusy(sid)) { skipped++; } else { closed++; toClose.add(sid); }
          }
          state.openSessionIds = state.openSessionIds.filter((e) => !toClose.has(e));
          state.mruStack = state.mruStack.filter((e) => !toClose.has(e));
          if (toClose.has(state.activeSessionId)) {
            state.activeSessionId = state.mruStack[0] || state.openSessionIds[0] || '';
          }
          await commitState();
          return { closed, skipped };
        });
      },

      async closeAllSessions() {
        return queueMutation(async () => {
          let closed = 0;
          let skipped = 0;
          const keep = new Set();
          for (const sid of state.openSessionIds) {
            if (isSessionBusy(sid)) { skipped++; keep.add(sid); } else { closed++; }
          }
          state.openSessionIds = state.openSessionIds.filter((e) => keep.has(e));
          state.mruStack = state.mruStack.filter((e) => keep.has(e));
          if (!keep.has(state.activeSessionId)) {
            state.activeSessionId = state.mruStack[0] || '';
          }
          await commitState();
          return { closed, skipped };
        });
      },

      async restore(validSessionIds) {
        const capturedValidSessionIds = normalizeIdList(validSessionIds);
        return queueMutation(async () => {
          lastValidSessionIds = capturedValidSessionIds;
          resetCycle(); // a full restore rebuilds mruStack; drop any stale snapshot
          const saved = await bridge.getState().catch(() => ({}));
          const validSet = new Set(capturedValidSessionIds);
          const savedOpen = normalizeIdList(saved?.openSessionIds, validSet, MAX_OPEN_SESSIONS);
          const savedActive = normalizeId(saved?.activeSessionId);
          state.openSessionIds = savedOpen.length
            ? savedOpen
            : (capturedValidSessionIds[0] ? [capturedValidSessionIds[0]] : []);
          state.activeSessionId =
            savedActive && validSet.has(savedActive) && state.openSessionIds.includes(savedActive)
              ? savedActive
              : (state.openSessionIds[0] || '');
          state.mruStack = state.activeSessionId
            ? [state.activeSessionId, ...state.openSessionIds.filter((e) => e !== state.activeSessionId)]
            : state.openSessionIds.slice();
          return commitState();
        });
      },

      dispose() {
        disposed = true;
      },
    };
  }

  return { createWorkspaceStateController };
});
