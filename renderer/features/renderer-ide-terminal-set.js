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
 * the set never issues an id-less kill.
 *
 * Row 82 T2: the set also owns each terminal header's actions (+, the shell-profile
 * chevron of the New Terminal split-button, Kill), the profile menus
 * (renderer-ide-terminal-profile-menu.js) and per-view label overrides (Terminal:
 * Rename). Labels are session-only: the layout tree persists no per-view data, and
 * the workbench reads them through its labelOverride hook. */
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
  const LABEL_MAX = 64;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

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

    const getIde = typeof baseDeps.getIde === 'function' ? baseDeps.getIde : () => ({});
    const getWorkbenchRoot = () => (typeof baseDeps.getDom === 'function' ? baseDeps.getDom()?.ideWorkbench || null : null);
    const requestRender = typeof o.requestRender === 'function' ? o.requestRender : noop;

    const panels = new Map(); // viewId -> panel
    const focusBinds = new Map(); // viewId -> { el, handler }
    const labels = new Map(); // viewId -> the user's name for it (Terminal: Rename), session-only
    let lastUsedViewId = '';
    let lastNear = FIRST_VIEW_ID; // the terminal whose + was pressed last: new ones open beside it
    let disposed = false;
    let renameRoot = null; // the workbench root carrying the tab click/focus/double-click listeners
    let renaming = null; // { viewId, tab, input } while a tab's inline name field is open
    const taskViews = new Set(); // terminals opened by openTaskTerminal, reused once idle
    const profileMenu = resolveModule('rendererIdeTerminalProfileMenu', './renderer-ide-terminal-profile-menu').createIdeTerminalProfileMenu?.({
      getApi, getIde, contextMenu: o.contextMenu, logError, getRootEl: getWorkbenchRoot,
      commitPreference: typeof o.commitPreference === 'function' ? o.commitPreference : undefined,
      newTerminal: (opts) => newTerminal(opts),
      reanchor: (el) => (el && el.isConnected === false ? findProfileAnchor(resolveTarget('')) : el),
    }) || { isAvailable: () => false, openLaunchMenu: async () => false, openDefaultMenu: async () => false };

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
      labels.delete(viewId);
      if (renaming?.viewId === viewId) renaming = null;
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
      bindRenameGesture();
      resumeRename();
    }

    function tabViewId(event) {
      const tab = event?.target?.closest?.('[data-wb-tab]');
      return tab ? String(tab.getAttribute('data-wb-tab') || '') : '';
    }

    // Double-click on a terminal's tab renames it (VS Code); one listener on the workbench root.
    function onTabDoubleClick(event) {
      const viewId = tabViewId(event);
      if (viewId && panels.has(viewId) && renameTerminal(viewId)) event.preventDefault?.();
    }

    // A click or arrow-key focus on a terminal's tab makes it the active terminal,
    // so the palette's Kill/Find/Rename act on the shown one (a not-started panel
    // never takes focus inside its mount).
    function onTabActivate(event) {
      touch(tabViewId(event));
    }

    function unbindRoot() {
      renameRoot?.removeEventListener?.('dblclick', onTabDoubleClick);
      renameRoot?.removeEventListener?.('click', onTabActivate);
      renameRoot?.removeEventListener?.('focusin', onTabActivate);
      renameRoot = null;
    }

    function bindRenameGesture() {
      const root = getWorkbenchRoot();
      if (root === renameRoot) return;
      unbindRoot();
      renameRoot = root && typeof root.addEventListener === 'function' ? root : null;
      renameRoot?.addEventListener('dblclick', onTabDoubleClick);
      renameRoot?.addEventListener('click', onTabActivate);
      renameRoot?.addEventListener('focusin', onTabActivate);
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
    // otherwise); opts.near places it beside that terminal; opts.cwd (root-relative)
    // and opts.profileId pick its start folder and shell. Returns the new viewId,
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
      addTerminalView(viewId, opts && opts.near, lastNear);
      sync();
      touch(viewId);
      revealView(viewId, { focus: true });
      if (opts && opts.start === true) {
        const start = opts.cwd || opts.profileId ? { cwd: opts.cwd || '', profileId: opts.profileId || '' } : undefined;
        panels.get(viewId)?.startSession?.(start).catch?.(noop);
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
      const remove = () => {
        if (disposed || panels.get(viewId) !== panel) return;
        disposePanel(viewId);
        removeTerminalView(viewId);
        sync();
      };
      if (!panel.isRunning?.() || typeof panel.stopSession !== 'function') {
        remove();
        return true;
      }
      // A live shell leaves the layout only once its kill is CONFIRMED; an
      // unconfirmed stop keeps the view so its 'stop unconfirmed' state shows.
      Promise.resolve(panel.stopSession()).then((confirmed) => {
        if (confirmed === true) remove();
      }, (error) => logError('WARN', 'ide.terminal_set_close', { message: String(error?.message || error) }));
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

    /* ---- header actions, profile menus and rename (row 82 T2) ------------ */

    // + (and its shell-profile chevron: the New Terminal split-button) while a slot is
    // free, then Kill. The chevron needs the listProfiles bridge (absent when hosted).
    function viewActions(viewId) {
      if (disposed || !(slotOf(viewId) > 0)) return [];
      const icons = o.actionIcons || {};
      const actions = [];
      if (canAdd()) {
        actions.push({ name: 'new-terminal', label: jt('ide.terminal.new', 'New Terminal'), icon: icons.add });
        if (icons.chevron && profileMenu.isAvailable()) {
          actions.push({ name: 'new-terminal-profile', label: jt('ide.terminal.launchProfileMenu', 'Launch Profile...'), icon: icons.chevron });
        }
      }
      actions.push({ name: 'kill-terminal', label: jt('ide.terminal.kill', 'Kill Terminal'), icon: icons.trash });
      return actions;
    }

    function runViewAction(viewId, name, anchorEl) {
      if (name === 'new-terminal') {
        lastNear = viewId;
        newTerminal({ start: true });
      } else if (name === 'new-terminal-profile') {
        openProfileMenu({ anchorEl, near: viewId }).catch(noop);
      } else if (name === 'kill-terminal') {
        closeTerminal(viewId);
      }
    }

    // The live chevron in the stack showing viewId, else any chevron, else the view's tab.
    function findProfileAnchor(viewId) {
      const root = getWorkbenchRoot();
      if (!root || typeof root.querySelector !== 'function') return null;
      const tab = viewId ? root.querySelector(`[data-wb-tab="${viewId}"]`) : null;
      const chevron = '[data-wb-action="view:new-terminal-profile"]';
      return tab?.closest?.('[data-wb-stack]')?.querySelector?.(chevron) || root.querySelector(chevron) || tab || null;
    }

    function profilesAvailable() {
      return !disposed && profileMenu.isAvailable();
    }

    // The launch menu; from the palette (no anchor) it reveals the active terminal first.
    async function openProfileMenu(opts) {
      const options = opts || {};
      if (!profilesAvailable() || !canAdd()) return false;
      const target = options.near || resolveTarget('');
      if (!options.anchorEl && target) revealView(target, { focus: false });
      const anchor = options.anchorEl || findProfileAnchor(target);
      return profileMenu.openLaunchMenu(anchor, options.near || '');
    }

    async function openDefaultProfileMenu(opts) {
      if (!profilesAvailable()) return false;
      const target = resolveTarget('');
      if (!opts?.anchorEl && target) revealView(target, { focus: false });
      return profileMenu.openDefaultMenu(opts?.anchorEl || findProfileAnchor(target));
    }

    function labelOf(viewId) {
      return labels.get(viewId) || '';
    }

    // '' (or whitespace) restores the default "Terminal N" name.
    function setLabel(viewId, text) {
      if (!panels.has(viewId)) return false;
      const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
      if (value) labels.set(viewId, value);
      else labels.delete(viewId);
      requestRender();
      return true;
    }

    // An inline name field over the terminal's tab (inventory inline-title-editor): Enter or
    // blur keeps it, Escape cancels, an emptied field puts the default name back. `resume`
    // ({ value, start, end }) re-opens a field a header re-render removed (cleanup T12).
    function renameTerminal(viewId, resume) {
      const target = resolveTarget(viewId || '');
      const editor = resolveModule('inventoryInlineTitleEditor', '../inventory/inline-title-editor');
      if (!target || typeof editor.startInlineTitleEdit !== 'function') return false;
      revealView(target, { focus: false });
      const tab = getWorkbenchRoot()?.querySelector?.(`[data-wb-tab="${target}"]`);
      if (!tab) return false;
      let lastKey = '';
      // A re-render detaches the tab: the field's blur then is not the user's commit.
      const settle = (fn) => (value) => {
        if (tab.isConnected === false) return;
        renaming = null;
        fn(value);
      };
      const handle = editor.startInlineTitleEdit({
        titleEl: tab,
        initialValue: tab.querySelector?.('.wb-tab-label')?.textContent || labelOf(target),
        ariaLabel: jt('ide.terminal.renameLabel', 'Terminal name'),
        maxLength: LABEL_MAX,
        onCommit: settle((value) => setLabel(target, value)),
        onCancel: settle(() => { if (lastKey !== 'Escape' && !String(handle?.input?.value || '').trim()) setLabel(target, ''); }),
      });
      if (!handle) return false;
      handle.input.addEventListener('keydown', (event) => { lastKey = event.key; });
      if (resume) {
        handle.input.value = resume.value;
        try { handle.input.setSelectionRange(resume.start, resume.end); } catch (_error) { /* the caret is best-effort */ }
      }
      renaming = { viewId: target, tab, input: handle.input };
      return true;
    }

    // After a workbench render: a rename whose tab was replaced re-opens on the new tab,
    // keeping its text and caret.
    function resumeRename() {
      const open = renaming;
      if (!open || open.tab.isConnected !== false) return;
      renaming = null;
      if (!panels.has(open.viewId)) return;
      const { value, selectionStart, selectionEnd } = open.input;
      renameTerminal(open.viewId, { value: String(value || ''), start: selectionStart, end: selectionEnd });
    }

    // The header's More menu gains Rename for a terminal view.
    function menuItems(viewId) {
      if (!panels.has(viewId)) return [];
      return [{ separator: true }, { label: jt('ide.terminal.rename', 'Rename Terminal...'), action: () => { renameTerminal(viewId); } }];
    }

    function dispose() {
      if (disposed) {
        return;
      }
      for (const viewId of Array.from(panels.keys())) {
        disposePanel(viewId);
      }
      unbindRoot();
      renaming = null;
      disposed = true;
    }

    return {
      // The terminal a palette row acts on: the last one used, else the main slot.
      activeViewId: () => resolveTarget(''),
      bindEvents,
      canAdd,
      closeTerminal,
      count,
      dispose,
      focusTerminal,
      labelOf,
      menuItems,
      newTerminal,
      openDefaultProfileMenu,
      openProfileMenu,
      openTaskTerminal,
      panelFor,
      profilesAvailable,
      renameTerminal,
      renderAll,
      runViewAction,
      sendCommand,
      setLabel,
      sync,
      viewActions,
    };
  }

  return { createIdeTerminalSet };
});
