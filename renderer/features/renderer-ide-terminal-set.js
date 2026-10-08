/* renderer/features/renderer-ide-terminal-set.js - manages up to four Workspace
 * terminals: one PTY panel per terminal view (`terminal`, `terminal-2..4`), each
 * bound to its own main-process session slot. The controller owns the layout; the
 * set only asks it (addTerminalView / removeTerminalView / revealView) and then
 * mirrors listTerminalViews() through sync(), so the layout stays the single
 * source of truth for which terminals exist.
 *
 * Besides the user-facing "+" and close actions it offers openTaskTerminal(): a
 * fresh terminal for a tool (the debug inspector) that must never type into the
 * user's own shell. It resolves a small handle whose onData is filtered to that
 * terminal's session id. Every kill goes through the owning panel by session id;
 * the set never issues an id-less kill. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalSet = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_TERMINALS = 4;
  const FIRST_VIEW_ID = 'terminal';

  function noop() {}

  function createIdeTerminalSet(deps) {
    const o = deps || {};
    const panelUtils = o.ptyTerminalPanelUtils || null;
    const baseDeps = o.baseDeps || {};
    const model = o.model || {};
    const viewDeps = typeof o.viewDeps === 'function' ? o.viewDeps : () => ({});
    const listTerminalViews = typeof o.listTerminalViews === 'function' ? o.listTerminalViews : () => [];
    const addTerminalView = typeof o.addTerminalView === 'function' ? o.addTerminalView : noop;
    const removeTerminalView = typeof o.removeTerminalView === 'function' ? o.removeTerminalView : noop;
    const revealView = typeof o.revealView === 'function' ? o.revealView : noop;
    const maxTerminals = Math.min(DEFAULT_MAX_TERMINALS, Math.max(1, Math.floor(Number(o.maxTerminals)) || DEFAULT_MAX_TERMINALS));
    const getApi = typeof baseDeps.getWorkspacePtyApi === 'function' ? baseDeps.getWorkspacePtyApi : () => null;
    const logError = typeof baseDeps.appendClientLog === 'function' ? baseDeps.appendClientLog : noop;

    const panels = new Map(); // viewId -> panel
    const focusBinds = new Map(); // viewId -> { el, handler }
    let lastUsedViewId = '';
    let disposed = false;
    const taskViews = new Set(); // terminals opened by openTaskTerminal, reused once idle

    function slotOf(viewId) {
      return typeof model.terminalSlot === 'function' ? model.terminalSlot(viewId) : 0;
    }

    function viewIdOf(slot) {
      return typeof model.terminalViewId === 'function' ? model.terminalViewId(slot) : null;
    }

    function listed() {
      const raw = listTerminalViews();
      return Array.isArray(raw) ? raw.filter((id) => slotOf(id) > 0) : [];
    }

    function panelFor(viewId) {
      return panels.get(viewId) || null;
    }

    function touch(viewId) {
      if (panels.has(viewId)) {
        lastUsedViewId = viewId;
      }
    }

    function unbindFocus(viewId) {
      const bound = focusBinds.get(viewId);
      if (bound) {
        try { bound.el.removeEventListener('focusin', bound.handler); } catch (error) { logError('DEBUG', 'ide.terminal_set_unbind', { message: String(error?.message || error) }); }
        focusBinds.delete(viewId);
      }
    }

    function disposePanel(viewId) {
      const panel = panels.get(viewId);
      if (!panel) {
        return;
      }
      panels.delete(viewId);
      taskViews.delete(viewId);
      unbindFocus(viewId);
      if (lastUsedViewId === viewId) {
        lastUsedViewId = '';
      }
      // The panel kills its own session by id and cancels an in-flight spawn.
      try { panel.dispose?.(); } catch (error) { logError('DEBUG', 'ide.terminal_set_dispose', { message: String(error?.message || error) }); }
    }

    function createPanel(viewId) {
      if (typeof panelUtils?.createIdePtyTerminalPanel !== 'function') {
        return null;
      }
      return panelUtils.createIdePtyTerminalPanel({
        ...baseDeps,
        ...viewDeps(viewId),
        slot: slotOf(viewId),
        onSessionChange: (sessionId) => {
          if (sessionId && panels.get(viewId)) {
            lastUsedViewId = viewId;
          }
          if (typeof o.onSessionChange === 'function') {
            o.onSessionChange(viewId, sessionId);
          }
        },
      }) || null;
    }

    // Creates a panel for each listed terminal view that lacks one and disposes
    // the panel of any view that left the layout. Idempotent.
    function sync() {
      if (disposed) {
        return;
      }
      const ids = listed();
      const wanted = new Set(ids);
      for (const viewId of Array.from(panels.keys())) {
        if (!wanted.has(viewId)) {
          disposePanel(viewId);
        }
      }
      for (const viewId of ids) {
        if (!panels.has(viewId)) {
          const panel = createPanel(viewId);
          if (panel) {
            panels.set(viewId, panel);
          }
        }
      }
    }

    function renderAll() {
      sync();
      for (const panel of panels.values()) {
        panel.renderTerminalPanel?.();
      }
    }

    function mountOf(viewId) {
      try { return viewDeps(viewId)?.getMountEl?.() || null; } catch (_error) { return null; }
    }

    // Binds each panel's click handling, plus a focusin listener on its mount so
    // "the terminal the user last worked in" is known without the controller.
    function bindEvents() {
      sync();
      for (const [viewId, panel] of panels) {
        panel.bindEvents?.();
        const el = mountOf(viewId);
        const bound = focusBinds.get(viewId);
        if (bound && bound.el !== el) {
          unbindFocus(viewId);
        }
        if (el && !focusBinds.has(viewId) && typeof el.addEventListener === 'function') {
          const handler = () => touch(viewId);
          el.addEventListener('focusin', handler);
          focusBinds.set(viewId, { el, handler });
        }
      }
    }

    function resolveTarget(viewId) {
      if (viewId) {
        return panels.has(viewId) ? viewId : '';
      }
      if (lastUsedViewId && panels.has(lastUsedViewId)) {
        return lastUsedViewId;
      }
      if (panels.has(FIRST_VIEW_ID)) {
        return FIRST_VIEW_ID;
      }
      const first = panels.keys().next();
      return first.done ? '' : first.value;
    }

    function focusTerminal(viewId) {
      const target = resolveTarget(viewId);
      if (!target) {
        return false;
      }
      touch(target);
      return panels.get(target).focusTerminal?.() === true;
    }

    // Back-compat with the single-terminal sendCommand(builder): no viewId
    // targets slot 1 (the user's main terminal), never the last-used one.
    async function sendCommand(builder, viewId) {
      const target = viewId || viewIdOf(1) || FIRST_VIEW_ID;
      if (!panels.has(target)) {
        sync();
      }
      const panel = panels.get(target);
      if (!panel) {
        return false;
      }
      touch(target);
      return panel.sendCommand(builder);
    }

    function count() {
      return listed().length;
    }

    function canAdd() {
      return !disposed && count() < maxTerminals && freeSlot() > 0;
    }

    function freeSlot() {
      const used = new Set(listed().map(slotOf));
      for (let slot = 2; slot <= maxTerminals; slot += 1) {
        if (!used.has(slot) && viewIdOf(slot)) {
          return slot;
        }
      }
      return 0;
    }

    // Adds the lowest free slot 2..max to the layout and reveals it. The new
    // terminal is not started unless opts.start is true (the panel's Start button
    // otherwise); opts.near places it beside that terminal. Returns the new viewId,
    // or null at the cap.
    function newTerminal(opts) {
      if (disposed || count() >= maxTerminals) {
        return null;
      }
      const slot = freeSlot();
      const viewId = slot ? viewIdOf(slot) : null;
      if (!viewId) {
        return null;
      }
      addTerminalView(viewId, opts && opts.near);
      sync();
      touch(viewId);
      revealView(viewId, { focus: true });
      if (opts && opts.start === true) {
        panels.get(viewId)?.startSession?.().catch?.(noop);
      }
      return viewId;
    }

    // Kills the terminal's own session by id. Slot 1 stays in the layout (back to
    // its not-started state); slots 2..4 leave the layout and their panel goes.
    function closeTerminal(viewId) {
      const panel = panels.get(viewId);
      if (!panel) {
        return false;
      }
      if (slotOf(viewId) <= 1) {
        panel.stopSession?.();
        return true;
      }
      disposePanel(viewId);
      removeTerminalView(viewId);
      sync();
      return true;
    }

    function dataSubscription(sessionId) {
      return (cb) => {
        const api = getApi();
        if (typeof cb !== 'function' || typeof api?.onData !== 'function') {
          return noop;
        }
        const unsub = api.onData((payload) => {
          if (payload && String(payload.sessionId || '') === sessionId) {
            cb(payload);
          }
        });
        return typeof unsub === 'function' ? unsub : noop;
      };
    }

    function isIdle(panel) {
      return Boolean(panel) && !panel.isRunning() && !panel.getSessionId();
    }

    // Opens a terminal for a task and resolves a handle once its session is
    // live: { viewId, sendCommand(builder), getSessionId(), onData(cb) }. An
    // earlier task terminal that has gone idle is reused first, then a NEW
    // terminal; with no free slot, slot 1 is reused only when it is idle.
    // Resolves null when no terminal is free, and false when the session could
    // not start (the panel has already said why). `bound` (W7c: the terminal bound
    // to the focused editor group) is used when idle, else a new one opens beside it.
    async function openTaskTerminal(bound) {
      if (disposed) {
        return null;
      }
      const near = bound && panels.has(bound) ? bound : '';
      let viewId = near && isIdle(panels.get(near)) ? near
        : (near ? '' : Array.from(taskViews).find((id) => isIdle(panels.get(id))) || '');
      if (viewId) {
        touch(viewId);
        revealView(viewId, { focus: true });
      } else {
        viewId = newTerminal(near ? { near } : undefined);
      }
      if (!viewId) {
        const first = viewIdOf(1);
        const firstPanel = first ? panels.get(first) : null;
        if (!isIdle(firstPanel)) {
          return null;
        }
        viewId = first;
        touch(viewId);
        revealView(viewId, { focus: true });
      }
      const panel = panels.get(viewId);
      if (!panel) {
        return null;
      }
      if (slotOf(viewId) > 1) {
        taskViews.add(viewId);
      }
      const started = await panel.startSession();
      const sessionId = String(panel.getSessionId() || '');
      if (disposed || started !== true || !sessionId || panels.get(viewId) !== panel) {
        return false;
      }
      return {
        viewId,
        sendCommand: (builder) => panel.sendCommand(builder),
        getSessionId: () => String(panel.getSessionId() || ''),
        onData: dataSubscription(sessionId),
      };
    }

    function dispose() {
      if (disposed) {
        return;
      }
      for (const viewId of Array.from(panels.keys())) {
        disposePanel(viewId);
      }
      disposed = true;
    }

    return {
      bindEvents,
      canAdd,
      closeTerminal,
      count,
      dispose,
      focusTerminal,
      newTerminal,
      openTaskTerminal,
      panelFor,
      renderAll,
      sendCommand,
      sync,
    };
  }

  return { createIdeTerminalSet };
});
