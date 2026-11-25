/* renderer/features/board/board-page.js - the Board page (UMD), the Board tab's one entry point.
 *
 * showBoardPage({ container, windowRef, ... }) builds the page into #boardView; hideBoardPage() stops it.
 * Nothing runs before the first show: no read, no listener, no timer. Everything the page starts (the
 * project subscription, the source's change listener, the size observer, the workbench's own listeners)
 * is stopped by dispose(), which hideBoardPage() calls; parkBoardPage() keeps the page built and idle instead (resumed by the next show).
 *
 * The page talks to a BoardSource (the project board plan, section 6): the preload bridge
 * while it is present and enabled; with none it says boards are not available (the in-memory source is
 * only used when the caller passes `allowMemorySource`). It lists the current project's boards, opens
 * one (the person's last one for that project, saved), draws it read-only, and offers create, rename,
 * duplicate and delete with an Undo toast. It listens to onChanged and re-reads what an event touches; an
 * event for another project's board is ignored. Text from documents reaches the DOM only through
 * textContent paths. Editing on the canvas is slices B5 and B6. Export (a row's menu) and Import board… are
 * board-export.js (slice B10); without it, or on a bridge without the calls, they are disabled with the reason.
 * A board that loads read-only (slice B11, D20) shows why with two buttons under it: Show file (revealFile) and Remove
 * from list (setAside: its files are renamed aside in the boards folder, nothing is deleted); a healthy board has neither.
 *
 * Row 151 slice T7 (D30): the project may be a team project ({ id, name, team, role() }, picked through pickProject).
 * The page's one source is scoped (board-source-bridge.js createScopedBoardSource): while a team project is shown its
 * calls go to board-source-team.js, which is loaded with Team only; this file names no team call. A member who may not
 * write sees the board view-only, and a batch the host turned down is read again and said. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardPage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const NAME_MAX = 200;
  const UNDO_TOAST_MS = 8000;
  const memorySources = new WeakMap(); // one in-memory source per window, so a tab hidden and shown again keeps its boards
  let active = null;

  // Where each module lives: the window's global in the app, `require` in a test. A missing module is null.
  const LOCATIONS = Object.freeze({
    jennyBoardModel: '../../../services/boards/board-model',
    jennyWorkbenchLayoutModel: '../../shared/workbench-layout-model',
    rendererIdeWorkbench: '../renderer-ide-workbench',
    inventoryActionButton: '../../inventory/action-button',
    inventoryCanvasSurface: '../../inventory/canvas-surface',
    inventoryBoardCard: '../../inventory/board-card',
    inventoryConnectorLayer: '../../inventory/connector-layer',
    inventoryInlineTitleEditor: '../../inventory/inline-title-editor',
    rendererBoardSourceMemory: './board-source-memory',
    rendererBoardSourceBridge: './board-source-bridge',
    rendererBoardProject: './board-project',
    rendererBoardLayoutStore: './board-layout-store',
    rendererBoardCanvasView: './board-canvas-view',
    rendererBoardEditor: './board-editor',
    rendererBoardCardKinds: './board-card-kinds',
    rendererBoardCanvasInteractions: './board-canvas-interactions',
    rendererBoardCanvasToolbar: './board-canvas-toolbar',
    rendererBoardCardEditing: './board-card-editing',
    rendererBoardListView: './board-list-view',
    rendererBoardPageWorkbench: './board-page-workbench',
    rendererBoardChatDock: './board-chat-dock',
    rendererBoardFind: './board-find',
    rendererBoardOutlineView: './board-outline-view',
    rendererBoardKeyboard: './board-keyboard',
    rendererBoardViewSwitch: './board-view-switch',
    rendererBoardViews: './board-views',
    rendererBoardExport: './board-export',
    rendererBoardSourceTeam: './board-source-team',
  });

  function resolveModule(windowRef, name) {
    if (windowRef && windowRef[name]) return windowRef[name];
    if (typeof require === 'function') {
      try { return require(LOCATIONS[name]); } catch (_error) { /* not loadable here */ }
    }
    return null;
  }

  function refusalText(result) {
    if (result && typeof result.message === 'string' && result.message) return result.message; // a team board's own sentence
    switch (result && result.reason) {
      case 'invalid': return jt('board.error.name', 'A board name is 1 to 200 characters on one line.');
      case 'not_found': return jt('board.error.gone', 'This board no longer exists.');
      case 'read_only': return jt('board.error.readOnly', 'This board cannot be changed.');
      case 'limit': return jt('board.error.limit', 'This project already has the most boards it can hold.');
      default: return jt('board.error.failed', 'That did not work. Try again.');
    }
  }

  function uniqueName(base, taken) {
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
      const candidate = `${base} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return base;
  }

  function createBoardPage(options) {
    const opts = options || {};
    const container = opts.container;
    const windowRef = opts.windowRef || (container && container.ownerDocument && container.ownerDocument.defaultView) || globalThis;
    const doc = container.ownerDocument;
    const mod = (name) => {
      const found = resolveModule(windowRef, name);
      if (!found) throw new Error(`board page: ${name} unavailable`);
      return found;
    };
    const model = mod('jennyBoardModel');
    const layoutModel = mod('jennyWorkbenchLayoutModel');
    const actionButton = mod('inventoryActionButton');
    const log = typeof opts.appendClientLog === 'function' ? opts.appendClientLog : () => {};
    const notify = (message, extra) => { if (typeof opts.showToast === 'function') opts.showToast(message, extra || {}); };
    const storage = opts.storage || (() => { try { return windowRef.localStorage; } catch (_error) { return null; } })() || { getItem: () => null, setItem: () => {} };

    const layoutStore = mod('rendererBoardLayoutStore').createLayoutStore({ storage, model: layoutModel });
    const projectTracker = mod('rendererBoardProject').createProjectTracker({
      getProjectSwitcher: opts.getProjectSwitcher,
      onChange: () => { void switchProject(); },
    });

    let disposed = false;
    let source = null;
    let unsubscribeSource = null;
    let boards = [];
    let openId = '';
    let docFor = null; // the board id the canvas was last read for
    let listToken = 0;
    let docToken = 0;
    let observer = null;
    let frame = 0;
    // stale: 'list' or 'project' changed while parked; lastSize: the size last drawn at
    let parked = false; let stale = ''; let lastSize = '';
    let project = projectTracker.get();
    let unavailable = false;
    let transfer = null; // the Export menu and the Import call (board-export.js), once the source is chosen
    let canCall = () => false; // whether the chosen source has a call (a bridge from before it does not)
    let scoped = null; // the source's scope switch (this Jenny's boards, or a team project's)
    const teamSource = () => (scoped ? scoped.team() : null);
    let teamPart = null; // the team half of the page (board-team.js), attached only with Team on
    let teamLoading = false;
    let boardEditor = null;
    const teamCall = (name, ...args) => (teamPart && typeof teamPart[name] === 'function' ? teamPart[name](...args) : undefined);

    const list = mod('rendererBoardListView').createBoardListView({
      document: doc, actionButton, startInlineTitleEdit: mod('inventoryInlineTitleEditor').startInlineTitleEdit,
      handlers: {
        onOpen: (id) => { void openBoard(id); },
        onCreate: () => { void createBoard(); },
        onRename: (id, name) => renameBoard(id, name),
        onDuplicate: (id) => { void duplicateBoard(id); },
        onDelete: (id) => { void deleteBoard(id); },
        onExport: (id, button) => { if (transfer) transfer.openMenu({ boardId: id, anchorEl: button, rootEl, onCopyToTeam: (teamCall('listState') || {}).copy === true ? () => { teamCall('copyBoard', id, button); } : null }); },
        onImport: () => { void importBoard(); },
        onProjectMenu: (anchorEl) => { teamCall('openProjectMenu', anchorEl); },
      },
    });
    const canvas = mod('rendererBoardCanvasView').createBoardCanvasView({
      document: doc, actionButton, canvasSurface: mod('inventoryCanvasSurface'), boardCard: mod('inventoryBoardCard'), connectorLayer: mod('inventoryConnectorLayer'),
    });

    // The canvas, the outline and the find box in one centre element (slice B5); filled in once the editor exists.
    const views = mod('rendererBoardViews').createBoardViews({
      document: doc, canvas, layoutStore, model, jt, actionButton, boardCard: mod('inventoryBoardCard'), getProjectId: () => project.id, onViewChange: () => scheduleRender(),
      modules: { find: mod('rendererBoardFind'), outline: mod('rendererBoardOutlineView'), keyboard: mod('rendererBoardKeyboard'), viewSwitch: mod('rendererBoardViewSwitch') },
    });

    container.textContent = '';
    const rootEl = doc.createElement('div');
    rootEl.className = 'ide-workbench board-workbench';
    rootEl.setAttribute('data-board-workbench', '');
    container.appendChild(rootEl);
    let chatDock = null;
    const bench = mod('rendererBoardPageWorkbench').createBoardPageWorkbench({
      workbenchUtils: mod('rendererIdeWorkbench'), layoutModel, store: layoutStore, rootEl, centreEl: views.element, listEl: list.element, jt,
      onLayoutChange: () => { if (chatDock) chatDock.sync(); teamCall('sync'); scheduleRender(); }, // a column change moves the canvas width: the toolbar re-measures
    });
    // The chat beside the board (slice C1): the app's one chat dock, held here while the Board is on screen.
    const attachDock = () => mod('rendererBoardChatDock').attachBoardChatDock({
      windowRef, state: opts.state, bench, chatHost: bench.chatHost, rootEl, chat: opts.chat, appendClientLog: log,
      getBoard: () => boards.find((board) => board.id === openId) || null, getProject: () => project, nameOfProject: (id) => projectTracker.nameOf(id),
      isTeam: () => Boolean(project.team),
      layout: () => scheduleRender(), focusCanvas: () => views.focus() || bench.focusCanvas(),
    });
    chatDock = attachDock();

    // The docked chat follows the open board and the project: which board a turn is stamped with, and the
    // line that says the chat belongs to another project. Never called inside the tab's show, where the
    // chat render that asked for the page moves the transcript itself.
    function syncChat() {
      if (disposed) return;
      if (chatDock) chatDock.sync();
      teamCall('sync');
    }

    // What the cards and the toolbar reach the app through (slice C5): the docked chat, and a chat opened on the Chat page.
    async function openSession(target) {
      // A team board: the conversation is shown in the chat column, beside the board.
      if (teamSource()) { if (teamCall('openConversation', String(target && target.sessionId || '')) !== true) throw new Error('no such conversation'); return; }
      const actions = opts.state && opts.state.harness && opts.state.harness.agentActions;
      if (!actions || typeof actions.openSession !== 'function') throw new Error('no chat opener');
      if (!(chatDock && chatDock.openChat() === true) && typeof actions.setActiveView === 'function') actions.setActiveView('chat'); // a personal board stays on the Board when its chat column opens
      await actions.openSession(String(target && target.sessionId || ''));
    }

    function drawList() {
      const off = jt('board.transfer.missing', 'Export and import are not available right now.');
      const team = teamSource();
      list.render({ project, boards, openId, limit: model.LIMITS.boards_per_project, unavailable, whyNot: team ? team.whyNot : null,
        teamUi: teamCall('listState') || null,
        exportReason: team ? team.whyNot('exportFile') : transfer ? transfer.exportReason() : off,
        importReason: team ? team.whyNot('importFile') : transfer ? transfer.importReason() : off });
    }

    function chooseOpen() {
      const saved = layoutStore.openBoardOf(project.id);
      const keep = boards.find((board) => board.id === openId) || boards.find((board) => board.id === saved) || boards[0];
      openId = keep ? keep.id : '';
    }

    async function loadDoc() {
      const token = ++docToken;
      docFor = openId;
      if (!openId) { canvas.show(null, { message: jt('board.canvas.none', 'Create a board to start.') }); return; }
      const wanted = openId;
      const result = await source.get({ boardId: wanted });
      if (disposed || token !== docToken) return;
      if (!result.ok) {
        if (result.reason === 'not_found') {
          // Gone since the list was read: drop it from the list and open what is next.
          boards = boards.filter((board) => board.id !== wanted);
          chooseOpen();
          layoutStore.saveOpenBoard(project.id, openId);
          drawList();
          await loadDoc();
          return;
        }
        canvas.show(null, { message: refusalText(result) });
        return;
      }
      if (result.readOnly && teamSource()) { canvas.show(null, { message: refusalText(result) }); return; }
      if (result.readOnly) {
        const newer = result.reason === 'newer_schema';
        canvas.show(null, { message: newer
          ? jt('board.canvas.newerSchema', 'This board was made by a newer version of Jenny, so it is shown as nothing and left as it is.')
          : jt('board.canvas.corrupt', 'This board file is damaged, so it is left as it is.'), actions: readOnlyActions(wanted) });
        return;
      }
      canvas.show(result.board, { canUndo: result.canUndo, canRedo: result.canRedo, readOnly: result.viewOnly === true });
    }

    // Show file and Remove from list under a read-only board's sentence; a source without the call draws it disabled.
    function readOnlyActions(boardId) {
      const off = jt('board.readOnly.unavailable', 'Not available in this version');
      const action = (call, id, label, title, onClick) => (canCall(call) ? { id, label, title, onClick } : { id, label, title: off, disabled: true });
      return [
        action('revealFile', 'reveal', jt('board.readOnly.showFile', 'Show file'), jt('board.readOnly.showFileTitle', "Open the folder that holds this board's file"),
          () => revealBoardFile(boardId)),
        action('setAside', 'set-aside', jt('board.readOnly.remove', 'Remove from list'),
          jt('board.readOnly.removeTitle', "Move this board's file aside and take it out of the list. Nothing is deleted."), () => setAsideBoard(boardId)),
      ];
    }

    async function revealBoardFile(boardId) {
      const result = await source.revealFile({ boardId });
      if (!disposed && !result.ok) notify(jt('board.readOnly.showFileFailed', 'The file of this board could not be shown.'), { tone: 'warning' });
    }

    // The board leaves the list here at once (its change event may come later) and the next one opens; focus moves off the
    // button that is gone, to the next board's canvas or, with none left, to New board.
    async function setAsideBoard(boardId) {
      const result = await source.setAside({ boardId });
      if (disposed) return;
      if (!result.ok) { notify(jt('board.readOnly.removeFailed', 'This board could not be taken out of the list.'), { tone: 'warning' }); return; }
      notify(jt('board.readOnly.moved', "Moved aside as {name}. The file is still in Jenny's boards folder.", { name: String(result.movedTo || '') }));
      boards = boards.filter((board) => board.id !== boardId);
      chooseOpen();
      layoutStore.saveOpenBoard(project.id, openId);
      drawList();
      await loadDoc();
      if (disposed) return;
      syncChat();
      const newBoard = list.element.querySelector('[data-board-action="new"]');
      if (openId) { if (!views.focus()) bench.focusCanvas(); } else if (newBoard) newBoard.focus({ preventScroll: true });
    }

    // Re-reads the project's boards. The open board's document is read again only when the open board
    // changed (or `doc` asks for it), so a rename or a new board does not repaint the canvas.
    async function loadList({ answer, doc } = {}) {
      const token = ++listToken;
      const result = answer || await source.list({ projectId: project.id });
      if (disposed || token !== listToken) return;
      boards = result.ok ? result.boards.slice() : [];
      chooseOpen();
      layoutStore.saveOpenBoard(project.id, openId);
      drawList();
      // Compared with the board last read for the canvas, not with the open id before this list: over the real
      // bridge a `created` event arrives before the answer to `create`, and its list read is dropped.
      if (doc === true || docFor !== openId) await loadDoc();
      views.sync(); // the view this project was left in
      syncChat();
    }

    async function openBoard(id) {
      if (!source || !id || id === openId || !boards.some((board) => board.id === id)) return;
      openId = id;
      layoutStore.saveOpenBoard(project.id, openId);
      drawList();
      await loadDoc();
      syncChat();
    }

    async function createBoard() {
      if (!source) return;
      const taken = new Set(boards.map((board) => board.name));
      const result = await source.create({ projectId: project.id, name: uniqueName(jt('board.new.defaultName', 'New board'), taken) });
      if (disposed) return;
      if (!result.ok) { notify(refusalText(result), { tone: 'warning' }); return; }
      openId = result.board.id;
      layoutStore.saveOpenBoard(project.id, openId);
      await loadList({});
      // Like a new file, the new board opens with its name field ready to type over.
      if (!disposed) list.beginRename(result.board.id);
    }

    async function duplicateBoard(id) {
      const from = boards.find((board) => board.id === id);
      if (!source || !from) return;
      const taken = new Set(boards.map((board) => board.name));
      const name = uniqueName(jt('board.copy.name', '{name} copy', { name: from.name }), taken).slice(0, NAME_MAX);
      const result = await source.duplicate({ boardId: id, name });
      if (disposed) return;
      if (!result.ok) { notify(refusalText(result), { tone: 'warning' }); return; }
      openId = result.board.id;
      layoutStore.saveOpenBoard(project.id, openId);
      await loadList();
    }

    async function importBoard() {
      if (!source || !transfer) return;
      const id = await transfer.importBoard(project.id);
      if (disposed || !id) return;
      openId = id;
      layoutStore.saveOpenBoard(project.id, openId);
      await loadList();
    }

    async function renameBoard(id, name) {
      if (!source) return { ok: false, message: refusalText({}) };
      const result = await source.rename({ boardId: id, name });
      if (disposed) return { ok: true };
      if (!result.ok) return { ok: false, message: refusalText(result) };
      await loadList();
      return { ok: true };
    }

    async function deleteBoard(id) {
      if (!source) return;
      const wasOpen = id === openId; // read before the call: the change event can move the open board first
      const result = await source.delete({ boardId: id });
      if (disposed) return;
      if (!result.ok) { notify(refusalText(result), { tone: 'warning' }); return; }
      await loadList();
      notify(jt('board.toast.deleted', 'Board deleted.'), {
        durationMs: UNDO_TOAST_MS,
        actions: [{
          id: 'board-undo-delete', kind: 'primary', label: jt('board.toast.undo', 'Undo'),
          onClick: () => { void restoreBoard(id, wasOpen); },
        }],
      });
    }

    async function restoreBoard(id, reopen) {
      const result = await source.restore({ boardId: id });
      if (disposed) return;
      if (!result.ok) { notify(refusalText(result), { tone: 'warning' }); return; }
      if (reopen) { openId = id; layoutStore.saveOpenBoard(project.id, openId); }
      await loadList();
    }

    function onSourceEvent(event, editor) {
      if (disposed || !event || event.kind === 'proposals') return; // the changes view reads those itself
      if (event.kind !== 'moved' && event.projectId !== project.id) return;
      if (parked) { stale = stale || 'list'; return; } // a hidden page does no reads; resume reads once
      // A team batch the host turned down after this page drew it: the board is read again, and the person is told.
      if (event.kind === 'refused') {
        if (event.boardId === openId) { notify(refusalText(event), { tone: 'warning' }); void loadDoc(); }
        return;
      }
      // An applied batch changes one board's drawing, never the list. A batch the editor sent itself is not read
      // again: its answer already carries the board.
      if (event.kind === 'applied') {
        if (event.boardId === openId && !(event.applied && editor.sentBatch(event.applied.batch_id))) void loadDoc();
        return;
      }
      void loadList();
    }

    // The source follows the project: a team project's boards come from the team's host (board-source-team.js, on the
    // window only with Team on), everything else from this Jenny. A team project that cannot be shown is not kept.
    function setScope() {
      const team = project.team;
      const now = teamSource();
      if (team && now && now.scope.teamId === team.id && now.scope.projectId === project.id) return;
      const built = team ? resolveModule(windowRef, 'rendererBoardSourceTeam') : null;
      const bridge = windowRef.jennyShell && windowRef.jennyShell.team;
      if (team && (!built || !bridge)) {
        log('WARN', 'board.team_source_unavailable', {});
        scoped.setTeam(null);
        projectTracker.pick(null);
        project = projectTracker.get();
        return;
      }
      scoped.setTeam(team ? built.createTeamBoardSource({ bridge, teamId: team.id, projectId: project.id, role: project.role,
        words: windowRef.rendererSettingsTeamStrings || null, jt }) : null);
    }

    // Row 151 slice T7: the team half of the Board (board-team.js: the project menu's team rows, the team conversation in
    // the chat column, who else is on the board). The gate is on the window only with the `team` flag on, so with Team
    // off nothing here loads or runs. A load that failed is tried again the next time the tab is shown.
    async function attachTeam() {
      const gate = windowRef.rendererTeamTabGate;
      const lists = windowRef.rendererSettingsScriptManifest;
      if (teamPart || teamLoading || disposed || !scoped || !gate || typeof gate.ensureTeamAssets !== 'function' || !lists || !Array.isArray(lists.teamBoard)) return;
      teamLoading = true;
      const ok = await Promise.resolve().then(() => gate.ensureTeamAssets({ windowRef, scripts: lists.teamBoard, styles: ['styles/board-team.css'] })).catch(() => false);
      teamLoading = false;
      const part = ok === true ? windowRef.rendererBoardTeam : null;
      if (disposed || parked || teamPart || !part || typeof part.attachBoardTeam !== 'function') return; // parked meanwhile: resume attaches
      const made = part.attachBoardTeam({
        windowRef, document: doc, jt, notify, gate, lists,
        rootEl, listEl: list.element, canvas, chatHost: bench.chatHost,
        chat: { isOpen: () => bench.isChatOpen(), setOpen: (open) => bench.setChatOpen(open) },
        editor: boardEditor, own: scoped.own(), getProject: () => project, getTeamSource: teamSource,
        getBoards: () => boards.slice(), getOpenBoardId: () => openId, openBoard,
        pickProject: (next) => projectTracker.pick(next), getProjectSwitcher: opts.getProjectSwitcher,
        reload: () => loadList({ doc: true }), redraw: () => { if (!disposed) { drawList(); scheduleRender(); } },
      });
      teamPart = made && typeof made.sync === 'function' ? made : null;
      if (teamPart) { drawList(); syncChat(); }
    }

    async function switchProject() {
      if (disposed) return;
      if (parked) { stale = 'project'; return; }
      project = projectTracker.get();
      if (!source) return; // start() reads the project again once the source is chosen
      setScope();
      boards = [];
      openId = '';
      drawList();
      await loadList({ doc: true });
    }

    function scheduleRender() {
      if (disposed || frame) return;
      if (parked) return; // resume() renders
      const run = () => { frame = 0; if (disposed || parked) return; bench.render(); canvas.resized(); lastSize = sizeKey(); };
      frame = typeof windowRef.requestAnimationFrame === 'function' ? windowRef.requestAnimationFrame(run) : windowRef.setTimeout(run, 16);
    }
    const sizeKey = () => `${rootEl.clientWidth}x${rootEl.clientHeight}`; const onResize = () => { if (!parked && sizeKey() !== lastSize) scheduleRender(); };

    async function start() {
      bench.render();
      drawList();
      project = await projectTracker.start();
      if (disposed) return;
      syncChat(); // a page that loaded after the chat's last render docks the chat now
      const bridge = windowRef.jennyShell && windowRef.jennyShell.boards;
      const picked = await mod('rendererBoardSourceBridge').chooseBoardSource({
        bridge,
        projectId: project.id,
        createMemory: opts.allowMemorySource !== true ? null : () => {
          if (!memorySources.has(windowRef)) memorySources.set(windowRef, mod('rendererBoardSourceMemory').createMemoryBoardSource({ model }));
          return memorySources.get(windowRef);
        },
      });
      if (disposed) return;
      if (!picked.source) {
        // No store answered: nothing is offered, rather than boards that would be gone after a restart.
        unavailable = true;
        drawList();
        canvas.show(null, { message: jt('board.canvas.unavailable', 'Boards are not available right now.') });
        log('WARN', 'board.source_unavailable', {});
        return;
      }
      scoped = mod('rendererBoardSourceBridge').createScopedBoardSource(picked.source);
      source = scoped.source;
      const ownCall = (name) => (picked.kind === 'bridge' ? typeof bridge[name] === 'function' : typeof picked.source[name] === 'function');
      canCall = (name) => (teamSource() ? teamSource().can(name) : ownCall(name));
      const exporter = resolveModule(windowRef, 'rendererBoardExport');
      transfer = exporter && exporter.createBoardTransferActions({ windowRef, source, notify, onChange: () => drawList(),
        available: (name) => canCall(name) });
      // Row 150 slice B6: the canvas edits through one editor, built here because it needs the source; the canvas owns it from now on.
      const editor = mod('rendererBoardEditor').createBoardEditor({ model, source, notify, log, jt });
      boardEditor = editor;
      canvas.setEditor(editor, {
        source, notify, log, context: { state: opts.state, getProjectId: () => project.id, getProject: () => project, getTeamSource: teamSource,
          nameOfMember: (id) => String(teamCall('nameOf', id) || ''), isSelfMember: (id) => teamCall('isSelf', id) === true,
          openChat: () => (teamSource() ? teamCall('openChat') === true : chatDock ? chatDock.openChat() : false), openSession,
          teamChats: () => (teamSource() ? teamCall('chats') || [] : null),
          getChangesHost: () => bench.changesHost, revealChanges: () => bench.revealChanges() },
        modules: { interactions: mod('rendererBoardCanvasInteractions'), toolbar: mod('rendererBoardCanvasToolbar'), cardEditing: mod('rendererBoardCardEditing'), cardKinds: mod('rendererBoardCardKinds') },
      });
      views.setEditor(editor);
      unsubscribeSource = source.onChanged((event) => onSourceEvent(event, editor));
      if (typeof windowRef.ResizeObserver === 'function') {
        observer = new windowRef.ResizeObserver(onResize);
        if (!parked) observer.observe(rootEl); // parked before the source was chosen: resume() starts it
      }
      project = projectTracker.get();
      setScope();
      // The bridge's first answer is reused when it was for this project.
      const answer = !project.team && picked.first && picked.first.ok && project.id === picked.projectId ? picked.first : undefined;
      await loadList({ answer, doc: true });
      scheduleRender();
      void attachTeam();
    }

    const started = start().catch((error) => { log('WARN', 'board.page_start_failed', { message: String(error && error.message || error).slice(0, 200) }); });

    function dispose() {
      if (disposed) return;
      disposed = true;
      projectTracker.stop();
      if (typeof unsubscribeSource === 'function') unsubscribeSource();
      unsubscribeSource = null;
      if (observer) observer.disconnect();
      observer = null;
      if (frame) {
        if (typeof windowRef.cancelAnimationFrame === 'function') windowRef.cancelAnimationFrame(frame);
        else windowRef.clearTimeout(frame);
      }
      frame = 0;
      try { teamCall('dispose'); } catch (_error) { /* the page leaves either way */ }
      teamPart = null;
      if (scoped) scoped.setTeam(null); // a team board held open on this Jenny is closed
      chatDock.detach(); // before the container is cleared: the dock element leaves with what it holds
      bench.dispose();
      list.dispose();
      views.dispose(); // before the canvas, which disposes the editor the views follow
      canvas.dispose();
      container.textContent = '';
    }

    // Parked: built, no reads or renders; dock back, team half let go. A team project's page is disposed (its viewing lease).
    function park() {
      if (disposed || parked) return;
      if (teamSource()) { dispose(); return; }
      parked = true; canvas.setShown(false);
      if (observer) observer.disconnect();
      chatDock.detach();
      try { teamCall('dispose'); } catch (_error) { /* the page parks either way */ } teamPart = null;
    }
    const checkProject = () => { projectTracker.check(); if (!teamPart && !teamLoading) void attachTeam(); };
    function resume() {
      if (disposed || !parked) return;
      parked = false; chatDock = attachDock(); canvas.setShown(true);
      if (observer) observer.observe(rootEl);
      checkProject(); // a project switch while away is noticed here, and the team half attached again
      const was = stale; stale = ''; if (was === 'project') void switchProject(); else if (was) void loadList({ doc: true });
      scheduleRender(); // always once: a load that landed while parked may still owe its fit
      void Promise.resolve().then(() => { if (!parked) syncChat(); }); // not inside the show: the chat render that asked for it moves the transcript
    }

    return { dispose, park, resume, isParked: () => parked, started, container, isDisposed: () => disposed, checkProject, getProjectId: () => project.id, getOpenBoardId: () => openId, openBoard, getView: () => views.getView(), revealChanges: () => bench.revealChanges(), toggleBoardsList: () => !parked && bench.toggle('boards'), toggleChat: () => !parked && bench.toggle('chat'),
      getProject: () => project, getTeamSource: teamSource, pickProject: (next) => projectTracker.pick(next), reload: () => (source ? loadList({ doc: true }) : Promise.resolve()) };
  }

  /** The tab's show: idempotent for the same container while the page is up. */
  function showBoardPage(options) {
    if (active && !active.isDisposed() && active.container === options.container) { if (active.isParked()) active.resume(); else active.checkProject(); return active; }
    hideBoardPage();
    active = createBoardPage(options);
    return active;
  }

  function hideBoardPage() {
    if (!active) return;
    const page = active;
    active = null;
    page.dispose();
  }

  /** Leaves the Board with the page kept built and idle; the next showBoardPage resumes it. */
  function parkBoardPage() { if (active) { active.park(); if (active.isDisposed()) active = null; } }

  /** Opens a board on the page, up or parked (the palette and pin menu call this before the tab moves). */
  function openBoardOnPage(id) {
    return active && !active.isDisposed() ? active.openBoard(id) : Promise.resolve();
  }

  /** Shows the Changes view of the page that is up (the chat row's Review); false when no page is. */
  function revealChangesOnPage() {
    return active && !active.isDisposed() && !active.isParked() ? active.revealChanges() : false;
  }

  const toggleOnPage = (name) => () => (active && !active.isDisposed() && !active.isParked() ? active[name]() : false); // the shell's panel toggles

  return { showBoardPage, hideBoardPage, parkBoardPage, createBoardPage, openBoard: openBoardOnPage, revealChanges: revealChangesOnPage, toggleBoardsList: toggleOnPage('toggleBoardsList'), toggleChat: toggleOnPage('toggleChat') };
});
