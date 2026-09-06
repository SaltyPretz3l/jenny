/* renderer/features/renderer-ide-image-host.js - image preview pane for the
 * Workspace IDE editor stage (W7). Overlays #ideEditorHost exactly like the
 * diff pane; renders images STRICTLY via <img src="..."> (never innerHTML of
 * file bytes - img-loaded SVG is a non-scripting context regardless of
 * whether the src is a data: URI or a blob: object URL from doc.blobUrl -
 * see renderer-ide-image-memory.js, UIUX-034). Checkerboard backdrop,
 * fit/100%/in/out zoom, dimensions + size readout, and an explicit
 * corrupt/unsupported-format/oversized error state (UIUX-034).
 * Composed by renderer-ide-editor-host, which owns the document map. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeImageHost = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const ZOOM_MIN = 10;
  const ZOOM_MAX = 800;
  const ZOOM_STEP = 1.25;
  // Decoded-pixel budget (UIUX-034): a small file can still decompress into a
  // huge bitmap (decode bomb / malformed dimensions). 64 megapixels at 4
  // bytes/pixel (RGBA) is a 256 MB decoded surface - past that, treat the
  // image as too large to safely render rather than handing the GPU an
  // unbounded bitmap.
  const MAX_DECODE_PIXELS = 64 * 1000 * 1000;

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function prettySize(bytes) {
    const size = Number(bytes) || 0;
    if (size < 1024) {
      return `${size} B`;
    }
    if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)} KB`;
    }
    return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  }

  function createIdeImagePane(deps) {
    const getHost = typeof deps?.getHost === 'function' ? deps.getHost : () => null;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');

    let paneEl = null;
    let imgEl = null;
    let metaEl = null;
    let errorEl = null;
    let currentDoc = null;

    function buildToolbarMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const zoomButton = (action, label, title) => actionButton({
        plain: true,
        className: 'ide-image-zoom-button',
        title,
        trustedHtml: label,
        dataset: { 'ide-image-zoom': action },
      });
      return '<div class="ide-image-toolbar">'
        + zoomButton('fit', 'Fit', 'Fit to view')
        + zoomButton('100', '100%', 'Actual size')
        + zoomButton('out', '−', 'Zoom out')
        + zoomButton('in', '+', 'Zoom in')
        + '<span class="ide-image-meta"></span>'
        + '</div>';
    }

    function ensurePane() {
      if (paneEl) {
        return paneEl;
      }
      const host = getHost();
      const documentRef = host?.ownerDocument || null;
      if (!host || !documentRef) {
        return null;
      }
      paneEl = documentRef.createElement('div');
      paneEl.className = 'ide-image-pane hidden';
      paneEl.innerHTML = buildToolbarMarkup()
        + '<div class="ide-image-stage"><img class="ide-image-el" alt="">'
        + '<div class="ide-image-error hidden" role="status"></div></div>';
      imgEl = paneEl.querySelector('.ide-image-el');
      metaEl = paneEl.querySelector('.ide-image-meta');
      errorEl = paneEl.querySelector('.ide-image-error');
      imgEl.addEventListener('load', handleImageLoad);
      imgEl.addEventListener('error', handleImageError);
      paneEl.addEventListener('click', handleToolbarClick);
      host.appendChild(paneEl);
      return paneEl;
    }

    function showError(reason) {
      imgEl?.classList.add('hidden');
      if (errorEl) {
        errorEl.textContent = reason;
        errorEl.classList.remove('hidden');
      }
      if (metaEl) {
        metaEl.textContent = currentDoc ? prettySize(currentDoc.size) : '';
      }
    }

    function clearError() {
      imgEl?.classList.remove('hidden');
      errorEl?.classList.add('hidden');
    }

    function refreshMeta() {
      if (!metaEl || !currentDoc) {
        return;
      }
      const dims = currentDoc.naturalWidth
        ? `${currentDoc.naturalWidth}×${currentDoc.naturalHeight} • `
        : '';
      const zoomLabel = currentDoc.zoom === 'fit' ? 'fit' : `${Math.round(currentDoc.zoom)}%`;
      metaEl.textContent = `${dims}${prettySize(currentDoc.size)} • ${zoomLabel}`;
    }

    function applyZoom() {
      if (!imgEl || !currentDoc) {
        return;
      }
      if (currentDoc.zoom === 'fit') {
        imgEl.style.width = '';
        imgEl.style.height = '';
        imgEl.classList.add('ide-image-el--fit');
      } else {
        imgEl.classList.remove('ide-image-el--fit');
        const width = (Number(currentDoc.naturalWidth) || 0) * (currentDoc.zoom / 100);
        imgEl.style.width = width > 0 ? `${width}px` : '';
        imgEl.style.height = 'auto';
      }
      refreshMeta();
    }

    function handleImageLoad() {
      if (!currentDoc || !imgEl) {
        return;
      }
      const width = imgEl.naturalWidth || 0;
      const height = imgEl.naturalHeight || 0;
      if (width * height > MAX_DECODE_PIXELS) {
        // Release the oversized decoded bitmap rather than leaving it live.
        imgEl.src = '';
        showError(`Image is too large to preview (${width}×${height} decodes past the size budget).`);
        return;
      }
      currentDoc.naturalWidth = width;
      currentDoc.naturalHeight = height;
      applyZoom();
    }

    function handleImageError() {
      if (!currentDoc) {
        return;
      }
      showError('Could not load this image — the file may be corrupted or an unsupported format.');
    }

    function handleToolbarClick(event) {
      const button = event.target?.closest?.('[data-ide-image-zoom]');
      if (!button || !currentDoc) {
        return;
      }
      const action = button.dataset.ideImageZoom;
      if (action === 'fit') {
        currentDoc.zoom = 'fit';
      } else if (action === '100') {
        currentDoc.zoom = 100;
      } else {
        const base = currentDoc.zoom === 'fit' ? 100 : Number(currentDoc.zoom) || 100;
        const next = action === 'in' ? base * ZOOM_STEP : base / ZOOM_STEP;
        currentDoc.zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
      }
      applyZoom();
    }

    // doc: editor-host image document { blobUrl?, base64?, mime, size, zoom?,
    // ... } (renderer-ide-image-memory.js). blobUrl wins when present - it is
    // the real fix for UIUX-034's base64 retention; base64 is only still
    // populated as a data: URL fallback where the runtime has no object-URL
    // support (jsdom tests). Zoom survives tab switches on the doc itself.
    function show(doc) {
      if (!ensurePane() || !doc) {
        return false;
      }
      currentDoc = doc;
      if (doc.zoom === undefined) {
        doc.zoom = 'fit';
      }
      clearError();
      imgEl.src = doc.blobUrl || `data:${doc.mime || 'application/octet-stream'};base64,${doc.base64 || ''}`;
      paneEl.classList.remove('hidden');
      applyZoom();
      return true;
    }

    function hide() {
      currentDoc = null;
      paneEl?.classList.add('hidden');
    }

    function isVisible() {
      return Boolean(paneEl && !paneEl.classList.contains('hidden'));
    }

    function dispose() {
      imgEl?.removeEventListener('load', handleImageLoad);
      imgEl?.removeEventListener('error', handleImageError);
      paneEl?.removeEventListener('click', handleToolbarClick);
      paneEl?.remove?.();
      paneEl = null;
      imgEl = null;
      metaEl = null;
      errorEl = null;
      currentDoc = null;
    }

    return {
      dispose,
      hide,
      isVisible,
      show,
    };
  }

  return {
    createIdeImagePane,
  };
});
