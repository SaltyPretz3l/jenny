/* renderer/features/renderer-ide-terminal-pool.js - the seam that lets the chat's
 * Terminal panel (row 178) see and drive the Workspace IDE's terminals. One pool of at
 * most four PTY terminals, keyed by slot 1-4: the terminal set owns the sessions, this
 * module is a thin facade over it (no second set, no second xterm, no output mirroring).
 * host(slot, el) moves a terminal's live xterm into a chat element; the IDE view shows a
 * placeholder meanwhile and takes it back on release. The root service publishes the
 * pool as window.rendererIdeTerminalPool = { ensure, peek }.
 *
 * Contract rules: every method is safe with a slot that does not exist (false, '' or a
 * no-op), none throws, and the pool never issues an id-less kill (kills go through the
 * set's panels by session id). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalPoolUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_TERMINALS = 4;
  const ROOT_COMMITTED_EVENT = 'ide:workspace-root-committed';
  const PROFILE_ID_RE = /^[a-z0-9-]{1,32}$/;
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalThis[globalName]) return globalThis[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }

  const profileMenuUtils = resolveModule('rendererIdeTerminalProfileMenu', './renderer-ide-terminal-profile-menu');

  // deps: { terminals (the terminal set), layoutModel, windowRef, appendClientLog, getWiring (the workbench
  //         wiring: getLayout / commitLayout / showPanel), setActiveView, getRootPath, getApi, registerCleanup }
  function createIdeTerminalPool(deps) {
    const o = deps || {};
    const terminals = o.terminals || null;
    const model = o.layoutModel || {};
    const windowRef = o.windowRef || globalThis.window || globalThis;
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : noop;
    const listeners = new Set();
    let disposed = false;
    let pending = null; // { changed, root } while a notification microtask is queued
    let unsubscribeSet = noop;

    function logError(site, error) {
      try { log('DEBUG', 'ide.terminal_pool_error', { site, message: String(error?.message || error || '') }); } catch (_error) { /* logging is best-effort */ }
    }

    function slotOf(viewId) {
      return typeof model.terminalSlot === 'function' ? model.terminalSlot(viewId) : 0;
    }

    function viewIdOf(slot) {
      const n = Math.floor(Number(slot));
      return n >= 1 && n <= MAX_TERMINALS && typeof model.terminalViewId === 'function' ? model.terminalViewId(n) : null;
    }

    // One entry per terminal view in the layout, by slot. The set's sync() is idempotent and keeps panels in step.
    function entries() {
      if (disposed || !terminals) return [];
      terminals.sync();
      const found = [];
      for (const viewId of terminals.viewIds()) {
        const panel = terminals.panelFor(viewId);
        if (panel) found.push({ slot: slotOf(viewId), viewId, panel });
      }
      return found.sort((a, b) => a.slot - b.slot);
    }

    function panelOf(slot) {
      const viewId = viewIdOf(slot);
      return viewId && !disposed && terminals ? (terminals.sync(), terminals.panelFor(viewId)) : null;
    }

    function getApi() {
      return typeof o.getApi === 'function' ? o.getApi() : null;
    }

    /* ---- notifications -------------------------------------------------- */

    function flushNotifications() {
      const batch = pending;
      pending = null;
      if (!batch || disposed) return;
      const events = (batch.root ? [{ type: 'root_reset' }] : []).concat(batch.changed ? [{ type: 'changed' }] : []);
      for (const event of events) {
        for (const fn of Array.from(listeners)) {
          try { fn(event); } catch (error) { logError('listener', error); }
        }
      }
    }

    function queue(kind) {
      if (disposed) return;
      if (!pending) {
        pending = { changed: false, root: false };
        Promise.resolve().then(flushNotifications);
      }
      pending[kind] = true;
    }

    function onRootCommitted() {
      queue('root'); // the panels reset on this same event; subscribers hear in a later microtask
    }

    if (terminals && typeof terminals.onChange === 'function') unsubscribeSet = terminals.onChange(() => queue('changed'));
    if (typeof windowRef?.addEventListener === 'function') windowRef.addEventListener(ROOT_COMMITTED_EVENT, onRootCommitted);

    function subscribe(fn) {
      if (typeof fn !== 'function' || disposed) return noop;
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    }

    /* ---- the pool ------------------------------------------------------- */

    function list() {
      try {
        return entries().map(({ slot, viewId, panel }) => ({
          slot,
          viewId,
          label: terminals.labelOf(viewId) || jt('ide.workbench.view.terminalN', 'Terminal {n}', { n: slot }),
          running: panel.isRunning() === true,
          starting: panel.isStarting?.() === true,
          task: terminals.isTaskView(viewId) === true,
          cwd: String(panel.getCwd?.() || ''),
          shell: String(panel.getShell?.() || ''),
        }));
      } catch (error) {
        logError('list', error);
        return [];
      }
    }

    // Adding a view to the layout activates and opens its stack. The chat adds a terminal without opening the IDE
    // bottom panel, so the stack's active view and collapsed state are put back in the same tick.
    function addWithoutReveal(add) {
      const wiring = typeof o.getWiring === 'function' ? o.getWiring() : null;
      let before = null;
      try { before = wiring?.getLayout?.() ? JSON.parse(JSON.stringify(wiring.getLayout())) : null; } catch (error) { logError('layout_snapshot', error); }
      const viewId = add();
      const after = viewId && before ? wiring.getLayout() : null;
      const found = after ? model.findView?.(after, viewId) : null;
      const prior = found ? model.findStack?.(before, found.stackId) : null;
      if (prior && prior.active) {
        const next = model.setCollapsed(model.setActiveView(after, prior.active), found.stackId, prior.collapsed === true);
        if (next && next !== after) wiring.commitLayout(next);
      }
      return viewId;
    }

    async function create(options) {
      try {
        if (disposed || !terminals || typeof getApi()?.spawn !== 'function') return { ok: false, reason: 'unavailable' };
        if (!terminals.canAdd()) return { ok: false, reason: 'max_terminals' };
        const id = String(options?.profileId || '');
        const viewId = addWithoutReveal(() => terminals.newTerminal({ reveal: false }));
        if (!viewId) return { ok: false, reason: 'max_terminals' };
        const panel = terminals.panelFor(viewId);
        const started = panel ? await panel.startSession(PROFILE_ID_RE.test(id) ? { profileId: id } : undefined) : false;
        if (started !== true) {
          terminals.closeTerminal(viewId); // never shown to the user: do not leave a stopped terminal behind
          return { ok: false, reason: 'start_failed' };
        }
        return { ok: true, slot: slotOf(viewId) };
      } catch (error) {
        logError('create', error);
        return { ok: false, reason: 'start_failed' };
      }
    }

    async function start(slot) {
      try {
        const panel = panelOf(slot);
        return panel ? (await panel.startSession()) === true : false;
      } catch (error) {
        logError('start', error);
        return false;
      }
    }

    // Slot 1 is killed and stays; slots 2-4 leave the layout once the kill is confirmed (the set's rule).
    async function close(slot) {
      try {
        const viewId = viewIdOf(slot);
        const panel = panelOf(slot);
        if (!panel) return false;
        if (slotOf(viewId) <= 1) return (await panel.stopSession()) === true;
        const confirmed = panel.isRunning() ? (await panel.stopSession()) === true : true;
        if (confirmed && terminals.panelFor(viewId) === panel) terminals.closeTerminal(viewId);
        return confirmed;
      } catch (error) {
        logError('close', error);
        return false;
      }
    }

    function rename(slot, name) {
      try { return panelOf(slot) ? terminals.setLabel(viewIdOf(slot), name) === true : false; } catch (error) { logError('rename', error); return false; }
    }

    function clear(slot) {
      try { const panel = panelOf(slot); panel?.clear(); return Boolean(panel); } catch (error) { logError('clear', error); return false; }
    }

    async function listProfiles() {
      try {
        const api = getApi();
        return typeof api?.listProfiles === 'function' && typeof profileMenuUtils.normalizeProfiles === 'function'
          ? profileMenuUtils.normalizeProfiles(await api.listProfiles()).profiles : [];
      } catch (error) {
        logError('list_profiles', error);
        return [];
      }
    }

    function host(slot, el) {
      try {
        const panel = panelOf(slot);
        if (!panel || !el || typeof panel.hostIn !== 'function') return false;
        for (const entry of entries()) { if (entry.panel !== panel) entry.panel.releaseHost?.(); } // one hosted slot at a time
        return panel.hostIn(el) === true;
      } catch (error) {
        logError('host', error);
        return false;
      }
    }

    function release() {
      try { for (const entry of entries()) entry.panel.releaseHost?.(); } catch (error) { logError('release', error); }
    }

    function hostedSlot() {
      try { return entries().find((entry) => entry.panel.isHostedOutside?.() === true)?.slot || 0; } catch (error) { logError('hosted_slot', error); return 0; }
    }

    function refit() {
      try { for (const entry of entries()) entry.panel.refit?.(); } catch (error) { logError('refit', error); }
    }

    function showInWorkspace(slot) {
      try {
        const panel = panelOf(slot);
        if (!panel) return false;
        panel.releaseHost?.();
        if (typeof o.setActiveView === 'function') o.setActiveView('ide');
        return (typeof o.getWiring === 'function' ? o.getWiring() : null)?.showPanel?.(viewIdOf(slot), { focus: true }) === true;
      } catch (error) {
        logError('show_in_workspace', error);
        return false;
      }
    }

    function getSelection(slot) {
      try { return String(panelOf(slot)?.getSelection?.() || ''); } catch (error) { logError('get_selection', error); return ''; }
    }

    function focus(slot) {
      try { panelOf(slot)?.focusTerminal?.(); } catch (error) { logError('focus', error); }
    }

    // Gives a hosted terminal back to the IDE and stops listening; never kills a session.
    function dispose() {
      if (disposed) return;
      release();
      disposed = true;
      pending = null;
      listeners.clear();
      unsubscribeSet();
      try { windowRef?.removeEventListener?.(ROOT_COMMITTED_EVENT, onRootCommitted); } catch (error) { logError('unbind_root', error); }
    }
    if (typeof o.registerCleanup === 'function') o.registerCleanup(dispose);

    return {
      maxTerminals: MAX_TERMINALS,
      list,
      rootPath: () => { try { return String(o.getRootPath?.() || ''); } catch (error) { logError('root_path', error); return ''; } },
      subscribe,
      create,
      start,
      close,
      rename,
      clear,
      listProfiles,
      host,
      refit,
      release,
      hostedSlot,
      showInWorkspace,
      getSelection,
      focus,
      dispose,
    };
  }

  return { createIdeTerminalPool };
});
