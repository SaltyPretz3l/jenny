/* renderer/features/renderer-ide-editor-host.js - single shared Monaco editor
 * with one model per open file: per-file undo stacks, cursor and
 * scroll preserved via saveViewState/restoreViewState). When Monaco is
 * unavailable (jsdom tests, loader failure) the host runs the same API over
 * the #ideEditorFallback textarea with per-path buffers. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const IDE_EDITOR_OPTIONS = {
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    wordWrap: 'off',
    fontSize: 13,
    lineNumbers: 'on',
    folding: true,
    // Glyph-margin lane (left of the line-number margin) for the bookmark glyph
    // decorations; inert until a glyphMarginClassName decoration is added.
    glyphMargin: true,
    tabSize: 2,
    renderWhitespace: 'selection',
    // Modern-editor chrome (Monaco 0.52 option shapes): colorized bracket
    // pairs + guides, pinned scope headers, smooth caret/scroll feel.
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    stickyScroll: { enabled: true },
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    fontLigatures: true,
    linkedEditing: true,
    occurrencesHighlight: 'singleFile',
    renderLineHighlight: 'all',
    mouseWheelZoom: true,
  };

  function createIdeEditorHost(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const log = typeof deps?.log === 'function' ? deps.log : null;
    const asyncFence = deps?.asyncFence || globalRef.rendererAsyncFence || (typeof require === 'function' ? require('../shared/async-fence') : {});
    const disposalFence = asyncFence.createDisposalFence();
    const editorGate = asyncFence.createGenerationGate();
    const monacoUtils = deps?.monacoUtils
      || globalRef.rendererMonacoEditorUtils
      || (typeof require === 'function' ? require('./renderer-monaco-editor-utils') : null)
      || {};
    // Image / binary-document kinds live in the panes sibling.
    const panesUtils = deps?.panesUtils
      || globalRef.rendererIdeEditorHostPanes
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-editor-host-panes'); } catch (_error) { return null; }
      })() : null)
      || {};
    // Pure selection/cursor/diagnostics read accessors (extracted for the
    // file-size ceiling); the host wraps them with its live state below.
    const editorReads = deps?.editorReads
      || globalRef.rendererIdeEditorReads
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-editor-reads'); } catch (_error) { return null; }
      })() : null)
      || {};
    // Document store: owns the per-file `docs` Map and the document-level
    // operations; this host keeps the view side (editors, activePath, DOM).
    const editorDocuments = deps?.editorDocuments
      || globalRef.rendererIdeEditorDocuments
      || (typeof require === 'function' ? require('./renderer-ide-editor-documents') : null);
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    // Fires once when Monaco actually boots (never on the textarea fallback
    // path) - the controller hangs the palette theme bridge off this.
    const onMonacoReady = typeof deps?.onMonacoReady === 'function' ? deps.onMonacoReady : () => {};
    // Cursor/selection movement in the Monaco editor (status-bar feed). The
    // fallback textarea has no reliable cursor events; the status bar pulls
    // getCursorInfo() on its other refresh triggers instead.
    const onCursorActivity = typeof deps?.onCursorActivity === 'function' ? deps.onCursorActivity : () => {};
    // Buffer edits (Monaco + fallback). The Preview stage debounces live
    // preview re-renders off this.
    const onModelChange = typeof deps?.onModelChange === 'function' ? deps.onModelChange : () => {};
    const onDocumentEdit = typeof deps?.onDocumentEdit === 'function' ? deps.onDocumentEdit : () => {};
    // A click in the editor's glyph-margin lane (1-based line). The controller
    // routes it to the bookmark toggle; no-op on the textarea fallback path.
    const onGlyphMarginClick = typeof deps?.onGlyphMarginClick === 'function'
      ? deps.onGlyphMarginClick
      : () => {};

    let monacoApi = null;
    let monacoEditor = null;
    // One reused diff editor (created lazily on the first diff tab) swapped
    // over the regular editor inside the same host element.
    let diffEditor = null;
    let diffRevealSubscription = null;
    let diffPane = null;
    let diffEditorEl = null;
    let diffPlaceholderEl = null;
    let activePath = '';
    // Problems-panel diagnostics listeners (fanned out from ensureEditor on boot).
    const markerListeners = new Set(); let markerSubscription = null;
    let fallbackBound = false; let fallbackInputHandler = null;
    let applyingValue = false;
    let wordWrapMode = 'off';
    let minimapEnabled = IDE_EDITOR_OPTIONS.minimap.enabled;
    // The editor-level preferences last applied (font size, line numbers, whitespace):
    // a group editor created later starts from them, not from the shared code size.
    let editorLevelOptions = {};
    // Monaco applies its own per-platform mono stack whenever `fontFamily` is
    // absent, so every editor here opts in to --font-family-mono explicitly.
    // The binding owns registration and the shared typography observer.
    const fonts = typeof monacoUtils.createIdeFontBinding === 'function'
      ? monacoUtils.createIdeFontBinding()
      : { withFont: (options) => ({ ...(options || {}) }), register() {}, release() {} };
    // Last large-file mode applied to the shared Monaco editor (null = none yet).
    // applyLargeFileEditorMode re-spreads the full option set on every tab switch;
    // editor-level options persist across setModel, so re-applying when the mode
    // is unchanged is pure redundancy. Reset whenever the editor is (re)created or
    // detached so a fresh editor always re-applies.
    let lastAppliedLargeFile = null;
    // Secondary editor-group editors (W5): each is a Monaco editor created by
    // createGroupEditor over the same models; the value holds its font
    // unregister, its action registrations (id -> disposable) and getPath.
    const groupEditors = new Map();
    const groupDiffs = (globalRef.rendererIdeEditorHostGroupDiff || require('./renderer-ide-editor-host-group-diff')).createGroupDiffHost({
      getMonaco: () => monacoApi, getDoc: (id) => getDoc(id), isDisposed: () => disposalFence.isDisposed(), fonts,
      getOptions: () => ({ ...monacoUtils.IDE_DIFF_EDITOR_OPTIONS, ...editorLevelOptions, wordWrap: wordWrapMode }),
      registerFont: monacoUtils.registerMonacoFontConsumer,
    });
    // Every editor action contributed through addEditorAction (id -> descriptor),
    // so group editors created later get the same context-menu actions.
    const editorActions = new Map();
    // { editor, path } while a group editor runs an action: the active-editor
    // readers below answer for that editor instead of the primary.
    let actionContext = null;
    // The group editor that last had focus (null: the primary); readers follow it.
    let focusedGroupEditor = null;
    // Per-open-file bookkeeping lives in the document store (Monaco mode: docs
    // hold models + view states; fallback mode: plain string buffers).
    const documents = editorDocuments.createEditorDocuments({ monacoUtils, onDirtyChange, onModelChange });
    const {
      docs, docText, getAltVersionId, getDoc, getDocumentKind, getEol, getMtime,
      hasDocument, isDirty, languageForPath, syncDirty, withEol,
    } = documents;
    // Overlay panes (image W7, PDF/DOCX documents) share `docs`;
    // the panes module owns their DOM and per-format pane instances.
    const panes = panesUtils.createEditorHostPanes?.({
      docs, getDom, log, onDirtyChange, onDocumentEdit, onSaveRequest,
      asyncFence, ownerFence: disposalFence,
      hideEditorSurfaces: () => { setDiffPaneVisible(false); setFallbackVisible(false); },
      imageHostUtils: deps?.imageHostUtils,
      imageMemoryUtils: deps?.imageMemoryUtils, imageMemoryOptions: deps?.imageMemoryOptions,
      documentPaneFactories: deps?.documentPaneFactories,
    }) || null;

    async function ensureEditor() {
      if (disposalFence.isDisposed()) return false;
      if (monacoEditor) {
        return true;
      }
      if (typeof monacoUtils.ensureMonacoEditorApi !== 'function') {
        return false;
      }
      const editorToken = editorGate.capture();
      const loadedMonacoApi = await monacoUtils.ensureMonacoEditorApi(log).catch(() => null);
      if (disposalFence.isDisposed() || !editorGate.isCurrent(editorToken)) return false;
      monacoApi = loadedMonacoApi;
      const host = getDom().ideEditorHost || null;
      if (!monacoApi || !host) {
        return false;
      }
      if (!monacoEditor) {
        // Thread the session toggles (wrap + minimap) into creation so a
        // recreate honors them rather than snapping back to the frozen defaults.
        const createdEditor = monacoApi.editor.create(host, fonts.withFont({
          ...IDE_EDITOR_OPTIONS,
          wordWrap: wordWrapMode,
          minimap: { enabled: minimapEnabled },
        }, host?.ownerDocument));
        if (disposalFence.isDisposed() || !editorGate.isCurrent(editorToken)) { createdEditor.dispose?.(); return false; }
        monacoEditor = createdEditor;
        fonts.register(monacoEditor, host?.ownerDocument);
        // Fresh editor starts on the default (full-chrome) options, so the next
        // activation must re-apply the large-file mode regardless of prior state.
        lastAppliedLargeFile = null;
        monacoEditor.addCommand(
          monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS,
          () => onSaveRequest()
        );
        monacoEditor.onDidChangeModelContent(() => {
          if (applyingValue || documents.isApplyingValue() || !activePath) {
            return;
          }
          syncDirty(activePath);
          onModelChange(activePath);
        });
        // The TS/JS workers sync documents on demand; eager sync would push
        // every open model to the worker the moment it spawns.
        monacoApi.languages?.typescript?.typescriptDefaults?.setEagerModelSync?.(false);
        monacoApi.languages?.typescript?.javascriptDefaults?.setEagerModelSync?.(false);
        // Selection-change fires on bare cursor moves too, so binding only it
        // (not the redundant onDidChangeCursorPosition) keeps the statusbar +
        // symbol-nav feed correct while halving the per-caret-move work.
        monacoEditor.onDidChangeCursorSelection?.(() => onCursorActivity(getCursorInfo()));
        monacoEditor.onDidFocusEditorWidget?.(() => setFocusedGroupEditor(null));
        // Glyph-margin bookmark toggle.
        const glyphTargetType = monacoApi.editor?.MouseTargetType?.GUTTER_GLYPH_MARGIN;
        monacoEditor.onMouseDown?.((event) => {
          const target = event && event.target;
          if (target && target.type === glyphTargetType && target.position) {
            onGlyphMarginClick(target.position.lineNumber);
          }
        });
        onMonacoReady(monacoApi);
        // Fan marker changes out to onMarkersChanged listeners (Problems panel).
        markerSubscription = monacoApi.editor.onDidChangeMarkers?.(() => {
          for (const cb of markerListeners) { cb(); }
        }) || null;
      }
      setFallbackVisible(false);
      return true;
    }

    // Secondary editor groups: a lighter Monaco editor per group, created with
    // the primary's options over the SAME models (the document store owns them).
    // Never triggers a Monaco load; null until the primary has booted.
    function createGroupEditor(el, { onSave, onFocus, getPath } = {}) {
      if (!monacoApi || !el || disposalFence.isDisposed()) return null;
      const doc = el.ownerDocument;
      const editor = monacoApi.editor.create(el, fonts.withFont({
        ...IDE_EDITOR_OPTIONS, wordWrap: wordWrapMode, minimap: { enabled: minimapEnabled },
      }, doc));
      // The shared font binding only releases everything at once, so register
      // per editor here: a closed group must leave the typography observer.
      const unregisterFont = typeof monacoUtils.registerMonacoFontConsumer === 'function'
        ? monacoUtils.registerMonacoFontConsumer(editor, doc) : null;
      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => { if (typeof onSave === 'function') onSave(); });
      editor.onDidFocusEditorWidget?.(() => { setFocusedGroupEditor(editor); if (typeof onFocus === 'function') onFocus(); });
      editor.onDidChangeCursorSelection?.(() => { if (focusedGroupEditor === editor) onCursorActivity(getFocusedCursorInfo()); });
      editor.onDidChangeModel?.(() => { if (focusedGroupEditor === editor) dispatchActiveFileChanged(getFocusedPath()); });
      const { minimap: _minimap, wordWrap: _wordWrap, ...levelOptions } = editorLevelOptions;
      if (Object.keys(levelOptions).length) editor.updateOptions?.(levelOptions);
      const entry = { unregisterFont, actions: new Map(), getPath: typeof getPath === 'function' ? getPath : () => '' };
      groupEditors.set(editor, entry);
      for (const descriptor of editorActions.values()) bindGroupAction(editor, entry, descriptor);
      return editor;
    }

    function releaseGroupEditor(editor) {
      if (!editor || !groupEditors.has(editor)) return;
      if (focusedGroupEditor === editor) setFocusedGroupEditor(null);
      const entry = groupEditors.get(editor);
      entry.unregisterFont?.();
      for (const registration of entry.actions.values()) registration?.dispose?.();
      entry.actions.clear();
      groupEditors.delete(editor);
      editor.setModel?.(null);
      editor.dispose?.();
    }

    // A group editor changed a model: same bookkeeping as the primary's content listener.
    function noteModelEdited(path) {
      const normalizedPath = String(path || '');
      if (applyingValue || documents.isApplyingValue() || !hasDocument(normalizedPath)) return;
      syncDirty(normalizedPath);
      onModelChange(normalizedPath);
    }

    // True for a text file document backed by a Monaco model (no large-file limit).
    function isTextDocument(path) {
      const doc = getDoc(path);
      return Boolean(doc && doc.kind === 'file' && doc.model);
    }

    function setFallbackVisible(visible) {
      const dom = getDom();
      dom.ideEditorFallback?.classList.toggle('hidden', !visible);
      dom.ideEditorHost?.classList.toggle('hidden', visible);
    }

    // ── Diff surface (Monaco mode) ──
    // The diff pane overlays the regular editor inside #ideEditorHost; it
    // hosts the reused diff editor plus a plain-text placeholder element for
    // changes whose original snapshot is gone (hunks-summary fallback).

    function ensureDiffPane() {
      if (diffPane) {
        return diffPane;
      }
      const host = getDom().ideEditorHost || null;
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef) {
        return null;
      }
      diffPane = documentRef.createElement('div');
      diffPane.className = 'ide-diff-pane hidden';
      diffEditorEl = documentRef.createElement('div');
      diffEditorEl.className = 'ide-diff-editor';
      diffPlaceholderEl = documentRef.createElement('pre');
      diffPlaceholderEl.className = 'ide-diff-placeholder hidden';
      diffPane.appendChild(diffEditorEl);
      diffPane.appendChild(diffPlaceholderEl);
      host.appendChild(diffPane);
      return diffPane;
    }

    function ensureDiffEditor() {
      if (diffEditor) {
        return diffEditor;
      }
      if (!monacoApi || typeof monacoApi.editor?.createDiffEditor !== 'function' || !ensureDiffPane()) {
        return null;
      }
      diffEditor = monacoApi.editor.createDiffEditor(diffEditorEl, fonts.withFont(
        { ...monacoUtils.IDE_DIFF_EDITOR_OPTIONS, wordWrap: wordWrapMode }, diffEditorEl?.ownerDocument,
      ));
      // A diff editor is a pair of editors behind one facade; register both
      // sides so a typography change retunes original as well as modified.
      fonts.register(diffEditor.getOriginalEditor?.(), diffEditorEl?.ownerDocument);
      fonts.register(diffEditor.getModifiedEditor?.(), diffEditorEl?.ownerDocument);
      return diffEditor;
    }

    // A change deep inside a long line (a minified file) sat off-screen to the
    // right of the diff, so the person scrolled to find it (owner report,
    // 2026-10-05). Once Monaco has computed the diff, scroll its first changed
    // character into view; the two sides scroll together. One reveal per
    // activation, so later recomputes never yank the view back.
    function revealFirstDiffChange() {
      diffRevealSubscription?.dispose?.();
      diffRevealSubscription = null;
      if (typeof diffEditor?.onDidUpdateDiff !== 'function') return;
      diffRevealSubscription = diffEditor.onDidUpdateDiff(() => {
        diffRevealSubscription?.dispose?.();
        diffRevealSubscription = null;
        const change = (diffEditor.getLineChanges?.() || [])[0];
        if (!change) return;
        const chars = change.charChanges?.[0];
        // The modified pane alone: Monaco syncs the original pane's scroll to
        // it, so a second reveal there would be undone (a minified side renders
        // inline instead, see activateDiffDocument).
        const lineNumber = chars?.modifiedStartLineNumber || change.modifiedStartLineNumber || 1;
        diffEditor.getModifiedEditor?.()?.revealPositionInCenter?.({ lineNumber, column: chars?.modifiedStartColumn || 1 });
      });
    }

    function setDiffPaneVisible(visible) {
      if (!visible && !diffPane) {
        return;
      }
      ensureDiffPane();
      diffPane?.classList.toggle('hidden', !visible);
    }

    function ensureFallbackBinding() {
      const textarea = getDom().ideEditorFallback || null;
      if (!textarea || fallbackBound) {
        return textarea;
      }
      fallbackBound = true;
      fallbackInputHandler = () => {
        if (applyingValue || documents.isApplyingValue() || !activePath) {
          return;
        }
        const doc = getDoc(activePath);
        if (doc) {
          doc.buffer = withEol(textarea.value, doc.eol);
        }
        syncDirty(activePath);
        onModelChange(activePath);
      };
      textarea.addEventListener('input', fallbackInputHandler);
      return textarea;
    }

    // Loads (or refreshes) a document. Content comes from workspaceFs.readFile;
    // the document store owns the buffer from here until closeDocument.
    async function openDocument({ path, content, mtimeMs, eol, shouldApply = null, onApplied = null }) {
      const hasMonaco = await ensureEditor(); if (disposalFence.isDisposed() || (typeof shouldApply === 'function' && shouldApply() !== true)) return null;
      const doc = documents.openFile({ path, content, mtimeMs, eol, monacoApi: hasMonaco ? monacoApi : null });
      if (typeof onApplied === 'function') onApplied();
      return doc;
    }

    // Loads a read-only diff review document, keyed by `id` (a diff:// tab id).
    async function openDiffDocument({
      id,
      label = '',
      languagePath = '',
      original = '',
      modified = '',
      placeholderText = '', shouldApply = null,
    } = {}) {
      const normalizedId = String(id || '');
      if (!normalizedId) {
        return null;
      }
      await ensureEditor(); if (disposalFence.isDisposed()) return null;
      if (typeof shouldApply === 'function' && !shouldApply()) return null;
      return documents.openDiff({ id: normalizedId, label, languagePath, original, modified, placeholderText });
    }

    // Image / binary documents: the panes module owns the surfaces.
    function openImageDocument(payload) {
      return panes?.openImageDocument(payload, closeDocument) || null;
    }
    // Binary documents (PDF / DOCX): async pane parse with the same
    // shouldApply/onApplied fences as openDocument. Rejects with a coded error.
    async function openBinaryDocument(payload) {
      if (!panes || disposalFence.isDisposed()) return null;
      return panes.openBinaryDocument(payload);
    }
    function getDocumentBytes(path) { return panes ? panes.getDocumentBytes(path) : Promise.resolve(null); }
    function getDocumentFormat(path) { return panes?.getDocumentFormat(path) || ''; }

    function activateDiffDocument(normalizedId, doc) {
      activePath = normalizedId;
      if (monacoApi && monacoEditor) {
        setDiffPaneVisible(true);
        if (doc.placeholderText) {
          diffPlaceholderEl.textContent = doc.placeholderText; diffPlaceholderEl.classList.toggle('nowrap', wordWrapMode === 'off');
          diffPlaceholderEl.classList.remove('hidden');
          diffEditorEl.classList.add('hidden');
        } else if (ensureDiffEditor()) {
          groupDiffs.getDiffSurface(normalizedId); // creates the shared models once
          // A minified side wraps to a different height in each pane (live
          // recheck 2026-10-06: the original pane showed another part of the
          // one-line file), so such a diff renders inline, in one pane.
          diffEditor.updateOptions?.({ renderSideBySide: doc.inlineDiff !== true });
          diffEditor.setModel({ original: doc.originalModel, modified: doc.modifiedModel });
          revealFirstDiffChange();
          diffPlaceholderEl.classList.add('hidden');
          diffEditorEl.classList.remove('hidden');
        }
        setFallbackVisible(false);
        return true;
      }
      const textarea = ensureFallbackBinding();
      if (textarea) {
        applyingValue = true;
        try {
          textarea.value = monacoUtils.composeFallbackDiffText(doc);
          textarea.readOnly = true;
        } finally {
          applyingValue = false;
        }
        setFallbackVisible(true);
      }
      return true;
    }

    // Install the active-file accessor and dispatch only after activePath updates; dispatchEvent is optional in bare Node tests.
    function dispatchActiveFileChanged(path) {
      globalRef.rendererIdeActiveEditorReader = { getActivePath: getFocusedPath, getCursorInfo: getFocusedCursorInfo, getValue, getActiveLanguageId: getFocusedLanguageId, getDocumentKind, getWorkspaceId: () => deps?.getDocumentWorkspaceId?.(getFocusedPath()) || '', isLargeFile: () => getDoc(getFocusedPath())?.largeFile === true };
      globalRef.dispatchEvent?.(new globalRef.CustomEvent('ide:active-file-changed', { detail: { path: String(path || '') } }));
      return true;
    }

    // Swaps the visible document, preserving the outgoing one's view state.
    function activateDocument(path) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc) {
        return false;
      }
      if (monacoEditor && activePath && activePath !== normalizedPath) {
        const previous = getDoc(activePath);
        if (previous?.model) {
          previous.viewState = monacoEditor.saveViewState();
        }
      }
      if (doc.kind === 'image' || doc.kind === 'document') {
        activePath = normalizedPath;
        const shown = doc.kind === 'image' ? panes?.activateImageDocument(normalizedPath, doc)
          : panes?.activateBinaryDocument(normalizedPath, doc);
        return shown === true && dispatchActiveFileChanged(normalizedPath);
      }
      panes?.hideAll();
      if (doc.kind === 'diff') {
        return activateDiffDocument(normalizedPath, doc) && dispatchActiveFileChanged(normalizedPath);
      }
      activePath = normalizedPath;
      setDiffPaneVisible(false);
      if (monacoEditor && doc.model) {
        applyingValue = true;
        try {
          monacoEditor.setModel(doc.model);
          if (doc.viewState) {
            monacoEditor.restoreViewState(doc.viewState);
          }
        } finally {
          applyingValue = false;
        }
        setFallbackVisible(false);
        const nextLargeFile = doc.largeFile === true;
        // Always re-apply for a large file (preserves the re-degrade + notice on
        // every activation, even after an in-editor "restore full features");
        // for a normal file skip the idempotent full-option re-spread when the
        // previous activation was already normal (the common tab-switch case).
        if (nextLargeFile || lastAppliedLargeFile !== false) {
          monacoUtils.applyLargeFileEditorMode?.(monacoEditor, getDom().ideEditorHost, nextLargeFile, { ...IDE_EDITOR_OPTIONS, wordWrap: wordWrapMode, minimap: { enabled: minimapEnabled } });
          lastAppliedLargeFile = nextLargeFile;
        }
        return dispatchActiveFileChanged(normalizedPath);
      }
      const textarea = ensureFallbackBinding();
      if (textarea) {
        applyingValue = true;
        try {
          textarea.value = doc.buffer;
          textarea.readOnly = false;
        } finally {
          applyingValue = false;
        }
        setFallbackVisible(true);
      }
      return dispatchActiveFileChanged(normalizedPath);
    }

    function getValue(path) { return docText(getDoc(path)); }

    // Inputs of the active-editor readers: the primary editor and its document,
    // or the invoking group editor while one of its actions runs; `followFocus`
    // readers (status strip, selection intents, chat context) take a focused group editor.
    function readInputs(followFocus) {
      if (actionContext) return { doc: getDoc(actionContext.path), monacoEditor: actionContext.editor, textarea: null };
      const group = followFocus ? getFocusedGroupPath() : '';
      if (group) return { doc: getDoc(group), monacoEditor: focusedGroupEditor, textarea: null };
      return { doc: getDoc(activePath), monacoEditor, textarea: getDom().ideEditorFallback || null };
    }

    // The focused group editor's file, '' when the primary has focus or it shows nothing.
    function getFocusedGroupPath() {
      const model = groupEditors.has(focusedGroupEditor) && focusedGroupEditor.getModel?.();
      if (model) for (const [path, doc] of docs) if (doc.model === model) return path;
      return '';
    }
    function getFocusedPath() {
      return actionContext ? actionContext.path : getFocusedGroupPath() || activePath;
    }
    function setFocusedGroupEditor(editor) {
      if (focusedGroupEditor === editor) return;
      focusedGroupEditor = editor;
      onCursorActivity(getFocusedCursorInfo());
      dispatchActiveFileChanged(getFocusedPath());
    }

    // Selection reads serve the selection intents, so they follow a focused group.
    function getSelectedText() {
      return editorReads.readSelectedText?.(readInputs(true)) || '';
    }

    function getSelectionRange() {
      return editorReads.readSelectionRange?.({ ...readInputs(true), monacoUtils }) || null;
    }

    function getActiveLanguageId() { return languageIdOf(getActivePath()); }
    function getFocusedLanguageId() { return languageIdOf(getFocusedPath()); }
    function languageIdOf(path) {
      const doc = getDoc(path);
      if (!doc || doc.kind !== 'file') {
        return '';
      }
      return doc.model?.getLanguageId?.() || languageForPath(path);
    }

    // Path-centric diagnostics view-model for the Problems panel: file-model
    // markers only, mapped from the jenny-workspace model URI to a rel path.
    function getMarkers() {
      return editorReads.readMarkers?.(monacoApi) || [];
    }

    // Live diagnostics subscription: registers/detaches one fan-out listener.
    function onMarkersChanged(cb) {
      if (typeof cb === 'function') {
        markerListeners.add(cb);
      }
      return { dispose() { markerListeners.delete(cb); } };
    }

    // Git change-bars and line-bookmark glyphs each own a SEPARATE decoration-id
    // array so a delta for one lane never clobbers the other; both clear when
    // the model disposes on close. No-op (0) on the textarea fallback path.
    function setLaneDecorations(path, lane, decorations) {
      const doc = getDoc(path);
      if (!doc || !doc.model) {
        return 0;
      }
      const next = Array.isArray(decorations) ? decorations : [];
      doc[lane] = doc.model.deltaDecorations(doc[lane] || [], next);
      return doc[lane].length;
    }

    function setGutterDecorations(path, decorations) {
      return setLaneDecorations(path, 'gutterDecorationIds', decorations);
    }

    function setBookmarkDecorations(path, decorations) {
      return setLaneDecorations(path, 'bookmarkDecorationIds', decorations);
    }

    // Lets the controller contribute editor context-menu actions without
    // reaching into the host-private Monaco instance. Callers register from
    // onMonacoReady; every descriptor is also kept so each editor group's
    // editor (existing or created later) carries the same actions.
    function addEditorAction(descriptor) {
      if (!descriptor || typeof descriptor.id !== 'string' || !descriptor.id) {
        return null;
      }
      editorActions.set(descriptor.id, descriptor);
      for (const [editor, entry] of groupEditors) bindGroupAction(editor, entry, descriptor);
      if (!monacoEditor || typeof monacoEditor.addAction !== 'function') {
        return null;
      }
      return monacoEditor.addAction(descriptor);
    }

    // A group editor's copy of an action runs inside a synchronous action
    // context: getActivePath / getSelectedText / getSelectionRange /
    // getCursorInfo / getActiveLanguageId read THAT editor and the path it
    // shows. Async runs must read their inputs before the first await.
    function bindGroupAction(editor, entry, descriptor) {
      if (typeof editor.addAction !== 'function') return;
      entry.actions.get(descriptor.id)?.dispose?.();
      const run = (...args) => {
        const previous = actionContext;
        actionContext = { editor, path: String(entry.getPath() || '') };
        try { return descriptor.run?.(...args); } finally { actionContext = previous; }
      };
      entry.actions.set(descriptor.id, editor.addAction({ ...descriptor, run }) || null);
    }

    // 1-based cursor line/column plus selected-character count for the
    // status bar. Monaco reports natively; the fallback derives from the
    // textarea's selection offsets.
    function getCursorInfo() {
      return editorReads.readCursorInfo?.(readInputs()) || null;
    }
    function getFocusedCursorInfo() {
      return editorReads.readCursorInfo?.(readInputs(true)) || null;
    }

    function triggerGoToLine() {
      const editor = getFocusedGroupPath() ? focusedGroupEditor : monacoEditor;
      if (!editor || typeof editor.trigger !== 'function') {
        return false;
      }
      editor.focus?.();
      editor.trigger('jenny-statusbar', 'editor.action.gotoLine', null);
      return true;
    }

    // Runs a built-in Monaco editor action by id, focusing the editor FIRST —
    // quick-input actions (quickOutline) throw uncaught when run unfocused
    // (breadcrumb click, CMP-RENDER-0001). Throws contained to a false return.
    function runAction(id) {
      const action = monacoEditor?.getAction?.(String(id || ''));
      if (!action || typeof action.run !== 'function') {
        return false;
      }
      monacoEditor.focus?.();
      try { Promise.resolve(action.run()).catch(() => {}); } catch (_error) { return false; }
      return true;
    }

    function setWordWrap(mode) {
      wordWrapMode = mode === 'on' ? 'on' : 'off';
      diffPlaceholderEl?.classList.toggle('nowrap', wordWrapMode === 'off'); monacoEditor?.updateOptions?.({ wordWrap: wordWrapMode });
      diffEditor?.updateOptions?.({ wordWrap: wordWrapMode });
      groupDiffs.updateOptions({ wordWrap: wordWrapMode });
      for (const editor of groupEditors.keys()) editor.updateOptions?.({ wordWrap: wordWrapMode });
    }
    // Applies editor-LEVEL options live (fontSize, lineNumbers, renderWhitespace,
    // minimap, wordWrap). Per-MODEL
    // options (tabSize, eol) stay on setTabSize/setEol + the chip-picker. The two
    // recreate-sensitive vars are kept in sync so a Monaco recreate honors them;
    // fontSize/lineNumbers/renderWhitespace need no var because the controller
    // re-applies them in onMonacoReady on every (re)create.
    function setEditorOptions(opts) {
      const next = opts && typeof opts === 'object' ? opts : {};
      const applied = { ...next };
      if (typeof next.wordWrap === 'string') {
        wordWrapMode = next.wordWrap === 'on' ? 'on' : 'off'; diffPlaceholderEl?.classList.toggle('nowrap', wordWrapMode === 'off');
        // The diff editor is a separate instance: the wrap toggle reaches it too.
        diffEditor?.updateOptions?.({ wordWrap: wordWrapMode });
      }
      if (next.minimap && typeof next.minimap === 'object' && typeof next.minimap.enabled === 'boolean') {
        minimapEnabled = next.minimap.enabled;
        applied.minimap = { ...next.minimap, enabled: minimapEnabled && getDoc(activePath)?.largeFile !== true };
      }
      monacoEditor?.updateOptions?.(applied);
      editorLevelOptions = { ...editorLevelOptions, ...applied };
      // Group editors follow the preference only (the large-file override is per active primary doc).
      const groupApplied = applied.minimap ? { ...applied, minimap: { ...applied.minimap, enabled: minimapEnabled } } : applied;
      for (const editor of groupEditors.keys()) editor.updateOptions?.(groupApplied);
      groupDiffs.updateOptions(groupApplied);
      // The diff editor is a separate instance; without this the editor font
      // size never reached diffs.
      if (typeof next.fontSize === 'number') diffEditor?.updateOptions?.({ fontSize: next.fontSize });
    }

    // Document-pane docs (PDF / DOCX) report saves through the panes module.
    function markSaved(path, options) {
      if (getDoc(path)?.kind === 'document') { panes?.markDocumentSaved(path, { mtimeMs: options?.mtimeMs }); return; }
      documents.markSaved(path, options);
    }

    function closeDocument(path) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc) return;
      if (activePath === normalizedPath) {
        if (doc.kind === 'diff') setDiffPaneVisible(false);
        else if (doc.kind !== 'file') panes?.hideForClose(doc);
        else if (monacoEditor) monacoEditor.setModel(null);
      }
      // Monaco 0.52 asserts when a TextModel still attached to the DiffEditorWidget
      // is disposed (CMP-RENDER-0001). Switching tabs away only hides the diff pane
      // and leaves the models attached, so detach by identity, not active-tab state.
      const attachedDiff = diffEditor?.getModel?.();
      if (attachedDiff && (attachedDiff.original === doc.originalModel || attachedDiff.modified === doc.modifiedModel)) {
        diffEditor.setModel(null);
      }
      // Same Monaco assert for a group editor still showing this model.
      if (doc.model) for (const editor of groupEditors.keys()) if (editor.getModel?.() === doc.model) editor.setModel(null);
      groupDiffs.detach(doc);
      documents.disposeModels(doc);
      panes?.release(normalizedPath, doc); documents.deleteDocument(normalizedPath);
      if (activePath === normalizedPath) activePath = '';
    }

    function getActivePath() {
      return actionContext ? actionContext.path : activePath;
    }

    function showEmpty() {
      activePath = '';
      lastAppliedLargeFile = null;
      if (monacoEditor) {
        monacoEditor.setModel(null);
      }
      setDiffPaneVisible(false);
      panes?.hideAll();
      const textarea = getDom().ideEditorFallback || null;
      if (textarea) {
        textarea.value = '';
        textarea.readOnly = false;
        textarea.classList.add('hidden');
      }
      // Notify active-file listeners that no document remains active.
      dispatchActiveFileChanged('');
    }

    function layout() {
      monacoEditor?.layout?.();
      diffEditor?.layout?.();
    }

    function focus() {
      if (monacoEditor && getDoc(activePath)?.model) {
        monacoEditor.focus();
        return;
      }
      getDom().ideEditorFallback?.focus?.();
    }

    function isUsingMonaco() {
      return Boolean(monacoEditor);
    }

    // Moves the cursor to a 1-based line/column in the active document (used
    // by find-in-files result clicks). The document must already be active.
    function editorShowing(path) {
      const model = getDoc(path)?.model;
      if (!model) return null;
      return (activePath === path ? monacoEditor : [...groupEditors.keys()].find((editor) => editor.getModel?.() === model)) || null;
    }
    function runFormat(editor) {
      const action = editor?.getAction?.('editor.action.formatDocument');
      return action && typeof action.run === 'function' ? Promise.resolve(action.run()).then(() => ({ supported: true, formatted: true })) : Promise.resolve({ supported: false, formatted: false });
    }

    function revealPosition(path, lineNumber, column) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      const line = Math.max(1, Number(lineNumber) || 1);
      const col = Math.max(1, Number(column) || 1);
      // A file showing in a secondary editor group (W5) moves that group's cursor.
      const groupEditor = activePath !== normalizedPath ? editorShowing(normalizedPath) : null;
      if (groupEditor) {
        groupEditor.setPosition({ lineNumber: line, column: col });
        groupEditor.revealPositionInCenter?.({ lineNumber: line, column: col });
        groupEditor.focus?.();
        return true;
      }
      if (!doc || activePath !== normalizedPath) {
        return false;
      }
      if (monacoEditor && doc.model) {
        monacoEditor.setPosition({ lineNumber: line, column: col });
        monacoEditor.revealPositionInCenter?.({ lineNumber: line, column: col });
        monacoEditor.focus();
        return true;
      }
      const textarea = getDom().ideEditorFallback || null;
      if (!textarea) {
        return false;
      }
      const offset = editorReads.offsetForLineColumn(doc.buffer, line, col);
      textarea.focus();
      try {
        textarea.setSelectionRange(offset, offset);
      } catch (_error) {
        /* selection is best-effort in the fallback editor */
      }
      return true;
    }

    // Captures the Monaco view state (cursor + scroll + folds) for a document.
    // For the active doc the LIVE editor state is read (closeDocument disposes
    // the model without saving, so this must run before close); for a
    // backgrounded doc the value stashed on switch-away is returned. Powers
    // reopen-closed-tab (Ctrl+Shift+T) restoring the cursor where it was left.
    function getViewState(path) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc) {
        return null;
      }
      if (monacoEditor && activePath === normalizedPath && doc.model) {
        return monacoEditor.saveViewState();
      }
      return doc.viewState || null;
    }

    function getViewLines(path) {
      if (!getDoc(path) || !isTextDocument(path)) return null;
      const view = editorShowing(path)?.saveViewState?.() || getViewState(path);
      return { line: view?.cursorState?.[0]?.position?.lineNumber || (activePath === path ? getCursorInfo()?.lineNumber : 1) || 1,
        top: view?.viewState?.firstPosition?.lineNumber || 1 };
    }
    function revealTopLine(path, top, line) {
      const doc = getDoc(path);
      if (!doc) return false;
      const end = doc.model?.getLineCount?.() || String(doc.buffer || '').split('\n').length;
      const cursor = Math.min(end, Math.max(1, Number(line) || 1));
      const editor = editorShowing(path);
      if (!editor) return revealPosition(path, cursor, 1);
      editor.setPosition({ lineNumber: cursor, column: 1 });
      // Exact top, not revealLineNearTop: its gap above the line would move the
      // saved first line a few lines up on every restart.
      const topLine = Math.min(end, Math.max(1, Number(top) || 1));
      if (typeof editor.getTopForLineNumber === 'function') editor.setScrollTop(editor.getTopForLineNumber(topLine));
      return true;
    }
    // Restores a captured view state onto a document - immediately when active,
    // otherwise stashed for the next activation. No-op without Monaco.
    function applyViewState(path, viewState) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc || !viewState) {
        return false;
      }
      doc.viewState = viewState;
      editorShowing(normalizedPath)?.restoreViewState?.(viewState);
      return true;
    }

    // The indent width of `path`, by default the focused editor's file (a secondary
    // group's while it has focus, like the status strip that shows it), falling back to
    // the IDE default when there is no live Monaco model (fallback textarea path).
    function getTabSize(path) {
      const doc = getDoc(String(path || '') || getFocusedPath());
      const size = Number(doc?.model?.getOptions?.()?.tabSize);
      return size > 0 ? size : IDE_EDITOR_OPTIONS.tabSize;
    }

    function setTabSize(size, path) {
      const next = Number(size);
      if (!(next > 0)) {
        return false;
      }
      getDoc(String(path || '') || getFocusedPath())?.model?.updateOptions?.({ tabSize: next, insertSpaces: true });
      return true;
    }

    function setEol(path, eol) {
      return documents.setEol(String(path || '') || activePath, eol, monacoApi);
    }

    function dispose() {
      editorGate.bump(); disposalFence.dispose();
      const fallback = getDom().ideEditorFallback || null;
      if (fallbackBound && fallbackInputHandler) fallback?.removeEventListener('input', fallbackInputHandler);
      fallbackBound = false; fallbackInputHandler = null;
      // Release font handles first: the observer must not reach an editor
      // that the sweep below is about to tear down.
      fonts.release();
      focusedGroupEditor = null;
      for (const editor of [...groupEditors.keys()]) releaseGroupEditor(editor);
      groupDiffs.dispose();
      editorActions.clear();
      // Detach both editors before the model sweep (same Monaco assert as closeDocument).
      diffEditor?.setModel?.(null); monacoEditor?.setModel?.(null);
      documents.disposeAllModels();
      panes?.dispose();
      documents.clear();
      monacoEditor?.dispose?.();
      monacoEditor = null; markerSubscription?.dispose?.(); markerSubscription = null;
      diffRevealSubscription?.dispose?.();
      diffRevealSubscription = null;
      diffEditor?.dispose?.();
      diffEditor = null;
      diffPane?.remove?.();
      diffPane = null;
      diffEditorEl = null;
      diffPlaceholderEl = null;
      activePath = '';
      lastAppliedLargeFile = null;
    }

    return {
      activateDocument,
      addEditorAction,
      applyViewState,
      closeDocument,
      createGroupEditor,
      createGroupDiffEditor: groupDiffs.createGroupDiffEditor,
      releaseGroupDiffEditor: groupDiffs.releaseGroupDiffEditor,
      getDiffSurface: groupDiffs.getDiffSurface,
      dispose,
      focus,
      getActiveLanguageId,
      getActivePath,
      getFocusedPath,
      getFocusedGroupPath,
      getFocusedCursorInfo,
      getFocusedLanguageId,
      getAltVersionId,
      getCursorInfo,
      getDocumentBytes,
      getDocumentFormat,
      getDocumentKind,
      getEol,
      getMarkers,
      getViewState,
      getViewLines,
      getMtime,
      getSelectedText,
      getSelectionRange,
      getTabSize,
      getValue,
      // Thin accessors for save-time hygiene: live model, large-file flag, and a
      // format pass that returns its promise and never refocuses (unlike runAction).
      getModel: (path) => getDoc(path)?.model || null,
      getMonaco: () => monacoApi,
      isTextDocument,
      noteModelEdited,
      releaseGroupEditor,
      isLargeFile: (path) => getDoc(path)?.largeFile === true,
      formatActive: () => runFormat(monacoEditor),
      formatPath: (path) => runFormat(editorShowing(path)),
      showsPath: (path) => Boolean(editorShowing(path)),
      hasDocument,
      isDirty,
      isUsingMonaco,
      layout,
      markSaved,
      onMarkersChanged,
      openBinaryDocument,
      openDiffDocument,
      openDocument,
      openImageDocument,
      revealPosition,
      revealTopLine,
      runAction,
      setEditorOptions,
      setBookmarkDecorations,
      setEol,
      setGutterDecorations,
      setTabSize,
      setWordWrap,
      showEmpty,
      triggerGoToLine,
    };
  }

  return {
    createIdeEditorHost,
  };
});
