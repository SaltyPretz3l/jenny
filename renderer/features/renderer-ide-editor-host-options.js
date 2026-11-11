/* renderer/features/renderer-ide-editor-host-options.js - the editor-level option set of
 * renderer-ide-editor-host.js: the frozen Monaco defaults and the live wrap / minimap /
 * applied-preference state that every editor (primary, group, diff) starts from. Split out of
 * the host for the file-size ceiling; the host composes it and keeps its public API. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostOptions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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

  // deps: monacoUtils; getEditor() -> the primary Monaco editor (null before boot);
  // getDiffPane() / getGroupEditors() / getGroupDiffs() -> the sibling surfaces setEditorOptions
  // fans out to (thunks: they are built after this); isActiveLargeFile() -> the active
  // primary document is in large-file mode.
  function createEditorOptions(deps) {
    const { monacoUtils } = deps;
    let wordWrapMode = 'off';
    let minimapEnabled = IDE_EDITOR_OPTIONS.minimap.enabled;
    // The editor-level preferences last applied (font size, line numbers, whitespace):
    // a group editor created later starts from them, not from the shared code size.
    let editorLevelOptions = {};
    // The full editor options: the applied preferences (so a large-file restore keeps them) plus the session wrap + minimap.
    const baseEditorOptions = () => ({ ...IDE_EDITOR_OPTIONS, ...editorLevelOptions, wordWrap: wordWrapMode, minimap: { enabled: minimapEnabled } });
    const getWrapMode = () => wordWrapMode;
    const getLevelOptions = () => editorLevelOptions;
    const getDiffOptions = () => ({ ...monacoUtils.IDE_DIFF_EDITOR_OPTIONS, ...editorLevelOptions, wordWrap: wordWrapMode });

    function setWordWrap(mode) {
      setEditorOptions({ wordWrap: mode === 'on' ? 'on' : 'off' });
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
        wordWrapMode = next.wordWrap === 'on' ? 'on' : 'off';
        // The diff editor is a separate instance: the wrap toggle reaches it too.
        deps.getDiffPane().applyWrap(wordWrapMode);
      }
      if (next.minimap && typeof next.minimap === 'object' && typeof next.minimap.enabled === 'boolean') {
        minimapEnabled = next.minimap.enabled;
        applied.minimap = { ...next.minimap, enabled: minimapEnabled && !deps.isActiveLargeFile() };
      }
      deps.getEditor()?.updateOptions?.(applied);
      editorLevelOptions = { ...editorLevelOptions, ...applied };
      // Group editors follow the preference only (the large-file override is per active primary doc).
      const groupApplied = applied.minimap ? { ...applied, minimap: { ...applied.minimap, enabled: minimapEnabled } } : applied;
      deps.getGroupEditors().updateOptions(groupApplied);
      deps.getGroupDiffs().updateOptions(groupApplied);
      // The diff editor is a separate instance; without this the editor font
      // size never reached diffs.
      if (typeof next.fontSize === 'number') deps.getDiffPane().updateFontSize(next.fontSize);
    }

    return { baseEditorOptions, getWrapMode, getLevelOptions, getDiffOptions, setWordWrap, setEditorOptions };
  }

  return { IDE_EDITOR_OPTIONS, createEditorOptions };
});
