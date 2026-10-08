/* renderer/features/renderer-ide-editor-documents.js - the document side of the
 * IDE editor host: the per-open-file `docs` Map (Monaco models, fallback
 * buffers, dirty/saved versions, mtime, eol, large-file classification, diff
 * models) and the operations on it. It never touches an editor instance or the
 * DOM, so several editor views can share one document set. View state (the
 * Monaco editor, the diff editor, activePath, decorations, layout, focus) stays
 * in renderer-ide-editor-host.js. Per doc, Monaco mode holds models; fallback
 * mode holds plain string buffers; diff docs (kind 'diff') hold original and
 * modified fallback text until their Monaco models own it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorDocuments = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createEditorDocuments(deps) {
    const monacoUtils = deps?.monacoUtils || {};
    const onDirtyChange = typeof deps?.onDirtyChange === 'function' ? deps.onDirtyChange : () => {};
    const onModelChange = typeof deps?.onModelChange === 'function' ? deps.onModelChange : () => {};
    // Set while a programmatic setValue runs so the host's own model-change
    // listener ignores it (see isApplyingValue).
    let applyingValue = false;
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

    // The textarea reports LF breaks; the fallback buffer must carry the
    // document's own line endings (normalizes CRLF / lone CR / LF).
    function withEol(text, eol) {
      const lf = String(text || '').replace(/\r\n?/g, '\n');
      return eol === 'crlf' ? lf.replace(/\n/g, '\r\n') : lf;
    }

    function syncDirty(path) {
      const doc = getDoc(path);
      if (!doc || doc.kind === 'document') {
        return; // document panes report dirty through the panes module
      }
      const dirty = doc.model
        ? doc.model.getAlternativeVersionId() !== doc.savedAltVersionId
        : doc.buffer !== doc.savedBuffer;
      if (dirty !== doc.dirty) {
        doc.dirty = dirty;
        onDirtyChange(path, dirty);
      }
    }

    function docText(doc) {
      if (!doc) return '';
      return doc.model ? doc.model.getValue() : (doc.buffer ?? '');
    }

    // True while a programmatic setValue is running.
    function isApplyingValue() {
      return applyingValue;
    }

    // Creates (or refreshes) a file document. `monacoApi` is the live Monaco
    // API when the host runs Monaco (null on the textarea fallback path).
    // Content comes from workspaceFs.readFile; the store owns the buffer from
    // here until the document is deleted.
    function openFile({ path, content, mtimeMs, eol, monacoApi = null }) {
      const normalizedPath = String(path || '');
      const text = String(content ?? '');
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
      if (monacoApi) {
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
      return doc;
    }

    // Creates (or refreshes) a read-only diff review document; `languagePath`
    // only steers syntax highlighting, while the doc is keyed by `id` (a diff://
    // tab id). `placeholderText` switches the doc into its hunks-summary
    // fallback rendering (no side-by-side comparison).
    function openDiff({
      id,
      label = '',
      languagePath = '',
      original = '',
      modified = '',
      placeholderText = '',
    } = {}) {
      const normalizedId = String(id || '');
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
      doc.inlineDiff = typeof monacoUtils.classifyLargeFile === 'function'
        && (monacoUtils.classifyLargeFile(doc.original) === true || monacoUtils.classifyLargeFile(doc.modified) === true);
      if (doc.originalModel) {
        doc.originalModel.setValue(doc.original);
        doc.original = null;
      }
      if (doc.modifiedModel) {
        doc.modifiedModel.setValue(doc.modified);
        doc.modified = null;
      }
      return doc;
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
    // Document-pane docs (kind 'document') report saves through the panes module.
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

    function hasDocument(path) {
      return docs.has(String(path || ''));
    }

    function getDocumentKind(path) {
      const doc = getDoc(path);
      if (!doc) {
        return '';
      }
      return doc.kind === 'diff' || doc.kind === 'image' || doc.kind === 'document'
        ? doc.kind
        : 'file';
    }

    // Sets a document's end-of-line. doc.eol always tracks the choice so
    // getEol() stays truthful; under Monaco the model EOL changes, in the textarea
    // fallback the buffer is converted (either way a real change marks it dirty).
    // `monacoApi` is the live Monaco API (null on the fallback path).
    function setEol(path, eol, monacoApi = null) {
      const doc = getDoc(path);
      if (!doc) {
        return false;
      }
      const next = eol === 'crlf' ? 'crlf' : 'lf';
      doc.eol = next;
      const sequence = monacoApi?.editor?.EndOfLineSequence;
      if (doc.model && typeof doc.model.setEOL === 'function' && sequence) {
        doc.model.setEOL(next === 'crlf' ? sequence.CRLF : sequence.LF);
      } else if (doc.kind === 'file' && !doc.model && typeof doc.buffer === 'string') {
        doc.buffer = withEol(doc.buffer, next);
        syncDirty(String(path || ''));
        onModelChange(String(path || ''));
      }
      return true;
    }

    // Monaco 0.52 asserts when a TextModel still attached to a diff editor is
    // disposed, so the host detaches views first and then calls this.
    function disposeModels(doc) {
      doc?.model?.dispose?.();
      doc?.originalModel?.dispose?.();
      doc?.modifiedModel?.dispose?.();
    }

    function deleteDocument(path) {
      docs.delete(String(path || ''));
    }

    // Disposes every document's models (the host's dispose sweep).
    function disposeAllModels() {
      for (const doc of docs.values()) {
        disposeModels(doc);
      }
    }

    function clear() {
      docs.clear();
    }

    return {
      // The shared Map: the panes module and every editor view read the same one.
      docs,
      clear,
      deleteDocument,
      disposeAllModels,
      disposeModels,
      docText,
      getAltVersionId,
      getDoc,
      getDocumentKind,
      getEol,
      getMtime,
      hasDocument,
      isApplyingValue,
      isDirty,
      languageForPath,
      markSaved,
      openDiff,
      openFile,
      setEol,
      syncDirty,
      withEol,
    };
  }

  return {
    createEditorDocuments,
  };
});
