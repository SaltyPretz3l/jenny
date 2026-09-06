/**
 * renderer/features/renderer-artifacts-render-image.js – image artifact kind
 * renderer (WS2 registry). Relocated verbatim from the surface controller's
 * image branch; the legacy flag-off dispatch delegates here. Image data-URL
 * caches and failure tracking stay controller-owned and arrive via deps.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRenderImage = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function renderImageArtifactKind(ctx) {
    const { surface, artifact, deps } = ctx;
    const {
      state,
      escapeHtml,
      setDetailNote,
      resolveImagePreviewUrl,
      hasImageArtifactLoadFailed,
      isGeneratedImageArtifactReadRequired,
    } = deps;
    const image = artifact.image || {};
    const previewUrl = resolveImagePreviewUrl(artifact);
    const missing = artifact.status === 'missing' || hasImageArtifactLoadFailed(artifact);
    const available = Boolean(previewUrl) && !missing;
    const loadingImage = isGeneratedImageArtifactReadRequired(artifact) && state.artifacts.loading;
    setDetailNote(
      surface,
      available
        ? 'Previewing the session image at full stage size.'
        : loadingImage
          ? 'Loading image preview...'
          : 'Image unavailable in local storage.',
      !available && !loadingImage
    );
    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    surface.previewContent.innerHTML = available
      ? `<div class="artifact-preview-image-shell"><img class="artifact-preview-image" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(image.displayName || artifact.title)}"></div>`
      : `<div class="artifacts-empty">${loadingImage ? 'Loading image preview...' : 'Image unavailable in local storage.'}</div>`;
  }

  return { renderImageArtifactKind };
});
