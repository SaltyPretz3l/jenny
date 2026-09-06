/**
 * renderer/features/renderer-artifacts-render-markdown.js – markdown artifact
 * kind renderer (WS2 registry). Relocated verbatim from the surface
 * controller's renderMarkdownGeneratedArtifact + unavailable-state helpers;
 * the controller's legacy flag-off dispatch delegates here so both paths run
 * the identical implementation.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRenderMarkdown = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function renderMarkdownUnavailableState(surface, note, body, isError, deps) {
    const { escapeHtml, setDetailNote } = deps;
    setDetailNote(surface, note, isError);
    surface.previewContent.classList.remove('hidden');
    delete surface.previewContent.dataset.artifactDocumentSignature;
    surface.previewContent.innerHTML = `<div class="artifacts-empty">${escapeHtml(body)}</div>`;
    surface.editorShell.classList.add('hidden');
  }

  function getMarkdownUnavailableState(artifact, content, editable, deps) {
    const { state } = deps;
    if (state.artifacts.lastError) {
      return {
        note: state.artifacts.lastError,
        body: 'Artifact load failed. Use Reveal or Open External to inspect the file outside Jenny.',
        isError: true,
      };
    }
    const status = String(artifact?.status || '').trim().toLowerCase();
    if (status && status !== 'available') {
      return {
        note: 'Markdown artifact is unavailable in local storage.',
        body: 'This Markdown artifact is unavailable. Use Reveal or Open External if the file still exists.',
        isError: true,
      };
    }
    if (!editable && !String(content || '').trim()) {
      return {
        note: 'Markdown artifact is read-only or too large for inline rendering.',
        body: 'This Markdown artifact cannot be rendered inline. Use Reveal or Open External to inspect the file.',
        isError: false,
      };
    }
    return null;
  }

  function renderMarkdownGeneratedArtifact(surface, artifact, file, editable, deps) {
    const {
      state,
      setDetailNote,
      ensureEditor,
      getPreferredEditorValue,
      getArtifactDocumentViewMode,
      getArtifactDocumentRevision,
      getArtifactDocumentNode,
      buildMarkdownArtifactDocumentSignature,
      buildMarkdownArtifactDocumentHtml,
      decorateMarkdownArtifactDocument,
      updateArtifactDocumentProgress,
    } = deps;
    const mode = getArtifactDocumentViewMode(surface.key);
    const content = getPreferredEditorValue();
    const title = artifact.title || file?.title || 'Markdown Artifact';
    const unavailable = getMarkdownUnavailableState(artifact, content, editable, deps);
    if (unavailable && !state.artifacts.loading) {
      renderMarkdownUnavailableState(surface, unavailable.note, unavailable.body, unavailable.isError, deps);
      return;
    }
    if (state.artifacts.lastError) {
      setDetailNote(surface, state.artifacts.lastError, true);
    } else if (state.artifacts.loading) {
      setDetailNote(surface, 'Loading Markdown artifact...');
    } else if (mode === 'source') {
      setDetailNote(
        surface,
        editable
          ? 'Editing Markdown source. Save writes back to the session scratch file.'
          : 'Viewing read-only Markdown source.'
      );
    } else {
      setDetailNote(
        surface,
        editable
          ? 'Reading rendered Markdown. Switch to source to edit this artifact.'
          : 'Read-only rendered Markdown artifact.'
      );
    }

    surface.previewContent.classList.remove('hidden');
    const signature = buildMarkdownArtifactDocumentSignature({
      title,
      content,
      artifactId: file?.artifactId || artifact.id,
      contentRevision: getArtifactDocumentRevision(),
      mode,
      editable,
      surfaceKey: surface.key,
    });
    if (surface.previewContent.dataset.artifactDocumentSignature !== signature || !getArtifactDocumentNode(surface)) {
      surface.previewContent.dataset.artifactDocumentSignature = signature;
      surface.previewContent.innerHTML = buildMarkdownArtifactDocumentHtml({
        title,
        content,
        mode,
        editable,
        surfaceKey: surface.key,
      });
      decorateMarkdownArtifactDocument(surface.previewContent);
      if (typeof window !== 'undefined' && typeof window.markdownUtils?.renderInlineMermaidBlocks === 'function') {
        window.markdownUtils.renderInlineMermaidBlocks(surface.previewContent, { isStreaming: false });
      }
      if (typeof window !== 'undefined' && typeof window.markdownMathUtils?.renderMathInto === 'function') {
        window.markdownMathUtils.renderMathInto(surface.previewContent);
      }
    }
    updateArtifactDocumentProgress(surface);

    if (mode === 'source') {
      surface.editorShell.classList.remove('hidden');
      ensureEditor(surface.key)?.setDocument({
        value: content,
        language: file?.language || 'markdown',
        readOnly: !editable || state.artifacts.loading || Boolean(state.artifacts.lastError),
      }).catch(() => {});
    } else {
      surface.editorShell.classList.add('hidden');
    }
  }

  function renderMarkdownArtifactKind(ctx) {
    const { surface, artifact, file, editable, deps } = ctx;
    renderMarkdownGeneratedArtifact(surface, artifact, file, editable, deps);
  }

  return {
    renderMarkdownGeneratedArtifact,
    renderMarkdownArtifactKind,
  };
});
