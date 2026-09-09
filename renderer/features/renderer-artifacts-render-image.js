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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
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
        ? jt('artifacts.image.previewingFullStage', 'Previewing the session image at full stage size.')
        : loadingImage
          ? jt('artifacts.image.loadingPreview', 'Loading image preview...')
          : jt('artifacts.image.unavailableInLocalStorage', 'Image unavailable in local storage.'),
      !available && !loadingImage
    );
    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    surface.previewContent.innerHTML = available
      ? '<div class="artifact-preview-image-shell"><img class="artifact-preview-image" src="{src}" alt="{alt}"></div>'.replace('{src}', () => escapeHtml(previewUrl)).replace('{alt}', () => escapeHtml(jt('artifacts.image.previewAlt', '{name}', { name: image.displayName || artifact.title })))
      : `<div class="artifacts-empty">${escapeHtml(loadingImage ? jt('artifacts.image.loadingPreview', 'Loading image preview...') : jt('artifacts.image.unavailableInLocalStorage', 'Image unavailable in local storage.'))}</div>`;
  }

  return { renderImageArtifactKind };
});
