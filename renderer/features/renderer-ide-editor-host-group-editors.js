/* renderer/features/renderer-ide-editor-host-group-editors.js - the secondary editor-group
 * editors of renderer-ide-editor-host.js (row 40 W5): one lighter Monaco editor per group over
 * the same models, the editor actions every editor shares, the focused-group-editor and
 * action-context state the active-editor readers follow, and the "which editor shows this
 * path" lookup. Split out of the host for the file-size ceiling; the host owns the primary
 * editor, the document map and the public API. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostGroupEditors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // deps: getMonaco() / getPrimaryEditor() -> the Monaco API / primary editor (null before
  // boot); getActivePath() -> the primary's raw active path; isDisposed(); docs (the host's
  // document Map); getDoc; options (editor-host-options); fonts; monacoUtils; onCursorActivity;
  // getFocusedCursorInfo / getFocusedPath / dispatchActiveFileChanged (host readers).
  function createGroupEditors(deps) {
    const {
      getMonaco, getPrimaryEditor, getActivePath, isDisposed, docs, getDoc, options, fonts, monacoUtils,
      onCursorActivity, getFocusedCursorInfo, getFocusedPath, dispatchActiveFileChanged,
    } = deps;
    // Secondary editor-group editors (W5): each is a Monaco editor created by
    // createGroupEditor over the same models; the value holds its font
    // unregister, its action registrations (id -> disposable) and getPath.
    const groupEditors = new Map();
    // Every editor action contributed through addEditorAction (id -> descriptor),
    // so group editors created later get the same context-menu actions.
    const editorActions = new Map();
    // { editor, path } while a group editor runs an action: the active-editor
    // readers answer for that editor instead of the primary.
    let actionContext = null;
    // The group editor that last had focus (null: the primary); readers follow it.
    let focusedGroupEditor = null;

    // Secondary editor groups: a lighter Monaco editor per group, created with
    // the primary's options over the SAME models (the document store owns them).
    // Never triggers a Monaco load; null until the primary has booted.
    function createGroupEditor(el, { onSave, onFocus, getPath } = {}) {
      const monacoApi = getMonaco();
      if (!monacoApi || !el || isDisposed()) return null;
      const doc = el.ownerDocument;
      const editor = monacoApi.editor.create(el, fonts.withFont(options.baseEditorOptions(), doc));
      // The shared font binding only releases everything at once, so register
      // per editor here: a closed group must leave the typography observer.
      const unregisterFont = typeof monacoUtils.registerMonacoFontConsumer === 'function'
        ? monacoUtils.registerMonacoFontConsumer(editor, doc) : null;
      editor.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => { if (typeof onSave === 'function') onSave(); });
      editor.onDidFocusEditorWidget?.(() => { setFocusedGroupEditor(editor); if (typeof onFocus === 'function') onFocus(); });
      editor.onDidChangeCursorSelection?.(() => { if (focusedGroupEditor === editor) onCursorActivity(getFocusedCursorInfo()); });
      editor.onDidChangeModel?.(() => { if (focusedGroupEditor === editor) dispatchActiveFileChanged(getFocusedPath()); });
      const { minimap: _minimap, wordWrap: _wordWrap, ...levelOptions } = options.getLevelOptions();
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

    // The focused group editor's file, '' when the primary has focus or it shows nothing.
    function getFocusedGroupPath() {
      const model = groupEditors.has(focusedGroupEditor) && focusedGroupEditor.getModel?.();
      if (model) for (const [path, doc] of docs) if (doc.model === model) return path;
      return '';
    }
    function setFocusedGroupEditor(editor) {
      if (focusedGroupEditor === editor) return;
      focusedGroupEditor = editor;
      onCursorActivity(getFocusedCursorInfo());
      dispatchActiveFileChanged(getFocusedPath());
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
      const monacoEditor = getPrimaryEditor();
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

    function triggerGoToLine() {
      const editor = getFocusedGroupPath() ? focusedGroupEditor : getPrimaryEditor();
      if (!editor || typeof editor.trigger !== 'function') {
        return false;
      }
      editor.focus?.();
      editor.trigger('jenny-statusbar', 'editor.action.gotoLine', null);
      return true;
    }

    // The editor showing `path`: the primary while it is the active path, else a group editor over the model.
    function editorShowing(path) {
      const model = getDoc(path)?.model;
      if (!model) return null;
      return (getActivePath() === path ? getPrimaryEditor() : [...groupEditors.keys()].find((editor) => editor.getModel?.() === model)) || null;
    }

    // Monaco 0.52 asserts when a model is disposed while a group editor still shows it.
    function detachModel(model) {
      for (const editor of groupEditors.keys()) if (editor.getModel?.() === model) editor.setModel(null);
    }

    function updateOptions(applied) {
      for (const editor of groupEditors.keys()) editor.updateOptions?.(applied);
    }

    function releaseAll() {
      focusedGroupEditor = null;
      for (const editor of [...groupEditors.keys()]) releaseGroupEditor(editor);
    }

    return {
      createGroupEditor,
      releaseGroupEditor,
      addEditorAction,
      getFocusedGroupPath,
      setFocusedGroupEditor,
      getFocusedEditor: () => focusedGroupEditor,
      getActionContext: () => actionContext,
      triggerGoToLine,
      editorShowing,
      detachModel,
      updateOptions,
      releaseAll,
      clearActions: () => editorActions.clear(),
    };
  }

  return { createGroupEditors };
});
