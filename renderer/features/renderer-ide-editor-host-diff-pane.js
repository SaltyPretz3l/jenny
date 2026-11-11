/* renderer/features/renderer-ide-editor-host-diff-pane.js - the primary diff surface of
 * renderer-ide-editor-host.js (Monaco mode): the pane that overlays the regular editor inside
 * #ideEditorHost, the reused diff editor, the plain-text placeholder for changes whose original
 * snapshot is gone, and the first-change reveal. Split out of the host for the file-size
 * ceiling; the host owns the document map and the textarea fallback. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorHostDiffPane = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // deps: getDom; getMonaco() -> the Monaco API (null before boot); monacoUtils;
  // groupDiffUtils (revealFirstChangeOnce) + groupDiffs (getDiffSurface); fonts (the host's
  // font binding); getWrapMode() -> 'on' | 'off'.
  function createDiffPane(deps) {
    const { getDom, getMonaco, monacoUtils, groupDiffUtils, groupDiffs, fonts, getWrapMode } = deps;
    // One reused diff editor (created lazily on the first diff tab) swapped
    // over the regular editor inside the same host element.
    let diffEditor = null;
    let diffRevealSubscription = null;
    let diffPane = null;
    let diffEditorEl = null;
    let diffPlaceholderEl = null;

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
      const monacoApi = getMonaco();
      if (!monacoApi || typeof monacoApi.editor?.createDiffEditor !== 'function' || !ensureDiffPane()) {
        return null;
      }
      diffEditor = monacoApi.editor.createDiffEditor(diffEditorEl, fonts.withFont(
        { ...monacoUtils.IDE_DIFF_EDITOR_OPTIONS, wordWrap: getWrapMode() }, diffEditorEl?.ownerDocument,
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
      diffRevealSubscription = groupDiffUtils.revealFirstChangeOnce(diffEditor);
    }

    function setDiffPaneVisible(visible) {
      if (!visible && !diffPane) {
        return;
      }
      ensureDiffPane();
      diffPane?.classList.toggle('hidden', !visible);
    }

    // The Monaco branch of activating a diff document (the host handles the textarea fallback).
    function show(normalizedId, doc) {
      setDiffPaneVisible(true);
      if (doc.placeholderText) {
        diffPlaceholderEl.textContent = doc.placeholderText; diffPlaceholderEl.classList.toggle('nowrap', getWrapMode() === 'off');
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
    }

    // The wrap toggle reaches the placeholder's wrapping and the diff editor.
    function applyWrap(mode) {
      diffPlaceholderEl?.classList.toggle('nowrap', mode === 'off');
      diffEditor?.updateOptions?.({ wordWrap: mode });
    }

    function updateFontSize(fontSize) {
      diffEditor?.updateOptions?.({ fontSize });
    }

    function layout() {
      diffEditor?.layout?.();
    }

    // Monaco 0.52 asserts when a TextModel still attached to the DiffEditorWidget
    // is disposed (CMP-RENDER-0001). Switching tabs away only hides the diff pane
    // and leaves the models attached, so detach by identity, not active-tab state.
    function detachDocument(doc) {
      const attachedDiff = diffEditor?.getModel?.();
      if (attachedDiff && (attachedDiff.original === doc.originalModel || attachedDiff.modified === doc.modifiedModel)) {
        diffEditor.setModel(null);
      }
    }

    // Detach before the host's model sweep (same Monaco assert as detachDocument).
    function detachModel() {
      diffEditor?.setModel?.(null);
    }

    function dispose() {
      diffRevealSubscription?.dispose?.();
      diffRevealSubscription = null;
      diffEditor?.dispose?.();
      diffEditor = null;
      diffPane?.remove?.();
      diffPane = null;
      diffEditorEl = null;
      diffPlaceholderEl = null;
    }

    return {
      setVisible: setDiffPaneVisible, show, applyWrap, updateFontSize, layout, detachDocument, detachModel, dispose,
    };
  }

  return { createDiffPane };
});
