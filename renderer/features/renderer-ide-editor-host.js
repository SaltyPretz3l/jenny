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
    const optionsUtils = globalRef.rendererIdeEditorHostOptions || require('./renderer-ide-editor-host-options');
    const { IDE_EDITOR_OPTIONS } = optionsUtils;
    const diffPaneUtils = globalRef.rendererIdeEditorHostDiffPane || require('./renderer-ide-editor-host-diff-pane');
    const groupEditorsUtils = globalRef.rendererIdeEditorHostGroupEditors || require('./renderer-ide-editor-host-group-editors');
    const viewUtils = globalRef.rendererIdeEditorHostView || require('./renderer-ide-editor-host-view');
    const groupDiffUtils = globalRef.rendererIdeEditorHostGroupDiff || require('./renderer-ide-editor-host-group-diff');
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
    let activePath = '';
    // Problems-panel diagnostics listeners (fanned out from ensureEditor on boot).
    const markerListeners = new Set(); let markerSubscription = null;
    let fallbackBound = false; let fallbackInputHandler = null;
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
    let draftLocked = false; // the primary editor is showing a Follow Jenny draft (read-only)
    // Editor-level options (wrap, minimap, applied preferences) and the fan-out of
    // setEditorOptions live in the options sibling; the thunks reach the surfaces built below.
    const options = optionsUtils.createEditorOptions({
      monacoUtils, getEditor: () => monacoEditor, getDiffPane: () => diffPane, getGroupEditors: () => groupEditors,
      getGroupDiffs: () => groupDiffs, isActiveLargeFile: () => getDoc(activePath)?.largeFile === true,
    });
    const { baseEditorOptions, setEditorOptions, setWordWrap } = options;
    const groupDiffs = groupDiffUtils.createGroupDiffHost({
      getMonaco: () => monacoApi, getDoc: (id) => getDoc(id), isDisposed: () => disposalFence.isDisposed(), fonts,
      getOptions: () => options.getDiffOptions(),
      registerFont: monacoUtils.registerMonacoFontConsumer,
    });
    // The primary diff surface (Monaco mode): the pane over the editor, the reused diff editor and the placeholder.
    const diffPane = diffPaneUtils.createDiffPane({
      getDom, getMonaco: () => monacoApi, monacoUtils, groupDiffUtils, groupDiffs, fonts, getWrapMode: options.getWrapMode,
    });
    // Per-open-file bookkeeping lives in the document store (Monaco mode: docs
    // hold models + view states; fallback mode: plain string buffers).
    const documents = editorDocuments.createEditorDocuments({ monacoUtils, onDirtyChange, onModelChange });
    const {
      docs, docText, getAltVersionId, getDoc, getDocumentKind, getEol, getMtime,
      hasDocument, isDirty, languageForPath, syncDirty, withEol,
    } = documents;
    // Secondary editor-group editors, the shared editor actions and the focused-group / action-context state.
    const groupEditors = groupEditorsUtils.createGroupEditors({
      getMonaco: () => monacoApi, getPrimaryEditor: () => monacoEditor, getActivePath: () => activePath,
      isDisposed: () => disposalFence.isDisposed(), docs, getDoc, options, fonts, monacoUtils,
      onCursorActivity, getFocusedCursorInfo: () => getFocusedCursorInfo(), getFocusedPath: () => getFocusedPath(),
      dispatchActiveFileChanged: (path) => dispatchActiveFileChanged(path),
    });
    const {
      addEditorAction, createGroupEditor, releaseGroupEditor, triggerGoToLine, editorShowing,
      getFocusedGroupPath, setFocusedGroupEditor,
    } = groupEditors;
    // Overlay panes (image W7, PDF/DOCX documents) share `docs`;
    // the panes module owns their DOM and per-format pane instances.
    const panes = panesUtils.createEditorHostPanes?.({
      docs, getDom, log, onDirtyChange, onDocumentEdit, onSaveRequest,
      asyncFence, ownerFence: disposalFence,
      hideEditorSurfaces: () => { diffPane.setVisible(false); setFallbackVisible(false); },
      imageHostUtils: deps?.imageHostUtils,
      imageMemoryUtils: deps?.imageMemoryUtils, imageMemoryOptions: deps?.imageMemoryOptions,
      documentPaneFactories: deps?.documentPaneFactories,
    }) || null;
    // Cursor reveal and view-state capture (find-in-files, tab restore, reopen-closed-tab).
    const view = viewUtils.createEditorView({
      getDom, getDoc, getActivePath: () => activePath, getPrimaryEditor: () => monacoEditor, editorShowing, editorReads,
      isTextDocument: (path) => isTextDocument(path), getCursorInfo: () => getCursorInfo(),
    });
    const { revealPosition, getViewState, getViewLines, revealTopLine, applyViewState } = view;

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
        const createdEditor = monacoApi.editor.create(host, fonts.withFont(baseEditorOptions(), host?.ownerDocument));
        if (disposalFence.isDisposed() || !editorGate.isCurrent(editorToken)) { createdEditor.dispose?.(); return false; }
        monacoEditor = createdEditor;
        fonts.register(monacoEditor, host?.ownerDocument);
        // Fresh editor starts on the default (full-chrome) options, so the next
        // activation must re-apply the large-file mode regardless of prior state.
        lastAppliedLargeFile = null; draftLocked = false;
        monacoEditor.addCommand(
          monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS,
          () => onSaveRequest()
        );
        monacoEditor.onDidChangeModelContent(() => {
          if (documents.isApplyingValue() || !activePath) {
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

    // A group editor changed a model: same bookkeeping as the primary's content listener.
    function noteModelEdited(path) {
      const normalizedPath = String(path || '');
      if (documents.isApplyingValue() || !hasDocument(normalizedPath)) return;
      syncDirty(normalizedPath);
      onModelChange(normalizedPath);
    }

    // True for a text file document backed by a Monaco model (no large-file limit).
    function isTextDocument(path) {
      const doc = getDoc(path);
      return Boolean(doc && doc.kind === 'file' && doc.model && doc.draft !== true);
    }

    function setFallbackVisible(visible) {
      const dom = getDom();
      dom.ideEditorFallback?.classList.toggle('hidden', !visible);
      dom.ideEditorHost?.classList.toggle('hidden', visible);
    }

    function ensureFallbackBinding() {
      const textarea = getDom().ideEditorFallback || null;
      if (!textarea || fallbackBound) {
        return textarea;
      }
      fallbackBound = true;
      fallbackInputHandler = () => {
        if (documents.isApplyingValue() || !activePath) {
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
    async function openDocument({ path, content, mtimeMs, eol, encoding, shouldApply = null, onApplied = null }) {
      const hasMonaco = await ensureEditor(); if (disposalFence.isDisposed() || (typeof shouldApply === 'function' && shouldApply() !== true)) return null;
      const doc = documents.openFile({ path, content, mtimeMs, eol, encoding, monacoApi: hasMonaco ? monacoApi : null });
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

    // Follow Jenny (row 121): a read-only draft of a file Jenny is writing, keyed by a diff:// tab id.
    async function openDraftDocument({ id, languagePath = '', text = '', lineNumbers = null } = {}) {
      const normalizedId = String(id || '');
      if (!normalizedId) return null;
      const hasMonaco = await ensureEditor(); if (disposalFence.isDisposed()) return null;
      return documents.openDraft({ id: normalizedId, languagePath, text, lineNumbers, monacoApi: hasMonaco ? monacoApi : null });
    }
    function writeDraftDocument(id, text, splice = null) {
      const normalizedId = String(id || '');
      if (!documents.writeDraft(normalizedId, text, splice)) return false;
      const textarea = getDoc(normalizedId)?.model || activePath !== normalizedId ? null : getDom().ideEditorFallback || null;
      if (textarea) documents.runApplying(() => { textarea.value = String(text ?? ''); });
      return true;
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
    // PDF reading position (tab restore) and reading context (chat); row 65.
    const getPdfViewPosition = (path) => panes?.callPdfPane(path, 'getViewPosition') || null;
    const restorePdfView = (path, position) => panes?.callPdfPane(path, 'restoreViewPosition', position) === true;
    const getPdfReadingContext = (path, options) => panes?.callPdfPane(path, 'getReadingContext', options) || null;

    function activateDiffDocument(normalizedId, doc) {
      activePath = normalizedId;
      if (monacoApi && monacoEditor) {
        diffPane.show(normalizedId, doc);
        setFallbackVisible(false);
        return true;
      }
      const textarea = ensureFallbackBinding();
      if (textarea) {
        documents.runApplying(() => {
          textarea.value = monacoUtils.composeFallbackDiffText(doc);
          textarea.readOnly = true;
        });
        setFallbackVisible(true);
      }
      return true;
    }

    // Install the active-file accessor and dispatch only after activePath updates; dispatchEvent is optional in bare Node tests.
    function dispatchActiveFileChanged(path) {
      globalRef.rendererIdeActiveEditorReader = { getActivePath: getFocusedPath, getCursorInfo: getFocusedCursorInfo, getValue, getModel: (path) => getDoc(path)?.model || null, getActiveLanguageId: getFocusedLanguageId, getDocumentKind, getPdfReadingContext, getWorkspaceId: () => deps?.getDocumentWorkspaceId?.(getFocusedPath()) || '', isLargeFile: () => getDoc(getFocusedPath())?.largeFile === true };
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
      diffPane.setVisible(false);
      if (monacoEditor && doc.model) {
        documents.runApplying(() => {
          monacoEditor.setModel(doc.model);
          if (doc.viewState) {
            monacoEditor.restoreViewState(doc.viewState);
          }
        });
        setFallbackVisible(false);
        const nextLargeFile = doc.largeFile === true;
        // Always re-apply for a large file (preserves the re-degrade + notice on
        // every activation, even after an in-editor "restore full features");
        // for a normal file skip the idempotent full-option re-spread when the
        // previous activation was already normal (the common tab-switch case).
        if (nextLargeFile || lastAppliedLargeFile !== false) {
          monacoUtils.applyLargeFileEditorMode?.(monacoEditor, getDom().ideEditorHost, nextLargeFile, baseEditorOptions());
          lastAppliedLargeFile = nextLargeFile;
        }
        // A draft is read-only and numbers its own lines; the next file takes the editor back.
        const draft = doc.draft === true;
        if (draft || draftLocked) {
          const numbers = baseEditorOptions().lineNumbers;
          monacoEditor.updateOptions?.({ readOnly: draft, lineNumbers: draft && doc.lineNumbers && numbers !== 'off' ? doc.lineNumbers : numbers });
          draftLocked = draft;
        }
        return dispatchActiveFileChanged(normalizedPath);
      }
      const textarea = ensureFallbackBinding();
      if (textarea) {
        documents.runApplying(() => {
          textarea.value = doc.buffer;
          textarea.readOnly = doc.draft === true;
        });
        setFallbackVisible(true);
      }
      return dispatchActiveFileChanged(normalizedPath);
    }

    function getValue(path) { return docText(getDoc(path)); }

    // Inputs of the active-editor readers: the primary editor and its document,
    // or the invoking group editor while one of its actions runs; `followFocus`
    // readers (status strip, selection intents, chat context) take a focused group editor.
    function readInputs(followFocus) {
      const actionContext = groupEditors.getActionContext();
      if (actionContext) return { doc: getDoc(actionContext.path), monacoEditor: actionContext.editor, textarea: null };
      const group = followFocus ? getFocusedGroupPath() : '';
      if (group) return { doc: getDoc(group), monacoEditor: groupEditors.getFocusedEditor(), textarea: null };
      return { doc: getDoc(activePath), monacoEditor, textarea: getDom().ideEditorFallback || null };
    }

    function getFocusedPath() {
      const actionContext = groupEditors.getActionContext();
      return actionContext ? actionContext.path : getFocusedGroupPath() || activePath;
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

    // 1-based cursor line/column plus selected-character count for the
    // status bar. Monaco reports natively; the fallback derives from the
    // textarea's selection offsets.
    function getCursorInfo() {
      return editorReads.readCursorInfo?.(readInputs()) || null;
    }
    function getFocusedCursorInfo() {
      return editorReads.readCursorInfo?.(readInputs(true)) || null;
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
        if (doc.kind === 'diff') diffPane.setVisible(false);
        else if (doc.kind !== 'file') panes?.hideForClose(doc);
        else if (monacoEditor) monacoEditor.setModel(null);
      }
      // Monaco 0.52 asserts when a TextModel still attached to the DiffEditorWidget
      // is disposed (CMP-RENDER-0001): detach by identity, not active-tab state.
      diffPane.detachDocument(doc);
      // Same Monaco assert for a group editor still showing this model.
      if (doc.model) groupEditors.detachModel(doc.model);
      groupDiffs.detach(doc);
      documents.disposeModels(doc);
      panes?.release(normalizedPath, doc); documents.deleteDocument(normalizedPath);
      if (activePath === normalizedPath) activePath = '';
    }

    function getActivePath() {
      const actionContext = groupEditors.getActionContext();
      return actionContext ? actionContext.path : activePath;
    }

    function showEmpty() {
      activePath = '';
      lastAppliedLargeFile = null;
      if (monacoEditor) {
        monacoEditor.setModel(null);
      }
      diffPane.setVisible(false);
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
      diffPane.layout();
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

    function runFormat(editor) {
      const action = editor?.getAction?.('editor.action.formatDocument');
      return action && typeof action.run === 'function' ? Promise.resolve(action.run()).then(() => ({ supported: true, formatted: true })) : Promise.resolve({ supported: false, formatted: false });
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
      const doc = getDoc(String(path || '') || getFocusedPath());
      // Keep the file's own spaces/tabs choice (an explicit pick, or Monaco's detection).
      doc?.model?.updateOptions?.({ tabSize: next, insertSpaces: (doc.indent ? doc.indent.insertSpaces : doc.model.getOptions?.()?.insertSpaces) !== false });
      if (doc?.indent) doc.indent.tabSize = next;
      return true;
    }

    const pathOrFocused = (path) => String(path || '') || getFocusedPath();
    // Runs Monaco's convert-indentation action on the editor showing `path`, then records the result.
    function convertIndentation(path, to) {
      const target = pathOrFocused(path);
      const action = editorShowing(target)?.getAction?.(to === 'tabs' ? 'editor.action.indentationToTabs' : 'editor.action.indentationToSpaces');
      return action && typeof action.run === 'function' ? Promise.resolve(action.run()).then(() => documents.syncIndent(target)) : Promise.resolve(false);
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
      groupEditors.releaseAll();
      groupDiffs.dispose();
      groupEditors.clearActions();
      // Detach both editors before the model sweep (same Monaco assert as closeDocument).
      diffPane.detachModel(); monacoEditor?.setModel?.(null);
      documents.disposeAllModels();
      panes?.dispose();
      documents.clear();
      monacoEditor?.dispose?.();
      monacoEditor = null; markerSubscription?.dispose?.(); markerSubscription = null;
      diffPane.dispose();
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
      getPdfReadingContext,
      getPdfViewPosition,
      restorePdfView,
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
      showsPath: (path) => Boolean(editorShowing(path)), editorFor: (path) => editorShowing(path), // editorFor: row 82 G2 peek + blame
      hasDocument,
      isDirty,
      isUsingMonaco,
      layout,
      markSaved,
      onMarkersChanged,
      openBinaryDocument,
      openDiffDocument,
      openDocument,
      openDraftDocument,
      openImageDocument,
      revealPosition,
      revealTopLine,
      runAction,
      setEditorOptions,
      setBookmarkDecorations,
      setEol,
      setFollowDecorations: (path, decorations) => setLaneDecorations(path, 'followDecorationIds', decorations),
      setGutterDecorations,
      setTabSize,
      // Status-bar pickers: session-only per-tab language / indentation / encoding info.
      setLanguage: (path, id) => documents.setLanguage(pathOrFocused(path), id, monacoApi),
      setIndent: (path, indent) => documents.setIndent(pathOrFocused(path), indent),
      detectIndentation: (path, defaults) => documents.detectIndentation(pathOrFocused(path), defaults?.insertSpaces !== false, Number(defaults?.tabSize) || IDE_EDITOR_OPTIONS.tabSize),
      convertIndentation,
      getIndentInfo: (path) => documents.getIndentInfo(pathOrFocused(path), IDE_EDITOR_OPTIONS.tabSize),
      getEncodingInfo: (path) => ({ encoding: 'utf-8', bom: getDoc(pathOrFocused(path))?.bom === true }),
      setWordWrap,
      showEmpty,
      triggerGoToLine,
      writeDraftDocument,
    };
  }

  return {
    createIdeEditorHost,
  };
});
