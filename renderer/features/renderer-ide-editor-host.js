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
    // Enable Monaco's ghost-text UX (Tab-to-accept). The actual suggestions come
    // from the InlineCompletionsProvider that renderer-ide-inline-suggest registers
    // only when the workspace_inline_suggest feature is on; with no provider this
    // option is inert, so it's safe to leave enabled unconditionally.
    inlineSuggest: { enabled: true },
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
    const imageHostUtils = deps?.imageHostUtils
      || globalRef.rendererIdeImageHost
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-image-host'); } catch (_error) { return null; }
      })() : null)
      || {};
    const previewHostUtils = deps?.previewHostUtils
      || globalRef.rendererIdePreviewHost
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-preview-host'); } catch (_error) { return null; }
      })() : null)
      || {};
    const imageMemory = (deps?.imageMemoryUtils || globalRef.rendererIdeImageMemory || (typeof require === 'function' ? (() => { try { return require('./renderer-ide-image-memory'); } catch (_error) { return null; } })() : null) || {}).createImageMemory?.({ getWindow: () => getDom().ideEditorHost?.ownerDocument?.defaultView || null, ...deps?.imageMemoryOptions }) || null; // UIUX-034
    // Pure selection/cursor/diagnostics read accessors (extracted for the
    // file-size ceiling); the host wraps them with its live state below.
    const editorReads = deps?.editorReads
      || globalRef.rendererIdeEditorReads
      || (typeof require === 'function' ? (() => {
        try { return require('./renderer-ide-editor-reads'); } catch (_error) { return null; }
      })() : null)
      || {};
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onSaveRequest = typeof deps?.onSaveRequest === 'function' ? deps.onSaveRequest : () => {};
    // Fires once when Monaco actually boots (never on the textarea fallback
    // path) - the controller hangs the palette theme bridge off this.
    const onMonacoReady = typeof deps?.onMonacoReady === 'function' ? deps.onMonacoReady : () => {};
    // Cursor/selection movement in the Monaco editor (status-bar feed). The
    // fallback textarea has no reliable cursor events; the status bar pulls
    // getCursorInfo() on its other refresh triggers instead.
    const onCursorActivity = typeof deps?.onCursorActivity === 'function' ? deps.onCursorActivity : () => {};
    // Buffer edits (Monaco + fallback). The preview controller debounces
    // live preview re-renders off this.
    const onModelChange = typeof deps?.onModelChange === 'function' ? deps.onModelChange : () => {};
    // A click in the editor's glyph-margin lane (1-based line). The controller
    // routes it to the bookmark toggle; no-op on the textarea fallback path.
    const onGlyphMarginClick = typeof deps?.onGlyphMarginClick === 'function'
      ? deps.onGlyphMarginClick
      : () => {};
    // Runs after sanitized preview HTML lands in the pane (mermaid pass).
    const onPreviewDomInjected = typeof deps?.onPreviewDomInjected === 'function'
      ? deps.onPreviewDomInjected
      : () => {};

    let monacoApi = null;
    let monacoEditor = null;
    // One reused diff editor (created lazily on the first diff tab) swapped
    // over the regular editor inside the same host element.
    let diffEditor = null;
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
    // Image preview pane (W7): overlays the editor like the diff pane; the
    // pane module owns its DOM, this host owns the image documents.
    const imagePane = imageHostUtils.createIdeImagePane?.({
      getHost: () => getDom().ideEditorHost || null,
    }) || null;
    // Markdown/Mermaid preview pane (W8): same overlay technique.
    const previewPane = previewHostUtils.createIdePreviewPane?.({
      getHost: () => getDom().ideEditorHost || null,
      postRender: (containerEl) => onPreviewDomInjected(containerEl),
    }) || null;
    // Per-open-file bookkeeping. Monaco mode: docs hold models + view states.
    // Fallback mode: docs hold plain string buffers. Diff docs (kind 'diff')
    // hold original/modified text plus their own pair of Monaco models.
    const docs = new Map(); // path -> { kind, model, viewState, savedAltVersionId, buffer, savedBuffer, mtimeMs, eol, dirty, ... }

    function getDoc(path) {
      return docs.get(String(path || '')) || null;
    }

    function languageForPath(path) {
      const name = String(path || '').split('/').pop() || '';
      const dotIndex = name.lastIndexOf('.');
      const extension = dotIndex > 0 ? name.slice(dotIndex + 1) : '';
      return typeof monacoUtils.normalizeEditorLanguage === 'function'
        ? monacoUtils.normalizeEditorLanguage(extension)
        : 'plaintext';
    }

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
          if (applyingValue || !activePath) {
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
        monacoUtils.IDE_DIFF_EDITOR_OPTIONS, diffEditorEl?.ownerDocument,
      ));
      // A diff editor is a pair of editors behind one facade; register both
      // sides so a typography change retunes original as well as modified.
      fonts.register(diffEditor.getOriginalEditor?.(), diffEditorEl?.ownerDocument);
      fonts.register(diffEditor.getModifiedEditor?.(), diffEditorEl?.ownerDocument);
      return diffEditor;
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
        if (applyingValue || !activePath) {
          return;
        }
        const doc = getDoc(activePath);
        if (doc) {
          doc.buffer = String(textarea.value || '');
        }
        syncDirty(activePath);
        onModelChange(activePath);
      };
      textarea.addEventListener('input', fallbackInputHandler);
      return textarea;
    }

    function syncDirty(path) {
      const doc = getDoc(path);
      if (!doc) {
        return;
      }
      const dirty = doc.model
        ? doc.model.getAlternativeVersionId() !== doc.savedAltVersionId
        : doc.buffer !== doc.savedBuffer;
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        onDirtyChange(path, dirty);
      }
    }

    // Loads (or refreshes) a document. Content comes from workspaceFs.readFile;
    // the host owns the buffer from here until closeDocument.
    async function openDocument({ path, content, mtimeMs, eol, shouldApply = null, onApplied = null }) {
      const normalizedPath = String(path || '');
      const text = String(content ?? '');
      const hasMonaco = await ensureEditor(); if (disposalFence.isDisposed() || (typeof shouldApply === 'function' && shouldApply() !== true)) return null;
      let doc = getDoc(normalizedPath); const wasDirty = doc?.dirty === true;
      if (!doc) {
        doc = {
          kind: 'file',
          model: null,
          viewState: null,
          savedAltVersionId: 0,
          buffer: text,
          savedBuffer: text,
          mtimeMs: Number(mtimeMs) || 0,
          eol: eol === 'crlf' ? 'crlf' : 'lf',
          dirty: false,
        };
        docs.set(normalizedPath, doc);
      } else {
        doc.buffer = text;
        doc.savedBuffer = text;
        doc.mtimeMs = Number(mtimeMs) || doc.mtimeMs;
        doc.eol = eol === 'crlf' ? 'crlf' : 'lf';
      }
      // Large/minified files: degrade Monaco chrome + exclude from auto-context.
      // Cache the O(n) classification per-doc keyed by a content fingerprint (not
      // just length, so a same-length rewrite recomputes); re-scan only on change.
      const scanKey = monacoUtils.fingerprintText ? monacoUtils.fingerprintText(text) : text.length;
      if (doc.largeFileScanKey !== scanKey || typeof doc.largeFile !== 'boolean') {
        doc.largeFile = monacoUtils.classifyLargeFile
          ? monacoUtils.classifyLargeFile(text) === true : false;
        doc.largeFileScanKey = scanKey;
      }
      if (hasMonaco && monacoApi) {
        if (!doc.model) {
          const uri = monacoApi.Uri.parse(monacoUtils.workspacePathToMonacoUriString(normalizedPath));
          doc.model = monacoApi.editor.getModel?.(uri)
            || monacoApi.editor.createModel(text, languageForPath(normalizedPath), uri);
        } else if (doc.model.getValue() !== text) {
          applyingValue = true;
          try {
            doc.model.setValue(text);
          } finally {
            applyingValue = false;
          }
        }
        // Monaco owns the text now; every remaining doc.buffer reader is fallback-only.
        doc.buffer = null;
        doc.savedBuffer = null;
        doc.savedAltVersionId = doc.model.getAlternativeVersionId();
      }
      doc.dirty = false; if (wasDirty) onDirtyChange(normalizedPath, false);
      if (typeof onApplied === 'function') onApplied();
      return doc;
    }

    // Loads a read-only diff review document; `languagePath` only steers syntax highlighting, while the doc is keyed by `id`
    // (a diff:// tab id). `placeholderText` switches the doc into its
    // hunks-summary fallback rendering (no side-by-side comparison).
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
      let doc = getDoc(normalizedId);
      if (!doc) {
        doc = {
          kind: 'diff',
          model: null,
          originalModel: null,
          modifiedModel: null,
          viewState: null,
          savedAltVersionId: 0,
          buffer: '',
          savedBuffer: '',
          mtimeMs: 0,
          eol: 'lf',
          dirty: false,
        };
        docs.set(normalizedId, doc);
      }
      doc.label = String(label || doc.label || 'Diff');
      doc.language = languageForPath(languagePath);
      doc.placeholderText = String(placeholderText || '');
      doc.original = String(original ?? '');
      doc.modified = String(modified ?? '');
      if (doc.originalModel) {
        doc.originalModel.setValue(doc.original);
      }
      if (doc.modifiedModel) {
        doc.modifiedModel.setValue(doc.modified);
      }
      return doc;
    }

    // Loads (or refreshes after an external change) an image document from a
    // workspaceFs.readFileBase64 payload. Never touches Monaco models.
    function openImageDocument({ path, base64, mime, size, mtimeMs } = {}) {
      const normalizedPath = String(path || '');
      if (!normalizedPath) {
        return null;
      }
      let doc = getDoc(normalizedPath);
      if (!doc) {
        doc = { kind: 'image', model: null, viewState: null, dirty: false };
        docs.set(normalizedPath, doc);
      }
      imageMemory?.applyPayload(doc, { base64, mime }); imageMemory?.registerOpen(normalizedPath, closeDocument);
      doc.size = Number(size) || 0;
      doc.mtimeMs = Number(mtimeMs) || 0;
      doc.naturalWidth = 0;
      doc.naturalHeight = 0;
      return doc;
    }

    function activateImageDocument(normalizedPath, doc) {
      activePath = normalizedPath; imageMemory?.touch(normalizedPath);
      setDiffPaneVisible(false); previewPane?.hide();
      // The pane lives inside #ideEditorHost, so that element must stay
      // visible even on the fallback (no-Monaco) path.
      setFallbackVisible(false);
      imagePane?.show(doc);
      return true;
    }

    // ── Markdown/Mermaid preview documents (W8) ──

    function openPreviewDocument({ id, label = '', sourcePath = '' } = {}) {
      const normalizedId = String(id || '');
      if (!normalizedId) {
        return null;
      }
      let doc = getDoc(normalizedId);
      if (!doc) {
        doc = { kind: 'preview', model: null, viewState: null, dirty: false, html: '' };
        docs.set(normalizedId, doc);
      }
      doc.id = normalizedId;
      doc.label = String(label || doc.label || 'Preview');
      doc.sourcePath = String(sourcePath || doc.sourcePath || '');
      return doc;
    }

    // Stores sanitized HTML; re-injects live when this preview is visible.
    function updatePreview(id, html) {
      const doc = getDoc(id);
      if (!doc || doc.kind !== 'preview') {
        return false;
      }
      doc.html = String(html || '');
      previewPane?.update(doc);
      return true;
    }

    function activatePreviewDocument(normalizedId, doc) {
      activePath = normalizedId;
      setDiffPaneVisible(false); imagePane?.hide(); setFallbackVisible(false);
      previewPane?.show(doc);
      return true;
    }

    function activateDiffDocument(normalizedId, doc) {
      activePath = normalizedId;
      if (monacoApi && monacoEditor) {
        setDiffPaneVisible(true);
        if (doc.placeholderText) {
          diffPlaceholderEl.textContent = doc.placeholderText; diffPlaceholderEl.classList.toggle('nowrap', wordWrapMode === 'off');
          diffPlaceholderEl.classList.remove('hidden');
          diffEditorEl.classList.add('hidden');
        } else if (ensureDiffEditor()) {
          if (!doc.originalModel) {
            doc.originalModel = monacoApi.editor.createModel(doc.original, doc.language);
          }
          if (!doc.modifiedModel) {
            doc.modifiedModel = monacoApi.editor.createModel(doc.modified, doc.language);
          }
          diffEditor.setModel({ original: doc.originalModel, modified: doc.modifiedModel });
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
      globalRef.rendererIdeActiveEditorReader = { getActivePath, getCursorInfo, getValue, getActiveLanguageId, getDocumentKind, isLargeFile: () => getDoc(activePath)?.largeFile === true };
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
      if (doc.kind === 'image') {
        return activateImageDocument(normalizedPath, doc) && dispatchActiveFileChanged(normalizedPath);
      }
      if (doc.kind === 'preview') {
        return activatePreviewDocument(normalizedPath, doc) && dispatchActiveFileChanged(normalizedPath);
      }
      imagePane?.hide(); previewPane?.hide();
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

    function docText(doc) {
      if (!doc) return '';
      return doc.model ? doc.model.getValue() : (doc.buffer ?? '');
    }
    function getValue(path) { return docText(getDoc(path)); }

    function getSelectedText() {
      return editorReads.readSelectedText?.({
        doc: getDoc(activePath), monacoEditor, textarea: getDom().ideEditorFallback || null,
      }) || '';
    }

    function getSelectionRange() {
      return editorReads.readSelectionRange?.({
        doc: getDoc(activePath), monacoEditor, textarea: getDom().ideEditorFallback || null, monacoUtils,
      }) || null;
    }

    function getActiveLanguageId() {
      const doc = getDoc(activePath);
      if (!doc || doc.kind !== 'file') {
        return '';
      }
      return doc.model?.getLanguageId?.() || languageForPath(activePath);
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
    // reaching into the host-private Monaco instance. No-op until Monaco
    // boots; callers register from onMonacoReady.
    function addEditorAction(descriptor) {
      if (!monacoEditor || typeof monacoEditor.addAction !== 'function' || !descriptor) {
        return null;
      }
      return monacoEditor.addAction(descriptor);
    }

    // 1-based cursor line/column plus selected-character count for the
    // status bar. Monaco reports natively; the fallback derives from the
    // textarea's selection offsets.
    function getCursorInfo() {
      return editorReads.readCursorInfo?.({
        doc: getDoc(activePath), monacoEditor, textarea: getDom().ideEditorFallback || null,
      }) || null;
    }

    function triggerGoToLine() {
      if (!monacoEditor || typeof monacoEditor.trigger !== 'function') {
        return false;
      }
      monacoEditor.focus?.();
      monacoEditor.trigger('jenny-statusbar', 'editor.action.gotoLine', null);
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
      }
      if (next.minimap && typeof next.minimap === 'object' && typeof next.minimap.enabled === 'boolean') {
        minimapEnabled = next.minimap.enabled;
        applied.minimap = { ...next.minimap, enabled: minimapEnabled && getDoc(activePath)?.largeFile !== true };
      }
      monacoEditor?.updateOptions?.(applied);
    }

    function getEol(path) {
      return getDoc(path)?.eol || 'lf';
    }

    function isDirty(path) {
      return getDoc(path)?.dirty === true;
    }

    function getMtime(path) {
      return getDoc(path)?.mtimeMs || 0;
    }

    // The active doc's dirty-tracking token (Monaco's alternative-version-id),
    // captured by the save caller BEFORE its async write so markSaved can record
    // the version that was actually written rather than re-reading a newer one
    // post-write. Returns null on the textarea fallback path (no model).
    function getAltVersionId(path) {
      const doc = getDoc(path);
      return doc?.model ? doc.model.getAlternativeVersionId() : null;
    }

    // Called after a successful workspaceFs.writeFile round-trip. `savedVersionId`
    // / `savedContent` are the version + buffer snapshot taken just before the
    // write began: using them (instead of re-reading the model/buffer now) keeps
    // an edit that landed DURING the async write dirty, so it is never silently
    // marked saved and lost — load-bearing for auto-save, which writes unattended.
    function markSaved(path, { mtimeMs, savedVersionId, savedContent } = {}) {
      const doc = getDoc(path);
      if (!doc) {
        return;
      }
      if (doc.model) {
        doc.savedAltVersionId = savedVersionId != null
          ? savedVersionId
          : doc.model.getAlternativeVersionId();
      } else {
        doc.savedBuffer = savedContent != null ? String(savedContent) : docText(doc);
      }
      doc.mtimeMs = Number(mtimeMs) || doc.mtimeMs;
      syncDirty(path);
    }

    function closeDocument(path) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc) return;
      if (activePath === normalizedPath) {
        if (doc.kind === 'diff') setDiffPaneVisible(false);
        else if (doc.kind === 'image') imagePane?.hide();
        else if (doc.kind === 'preview') previewPane?.hide();
        else if (monacoEditor) monacoEditor.setModel(null);
      }
      // Monaco 0.52 asserts when a TextModel still attached to the DiffEditorWidget
      // is disposed (CMP-RENDER-0001). Switching tabs away only hides the diff pane
      // and leaves the models attached, so detach by identity, not active-tab state.
      const attachedDiff = diffEditor?.getModel?.();
      if (attachedDiff && (attachedDiff.original === doc.originalModel || attachedDiff.modified === doc.modifiedModel)) {
        diffEditor.setModel(null);
      }
      doc.model?.dispose?.();
      doc.originalModel?.dispose?.();
      doc.modifiedModel?.dispose?.();
      if (doc.kind === 'image') imageMemory?.discard(normalizedPath, doc); docs.delete(normalizedPath);
      if (activePath === normalizedPath) activePath = '';
    }

    function hasDocument(path) {
      return docs.has(String(path || ''));
    }

    function getDocumentKind(path) {
      const doc = getDoc(path);
      if (!doc) {
        return '';
      }
      return doc.kind === 'diff' || doc.kind === 'image' || doc.kind === 'preview'
        ? doc.kind
        : 'file';
    }

    function getActivePath() {
      return activePath;
    }

    function showEmpty() {
      activePath = '';
      lastAppliedLargeFile = null;
      if (monacoEditor) {
        monacoEditor.setModel(null);
      }
      setDiffPaneVisible(false);
      imagePane?.hide(); previewPane?.hide();
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
    function revealPosition(path, lineNumber, column) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc || activePath !== normalizedPath) {
        return false;
      }
      const line = Math.max(1, Number(lineNumber) || 1);
      const col = Math.max(1, Number(column) || 1);
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

    // Restores a captured view state onto a document - immediately when active,
    // otherwise stashed for the next activation. No-op without Monaco.
    function applyViewState(path, viewState) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      if (!doc || !viewState) {
        return false;
      }
      doc.viewState = viewState;
      if (monacoEditor && activePath === normalizedPath && doc.model) {
        monacoEditor.restoreViewState(viewState);
      }
      return true;
    }

    // Active model's indent width, falling back to the IDE default when there
    // is no live Monaco model (fallback textarea path).
    function getTabSize() {
      const doc = getDoc(activePath);
      const size = Number(doc?.model?.getOptions?.()?.tabSize);
      return size > 0 ? size : IDE_EDITOR_OPTIONS.tabSize;
    }

    function setTabSize(size) {
      const next = Number(size);
      if (!(next > 0)) {
        return false;
      }
      getDoc(activePath)?.model?.updateOptions?.({ tabSize: next, insertSpaces: true });
      return true;
    }

    // Sets a document's end-of-line. doc.eol always tracks the choice so
    // getEol() stays truthful; the Monaco model EOL only changes under Monaco
    // (changing EOL marks the buffer dirty).
    function setEol(path, eol) {
      const doc = getDoc(String(path || '') || activePath);
      if (!doc) {
        return false;
      }
      const next = eol === 'crlf' ? 'crlf' : 'lf';
      doc.eol = next;
      const sequence = monacoApi?.editor?.EndOfLineSequence;
      if (doc.model && typeof doc.model.setEOL === 'function' && sequence) {
        doc.model.setEOL(next === 'crlf' ? sequence.CRLF : sequence.LF);
      }
      return true;
    }

    function dispose() {
      editorGate.bump(); disposalFence.dispose();
      const fallback = getDom().ideEditorFallback || null;
      if (fallbackBound && fallbackInputHandler) fallback?.removeEventListener('input', fallbackInputHandler);
      fallbackBound = false; fallbackInputHandler = null;
      // Release font handles first: the observer must not reach an editor
      // that the sweep below is about to tear down.
      fonts.release();
      // Detach both editors before the model sweep (same Monaco assert as closeDocument).
      diffEditor?.setModel?.(null); monacoEditor?.setModel?.(null);
      for (const doc of docs.values()) {
        doc.model?.dispose?.();
        doc.originalModel?.dispose?.();
        doc.modifiedModel?.dispose?.(); if (doc.kind === 'image') imageMemory?.release(doc);
      }
      docs.clear();
      imagePane?.dispose();
      previewPane?.dispose();
      monacoEditor?.dispose?.();
      monacoEditor = null; markerSubscription?.dispose?.(); markerSubscription = null;
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
      dispose,
      focus,
      getActiveLanguageId,
      getActivePath,
      getAltVersionId,
      getCursorInfo,
      getDocumentKind,
      getEol,
      getMarkers,
      getViewState,
      getMtime,
      getSelectedText,
      getSelectionRange,
      getTabSize,
      getValue,
      // Thin accessors for save-time hygiene: live model, large-file flag, and a
      // format pass that returns its promise and never refocuses (unlike runAction).
      getModel: (path) => getDoc(path)?.model || null,
      getMonaco: () => monacoApi,
      isLargeFile: (path) => getDoc(path)?.largeFile === true,
      formatActive: () => { const action = monacoEditor?.getAction?.('editor.action.formatDocument'); return action && typeof action.run === 'function' ? Promise.resolve(action.run()).then(() => ({ supported: true, formatted: true })) : Promise.resolve({ supported: false, formatted: false }); },
      hasDocument,
      isDirty,
      isUsingMonaco,
      layout,
      markSaved,
      onMarkersChanged,
      openDiffDocument,
      openDocument,
      openImageDocument,
      openPreviewDocument,
      revealPosition,
      runAction,
      setEditorOptions,
      setBookmarkDecorations,
      setEol,
      setGutterDecorations,
      setTabSize,
      setWordWrap,
      showEmpty,
      triggerGoToLine,
      updatePreview,
    };
  }

  return {
    createIdeEditorHost,
  };
});
