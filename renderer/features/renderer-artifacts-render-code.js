/**
 * renderer/features/renderer-artifacts-render-code.js – code (generic
 * generated-file) artifact kind renderer (WS2 registry). Relocated verbatim
 * from the surface controller's generated-file editor branch; the legacy
 * flag-off dispatch delegates here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRenderCode = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function renderCodeArtifactKind(ctx) {
    const { surface, file, editable, deps } = ctx;
    const { state, setDetailNote, ensureEditor, getPreferredEditorValue } = deps;
    if (state.artifacts.lastError) {
      setDetailNote(surface, state.artifacts.lastError, true);
    } else if (state.artifacts.loading) {
      setDetailNote(surface, 'Loading artifact...');
    } else if (editable) {
      setDetailNote(surface, 'Stage editor is ready. Save writes changes back to the session scratch file.');
    } else {
      setDetailNote(surface, 'Read-only artifact. Reveal or open externally to continue editing.');
    }
    surface.editorShell.classList.remove('hidden');
    surface.previewContent.classList.add('hidden');
    ensureEditor(surface.key)?.setDocument({
      value: getPreferredEditorValue(),
      language: file?.language || 'plaintext',
      readOnly: !editable || state.artifacts.loading || Boolean(state.artifacts.lastError),
    }).catch(() => {}); /* fire-and-forget */
  }

  return { renderCodeArtifactKind };
});
