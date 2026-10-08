/* Secondary diff editors share the host's document models and preferences. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostGroupDiff = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createGroupDiffHost(deps) {
    const editors = new Map();

    function createGroupDiffEditor(el, { onFocus } = {}) {
      const monaco = deps.getMonaco();
      if (!monaco || !el || deps.isDisposed()) return null;
      const editor = monaco.editor.createDiffEditor(el, deps.fonts.withFont(deps.getOptions(), el.ownerDocument));
      const registrations = [];
      for (const side of [editor.getOriginalEditor(), editor.getModifiedEditor()]) {
        registrations.push(deps.registerFont?.(side, el.ownerDocument));
        const subscription = side.onDidFocusEditorWidget?.(() => { if (typeof onFocus === 'function') onFocus(); });
        registrations.push(() => subscription?.dispose?.());
      }
      editors.set(editor, registrations);
      return editor;
    }

    function releaseGroupDiffEditor(editor) {
      if (!editors.has(editor)) return;
      for (const unregister of editors.get(editor)) unregister?.();
      editors.delete(editor);
      editor.setModel(null);
      editor.dispose();
    }

    function getDiffSurface(id) {
      const doc = deps.getDoc(id), monaco = deps.getMonaco();
      if (doc?.kind !== 'diff') return null;
      if (!doc.placeholderText && monaco) {
        if (!doc.originalModel) {
          doc.originalModel = monaco.editor.createModel(doc.original, doc.language);
          doc.original = null;
        }
        if (!doc.modifiedModel) {
          doc.modifiedModel = monaco.editor.createModel(doc.modified, doc.language);
          doc.modified = null;
        }
      }
      return { original: doc.originalModel, modified: doc.modifiedModel, placeholderText: doc.placeholderText, inlineDiff: doc.inlineDiff };
    }

    function detach(doc) {
      for (const editor of editors.keys()) {
        const pair = editor.getModel();
        if (pair && (pair.original === doc.originalModel || pair.modified === doc.modifiedModel)) editor.setModel(null);
      }
    }

    function updateOptions(options) {
      for (const editor of editors.keys()) editor.updateOptions(options);
    }

    function dispose() {
      for (const editor of [...editors.keys()]) releaseGroupDiffEditor(editor);
    }

    return { createGroupDiffEditor, releaseGroupDiffEditor, getDiffSurface, detach, updateOptions, dispose };
  }

  return { createGroupDiffHost };
});
