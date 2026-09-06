/* renderer/features/renderer-ide-editor-reads.js - pure read accessors for the
 * IDE editor host. Selection / cursor / diagnostics view-models computed from a
 * live Monaco editor (or the textarea fallback) plus the active document. These
 * never mutate host state, so they live here to keep renderer-ide-editor-host.js
 * under the file-size ceiling - same precedent as composeFallbackDiffText in
 * renderer-monaco-editor-utils.js. Each function takes the ingredients the host
 * already has (the active doc, the live monacoEditor, the fallback textarea) and
 * returns the same view-model the host used to compute inline. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorReads = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Monaco MarkerSeverity is a stable numeric enum (Error=8/Warning=4/Info=2/Hint=1).
  const MARKER_SEVERITY = { 8: 'error', 4: 'warning', 2: 'info', 1: 'hint' };

  // 1-based cursor line/column plus selected-character count for the status bar.
  // Monaco reports natively; the fallback derives from the textarea's selection
  // offsets. Returns null when the active doc is not an editable file.
  function readCursorInfo({ doc, monacoEditor, textarea } = {}) {
    if (!doc || doc.kind !== 'file') {
      return null;
    }
    if (monacoEditor && doc.model) {
      const position = monacoEditor.getPosition?.();
      const selection = monacoEditor.getSelection?.();
      let selectedChars = 0;
      if (selection && !selection.isEmpty?.()) {
        selectedChars = (doc.model.getValueInRange?.(selection) || '').length;
      }
      return {
        lineNumber: position?.lineNumber || 1,
        column: position?.column || 1,
        selectedChars,
      };
    }
    if (!textarea) {
      return null;
    }
    const start = Number(textarea.selectionStart) || 0;
    const end = Number(textarea.selectionEnd) || 0;
    const caret = Math.max(start, end);
    const buffer = String(textarea.value || '');
    const before = buffer.slice(0, caret);
    const lastBreak = before.lastIndexOf('\n');
    return {
      lineNumber: before.split('\n').length,
      column: caret - lastBreak,
      selectedChars: Math.max(0, end - start),
    };
  }

  function readSelectedText({ doc, monacoEditor, textarea } = {}) {
    if (!doc || doc.kind !== 'file') {
      return '';
    }
    if (monacoEditor && doc.model) {
      const selection = monacoEditor.getSelection?.();
      if (!selection || selection.isEmpty?.()) {
        return '';
      }
      return doc.model.getValueInRange?.(selection) || '';
    }
    if (!textarea) {
      return '';
    }
    const start = Number(textarea.selectionStart) || 0;
    const end = Number(textarea.selectionEnd) || 0;
    return end > start ? String(textarea.value || '').slice(start, end) : '';
  }

  function readSelectionRange({ doc, monacoEditor, textarea, monacoUtils } = {}) {
    if (!doc || doc.kind !== 'file') {
      return null;
    }
    if (monacoEditor && doc.model) {
      const selection = monacoEditor.getSelection?.();
      if (!selection || selection.isEmpty?.()) {
        return null;
      }
      return { startLine: selection.startLineNumber, endLine: selection.endLineNumber };
    }
    if (!textarea) {
      return null;
    }
    const start = Number(textarea.selectionStart) || 0;
    const end = Number(textarea.selectionEnd) || 0;
    if (end <= start) {
      return null;
    }
    return monacoUtils.fallbackSelectionLines(String(textarea.value || ''), start, end);
  }

  // Character offset of a 1-based line/column inside a plain buffer, for the
  // textarea fallback path (Monaco addresses positions directly). Clamps past
  // the last line rather than running off the end of the buffer.
  function offsetForLineColumn(buffer, line, column) {
    const lines = String(buffer ?? '').split('\n');
    const targetLine = Math.min(Math.max(1, Number(line) || 1) - 1, lines.length - 1);
    let offset = 0;
    for (let index = 0; index < targetLine; index += 1) {
      offset += lines[index].length + 1;
    }
    return offset + Math.min(Math.max(1, Number(column) || 1) - 1, lines[targetLine].length);
  }

  // Path-centric diagnostics view-model for the Problems panel: file-model
  // markers only, mapped from the jenny-workspace model URI to a rel path.
  function readMarkers(monacoApi) {
    const editorApi = monacoApi?.editor;
    if (typeof editorApi?.getModelMarkers !== 'function') {
      return [];
    }
    return (editorApi.getModelMarkers({}) || []).flatMap((m) => {
      const resource = m && m.resource;
      // Uri.path is already percent-decoded: strip the leading slash only.
      const path = resource && resource.scheme === 'jenny-workspace'
        ? String(resource.path || '').replace(/^\/+/, '')
        : '';
      if (!path) { return []; }
      const code = m.code && typeof m.code === 'object' ? m.code.value : m.code;
      return [{
        path,
        severity: MARKER_SEVERITY[m.severity] || 'info',
        message: String(m.message || '').trim(),
        line: Number(m.startLineNumber) || 1,
        column: Number(m.startColumn) || 1,
        source: String(m.source || ''),
        code: String(code == null ? '' : code),
      }];
    });
  }

  return {
    readCursorInfo,
    readSelectedText,
    readSelectionRange,
    readMarkers,
    offsetForLineColumn,
  };
});
