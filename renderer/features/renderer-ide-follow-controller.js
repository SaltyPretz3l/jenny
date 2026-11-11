/* renderer/features/renderer-ide-follow-controller.js - Follow Jenny in the Workspace editor: the draft tab of a file Jenny is writing, the line above it, and the switch (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.rendererIdeFollowController = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (globalRef) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || ((k, d, p) => p ? d.replace(/\{(\w+)\}/g, (m, n) => String(p[n] ?? m)) : d);

  /* While the model writes a write_file / edit_file call, the follow store (renderer/chat/
     renderer-follow-store.js) holds one record per call. This controller shows such a call
     as a read-only draft tab: the text arrives in it, a new file from the top, a change in
     place with the replaced lines kept above the new ones. A draft is never a file: it has
     a diff:// tab id, so it is never saved, restored, searched or reopened. When the tool
     has written the file, the draft gives way to the real file.

     It takes the editor only when that is safe (Workspace is showing its editor, the user
     is not typing, no switching loop); otherwise the draft opens as a background tab and
     never jumps in later. A click on the tab or on the chat's Watch link always shows it.
     It never moves keyboard focus. */

  const DRAFT_PREFIX = 'diff://live/';
  const MAX_ENDED_DRAFTS = 2;
  const ENDED_PHASES = new Set(['stopped', 'denied', 'failed']);
  const SCROLL_IMMEDIATE = 1; // monaco.editor.ScrollType.Immediate
  const noop = () => {};

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* script mode */ }
    }
    return null;
  }

  function formatSize(count) {
    const size = Number(count) > 0 ? Number(count) : 0;
    if (size >= 1024 * 1024) return jt('ide.follow.sizeMb', '{count} MB', { count: (size / (1024 * 1024)).toFixed(1) });
    if (size >= 1024) return jt('ide.follow.sizeKb', '{count} KB', { count: Math.round(size / 1024) });
    return jt('ide.follow.sizeB', '{count} B', { count: Math.floor(size) });
  }

  // What the line above the editor says: a too-large file reads differently only while it arrives.
  function stripKind(call) {
    return call.tooLarge === true && call.phase === 'arriving' ? 'tooLarge' : call.phase;
  }

  function stripCopy(call) {
    switch (stripKind(call)) {
      case 'arriving':
        return { dot: 'active', stop: true, text: call.mode === 'edit' ? jt('ide.follow.changing', 'Jenny is changing this file') : jt('ide.follow.writing', 'Jenny is writing this file') };
      case 'tooLarge':
        return { dot: 'active', text: jt('ide.follow.tooLarge', 'This file is too large to show while it is written.'), stop: true };
      case 'waiting':
        return { dot: 'pending', text: jt('ide.follow.waiting', 'Draft finished. It is saved only if you allow it in the chat.') };
      case 'denied':
        return { dot: 'muted', text: jt('ide.follow.denied', 'Denied. Nothing was saved.'), close: true };
      case 'failed':
        return { dot: 'muted', text: jt('ide.follow.failed', 'This change did not apply. Nothing was saved.'), close: true };
      default:
        return { dot: 'muted', text: jt('ide.follow.stopped', 'Stopped. Nothing was saved.'), close: true };
    }
  }

  function stripMeta(call, textLength) {
    const kind = stripKind(call);
    if (kind === 'tooLarge') return jt('ide.follow.metaSoFar', '{size} so far', { size: formatSize(call.bytes) });
    if (kind !== 'arriving') return '';
    return call.mode === 'edit'
      ? jt('ide.follow.metaNotSaved', 'not saved')
      : jt('ide.follow.metaWriting', '{size} · not saved', { size: formatSize(textLength) });
  }

  function lineRange(first, last) {
    return { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: 1 };
  }

  function buildDecorations(view) {
    const out = [];
    const mark = (first, count, className, linesDecorationsClassName) => {
      if (count > 0) out.push({ range: lineRange(first, first + count - 1), options: { isWholeLine: true, className, linesDecorationsClassName } });
    };
    for (const region of view.regions || []) {
      mark(region.removedStart, region.removedCount, 'ide-follow-line--removed', 'ide-follow-sign--removed');
      mark(region.addedStart, region.addedCount, 'ide-follow-line--added', 'ide-follow-sign--added');
    }
    if (view.caret) {
      const { line, column } = view.caret;
      out.push({
        range: { startLineNumber: line, startColumn: column, endLineNumber: line, endColumn: column },
        options: { afterContentClassName: 'ide-follow-caret' },
      });
    }
    return out;
  }

  function decorationKey(view) {
    const caret = view.caret ? `${view.caret.line}:${view.caret.column}` : '';
    return `${caret}|${(view.regions || []).map((r) => `${r.removedStart},${r.removedCount},${r.addedStart},${r.addedCount}`).join(';')}`;
  }

  function createIdeFollowController(deps) {
    const d = deps || {};
    const {
      getIde, ideStateUtils, editorHost, getDom,
      escapeHtml = (value) => String(value),
      windowRef = globalRef,
      getActiveView = () => '',
      getFeatureFlags = () => ({}),
      getWorkspaceRootContext = () => null,
      getFileOperations = () => null,
      getWorkspaceFsApi = () => null,
      getPresentation = () => null,
      activateTab = noop,
      closeTab = noop,
      openFile = noop,
      renderTabs = noop,
      schedulePersist = noop,
      appendClientLog = noop,
    } = d;
    const getHub = typeof d.getHub === 'function' ? d.getHub : () => windowRef.rendererFollowJennyHub || globalRef.rendererFollowJennyHub || null;
    const draftModel = d.draftModel || resolveModule('rendererIdeFollowDraftModel', './renderer-ide-follow-draft-model') || {};
    const pathResolve = d.pathResolve || resolveModule('jennyWorkspacePathResolve', '../shared/workspace-path-resolve') || {};
    const actionButton = d.actionButton || resolveModule('inventoryActionButton', '../inventory/action-button');

    const entries = new Map(); // callId -> entry
    const byTabId = new Map(); // draft tab id -> entry, while its tab is open
    let subscribedTo = null;
    let unsubscribe = null;
    let strip = null;
    let stripKey = '';
    let disposed = false;

    const flagOn = () => (getFeatureFlags() || {}).follow_jenny === true;
    const store = () => getHub()?.store || null;
    const tabOf = (entry) => ideStateUtils.getTab?.(getIde(), entry.id) || null;
    const isCurrent = (entry) => !disposed && entries.get(entry.callId) === entry && entry.state !== 'dismissed';

    // ---- the switch ----

    // null when the feature is off (no switch is shown); otherwise whether Follow Jenny is on.
    function getSwitch() {
      return flagOn() ? getIde().followJenny !== false : null;
    }

    function toggleSwitch() {
      if (!flagOn()) return false;
      const ide = getIde();
      ide.followJenny = ide.followJenny === false;
      schedulePersist();
      store()?.refreshEnabled?.(); // off: every followed call is released, so drafts and the chat tail go
      renderTabs();
      return ide.followJenny;
    }

    function registerCommands(registry) {
      return registry?.register?.({
        id: 'ide:toggle-follow-jenny',
        label: jt('ide.follow.toggleCommand', 'Toggle Follow Jenny'),
        group: 'Workspace',
        description: jt('ide.follow.switchTitle', 'Open the file Jenny is writing and show it arriving'),
        when: (ctx) => ctx.activeView === 'ide' && flagOn(),
        run: () => toggleSwitch(),
      }) || noop;
    }

    // ---- taking the editor ----

    const onEditorStage = () => (getIde().activeStageSurface || 'editor') === 'editor';

    function canTake() {
      return getActiveView() === 'ide' && onEditorStage() && getPresentation()?.canTakeEditor?.() === true;
    }

    // Shows the draft in the editor. Keyboard focus stays where it is.
    function take(entry, asked) {
      if (!asked) getPresentation()?.noteTaken?.();
      entry.caretLine = 0;
      activateTab(entry.id);
    }

    // ---- the draft's text ----

    function resolveTarget(call) {
      if (!call.pathDone || !call.path) return '';
      const root = getWorkspaceRootContext()?.path;
      const resolved = root && pathResolve.resolveWorkspacePath?.(call.path, { workspaceRoot: root });
      return resolved && resolved.kind === 'relative' && !resolved.isDir && resolved.relPath ? resolved.relPath : '';
    }

    async function readBase(path) {
      try {
        const operations = getFileOperations();
        const result = await (operations ? operations.readForMutation(path) : getWorkspaceFsApi().readFile({ path }));
        return typeof result?.content === 'string' ? result.content : '';
      } catch (_error) {
        return ''; // a file that is not there yet: every edit shows as unplaced new text
      }
    }

    function computeView(entry) {
      const call = entry.call;
      const arriving = call.phase === 'arriving' && call.tooLarge !== true;
      if (call.mode === 'edit' && entry.editDraft) {
        const view = entry.editDraft.update(call.edits);
        return arriving ? view : { ...view, caret: null };
      }
      return draftModel.buildWriteView(call.content, call.contentDone === true || !arriving);
    }

    function visibleLine(editor, line) {
      const ranges = editor.getVisibleRanges?.() || [];
      return ranges.some((range) => line >= range.startLineNumber && line <= range.endLineNumber);
    }

    // The reader's own wheel, key or pointer press in the editor. Only that can stop the follow: a glide
    // of ours that is still catching up leaves the last line off screen too, and used to end it for good.
    const watchedNodes = new WeakSet();
    function watchUserScroll(editor) {
      const node = editor.getDomNode?.();
      if (!node || watchedNodes.has(node) || typeof node.addEventListener !== 'function') return;
      watchedNodes.add(node);
      const mark = () => { const entry = byTabId.get(String(getIde().activeTabPath || '')); if (entry) entry.userMoved = true; };
      for (const type of ['wheel', 'pointerdown', 'keydown']) node.addEventListener(type, mark, { passive: true });
    }

    // Keeps the arrival line in view until the user scrolls away from it.
    function followCaret(entry) {
      const caret = entry.view?.caret;
      if (!caret) return;
      const editor = editorHost.editorFor?.(entry.id);
      // Nothing is remembered while no editor shows the draft (a background tab, or the editor still
      // mounting after Watch in Workspace): the first sight of it must jump to the arrival line.
      if (!editor) return;
      watchUserScroll(editor);
      const previous = entry.caretLine;
      entry.caretLine = caret.line;
      if (!previous) {
        entry.userMoved = false;
        editor.revealLineInCenterIfOutsideViewport?.(caret.line, SCROLL_IMMEDIATE);
        return;
      }
      if (previous === caret.line || (entry.userMoved && !visibleLine(editor, previous))) return;
      entry.userMoved = false; // back at the arrival line, or never left it
      // No scroll type: the editor glides to the new line (its smooth scrolling) instead of stepping.
      editor.revealLine?.(caret.line);
    }

    // The path came after the text: the unnamed draft takes its name and language, or closes
    // when the file is outside the open folder.
    function adoptPath(entry) {
      const relPath = resolveTarget(entry.call);
      const tab = tabOf(entry);
      if (!relPath || !tab) return closeDraft(entry);
      entry.relPath = relPath;
      tab.filePath = relPath;
      tab.label = ideStateUtils.fileNameOf(relPath);
      Promise.resolve(editorHost.openDraftDocument({ id: entry.id, languagePath: relPath })).catch(noop);
      return renderTabs();
    }

    function apply(entry) {
      if (!entry.relPath && entry.call.pathDone) adoptPath(entry);
      if (entry.state !== 'open') return;
      const view = computeView(entry);
      entry.view = view;
      if (view.text !== entry.text) {
        editorHost.writeDraftDocument(entry.id, view.text, draftModel.spliceBetween?.(entry.text, view.text) || null);
        entry.text = view.text;
      }
      const key = decorationKey(view);
      if (key !== entry.decorationKey) {
        entry.decorationKey = key;
        editorHost.setFollowDecorations?.(entry.id, buildDecorations(view));
      }
      followCaret(entry);
      const tab = tabOf(entry);
      const live = entry.call.phase === 'arriving';
      if (tab && tab.live !== live) {
        tab.live = live;
        renderTabs(); // ends in sync()
      } else {
        syncStrip();
      }
    }

    // ---- opening and closing ----

    function dismiss(entry) {
      entry.state = 'dismissed';
      byTabId.delete(entry.id);
      entry.view = null;
      entry.editDraft = null;
      entry.text = '';
    }

    function closeDraft(entry) {
      const open = Boolean(tabOf(entry));
      dismiss(entry);
      if (open) closeTab(entry.id);
      else syncStrip();
    }

    // At most two ended drafts stay open: the oldest that is not showing goes first.
    function capEnded() {
      const ended = [...byTabId.values()].filter((entry) => ENDED_PHASES.has(entry.call.phase));
      const active = getIde().activeTabPath;
      while (ended.length > MAX_ENDED_DRAFTS) {
        const at = ended.findIndex((entry) => entry.id !== active);
        if (at === -1) return;
        closeDraft(ended.splice(at, 1)[0]);
      }
    }

    // The tool wrote the file: the draft is done. Where it was showing, the real file takes its place.
    function settle(entry) {
      const phase = entry.call.phase;
      if (phase === 'written') {
        if (getIde().activeTabPath !== entry.id || !tabOf(entry) || !entry.relPath) {
          closeDraft(entry);
          return;
        }
        const finish = () => closeDraft(entry);
        entry.state = 'closing';
        Promise.resolve().then(() => openFile(entry.relPath, { preview: true })).then(finish, finish);
      } else if (ENDED_PHASES.has(phase)) {
        capEnded();
      }
    }

    async function open(entry) {
      const { call, id, relPath } = entry;
      if (call.mode === 'edit') {
        const base = await readBase(relPath);
        if (!isCurrent(entry)) return;
        entry.editDraft = draftModel.createEditDraft(base);
      }
      entry.view = computeView(entry);
      entry.text = entry.view.text;
      const doc = await editorHost.openDraftDocument({
        id,
        languagePath: relPath,
        text: entry.text,
        lineNumbers: call.mode === 'edit' ? (line) => draftModel.describeLine(entry.view, line).label : null,
      });
      if (!doc) { // the editor went away, or the id is taken by a real document
        if (isCurrent(entry)) dismiss(entry);
        return;
      }
      if (!isCurrent(entry)) {
        editorHost.closeDocument?.(id);
        return;
      }
      const ide = getIde();
      const before = ide.activeTabPath || '';
      ideStateUtils.openDiffTab(ide, { id, label: relPath ? ideStateUtils.fileNameOf(relPath) : jt('ide.tree.newFile', 'New File') });
      const tab = ideStateUtils.getTab(ide, id);
      if (!tab) { // the tab limit: nothing to show
        editorHost.closeDocument?.(id);
        dismiss(entry);
        return;
      }
      tab.draft = true;
      tab.filePath = relPath;
      tab.live = call.phase === 'arriving';
      ide.activeTabPath = before; // a background tab until it takes the editor
      entry.state = 'open';
      byTabId.set(id, entry);
      const asked = entry.asked === true;
      entry.asked = false;
      // With no tab open there is nothing to take the editor from; another stage is never interrupted.
      if (asked || canTake() || (!before && onEditorStage())) take(entry, asked);
      else renderTabs();
      apply(entry); // the call moved on while this waited
      if (entry.state === 'open') settle(entry);
    }

    function begin(call, relPath, asked) {
      const entry = {
        callId: call.callId, call, id: `${DRAFT_PREFIX}${encodeURIComponent(call.callId)}`, relPath,
        state: 'opening', asked, view: null, text: '', editDraft: null, caretLine: 0, decorationKey: '',
      };
      entries.set(call.callId, entry);
      open(entry).catch((error) => {
        appendClientLog('WARN', 'ide.follow.open_failed', { message: String(error?.message || error || '') });
        if (entries.get(call.callId) === entry) dismiss(entry);
      });
    }

    // A call with no draft yet: decide once whether it gets one.
    function consider(call, asked) {
      const skip = () => entries.set(call.callId, { callId: call.callId, call, id: '', state: 'dismissed' });
      if (ENDED_PHASES.has(call.phase)) return;
      if (!call.pathDone) { // the path is still arriving
        // A model may send a new file's text before its path: the draft opens unnamed.
        if (call.mode === 'write' && call.contentStarted && call.phase === 'arriving'
          && getWorkspaceRootContext()?.path) begin(call, '', asked);
        return;
      }
      const relPath = resolveTarget(call);
      if (!relPath) { // outside the open folder: followed in the chat only
        skip();
        return;
      }
      if (call.phase === 'written') {
        // An engine that sends no argument stream, in Auto mode: show the file it just wrote.
        skip();
        if (call.source === 'whole' && canTake()) {
          getPresentation()?.noteTaken?.();
          openFile(relPath, { preview: true });
        }
        return;
      }
      // Without an argument stream the text exists only once approval is asked, and only when
      // the approval is small enough to carry it.
      if (call.source === 'whole' && (call.phase !== 'waiting' || call.tooLarge === true)) return;
      begin(call, relPath, asked);
    }

    function onCall(call, asked) {
      if (disposed || !call || !flagOn() || getIde().followJenny === false) return;
      let entry = entries.get(call.callId);
      if (entry && entry.state === 'dismissed' && asked && entry.id && call.phase === 'arriving') {
        entries.delete(call.callId); // closed by the user, asked for again
        entry = null;
      }
      if (!entry) {
        consider(call, asked);
        return;
      }
      entry.call = call;
      if (entry.state === 'opening') {
        entry.asked = entry.asked || asked;
        return;
      }
      if (entry.state !== 'open') return;
      if (!tabOf(entry)) { // the user closed the tab: it does not come back by itself
        dismiss(entry);
        syncStrip();
        return;
      }
      apply(entry);
      if (entry.state !== 'open') return;
      if (asked) take(entry, true);
      settle(entry);
    }

    function onStoreEvent(event) {
      if (disposed || !event || !event.call) return;
      const call = event.call;
      if (event.type === 'removed') {
        const entry = entries.get(call.callId);
        entries.delete(call.callId);
        if (entry && entry.id) closeDraft(entry);
        return;
      }
      const asked = event.type === 'reveal';
      if (asked) store()?.takePendingReveal?.();
      onCall(call, asked);
    }

    // The chat side is built at startup and this controller on demand; a rebuilt chat shell
    // brings a new hub, so each sync re-checks which one this listens to.
    function ensureSubscribed() {
      const current = store();
      if (disposed || current === subscribedTo) return;
      unsubscribe?.();
      unsubscribe = null;
      subscribedTo = current;
      if (typeof current?.subscribe !== 'function') return;
      unsubscribe = current.subscribe(onStoreEvent);
      const asked = current.takePendingReveal?.() || '';
      for (const call of current.listCalls?.() || []) onCall(call, call.callId === asked);
    }

    // ---- the line above the editor ----

    function onStripClick(event) {
      const button = event.target?.closest?.('[data-ide-follow-action]');
      const entry = byTabId.get(getIde().activeTabPath);
      if (!button || !entry) return;
      if (button.getAttribute('data-ide-follow-action') === 'stop') getHub()?.stop?.(entry.call.sessionId);
      else closeDraft(entry);
    }

    function ensureStrip() {
      const stage = getDom().ideEditorStage;
      if (!stage || !stage.parentNode) return null;
      if (strip && strip.parentNode === stage.parentNode) return strip;
      strip = stage.ownerDocument.createElement('div');
      strip.className = 'ide-follow-strip hidden';
      strip.addEventListener('click', onStripClick);
      stage.parentNode.insertBefore(strip, stage);
      stripKey = '';
      return strip;
    }

    function stripMarkup(copy) {
      const button = (action, label, title) => actionButton?.({
        plain: true, className: 'ide-follow-strip-action', label, title, dataset: { 'ide-follow-action': action },
      }) || '';
      const actions = (copy.stop ? button('stop', jt('ide.follow.stop', 'Stop'), jt('ide.follow.stopTitle', 'Stop this reply')) : '')
        + (copy.close ? button('close', jt('ide.follow.closeDraft', 'Close draft'), jt('ide.follow.closeDraftTitle', 'Close this draft')) : '');
      return `<span class="status-dot status-dot--${copy.dot}" aria-hidden="true"></span>`
        + `<span class="ide-follow-strip-text" role="status">${escapeHtml(copy.text)}</span>`
        + '<span class="ide-follow-strip-meta"></span>'
        + (actions ? `<span class="ide-follow-strip-actions">${actions}</span>` : '');
    }

    // One line for the draft that is showing; rebuilt only when what it says changes, so its
    // buttons stay clickable while the size counts up.
    function syncStrip() {
      const entry = onEditorStage() ? byTabId.get(getIde().activeTabPath) : null;
      if (!entry || entry.state === 'dismissed') {
        if (strip) strip.classList.add('hidden');
        return;
      }
      const node = ensureStrip();
      if (!node) return;
      const key = `${entry.callId}|${stripKind(entry.call)}|${entry.call.mode}`;
      if (key !== stripKey) {
        stripKey = key;
        node.innerHTML = stripMarkup(stripCopy(entry.call));
      }
      const meta = node.querySelector('.ide-follow-strip-meta');
      const metaText = stripMeta(entry.call, entry.text.length);
      if (meta && meta.textContent !== metaText) meta.textContent = metaText;
      node.classList.remove('hidden');
    }

    // Called after every tab render: a draft tab the user closed is forgotten, the line follows the active tab.
    function sync() {
      if (disposed) return;
      ensureSubscribed();
      for (const entry of [...byTabId.values()]) {
        if (entry.state === 'open' && !tabOf(entry)) dismiss(entry);
      }
      syncStrip();
    }

    // A draft that became the visible document starts from its arrival line.
    function onActiveFileChanged(event) {
      const entry = byTabId.get(String(event?.detail?.path || ''));
      if (!entry || disposed) return;
      entry.caretLine = 0;
      followCaret(entry);
    }

    // ---- lifecycle ----

    // Drafts belong to the folder they were opened in.
    function closeAll() {
      for (const entry of [...byTabId.values()]) closeDraft(entry);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      unsubscribe = null;
      windowRef.removeEventListener?.('ide:active-file-changed', onActiveFileChanged);
      // State only: the editor is going away with this controller.
      const ide = getIde();
      for (const entry of byTabId.values()) {
        if (tabOf(entry)) ideStateUtils.closeTab?.(ide, entry.id);
      }
      byTabId.clear();
      entries.clear();
      if (strip) {
        strip.removeEventListener('click', onStripClick);
        strip.remove();
        strip = null;
      }
    }

    windowRef.addEventListener?.('ide:active-file-changed', onActiveFileChanged);
    // Not during construction: the store replays the calls it already holds, and a finished write opens its
    // file through the Workspace controller, which is still being built here. That threw and left Workspace blank.
    Promise.resolve().then(ensureSubscribed);

    return { getSwitch, toggleSwitch, registerCommands, sync, closeAll, dispose };
  }

  return { createIdeFollowController, DRAFT_PREFIX };
});
