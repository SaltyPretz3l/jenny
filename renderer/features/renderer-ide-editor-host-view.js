/* renderer/features/renderer-ide-editor-host-view.js - cursor reveal and view-state capture for
 * renderer-ide-editor-host.js: moving the cursor to a line/column (find-in-files, problems),
 * the Monaco view state (cursor + scroll + folds) behind reopen-closed-tab, tab restore and
 * hot exit, and the exact top-line restore. Split out of the host for the file-size ceiling;
 * the host owns the editors and the document map and hands in live accessors. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // deps: getDom; getDoc; getActivePath() / getPrimaryEditor() -> the primary's raw active path
  // and editor; editorShowing(path); editorReads; isTextDocument(path); getCursorInfo().
  function createEditorView(deps) {
    const { getDom, getDoc, getActivePath, getPrimaryEditor, editorShowing, editorReads, isTextDocument, getCursorInfo } = deps;

    // Moves the cursor to a 1-based line/column in the active document (used
    // by find-in-files result clicks). The document must already be active.
    function revealPosition(path, lineNumber, column) {
      const normalizedPath = String(path || '');
      const doc = getDoc(normalizedPath);
      const line = Math.max(1, Number(lineNumber) || 1);
      const col = Math.max(1, Number(column) || 1);
      const activePath = getActivePath();
      const monacoEditor = getPrimaryEditor();
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
      if (getPrimaryEditor() && getActivePath() === normalizedPath && doc.model) {
        return getPrimaryEditor().saveViewState();
      }
      return doc.viewState || null;
    }

    function getViewLines(path) {
      if (!isTextDocument(path)) return null;
      const view = editorShowing(path)?.saveViewState?.() || getViewState(path);
      return { line: view?.cursorState?.[0]?.position?.lineNumber || (getActivePath() === path ? getCursorInfo()?.lineNumber : 1) || 1,
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

    return { revealPosition, getViewState, getViewLines, revealTopLine, applyViewState };
  }

  return { createEditorView };
});
