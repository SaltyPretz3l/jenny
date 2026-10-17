/**
 * renderer/features/renderer-artifacts-render-image.js – image artifact kind
 * renderer (WS2 registry): the image as the full-screen viewer's opener, then
 * its generation details. Image data-URL caches and failure tracking stay
 * controller-owned and arrive via deps.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/artifact-figure'), require('../inventory/action-button'));
    return;
  }
  root.rendererArtifactsRenderImage = factory(root.inventoryArtifactFigure, root.inventoryActionButton);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (figure, actionButton) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // What each preview host shows now, read by its one delegated click listener.
  const shownByHost = new WeakMap();
  // The details markup each image shell shows, so a refresh swaps it only when it changed.
  const detailsByShell = new WeakMap();
  const positiveInteger = (value) => Number.isInteger(value) && value > 0;

  // The viewer addresses a generated image by artifact id and an attached one by attachment id.
  function viewerSelect(artifact) {
    const image = artifact.image || {};
    if (!artifact.sessionId) return null;
    if (artifact.sourceKind === 'generated_artifact' && (image.artifactId || image.id)) return { kind: 'artifact', id: image.artifactId || image.id };
    if (artifact.sourceKind === 'message_attachment' && image.id) return { kind: 'attachment', id: image.id };
    return null;
  }

  function notify(shown, text, isError) {
    if (shown.deps.showToastMessage) shown.deps.showToastMessage(text, { tone: isError ? 'danger' : 'info' });
    else shown.deps.setDetailNote(shown.surface, text, isError);
  }

  function handleHostClick(event) {
    const shown = shownByHost.get(event.currentTarget);
    if (!shown) return;
    if (event.target.closest?.('[data-image-copy-prompt]')) {
      Promise.resolve().then(() => globalThis.jennyShell.clipboard.writeText(shown.artifact.image.details.prompt))
        .then(() => notify(shown, jt('imageViewer.promptCopied', 'Prompt copied'), false),
          () => notify(shown, jt('artifacts.errors.copyFailed', 'Copy failed.'), true));
      return;
    }
    const button = event.target.closest?.('.artifact-preview-image-open');
    if (!button || button.dataset.artifactKey !== shown.key || !shown.select) return;
    // The header button outlives a body re-render, so the viewer returns focus there.
    const header = event.currentTarget.closest?.('.artifact-panel-v3')?.querySelector('[data-artifact-panel-fullscreen]:not(.hidden)');
    const fail = () => notify(shown, jt('chat.artifactFigure.unavailable', 'Image unavailable'), true);
    Promise.resolve().then(() => globalThis.rendererImageViewerController?.open?.({ sessionId: shown.artifact.sessionId, select: shown.select, contextNode: header || button }) ?? false)
      .then((opened) => { if (opened === false) fail(); }, fail);
  }

  function renderImageArtifactKind(ctx) {
    const { surface, artifact, deps } = ctx;
    const {
      escapeHtml,
      setDetailNote,
      resolveImagePreviewUrl,
      hasImageArtifactLoadFailed,
      isGeneratedImageArtifactReadRequired,
      isImageArtifactLoading,
    } = deps;
    const image = artifact.image || {};
    const host = surface.previewContent;
    const key = `${artifact.sessionId || ''}:${artifact.id || ''}`;
    const previewUrl = resolveImagePreviewUrl(artifact);
    const missing = artifact.status === 'missing' || hasImageArtifactLoadFailed(artifact);
    const available = Boolean(previewUrl) && !missing;
    setDetailNote(surface, '');
    surface.editorShell.classList.add('hidden');
    host.classList.remove('hidden');
    if (!shownByHost.has(host)) host.addEventListener('click', handleHostClick);
    shownByHost.set(host, available ? { key, artifact, deps, surface, select: viewerSelect(artifact) } : null);
    if (!available) {
      const loadingImage = isGeneratedImageArtifactReadRequired(artifact) && Boolean(isImageArtifactLoading?.(artifact));
      host.innerHTML = `<div class="artifacts-empty">${escapeHtml(loadingImage ? jt('artifacts.image.loadingPreview', 'Loading image preview...') : jt('artifacts.image.unavailableInLocalStorage', 'Image unavailable in local storage.'))}</div>`;
      return;
    }
    const alt = jt('artifacts.image.previewAlt', '{name}', { name: image.displayName || artifact.title });
    const size = positiveInteger(image.width) && positiveInteger(image.height) ? `${image.width} × ${image.height}` : '';
    const details = figure?.renderDetails?.(image.details, size) || '';
    // Keep the decoded image when this artifact already shows the same source; its alt and
    // details still follow the refreshed artifact.
    const shell = host.querySelector(':scope > .artifact-preview-image-shell');
    const shownImg = shell?.dataset.artifactKey === key ? shell.querySelector('.artifact-preview-image') : null;
    if (shownImg?.getAttribute('src') === previewUrl) {
      shownImg.alt = alt;
      if (detailsByShell.get(shell) !== details) {
        shell.querySelector(':scope > .inv-image-details')?.remove();
        shell.insertAdjacentHTML('beforeend', details);
        detailsByShell.set(shell, details);
      }
      return;
    }
    const img = '<img class="artifact-preview-image">';
    const viewLabel = jt('artifacts.actions.viewFullScreen', 'View full screen');
    host.innerHTML = `<div class="artifact-preview-image-shell" data-artifact-key="${escapeHtml(key)}">`
      + (viewerSelect(artifact)
        ? actionButton({ plain: true, className: 'artifact-preview-image-open', ariaLabel: viewLabel, title: viewLabel, dataset: { 'artifact-key': key }, trustedHtml: img })
        : img)
      + details + '</div>';
    detailsByShell.set(host.firstElementChild, details);
    // DOM properties, so a multi-MB data URL is never escaped into markup.
    const imgEl = host.querySelector('.artifact-preview-image');
    imgEl.alt = alt;
    imgEl.src = previewUrl;
  }

  return { renderImageArtifactKind };
});
