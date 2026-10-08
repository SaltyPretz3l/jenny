/* renderer/features/renderer-ide-editor-group-view.js - one secondary editor
 * group of the Workspace IDE (W5): its own tab strip plus its own Monaco
 * editor showing the SAME models the primary editor host owns. The view only
 * renders and reports intents (activate, close, save, context menu, tab drop)
 * through callbacks; the controller owns group membership and documents. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorGroupView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Drag payload type shared with the controller's drop handling.
  const TAB_MIME = 'application/x-jenny-editor-tab';

  function createIdeEditorGroupView(deps) {
    const jt = typeof deps?.jt === 'function' ? deps.jt : fallbackJt;
    const groupId = String(deps?.groupId || '');
    const doc = deps.document;
    const editorHost = deps.editorHost;
    const call = (name, ...args) => (typeof deps[name] === 'function' ? deps[name](...args) : undefined);
    const tabsApi = globalThis.rendererIdeTabs || require('./renderer-ide-tabs');

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

    const tabStrip = tabsApi.createIdeTabStrip({
      getDom: () => ({ ideTabStrip: stripEl }),
      escapeHtml: deps.escapeHtml,
      ariaControls: stageId,
    });

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

    function showDiff(path) {
      const surface = editorHost.getDiffSurface(path);
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
            revealSubscription = diffEditor.onDidUpdateDiff?.(() => {
              revealSubscription?.dispose?.(); revealSubscription = null;
              const change = diffEditor.getLineChanges?.()[0];
              if (!change) return;
              const chars = change.charChanges?.[0];
              diffEditor.getModifiedEditor()?.revealPositionInCenter?.({ lineNumber: chars?.modifiedStartLineNumber || change.modifiedStartLineNumber || 1, column: chars?.modifiedStartColumn || 1 });
            }) || null;
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

    function layout() {
      editor?.layout?.();
      diffEditor?.layout?.();
    }

    // ── Events (delegated on the section) ──
    const isRtl = () => (el.closest('[dir]')?.getAttribute('dir') || '').toLowerCase() === 'rtl';
    const tabPathOf = (tabEl) => tabEl?.getAttribute('data-ide-tab') || '';

    function onClick(event) {
      if (event.target?.closest?.('[data-ide-group-close]')) { call('onCloseGroup'); return; }
      const overflowEl = event.target?.closest?.('[data-ide-tab-overflow]');
      if (overflowEl) { call('onOverflow', overflowEl); return; }
      const closeEl = event.target?.closest?.('[data-ide-tab-close]');
      if (closeEl) { call('onClose', closeEl.getAttribute('data-ide-tab-close')); return; }
      const labelEl = event.target?.closest?.('[data-ide-tab-path]');
      if (labelEl) call('onActivate', labelEl.getAttribute('data-ide-tab-path'));
    }

    function onAuxClick(event) {
      const tabEl = event.button === 1 ? event.target?.closest?.('.ide-tab') : null;
      if (!tabEl) return;
      event.preventDefault();
      call('onClose', tabPathOf(tabEl));
    }

    function onContextMenu(event) {
      const tabEl = event.target?.closest?.('.ide-tab');
      if (!tabEl) return;
      event.preventDefault();
      const keyboard = !event.clientX && !event.clientY;
      call('onContextMenu', tabPathOf(tabEl), keyboard ? { anchorEl: tabEl } : { anchorX: event.clientX, anchorY: event.clientY });
    }

    function onKeyDown(event) {
      const key = event.key;
      if (!stripEl.contains(event.target) || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      const labels = [...stripEl.querySelectorAll('.ide-tab-label')];
      if (!labels.length) return;
      const index = Math.max(0, labels.indexOf(event.target?.closest?.('.ide-tab-label')));
      const step = (key === 'ArrowRight') === !isRtl() ? 1 : -1;
      const next = key === 'Home' ? 0 : key === 'End' ? labels.length - 1 : (index + step + labels.length) % labels.length;
      event.preventDefault();
      labels[next].focus();
    }

    function onFocusIn() {
      call('onFocus', groupId);
    }

    // ── Tab drag and drop ──
    const hasTabPayload = (event) => Array.from(event.dataTransfer?.types || []).includes(TAB_MIME);

    function clearDropMarks() {
      stripEl.removeAttribute('data-ide-drop');
      el.removeAttribute('data-ide-drop');
    }

    function onDragStart(event) {
      const tabEl = event.target?.closest?.('.ide-tab');
      if (!tabEl || !event.dataTransfer) return;
      event.dataTransfer.setData(TAB_MIME, JSON.stringify({ path: tabPathOf(tabEl), fromGroup: groupId }));
      event.dataTransfer.effectAllowed = 'move';
    }

    function onDragOver(event) {
      if (!hasTabPayload(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      if (tabbarEl.contains(event.target)) stripEl.setAttribute('data-ide-drop', 'tabs');
      else el.setAttribute('data-ide-drop', 'stage');
    }

    // Index among the strip's tabs by pointer x against each tab's midpoint. A tab
    // reordered within this group does not count itself (the index is its final place).
    function dropIndex(clientX, skipPath) {
      const rtl = isRtl();
      let index = 0;
      for (const tabEl of stripEl.querySelectorAll('.ide-tab')) {
        if (skipPath && tabPathOf(tabEl) === skipPath) continue;
        const rect = tabEl.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (rtl ? mid > clientX : mid < clientX) index += 1;
      }
      return index;
    }

    function parsePayload(event) {
      try {
        const data = JSON.parse(event.dataTransfer?.getData(TAB_MIME) || '');
        if (!data || typeof data.path !== 'string' || !data.path) return null;
        return { path: data.path, fromGroup: typeof data.fromGroup === 'string' ? data.fromGroup : '' };
      } catch (_error) {
        return null;
      }
    }

    function onDrop(event) {
      clearDropMarks();
      const payload = parsePayload(event);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      const own = payload.fromGroup === groupId ? payload.path : '';
      const index = tabbarEl.contains(event.target) ? dropIndex(event.clientX, own) : (call('getTabs') || []).length;
      call('onDropTab', payload, index);
    }

    const listeners = [
      ['click', onClick], ['auxclick', onAuxClick], ['contextmenu', onContextMenu], ['keydown', onKeyDown],
      ['focusin', onFocusIn], ['dragstart', onDragStart], ['dragover', onDragOver], ['dragleave', clearDropMarks],
      ['dragend', clearDropMarks], ['drop', onDrop],
    ];
    for (const [type, handler] of listeners) el.addEventListener(type, handler);

    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const [type, handler] of listeners) el.removeEventListener(type, handler);
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

    return { el, render, showPath, focus, getViewState, forget, layout, dispose };
  }

  return { createIdeEditorGroupView, TAB_MIME };
});
