/* renderer/chat/renderer-chat-terminal-panel.js - the chat Terminal side panel (row 178, UMD).

   The `terminal` mode of the chat's right-hand panel: the SAME terminals as the Workspace's bottom panel, through the
   terminal pool seam (window.rendererIdeTerminalPool, built by the IDE root service). There is one xterm per terminal:
   this panel only asks the pool to move the selected one into its mount (pool.host) and to give it back (pool.release)
   when the panel closes, the mode changes, the chat changes or the panel is disposed. Loaded lazily on first open; the
   shell (renderer-shell-artifact-rails.js) builds one controller, lets renderSplitDetail PULL its body through
   renderRailContent and shows titleHtml() (the tab strip and the actions) in the chrome's title slot. Markup is in
   -render.js. A chat of another project never starts or shows a terminal in the wrong folder. Nothing is persisted. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-terminal-panel-render'));
    return;
  }
  root.rendererChatTerminalPanelOwner = factory(root.rendererChatTerminalPanelRender);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (renderModule) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const MODE = 'terminal';
  const GENERAL_PROJECT_ID = 'project_general';
  const MAX_TERMINALS = 4;
  function noop() {}

  function createChatTerminalPanel(deps) {
    const d = deps || {};
    const state = d.state;
    if (!state || typeof state !== 'object') throw new Error('renderer-chat-terminal-panel: state dep is required');
    const rr = renderModule || globalThis.rendererChatTerminalPanelRender;
    const win = d.windowRef || globalThis.window || globalThis;
    const panelEl = d.dom?.artifactReviewPanel || null;
    const fn = (value, fallback = noop) => (typeof value === 'function' ? value : fallback);
    const [openArtifactRail, renderArtifactReviewPanel, closePanel, claimOwner, appendClientLog, setActiveView] = [d.openArtifactRail,
      d.renderArtifactReviewPanel, d.toggleArtifactReview, d.claimOwner, d.appendClientLog, d.setActiveView].map((value) => fn(value));
    const getPanelSessionId = fn(d.getPanelSessionId, () => state.currentSessionId);
    const getProjectSwitcher = fn(d.getProjectSwitcher, async () => null);
    const insertText = fn(d.insertIntoComposer, (payload) => win.rendererComposerInsert?.insertIntoComposer?.(payload) === true);
    const copyText = fn(d.copyText, async (text) => {
      if (typeof win.navigator?.clipboard?.writeText === 'function') await win.navigator.clipboard.writeText(text);
      else await win.jennyShell?.clipboard?.writeText?.(text);
    });

    let disposed = false, bound = false;
    let pool = null, poolOff = null, unavailable = false;
    let sessionId = null; // the chat last painted; null until the first paint
    let project = null, projectFor = null, projectLoad = null; // this chat's project { id, name, rootPath } and the chat it was read for
    let selected = 0, wantedSlot = 0, synced = false, knownTasks = new Set();
    const shown = new Set(), created = new Set(); // the slots with a tab: running ones and the ones started from this panel
    let ended = false, lastError = '', autoStarting = false; // autoStarting: opening the tab is starting its first terminal
    let hostedSlot = 0, hostedMount = null, forceHost = false, hostLost = false;
    let mountEl = null, panelObs = null;
    let renaming = null, lastHead = '', lastStateHtml = '', selectionText = '', opener = null, openToken = 0;
    const listeners = [['click', handleClick], ['keydown', handleKeydown], ['mouseup', handleSelectionEvent], ['keyup', handleSelectionEvent]];
    const windowEvents = [['workspace:root-committed', handleRootChanged], ['jenny:projects-changed', handleRootChanged]];

    const sid = () => String(getPanelSessionId() || '').trim();
    const flagOn = () => state.features?.featureFlags?.chat_terminal_panel !== false;
    const available = () => !disposed && flagOn() && Boolean(win.jennyShell?.workspacePty) && Boolean(win.rendererIdeTerminalPool);
    const logWarn = (event, error) => appendClientLog('WARN', event, { message: String(error?.message || error || '').slice(0, 200) });
    const inMode = () => state.ui?.artifactReview?.mode === MODE;
    const maxTerminals = () => (Number.isFinite(pool?.maxTerminals) && pool.maxTerminals > 0 ? pool.maxTerminals : MAX_TERMINALS);
    const rootEl = () => panelEl?.querySelector?.('.chat-terminal-panel') || null;

    function isOpen() {
      const prefs = state.ui?.artifactReview || {};
      return !disposed && prefs.mode === MODE && prefs.enabled === true && prefs.collapsed !== true && !panelEl?.classList?.contains('hidden');
    }

    // The pool never throws by contract; a broken one must still not take the panel down.
    function P(name, ...args) {
      try { return pool?.[name]?.(...args); } catch (error) { logWarn('chat_terminal.pool_call_failed', error); return undefined; }
    }
    const listPool = () => { const list = P('list'); return Array.isArray(list) ? list : []; };
    const entryOf = (slot) => listPool().find((entry) => entry.slot === slot) || null;

    // ── The chat's project ──
    function chatProjectId(key) {
      const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => String(entry?.id || '') === key);
      if (!session) return null; // unknown chat: never treated as "no project" (fail closed)
      // The Jenny chat (session_role 'primary') has no project of its own: its terminals open wherever the pool does.
      const id = session.session_role === 'primary' ? '' : String(session.project_id || '').trim();
      return id === GENERAL_PROJECT_ID ? '' : id;
    }

    // `force` re-reads while the last answer stays in use (a project-list refresh must not blank a running terminal).
    function resolveProject(force) {
      const key = sid();
      if (projectFor === key && !force) return Promise.resolve();
      if (projectLoad?.key === key) return projectLoad.promise;
      const promise = (async () => {
        const id = chatProjectId(key);
        let found = null;
        if (id) {
          try {
            const switcher = await getProjectSwitcher();
            await switcher?.refresh?.();
            found = switcher?.projectById?.(id) || null;
          } catch (error) { logWarn('chat_terminal.project_read_failed', error); }
        }
        if (disposed || key !== sid()) return;
        project = id === null ? { id: '', name: jt('chatTerminal.thisProject', 'this project'), rootPath: '' }
          : id ? { id, name: found?.name || jt('chatTerminal.thisProject', 'this project'), rootPath: found?.rootPath || '' } : null;
        projectFor = key;
      })().finally(() => { if (projectLoad?.key === key) projectLoad = null; });
      projectLoad = { key, promise };
      return promise;
    }

    // The chat's project when it is not the folder the pool opens terminals in; a chat without a project is never "wrong".
    function mismatch() {
      if (!project) return null;
      return project.rootPath && rr.sameFolder(project.rootPath, P('rootPath')) ? null : project;
    }

    // ── The model: which terminals have a tab, which one is selected ──
    function syncModel() {
      if (!pool) return;
      const list = listPool();
      const slots = new Set(list.map((entry) => entry.slot));
      for (const slot of [...shown]) if (!slots.has(slot)) shown.delete(slot);
      for (const slot of [...created]) if (!slots.has(slot)) created.delete(slot);
      const tasks = new Set();
      let newTask = 0;
      for (const entry of list) {
        const live = entry.running === true || entry.starting === true;
        if (entry.task === true) {
          if (synced && live && !knownTasks.has(entry.slot)) newTask = entry.slot; // a terminal_run the user approved (new or reused)
          if (live) tasks.add(entry.slot);
        }
        // A tab shows while its shell lives, or until the user starts the one they made here; an ended shell leaves.
        if (live || created.has(entry.slot)) shown.add(entry.slot);
        else if (!ended) shown.delete(entry.slot); // the ended state keeps its stopped tabs until a start
        if (live && ended) ended = false;
      }
      knownTasks = tasks;
      synced = true;
      const wanted = newTask || (slots.has(wantedSlot) ? wantedSlot : 0);
      if (wanted) { shown.add(wanted); selected = wanted; forceHost = true; wantedSlot = 0; }
      if (!shown.has(selected)) { selected = [...shown].sort((a, b) => a - b)[0] || 0; forceHost = true; }
    }

    function visibleTabs() {
      return listPool().filter((entry) => shown.has(entry.slot)).sort((a, b) => a.slot - b.slot).map((entry) => {
        const label = String(entry.label || '').trim() || jt('chatTerminal.defaultLabel', 'Terminal {slot}', { slot: entry.slot });
        return { slot: entry.slot, label, tooltip: rr.tabTooltip({ ...entry, label }), starting: entry.starting === true, selected: entry.slot === selected };
      });
    }

    function bodyKind() {
      if (!pool) return unavailable ? 'unavailable' : 'loading';
      if (projectFor !== sid()) return 'loading';
      if (mismatch()) return 'other';
      if (autoStarting) return 'loading';
      if (ended) return 'ended';
      return visibleTabs().length ? 'running' : 'empty';
    }

    // ── Hosting: one terminal at a time, never rebuilt while the same slot stays selected ──
    function release() {
      hostedMount = null;
      clearAttach();
      if (!hostedSlot) return;
      hostedSlot = 0;
      P('release');
    }

    function ensureHosted() {
      if (!mountEl || !pool || !selected || (hostLost && !forceHost)) return;
      if (!forceHost && hostedSlot === selected && hostedMount === mountEl) return;
      forceHost = false;
      hostLost = false;
      hostedSlot = selected; // before the call: a change event it raises must not read as "taken back"
      hostedMount = mountEl;
      if (P('host', selected, mountEl) === false) { hostedSlot = 0; hostedMount = null; }
    }

    // The pool's xterm watches the hosted element's size itself.
    const unwatchMount = () => { mountEl = null; };

    // Escape typed in the terminal belongs to the terminal's shell, not to the panel.
    function handleMountKeydown(event) { if (event.key === 'Escape') event.stopPropagation(); }

    // ── Painting ──
    function prepareSurface(surface) {
      if (!surface) return null;
      surface.detailPanel?.classList?.remove('hidden');
      for (const hidden of [surface.detailEmpty, surface.metaPane, surface.saveButton, surface.revertButton, surface.revealButton,
        surface.openExternalButton, surface.deleteButton, surface.editorShell, surface.dirtyBadge]) hidden?.classList?.add('hidden');
      for (const field of [surface.detailKicker, surface.detailTitle, surface.detailPath, surface.detailStatus, surface.detailNote]) if (field) field.textContent = '';
      if (surface.detailMeta) surface.detailMeta.innerHTML = '';
      if (surface.provenanceTimeline) surface.provenanceTimeline.innerHTML = '';
      const host = surface.previewContent || surface;
      host?.classList?.remove?.('hidden');
      return host;
    }

    function paintRunning(host) {
      if (rootEl()?.dataset.ctKind !== 'running') {
        release();
        unwatchMount();
        host.innerHTML = rr.runningHtml();
        lastStateHtml = '';
        mountEl = host.querySelector('[data-chat-terminal-mount]');
        mountEl.addEventListener('keydown', handleMountKeydown);
        forceHost = true;
        hostLost = false;
      }
      const notice = host.querySelector('[data-ct-notice]');
      const html = rr.noticeHtml(lastError);
      if (notice && notice.innerHTML !== html) notice.innerHTML = html;
      ensureHosted();
    }

    function paintState(host, kind) {
      release();
      unwatchMount();
      const rootPath = P('rootPath');
      const html = rr.stateHtml(kind, { name: kind === 'other' ? project?.name : rr.baseName(rootPath), error: lastError });
      if (html === lastStateHtml && rootEl()?.dataset.ctKind === kind) return;
      host.innerHTML = html;
      lastStateHtml = html;
    }

    function renderRailContent(surface) {
      const host = prepareSurface(surface);
      if (!host || disposed) return false;
      syncSession();
      syncModel();
      const kind = bodyKind();
      if (kind === 'running') paintRunning(host); else paintState(host, kind);
      return true;
    }

    function refreshView() {
      if (disposed || !isOpen()) return;
      renderArtifactReviewPanel();
    }

    // A re-render while a name is being typed must not replace the field.
    function titleHtml() {
      if (disposed || !inMode()) return '';
      if (renaming && lastHead) return lastHead;
      const kind = bodyKind();
      const tabs = kind === 'running' || kind === 'ended' ? visibleTabs() : null;
      lastHead = rr.headHtml({ tabs, canAdd: Boolean(tabs) && tabs.length < maxTerminals(), limit: maxTerminals(), actions: kind === 'running' });
      return lastHead;
    }

    // The chat changed: release the terminal and read the new chat's project before showing anything.
    function syncSession() {
      const next = sid();
      if (next === sessionId) return;
      const first = sessionId === null;
      sessionId = next;
      if (!first) { release(); ended = false; lastError = ''; }
      void resolveProject().then(() => refreshView());
    }

    // ── Pool events ──
    function adoptPool(next) {
      if (pool === next) return;
      poolOff?.();
      pool = next;
      const off = P('subscribe', onPoolEvent);
      poolOff = typeof off === 'function' ? off : null;
    }

    function onPoolEvent(event) {
      if (disposed) return;
      if (event?.type === 'root_reset') return onRootReset();
      if (event?.type !== 'changed' || !isOpen()) return;
      if (hostedSlot && P('hostedSlot') !== hostedSlot) { hostedSlot = 0; hostedMount = null; hostLost = true; } // the Workspace took it back
      refreshView();
    }

    function onRootReset() {
      const hadTabs = shown.size > 0;
      release();
      if (!isOpen()) return;
      if (hadTabs) { ended = true; lastError = ''; refreshView(); return; }
      reevaluate();
    }

    function reevaluate() {
      void resolveProject(true).then(() => refreshView());
    }
    function handleRootChanged() { if (pool && isOpen()) reevaluate(); }

    // ── Opening and closing ──
    async function open(options) {
      if (disposed || !available()) return false;
      const o = options || {};
      const owner = String(o.sessionId || '').trim();
      if (owner) claimOwner(owner);
      opener = o.opener && typeof o.opener.focus === 'function' ? o.opener : opener;
      const token = ++openToken;
      wantedSlot = Number(o.slot) > 0 ? Number(o.slot) : 0;
      unavailable = false;
      syncSession();
      openArtifactRail(MODE);
      const api = win.rendererIdeTerminalPool;
      let next = pool || api.peek?.() || null;
      if (!next) {
        renderArtifactReviewPanel(); // the quiet loading line
        try { next = await api.ensure(); } catch (error) { logWarn('chat_terminal.pool_ensure_failed', error); next = null; }
        if (disposed || token !== openToken) return false;
      }
      if (next) adoptPool(next); else unavailable = true;
      await resolveProject();
      if (disposed || token !== openToken) return false;
      syncModel();
      // Choosing Terminal starts this folder's first terminal; the empty state stays for no folder, an error or another project.
      if (bodyKind() === 'empty' && !lastError && P('rootPath')) {
        autoStarting = true;
        try { await createTerminal(); } finally { autoStarting = false; }
        if (disposed || token !== openToken) return false;
      }
      renderArtifactReviewPanel();
      return isOpen();
    }

    function close(options) {
      openToken += 1;
      if (!isOpen()) return false;
      release();
      closePanel();
      if (options?.restoreFocus !== false && opener?.isConnected && typeof opener.focus === 'function') opener.focus();
      return true;
    }

    // ── Actions ──
    function selectSlot(slot, options) {
      if (!shown.has(slot)) return;
      selected = slot;
      forceHost = true;
      hostLost = false;
      clearAttach();
      refreshView();
      if (options?.focusTab) panelEl?.querySelector?.(`[data-ct-tab="${slot}"]`)?.focus?.();
      else if (options?.focusTerminal) P('focus', slot);
    }

    async function createTerminal(profileId) {
      if (!pool) return;
      // create() only adds slots 2-4: a stopped first terminal is started instead (unless a shell was picked).
      const first = entryOf(1);
      let result;
      if (!profileId && first && first.running !== true && first.starting !== true && !shown.has(1)) {
        result = (await P('start', 1)) ? { ok: true, slot: 1 } : { ok: false, reason: 'start_failed' };
      } else {
        result = await P('create', profileId ? { profileId } : undefined);
      }
      if (result?.ok !== true && result?.reason === 'max_terminals') { // every slot is taken: a stopped one that has no tab comes back
        const idle = listPool().find((entry) => !shown.has(entry.slot) && entry.running !== true && entry.starting !== true);
        if (idle && await P('start', idle.slot)) result = { ok: true, slot: idle.slot };
      }
      if (result?.ok === true) {
        created.add(result.slot);
        shown.add(result.slot);
        selected = result.slot;
        forceHost = true;
        ended = false;
        lastError = '';
      } else {
        lastError = result?.reason === 'max_terminals' ? jt('chatTerminal.error.max', 'Four terminals are open.') : jt('chatTerminal.error.start', 'Could not start a terminal.');
      }
      syncModel();
      refreshView();
    }

    async function startAgain() {
      ended = false;
      projectFor = null;
      await resolveProject();
      const entry = entryOf(selected);
      if (!mismatch() && entry && entry.running !== true && entry.starting !== true && await P('start', entry.slot)) forceHost = true;
      else if (!mismatch()) await createTerminal();
      syncModel();
      refreshView();
    }

    async function closeTab(slot) {
      shown.delete(slot);
      created.delete(slot);
      if (hostedSlot === slot) release();
      await P('close', slot);
      syncModel();
      refreshView();
    }

    async function openProject() {
      if (!project) return;
      try {
        const switcher = await getProjectSwitcher();
        if (typeof switcher?.switchToProject === 'function') await switcher.switchToProject(project.id);
        else setActiveView('ide'); // no switch seam: the Workspace opens and the choice stays with the user
      } catch (error) { logWarn('chat_terminal.open_project_failed', error); }
      reevaluate();
    }

    function showInWorkspace() {
      if (!selected) return;
      P('showInWorkspace', selected);
      hostedSlot = 0;
      hostedMount = null;
      close({ restoreFocus: false });
    }

    // An inline name field over the tab: Enter or blur keeps it, Escape cancels, an emptied field restores the default name.
    function startRename(slot) {
      const editor = win.inventoryInlineTitleEditor;
      const label = panelEl?.querySelector?.(`[data-ct-tab="${slot}"] [data-ct-label]`);
      if (!label || typeof editor?.startInlineTitleEdit !== 'function' || renaming) return;
      let lastKey = '';
      const settle = (fnc) => (value) => { renaming = null; fnc(value); refreshView(); };
      const handle = editor.startInlineTitleEdit({
        titleEl: label,
        initialValue: label.textContent,
        ariaLabel: jt('chatTerminal.renameLabel', 'Terminal name'),
        maxLength: 40,
        onCommit: settle((value) => P('rename', slot, value)),
        onCancel: settle(() => { if (lastKey !== 'Escape' && !String(handle?.input?.value || '').trim()) P('rename', slot, ''); }),
      });
      if (!handle) return;
      handle.input.addEventListener('keydown', (event) => { lastKey = event.key; });
      renaming = { slot };
    }

    async function openMenu(anchor) {
      const menu = win.inventoryContextMenu;
      const slot = selected;
      if (!slot || typeof menu?.show !== 'function') return;
      let profiles = [];
      try { const list = await P('listProfiles'); profiles = Array.isArray(list) ? list : []; } catch (error) { logWarn('chat_terminal.profiles_failed', error); }
      if (disposed || !isOpen()) return;
      const full = visibleTabs().length >= maxTerminals();
      const items = profiles.map((profile) => ({ label: jt('chatTerminal.menu.newProfile', 'New {label}', { label: profile.label }), disabled: full, action: () => void createTerminal(profile.id) }));
      if (items.length) items.push({ separator: true });
      items.push(
        { label: jt('chatTerminal.menu.rename', 'Rename…'), action: () => startRename(slot) },
        { label: jt('chatTerminal.menu.clear', 'Clear'), action: () => { P('clear', slot); } },
        { label: jt('chatTerminal.menu.copyFolder', 'Copy folder path'), action: () => {
          const path = entryOf(slot)?.cwd || P('rootPath') || '';
          if (path) Promise.resolve().then(() => copyText(path)).catch(() => {}); // no toast: the clipboard is best effort
        } },
        { separator: true },
        { label: jt('chatTerminal.menu.kill', 'Kill terminal'), action: () => void closeTab(slot) },
      );
      menu.show({ anchorEl: anchor, rootEl: anchor, restoreFocusTo: anchor, ariaLabel: jt('chatTerminal.menu.label', 'Terminal'), items });
    }

    // ── Add to message ──
    function clearAttach() {
      selectionText = '';
      const holder = panelEl?.querySelector?.('[data-ct-attach-slot]');
      if (holder?.firstElementChild) holder.innerHTML = '';
    }

    function handleSelectionEvent(event) {
      if (disposed || !mountEl || !selected || !mountEl.contains(event.target)) return;
      selectionText = String(P('getSelection', selected) || '');
      const holder = panelEl.querySelector('[data-ct-attach-slot]');
      if (!holder) return;
      const has = selectionText.trim() !== '';
      if (has && !holder.firstElementChild) holder.innerHTML = rr.attachHtml();
      else if (!has && holder.firstElementChild) holder.innerHTML = '';
    }

    function attach() {
      const text = String(P('getSelection', selected) || selectionText || '');
      clearAttach();
      if (!text.trim()) return;
      const label = visibleTabs().find((tab) => tab.slot === selected)?.label || '';
      insertText({ text: rr.messageText(label, text) });
    }

    // ── Events ──
    function handleClick(event) {
      if (disposed || !inMode()) return;
      const hit = (selector) => event.target?.closest?.(selector);
      let node;
      if ((node = hit('[data-ct-close]'))) return void closeTab(Number(node.getAttribute('data-ct-close')));
      if ((node = hit('[data-ct-tab]'))) return selectSlot(Number(node.getAttribute('data-ct-tab')), { focusTerminal: true });
      if (hit('[data-ct-add]')) return void createTerminal();
      if ((node = hit('[data-ct-more]'))) return void openMenu(node);
      if (hit('[data-ct-workspace]')) return showInWorkspace();
      if (hit('[data-ct-start]')) return void createTerminal();
      if (hit('[data-ct-start-again]')) return void startAgain();
      if (hit('[data-ct-open-project]')) return void openProject();
      if (hit('[data-ct-attach]')) return attach();
    }

    function handleKeydown(event) {
      const tab = event.target?.closest?.('[data-ct-tab]');
      if (disposed || !inMode() || !tab || tab !== event.target) return;
      const slots = visibleTabs().map((entry) => entry.slot);
      const at = slots.indexOf(Number(tab.getAttribute('data-ct-tab')));
      const count = slots.length;
      const target = { ArrowRight: (at + 1) % count, ArrowLeft: (at - 1 + count) % count, Home: 0, End: count - 1, Enter: at, ' ': at }[event.key];
      if (target === undefined || at < 0) return;
      event.preventDefault();
      selectSlot(slots[target], { focusTab: event.key !== 'Enter' && event.key !== ' ', focusTerminal: event.key === 'Enter' });
    }

    // The rail changed the mode or closed the panel: the terminal goes back to the Workspace.
    function handlePanelChanged() { if (!disposed && !isOpen()) release(); }

    function bind() {
      if (bound || disposed) return;
      bound = true;
      for (const [type, listener] of listeners) panelEl?.addEventListener?.(type, listener);
      for (const [type, listener] of windowEvents) win.addEventListener?.(type, listener);
      const Observer = d.MutationObserverImpl || win.MutationObserver;
      if (panelEl && typeof Observer === 'function') {
        panelObs = new Observer(handlePanelChanged);
        panelObs.observe(panelEl, { attributes: true, attributeFilter: ['data-artifact-review-mode', 'class'] });
      }
    }

    function dispose() {
      if (disposed) return;
      release();
      disposed = true;
      poolOff?.();
      poolOff = null;
      pool = null;
      unwatchMount();
      panelObs?.disconnect?.();
      panelObs = null;
      if (bound) {
        for (const [type, listener] of listeners) panelEl?.removeEventListener?.(type, listener);
        for (const [type, listener] of windowEvents) win.removeEventListener?.(type, listener);
      }
    }

    return { bind, dispose, open, close, isOpen, renderRailContent, titleHtml, refresh: refreshView, isAvailable: available };
  }

  return { createChatTerminalPanel, MODE };
});
