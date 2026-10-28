/* renderer/features/renderer-ide-editor-group-view.js - one secondary editor
 * group of the Workspace IDE (W5): its own tab strip plus its own Monaco
 * editor showing the SAME models the primary editor host owns. The view only
 * renders and reports intents (activate, close, save, context menu, tab drop)
 * through callbacks; the controller owns group membership and documents. Its
 * strip events come from the shared renderer-ide-tab-strip-events layer, the
 * same one the primary strip binds. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorGroupView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Drag payload helpers shared with the primary strip (renderer-ide-tabs).
  const tabsShared = globalThis.rendererIdeTabs || (typeof require === 'function' ? require('./renderer-ide-tabs') : {});
  const { TAB_MIME } = tabsShared;
  const stripEventsShared = globalThis.rendererIdeTabStripEvents || (typeof require === 'function' ? require('./renderer-ide-tab-strip-events') : {});

  function createIdeEditorGroupView(deps) {
    const jt = typeof deps?.jt === 'function' ? deps.jt : fallbackJt;
    const groupId = String(deps?.groupId || '');
    const doc = deps.document;
    const editorHost = deps.editorHost;
    const call = (name, ...args) => (typeof deps[name] === 'function' ? deps[name](...args) : undefined);
    const { revealFirstChangeOnce } = globalThis.rendererIdeEditorHostGroupDiff || require('./renderer-ide-editor-host-group-diff');

    // ── DOM (built once) ──
    const stageId = `ideGroupStage-${groupId}`;
    const el = doc.createElement('section');
    el.className = 'ide-group';
    el.setAttribute('data-ide-group', groupId);
    const tabbarEl = doc.createElement('div');
    tabbarEl.className = 'ide-tabbar';
    const stripEl = doc.createElement('div');
    stripEl.className = 'ide-tabstrip';
    stripEl.setAttribute('role', 'tablist');
    stripEl.setAttribute('aria-label', jt('ide.groups.groupLabel', 'Editor group {n}', { n: deps.groupNumber }));
    tabbarEl.appendChild(stripEl);
    // Split / More toolbar after the strip (the count chip lands between them); filled
    // from the stage-switch markup once that module has loaded (it loads after this one).
    const actionsEl = doc.createElement('div');
    actionsEl.className = 'ide-editor-actions';
    actionsEl.setAttribute('role', 'toolbar');
    actionsEl.setAttribute('aria-label', jt('ide.tabs.editorActions', 'Editor actions'));
    tabbarEl.appendChild(actionsEl);
    const reviewEl = doc.createElement('div');
    reviewEl.className = 'ide-diff-toolbar ide-group-review hidden';
    reviewEl.hidden = true;
    const stageEl = doc.createElement('div');
    stageEl.className = 'ide-group-stage';
    stageEl.setAttribute('role', 'tabpanel');
    stageEl.id = stageId;
    stageEl.setAttribute('tabindex', '-1');
    const editorEl = doc.createElement('div');
    editorEl.className = 'ide-group-editor';
    const emptyEl = doc.createElement('div');
    emptyEl.className = 'ide-group-empty wb-empty';
    emptyEl.setAttribute('role', 'status');
    emptyEl.hidden = true;
    emptyEl.textContent = jt('ide.groups.empty', 'This file is still opening.');
    stageEl.appendChild(editorEl);
    stageEl.appendChild(emptyEl);
    el.appendChild(tabbarEl);
    el.appendChild(reviewEl);
    el.appendChild(stageEl);

    const tabStrip = tabsShared.createIdeTabStrip({
      getDom: () => ({ ideTabStrip: stripEl }),
      escapeHtml: deps.escapeHtml,
      ariaControls: stageId,
      getGitDecoration: typeof deps.getGitDecoration === 'function' ? deps.getGitDecoration : undefined,
    });

    let actionsFilled = false;
    function fillActions() {
      if (actionsFilled) return;
      const markup = globalThis.rendererIdeStageSwitch?.editorActionsMarkup;
      if (typeof markup !== 'function') return;
      const actionButton = globalThis.inventoryActionButton || (typeof require === 'function' ? require('../inventory/action-button') : null);
      actionsEl.innerHTML = markup({ actionButton, surfaces: false });
      actionsFilled = true;
    }
    fillActions();

    // ── Editor ──
    let editor = null;
    let diffEditor = null, diffEl = null, diffEditorEl = null, placeholderEl = null;
    let diffSurface = null, revealSubscription = null;
    let contentSubscription = null;
    // The path whose model is attached ('' = none) and that model; initialized
    // flips on the first showPath so the empty state is settled once.
    let currentPath = '';
    let currentModel = null;
    let initialized = false;
    let applying = false;
    let disposed = false;
    let emptyBound = null;
    const viewStates = new Map();

    function ensureEditor() {
      if (editor || disposed) return editor;
      editor = editorHost.createGroupEditor(editorEl, {
        onSave: () => call('onSave', currentPath),
        onFocus: () => call('onFocus', groupId),
        // Jenny's editor actions run from this editor act on the file it shows.
        getPath: () => currentPath,
      }) || null;
      contentSubscription = editor?.onDidChangeModelContent?.(() => {
        if (!applying && currentPath) editorHost.noteModelEdited(currentPath);
      }) || null;
      return editor;
    }

    function syncStage() {
      const showing = Boolean(editor && currentModel);
      editorEl.hidden = !showing;
      if (diffEl) diffEl.hidden = !diffSurface;
      emptyEl.hidden = showing || Boolean(diffSurface);
      if (showing) editor.layout?.();
      if (diffSurface) diffEditor?.layout?.();
    }

    // The same diff already showing (render runs on every tab-strip change):
    // nothing to re-attach, re-option or re-layout.
    function isShowingDiff(path, surface) {
      return Boolean(surface && diffSurface && path === currentPath
        && surface.original === diffSurface.original && surface.modified === diffSurface.modified
        && surface.placeholderText === diffSurface.placeholderText && surface.inlineDiff === diffSurface.inlineDiff
        && (surface.placeholderText || !(surface.original && surface.modified) || diffEditor?.getModel()));
    }

    function showDiff(path) {
      const surface = editorHost.getDiffSurface(path);
      if (isShowingDiff(path, surface)) return;
      if (!diffEl) {
        diffEl = doc.createElement('div'); diffEl.className = 'ide-group-diff';
        diffEditorEl = doc.createElement('div'); diffEditorEl.className = 'ide-diff-editor';
        placeholderEl = doc.createElement('pre'); placeholderEl.className = 'ide-diff-placeholder';
        diffEl.appendChild(diffEditorEl); diffEl.appendChild(placeholderEl); stageEl.appendChild(diffEl);
      }
      const changed = path !== currentPath || !diffSurface || surface?.original !== diffSurface.original || surface?.modified !== diffSurface.modified;
      if (currentModel && editor) viewStates.set(currentPath, editor.saveViewState());
      attach('', null);
      currentPath = path; currentModel = null; diffSurface = surface;
      placeholderEl.textContent = surface?.placeholderText || '';
      placeholderEl.hidden = !surface?.placeholderText;
      diffEditorEl.hidden = Boolean(surface?.placeholderText);
      if (surface && !surface.placeholderText && surface.original && surface.modified) {
        diffEditor = diffEditor || editorHost.createGroupDiffEditor(diffEditorEl, { onFocus: () => call('onFocus', groupId) });
        if (diffEditor) {
          diffEditor.updateOptions({ renderSideBySide: surface.inlineDiff !== true });
          if (changed || !diffEditor.getModel()) {
            revealSubscription?.dispose?.();
            diffEditor.setModel({ original: surface.original, modified: surface.modified });
            revealSubscription = revealFirstChangeOnce(diffEditor);
          }
        }
      } else {
        revealSubscription?.dispose?.(); revealSubscription = null;
        diffEditor?.setModel(null);
      }
      syncStage();
    }

    function attach(path, model) {
      if (!editor) return;
      applying = true;
      try {
        editor.setModel(model);
        // No state of this view's own: fall back to the document-level state the
        // primary editor stashed, so a tab moved in keeps its cursor and scroll.
        const state = model ? viewStates.get(path) || editorHost.getViewState?.(path) : null;
        if (state) editor.restoreViewState(state);
      } finally {
        applying = false;
      }
    }

    function showPath(path) {
      const requested = String(path || '');
      if (editorHost.getDocumentKind?.(requested) === 'diff') { initialized = true; showDiff(requested); return; }
      if (diffSurface) {
        revealSubscription?.dispose?.(); revealSubscription = null;
        diffEditor?.setModel(null); diffSurface = null; currentPath = '';
        syncStage(); // the early return below would otherwise leave the diff surface showing
      }
      const model = requested ? editorHost.getModel(requested) || null : null;
      const next = model ? requested : '';
      if (initialized && next === currentPath && model === currentModel && (editor || !model)) return;
      initialized = true;
      if (model) ensureEditor();
      if (editor && currentPath && next !== currentPath) viewStates.set(currentPath, editor.saveViewState());
      attach(next, model);
      currentPath = next;
      currentModel = model;
      syncStage();
    }

    function getViewState(path) {
      const key = String(path || '');
      if (diffSurface && key === currentPath) return null;
      if (editor && key && key === currentPath) return editor.saveViewState();
      return viewStates.get(key) || null;
    }

    // The controller calls this BEFORE it closes or moves a document, so the
    // model is never disposed while this editor still shows it.
    function forget(path) {
      const key = String(path || '');
      viewStates.delete(key);
      if (key && key === currentPath) {
        attach('', null);
        revealSubscription?.dispose?.(); revealSubscription = null;
        diffEditor?.setModel(null); diffSurface = null;
        currentPath = '';
        currentModel = null;
        syncStage();
      }
    }

    function render() {
      const dirtyByPath = {};
      const staleByPath = {};
      const tabs = call('getTabs') || [];
      for (const tab of tabs) {
        dirtyByPath[tab.path] = call('getDirty', tab.path) === true;
        staleByPath[tab.path] = call('getStale', tab.path) === true;
      }
      const active = String(call('getActive') || '');
      fillActions();
      tabStrip.renderTabs({ openTabs: tabs, activeTabPath: active, dirtyByPath, staleByPath });
      renderEmpty(tabs.length ? '' : String(call('getBoundText') || ''));
      showPath(active);
      if (editorHost.getDocumentKind?.(active) === 'diff') call('renderReviewBar', reviewEl, active);
      else { reviewEl.innerHTML = ''; reviewEl.__diffToolbarMarkup = ''; reviewEl.__suggestionBarMarkup = ''; }
      reviewEl.hidden = !reviewEl.childElementCount;
    }

    // A bound group with no tabs (W7c) says what lands here and offers Close Group.
    function renderEmpty(bound) {
      if (bound === emptyBound) return;
      emptyBound = bound;
      if (!bound) {
        emptyEl.textContent = jt('ide.groups.empty', 'This file is still opening.');
        return;
      }
      const actionButton = globalThis.inventoryActionButton || require('../inventory/action-button');
      const escape = typeof deps.escapeHtml === 'function' ? deps.escapeHtml : (v) => String(v);
      emptyEl.innerHTML = `<p class="wb-empty-copy">${escape(bound)}</p>`
        + actionButton({ variant: 'ghost', label: jt('ide.groups.closeGroup', 'Close Group'), dataset: { 'ide-group-close': '' } });
    }

    function focus() {
      if (diffSurface && !diffSurface.placeholderText && diffEditor) diffEditor.getModifiedEditor()?.focus?.();
      else if (editor && currentModel) editor.focus?.();
      else stageEl.focus?.();
    }

    // ── Events (delegated on the section) ──
    const { hasTabPayload } = tabsShared;

    function onClick(event) {
      if (event.target?.closest?.('[data-ide-group-close]')) call('onCloseGroup');
    }

    function onFocusIn() {
      call('onFocus', groupId);
    }

    // The strip events own everything inside the tabbar; the stage below it takes a
    // dropped tab as the group's last one (the section marks `data-ide-drop="stage"`).
    const stripEvents = stripEventsShared.createIdeTabStripEvents({
      root: el,
      getStrip: () => stripEl,
      groupId,
      callbacks: {
        onActivate: (path) => call('onActivate', path),
        onClose: (path) => call('onClose', path),
        onDoubleClick: (path) => call('onDoubleClick', path),
        onContextMenu: (path, anchor) => call('onContextMenu', path, anchor),
        onOverflow: (anchorEl) => call('onOverflow', anchorEl),
        onEditorAction: (action, target) => {
          if (action === 'split-right') call('onSplit');
          else if (action === 'more') call('onOverflow', target);
        },
        onDropTab: (payload, index) => call('onDropTab', payload, index),
      },
    });

    function clearStageMark() {
      el.removeAttribute('data-ide-drop');
    }

    function onStageDragOver(event) {
      if (!hasTabPayload(event)) return;
      if (tabbarEl.contains(event.target)) {
        clearStageMark();
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      el.setAttribute('data-ide-drop', 'stage');
    }

    function onStageDrop(event) {
      if (tabbarEl.contains(event.target)) return;
      clearStageMark();
      const payload = tabsShared.readTabPayload(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      call('onDropTab', payload, (call('getTabs') || []).length);
    }

    const listeners = [
      ['click', onClick], ['focusin', onFocusIn], ['dragover', onStageDragOver], ['dragleave', clearStageMark],
      ['dragend', clearStageMark], ['drop', onStageDrop],
    ];
    for (const [type, handler] of listeners) el.addEventListener(type, handler);

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, handler] of listeners) el.removeEventListener(type, handler);
      stripEvents.dispose();
      contentSubscription?.dispose?.();
      contentSubscription = null;
      if (editor) editorHost.releaseGroupEditor(editor);
      revealSubscription?.dispose?.(); revealSubscription = null;
      if (diffEditor) editorHost.releaseGroupDiffEditor(diffEditor);
      diffEditor = null; diffSurface = null;
      editor = null;
      currentPath = '';
      currentModel = null;
      viewStates.clear();
      el.remove();
    }

    return { el, render, showPath, focus, getViewState, forget, dispose };
  }

  return { createIdeEditorGroupView, TAB_MIME };
});
