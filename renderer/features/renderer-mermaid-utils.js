/* global window, document */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-mermaid-sanitize-utils'),
      require('./renderer-mermaid-theme-utils'),
      require('../shared/async-fence')
    );
    return;
  }
  root.rendererMermaidUtils = factory(
    root.rendererMermaidSanitizeUtils,
    root.rendererMermaidThemeUtils,
    root.rendererAsyncFence
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (sanitizeUtils, themeUtils, asyncFence) {
  // The ~3.2 MB Mermaid runtime is lazy-loaded on first direct render via
  // renderer-mermaid-runtime-loader.js (ensureMermaidRuntime), not eagerly.
  const runtimeLoader = (typeof globalThis !== 'undefined' && globalThis.rendererMermaidRuntimeLoader)
    || (typeof require === 'function' ? require('./renderer-mermaid-runtime-loader') : null);

  const HOST_DISPOSE_KEY = '__jennyMermaidFrameDispose';
  const DOCUMENT_FULLSCREEN_CLOSE_KEY = '__jennyMermaidFullscreenClose';
  const DEFAULT_FRAME_SRC = 'mermaid-frame.html';
  const DEFAULT_HEIGHT_PX = 80;
  const DEFAULT_MIN_HEIGHT_PX = 60;
  const DEFAULT_TIMEOUT_MS = 5000;
  const disconnectRegistries = new WeakMap();
  const nodeDisconnectRegistries = new WeakMap();
  const directRenderGates = new WeakMap();
  let requestSequence = 0;
  const sanitizeMermaidPreviewSource = sanitizeUtils.sanitizeMermaidPreviewSource;
  const sanitizeMermaidSvgMarkup = sanitizeUtils.sanitizeMermaidSvgMarkup;
  const buildThemeConfig = themeUtils.buildThemeConfig;
  const normalizeMermaidLabelContainers = themeUtils.normalizeMermaidLabelContainers;
  const normalizeMermaidEdgeAndClusterColors = themeUtils.normalizeMermaidEdgeAndClusterColors;

  function toFiniteNumber(value, fallback = 0) {
    const parsed = Number.parseFloat(String(value ?? '').trim());
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clampHeight(value, fallback) {
    return Math.max(Math.ceil(toFiniteNumber(value, fallback)), Math.ceil(toFiniteNumber(fallback, DEFAULT_HEIGHT_PX)));
  }

  function sanitizeToken(value, fallback) {
    const normalized = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || String(fallback || 'preview');
  }

  function resolveMessageOrigin(locationRef) {
    const origin = String(locationRef?.origin || '').trim();
    return origin && origin !== 'null' ? origin : '*';
  }

  function getDisconnectRegistry(windowRef, ownerDocument) {
    if (!windowRef || !ownerDocument || typeof windowRef.MutationObserver !== 'function' || !ownerDocument.body) {
      return null;
    }
    let registry = disconnectRegistries.get(ownerDocument);
    if (registry) {
      return registry;
    }
    const entries = new Set();
    const observer = new windowRef.MutationObserver(function handleDisconnectMutations() {
      for (const entry of Array.from(entries)) {
        if (!entry.host.isConnected || !entry.iframe.isConnected) {
          entries.delete(entry);
          entry.onDisconnect();
        }
      }
      if (!entries.size) {
        observer.disconnect();
        disconnectRegistries.delete(ownerDocument);
      }
    });
    observer.observe(ownerDocument.body, { childList: true, subtree: true });
    registry = { entries, observer };
    disconnectRegistries.set(ownerDocument, registry);
    return registry;
  }

  function registerDisconnectCheck(windowRef, ownerDocument, host, iframe, onDisconnect) {
    const registry = getDisconnectRegistry(windowRef, ownerDocument);
    if (!registry || typeof onDisconnect !== 'function') {
      return function noopUnregister() {};
    }
    const entry = { host, iframe, onDisconnect };
    registry.entries.add(entry);
    return function unregister() {
      registry.entries.delete(entry);
      if (!registry.entries.size) {
        registry.observer.disconnect();
        disconnectRegistries.delete(ownerDocument);
      }
    };
  }

  function getNodeDisconnectRegistry(windowRef, ownerDocument) {
    if (!windowRef || !ownerDocument || typeof windowRef.MutationObserver !== 'function' || !ownerDocument.body) {
      return null;
    }
    let registry = nodeDisconnectRegistries.get(ownerDocument);
    if (registry) {
      return registry;
    }
    const entries = new Set();
    const observer = new windowRef.MutationObserver(function handleNodeDisconnectMutations() {
      for (const entry of Array.from(entries)) {
        if (!entry.node.isConnected) {
          entries.delete(entry);
          entry.onDisconnect();
        }
      }
      if (!entries.size) {
        observer.disconnect();
        nodeDisconnectRegistries.delete(ownerDocument);
      }
    });
    observer.observe(ownerDocument.body, { childList: true, subtree: true });
    registry = { entries, observer };
    nodeDisconnectRegistries.set(ownerDocument, registry);
    return registry;
  }

  function registerNodeDisconnectCheck(windowRef, ownerDocument, node, onDisconnect) {
    const registry = getNodeDisconnectRegistry(windowRef, ownerDocument);
    if (!registry || !node || typeof onDisconnect !== 'function') {
      return function noopUnregister() {};
    }
    const entry = { node, onDisconnect };
    registry.entries.add(entry);
    return function unregister() {
      registry.entries.delete(entry);
      if (!registry.entries.size) {
        registry.observer.disconnect();
        nodeDisconnectRegistries.delete(ownerDocument);
      }
    };
  }

  function createMermaidFrame(host, source, options = {}) {
    if (!host || typeof host.appendChild !== 'function' || typeof host.innerHTML !== 'string') {
      return function noopDispose() {};
    }

    const previousDispose = host[HOST_DISPOSE_KEY];
    if (typeof previousDispose === 'function') {
      previousDispose();
    }

    const ownerDocument = host.ownerDocument || (typeof document !== 'undefined' ? document : null);
    const windowRef = ownerDocument?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!ownerDocument || !windowRef) {
      return function noopDispose() {};
    }

    const initialHeight = clampHeight(options.initialHeight, DEFAULT_HEIGHT_PX);
    const minHeight = clampHeight(options.minHeight, DEFAULT_MIN_HEIGHT_PX);
    const timeoutMs = Math.max(Math.floor(toFiniteNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS)), 1);
    const frameSrc = String(options.frameSrc || DEFAULT_FRAME_SRC).trim() || DEFAULT_FRAME_SRC;
    const iframeSandbox = 'allow-scripts';
    const onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;
    const onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;
    const requestId = `mermaid-frame-${++requestSequence}-${sanitizeToken(options.requestKey || source, 'preview')}`;
    const theme = buildThemeConfig();
    const cleanedSource = sanitizeMermaidPreviewSource(String(source || '').trim());
    // Sandboxed preview frames intentionally omit allow-same-origin, so the child
    // runs with an opaque origin and must be addressed with '*' over postMessage.
    const expectedOrigin = iframeSandbox.includes('allow-same-origin')
      ? resolveMessageOrigin(windowRef.location)
      : '*';
    let disposed = false;
    let renderSettled = false;
    let renderRequested = false;
    let timeoutId = 0;
    let unregisterDisconnect = null;

    host.innerHTML = '';

    const iframe = ownerDocument.createElement('iframe');
    iframe.src = frameSrc;
    iframe.setAttribute('sandbox', iframeSandbox);
    iframe.setAttribute('aria-label', 'Mermaid diagram preview');
    iframe.setAttribute('scrolling', 'no');
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    iframe.style.background = 'transparent';
    iframe.style.minHeight = `${minHeight}px`;
    iframe.style.height = `${initialHeight}px`;
    function clearPendingTimeout() {
      if (timeoutId) {
        windowRef.clearTimeout(timeoutId);
        timeoutId = 0;
      }
    }

    function setHeight(value) {
      iframe.style.height = `${clampHeight(value, initialHeight)}px`;
    }

    function teardown(removeFrame) {
      if (disposed) {
        return;
      }
      disposed = true;
      clearPendingTimeout();
      windowRef.removeEventListener('message', handleMessage);
      iframe.removeEventListener('load', handleLoad);
      iframe.removeEventListener('error', handleError);
      unregisterDisconnect?.();
      unregisterDisconnect = null;
      if (host[HOST_DISPOSE_KEY] === dispose) {
        delete host[HOST_DISPOSE_KEY];
      }
      if (removeFrame && iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    }

    function fail(payload) {
      if (renderSettled || disposed) {
        return;
      }
      renderSettled = true;
      teardown(true);
      if (onFailure) {
        onFailure(payload || { ok: false, error: 'Mermaid preview failed.' });
      }
    }

    function markRendered(payload) {
      if (disposed) {
        return;
      }
      if (payload && payload.height != null) {
        setHeight(payload.height);
      }
      if (!renderSettled) {
        renderSettled = true;
        clearPendingTimeout();
        if (onSuccess) {
          onSuccess(payload || { ok: true });
        }
      }
    }

    function handleMessage(event) {
      if (disposed || event.source !== iframe.contentWindow) {
        return;
      }
      if (expectedOrigin !== '*' && event.origin !== expectedOrigin) {
        return;
      }
      const payload = event && event.data && typeof event.data === 'object' ? event.data : null;
      if (payload?.type === 'mermaid-frame-ready') {
        postRenderRequestOnce();
        return;
      }
      if (!payload || payload.requestId !== requestId) {
        return;
      }
      if (payload.type === 'height') {
        setHeight(payload.height);
        return;
      }
      if (payload.type !== 'rendered') {
        return;
      }
      if (payload.ok === true) {
        markRendered(payload);
        return;
      }
      fail(payload);
    }

    function postRenderRequestOnce() {
      if (disposed || renderRequested || !iframe.contentWindow) {
        return;
      }
      renderRequested = true;
      try {
        iframe.contentWindow.postMessage({
          type: 'render',
          requestId,
          source: cleanedSource,
          config: theme.config,
          labelStyles: theme.labelStyles,
        }, expectedOrigin);
      } catch (error) {
        fail({
          type: 'rendered',
          requestId,
          ok: false,
          error: String(error && error.message || error || 'Unable to contact Mermaid preview frame.'),
        });
      }
    }

    function handleLoad() {
      if (disposed) {
        return;
      }
      postRenderRequestOnce();
    }

    function handleError() {
      fail({
        type: 'rendered',
        requestId,
        ok: false,
        error: 'Mermaid preview frame failed to load.',
      });
    }

    function dispose() {
      teardown(true);
    }

    timeoutId = windowRef.setTimeout(function handleTimeout() {
      fail({
        type: 'rendered',
        requestId,
        ok: false,
        error: 'Mermaid preview timed out.',
      });
    }, timeoutMs);

    windowRef.addEventListener('message', handleMessage);
    iframe.addEventListener('load', handleLoad);
    iframe.addEventListener('error', handleError);
    host[HOST_DISPOSE_KEY] = dispose;
    // Listener-before-append is deliberate: a cached local frame can dispatch
    // load (or its ready message) while appendChild is still on the stack.
    host.appendChild(iframe);
    unregisterDisconnect = registerDisconnectCheck(windowRef, ownerDocument, host, iframe, function handleDisconnect() {
      teardown(false);
    });
    return dispose;
  }

  /* ── Direct (no-iframe) rendering ── */

  let mermaidInitialized = false;
  let mermaidThemeKey = '';

  async function renderMermaidDirect(host, source, options) {
    options = options || {};
    if (!host || typeof host.appendChild !== 'function') return;
    if (!source || !String(source).trim()) return;

    var onSuccess = typeof options.onSuccess === 'function' ? options.onSuccess : null;
    var onFailure = typeof options.onFailure === 'function' ? options.onFailure : null;
    var windowRef = typeof window !== 'undefined' ? window : null;
    var renderGate = directRenderGates.get(host);
    if (!renderGate) {
      renderGate = asyncFence.createGenerationGate();
      directRenderGates.set(host, renderGate);
    }
    renderGate.bump();
    var renderToken = renderGate.capture();

    // Lazy-load the Mermaid runtime on first direct render; the readiness check
    // below is authoritative (ensureMermaidRuntime resolves true iff
    // window.mermaid.render exists), so its return value needs no separate test.
    if (windowRef && runtimeLoader && typeof runtimeLoader.ensureMermaidRuntime === 'function') {
      try {
        await runtimeLoader.ensureMermaidRuntime();
      } catch (loadErr) { // fail gracefully; never escape as an unhandled rejection
        if (!renderGate.isCurrent(renderToken)) return;
        console.warn('[mermaid-direct] mermaid runtime failed to load:', loadErr);
        if (onFailure) onFailure({ ok: false, error: String(loadErr && loadErr.message || loadErr || 'Mermaid runtime failed to load.') });
        return;
      }
      if (!renderGate.isCurrent(renderToken)) return;
    }
    if (!windowRef || !windowRef.mermaid || typeof windowRef.mermaid.render !== 'function') {
      console.warn('[mermaid-direct] mermaid runtime not available on window');
      if (onFailure) onFailure({ ok: false, error: 'Mermaid runtime not available.' });
      return;
    }

    try {
      var theme = buildThemeConfig();
      if (!mermaidInitialized || mermaidThemeKey !== theme.key) {
        windowRef.mermaid.initialize(theme.config);
        mermaidInitialized = true;
        mermaidThemeKey = theme.key;
      }

      var renderId = 'mermaid-direct-' + (++requestSequence);
      host.innerHTML = '';

      var cleanedSource = sanitizeMermaidPreviewSource(String(source).trim());
      var result = await windowRef.mermaid.render(renderId, cleanedSource);
      if (!renderGate.isCurrent(renderToken)) return;
      var svg = typeof result === 'string' ? result : (result && typeof result.svg === 'string' ? result.svg : '');
      if (!svg.trim()) throw new Error('Mermaid returned empty SVG.');
      var safeSvg = sanitizeMermaidSvgMarkup(svg, windowRef);
      if (!safeSvg.trim()) throw new Error('Mermaid SVG failed sanitization.');
      host.innerHTML = safeSvg;
      var svgEl = host.querySelector('svg');
      if (svgEl) {
        normalizeMermaidLabelContainers(svgEl, theme.labelStyles);
        normalizeMermaidEdgeAndClusterColors(svgEl, theme.edgeStyles);
        // Remove mermaid's hardcoded width/height so CSS can control sizing
        svgEl.removeAttribute('width');
        svgEl.style.removeProperty('max-width');
        // Crop the viewBox to the actual content bounds so mermaid's internal
        // diagramPadding doesn't leave a visible blank margin at the edges.
        try {
          var bbox = svgEl.getBBox();
          if (bbox && bbox.width > 0 && bbox.height > 0) {
            var pad = 4;
            svgEl.setAttribute('viewBox',
              (bbox.x - pad) + ' ' + (bbox.y - pad) + ' ' +
              (bbox.width + pad * 2) + ' ' + (bbox.height + pad * 2)
            );
          }
        } catch (_e) { /* getBBox unavailable; keep original viewBox */ }
      }
      if (onSuccess) onSuccess({ ok: true });
    } catch (err) {
      if (!renderGate.isCurrent(renderToken)) return;
      console.warn('[mermaid-direct] render error:', err);
      host.innerHTML = '';
      if (onFailure) onFailure({ ok: false, error: String(err && err.message || err || 'Mermaid render failed.') });
    }
  }

  /* ── Interactive zoom/pan controls ── */

  var ZOOM_MIN = 0.3;
  var ZOOM_MAX = 4.0;
  var ZOOM_STEP = 0.2;
  var ZOOM_WHEEL_STEP = 0.1;

  function closeExistingMermaidFullscreen(doc) {
    if (!doc) return;
    var closeFullscreen = doc[DOCUMENT_FULLSCREEN_CLOSE_KEY];
    if (typeof closeFullscreen === 'function') {
      closeFullscreen();
    }
  }

  function attachMermaidControls(previewNode) {
    if (!previewNode) return;
    if (previewNode.querySelector('.mermaid-controls') || previewNode.querySelector('.mermaid-viewport')) return;
    var svgEl = previewNode.querySelector('svg');
    if (!svgEl) return;
    var doc = previewNode.ownerDocument;
    if (!doc) return;
    var windowRef = doc.defaultView || (typeof window !== 'undefined' ? window : null);

    // Wrap SVG in a viewport div
    var viewport = doc.createElement('div');
    viewport.className = 'mermaid-viewport';
    previewNode.insertBefore(viewport, svgEl);
    viewport.appendChild(svgEl);

    // State
    var zoom = 1;
    var panX = 0;
    var panY = 0;
    var dragging = false;
    var dragStartX = 0;
    var dragStartY = 0;
    var panStartX = 0;
    var panStartY = 0;
    var panBoundsHalfW = Infinity;
    var panBoundsHalfH = Infinity;
    var fullscreenOverlay = null;
    var fullscreenShell = null;
    var fullscreenStage = null;
    var restoreFocusTarget = null;
    var controlsDisposed = false;
    var unregisterDisconnect = null;
    var isFullscreen = false;

    function applyTransform() {
      svgEl.style.transform = 'scale(' + zoom + ') translate(' + panX + 'px, ' + panY + 'px)';
    }

    function setZoom(newZoom, centerX, centerY) {
      var clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, newZoom));
      if (clamped === zoom) return;
      // Capture natural SVG size before zoom changes (getBoundingClientRect reflects current render)
      var svgRect = svgEl.getBoundingClientRect();
      var natW = svgRect.width / zoom;
      var natH = svgRect.height / zoom;
      // Adjust pan to zoom toward the cursor/center
      if (centerX !== undefined && centerY !== undefined) {
        var rect = viewport.getBoundingClientRect();
        var cx = (centerX - rect.left - rect.width / 2) / zoom;
        var cy = (centerY - rect.top - rect.height / 2) / zoom;
        panX += cx - cx * (clamped / zoom);
        panY += cy - cy * (clamped / zoom);
      }
      zoom = clamped;
      // Clamp pan so viewport center stays within the diagram bounds
      panX = Math.max(-natW / 2, Math.min(natW / 2, panX));
      panY = Math.max(-natH / 2, Math.min(natH / 2, panY));
      applyTransform();
      updateZoomLabel();
    }

    function resetView() {
      zoom = 1;
      panX = 0;
      panY = 0;
      applyTransform();
      updateZoomLabel();
    }

    function updateFullscreenButton() {
      if (!fullscreenBtn) return;
      fullscreenBtn.classList.toggle('is-active', isFullscreen);
      fullscreenBtn.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
      fullscreenBtn.setAttribute('title', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
      fullscreenBtn.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
    }

    function teardownFullscreenOverlay() {
      if (fullscreenOverlay && fullscreenOverlay.parentNode) {
        fullscreenOverlay.parentNode.removeChild(fullscreenOverlay);
      }
      fullscreenOverlay = null;
      fullscreenShell = null;
      fullscreenStage = null;
    }

    function restoreFocus() {
      if (!restoreFocusTarget || typeof restoreFocusTarget.focus !== 'function') {
        restoreFocusTarget = null;
        return;
      }
      if ('isConnected' in restoreFocusTarget && restoreFocusTarget.isConnected === false) {
        restoreFocusTarget = null;
        return;
      }
      try {
        restoreFocusTarget.focus();
      } catch (_error) {
        /* best-effort */
      }
      restoreFocusTarget = null;
    }

    function closeFullscreen() {
      if (!isFullscreen) return;
      isFullscreen = false;
      doc.removeEventListener('keydown', handleFullscreenKeydown);
      if (previewNode && typeof previewNode.appendChild === 'function') {
        previewNode.appendChild(toolbar);
        previewNode.appendChild(viewport);
      }
      if (doc.body) {
        doc.body.classList.remove('mermaid-fullscreen-open');
      }
      if (doc[DOCUMENT_FULLSCREEN_CLOSE_KEY] === closeFullscreen) {
        delete doc[DOCUMENT_FULLSCREEN_CLOSE_KEY];
      }
      teardownFullscreenOverlay();
      updateFullscreenButton();
      restoreFocus();
    }

    function handleFullscreenKeydown(event) {
      if (!isFullscreen) return;
      if (event && event.key === 'Tab' && fullscreenOverlay) {
        var focusableSelector = [
          'button:not([disabled])',
          '[href]',
          'input:not([disabled])',
          'select:not([disabled])',
          'textarea:not([disabled])',
          '[tabindex]:not([tabindex="-1"])',
        ].join(',');
        var focusable = Array.from(fullscreenOverlay.querySelectorAll(focusableSelector)).filter(function (node) {
          return node && typeof node.focus === 'function';
        });
        if (focusable.length) {
          var currentIndex = focusable.indexOf(doc.activeElement);
          var nextIndex = event.shiftKey
            ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
            : (currentIndex === -1 || currentIndex >= focusable.length - 1 ? 0 : currentIndex + 1);
          event.preventDefault();
          focusable[nextIndex].focus();
          return;
        }
      }
      if (event && event.key === 'Escape') {
        event.preventDefault();
        closeFullscreen();
      }
    }

    function ensureFullscreenOverlay() {
      if (fullscreenOverlay) {
        return fullscreenOverlay;
      }

      fullscreenOverlay = doc.createElement('div');
      fullscreenOverlay.className = 'mermaid-fullscreen-overlay';
      fullscreenOverlay.setAttribute('role', 'dialog');
      fullscreenOverlay.setAttribute('aria-modal', 'true');
      fullscreenOverlay.setAttribute('aria-label', 'Mermaid diagram fullscreen preview');
      fullscreenOverlay.tabIndex = -1;

      fullscreenShell = doc.createElement('div');
      fullscreenShell.className = 'mermaid-fullscreen-shell';

      fullscreenStage = doc.createElement('div');
      fullscreenStage.className = 'mermaid-fullscreen-stage';

      fullscreenShell.appendChild(fullscreenStage);
      fullscreenOverlay.appendChild(fullscreenShell);

      fullscreenOverlay.addEventListener('click', function (event) {
        if (!isFullscreen) return;
        if (event.target === fullscreenOverlay) {
          closeFullscreen();
        }
      });

      return fullscreenOverlay;
    }

    function openFullscreen() {
      if (isFullscreen || !doc.body) return;
      closeExistingMermaidFullscreen(doc);
      ensureFullscreenOverlay();
      restoreFocusTarget = doc.activeElement || null;
      isFullscreen = true;
      doc.body.classList.add('mermaid-fullscreen-open');
      doc[DOCUMENT_FULLSCREEN_CLOSE_KEY] = closeFullscreen;
      doc.addEventListener('keydown', handleFullscreenKeydown);
      doc.body.appendChild(fullscreenOverlay);
      fullscreenStage.appendChild(toolbar);
      fullscreenStage.appendChild(viewport);
      updateFullscreenButton();
      fullscreenBtn.focus();
    }

    function toggleFullscreen() {
      if (isFullscreen) {
        closeFullscreen();
        return;
      }
      openFullscreen();
    }

    // Build toolbar
    var toolbar = doc.createElement('div');
    toolbar.className = 'mermaid-controls';

    var zoomOutBtn = doc.createElement('button');
    zoomOutBtn.className = 'mermaid-control-btn';
    zoomOutBtn.type = 'button';
    zoomOutBtn.textContent = '\u2212'; // minus
    zoomOutBtn.title = 'Zoom out';
    zoomOutBtn.addEventListener('click', function () { setZoom(zoom - ZOOM_STEP); });

    var zoomLabel = doc.createElement('span');
    zoomLabel.className = 'mermaid-zoom-label';
    function updateZoomLabel() {
      zoomLabel.textContent = Math.round(zoom * 100) + '%';
    }
    updateZoomLabel();

    var zoomInBtn = doc.createElement('button');
    zoomInBtn.className = 'mermaid-control-btn';
    zoomInBtn.type = 'button';
    zoomInBtn.textContent = '+';
    zoomInBtn.title = 'Zoom in';
    zoomInBtn.addEventListener('click', function () { setZoom(zoom + ZOOM_STEP); });

    var resetBtn = doc.createElement('button');
    resetBtn.className = 'mermaid-control-btn';
    resetBtn.type = 'button';
    resetBtn.textContent = '\u21BA'; // reset arrow
    resetBtn.title = 'Reset view';
    resetBtn.addEventListener('click', resetView);

    var fullscreenBtn = doc.createElement('button');
    fullscreenBtn.className = 'mermaid-control-btn mermaid-control-btn-fullscreen';
    fullscreenBtn.type = 'button';
    // Inline SVG expand glyph (WS1 spec: 14x14 arrows-diagonal-out,
    // currentColor stroke). SVG via innerHTML — no new raw primitives.
    fullscreenBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + '<path d="M16 4h4v4"></path>'
      + '<path d="M14 10l6 -6"></path>'
      + '<path d="M8 20H4v-4"></path>'
      + '<path d="M4 20l6 -6"></path>'
      + '</svg>';
    fullscreenBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleFullscreen();
    });
    updateFullscreenButton();

    toolbar.appendChild(zoomOutBtn);
    toolbar.appendChild(zoomLabel);
    toolbar.appendChild(zoomInBtn);
    toolbar.appendChild(resetBtn);
    toolbar.appendChild(fullscreenBtn);
    previewNode.insertBefore(toolbar, viewport);

    function handleViewportWheel(e) {
      e.preventDefault();
      var delta = e.deltaY > 0 ? -ZOOM_WHEEL_STEP : ZOOM_WHEEL_STEP;
      setZoom(zoom + delta, e.clientX, e.clientY);
    }
    viewport.addEventListener('wheel', handleViewportWheel, { passive: false });

    function handleViewportMouseDown(e) {
      if (e.button !== 0) return;
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      panStartX = panX;
      panStartY = panY;
      // Cache SVG natural size for pan clamping across this drag gesture
      var svgRect = svgEl.getBoundingClientRect();
      panBoundsHalfW = svgRect.width / zoom / 2;
      panBoundsHalfH = svgRect.height / zoom / 2;
      viewport.style.cursor = 'grabbing';
      e.preventDefault();
    }
    viewport.addEventListener('mousedown', handleViewportMouseDown);

    function handleDocumentMouseMove(e) {
      if (!dragging) return;
      panX = Math.max(-panBoundsHalfW, Math.min(panBoundsHalfW, panStartX + (e.clientX - dragStartX)));
      panY = Math.max(-panBoundsHalfH, Math.min(panBoundsHalfH, panStartY + (e.clientY - dragStartY)));
      applyTransform();
    }
    doc.addEventListener('mousemove', handleDocumentMouseMove);

    function handleDocumentMouseUp() {
      if (!dragging) return;
      dragging = false;
      viewport.style.cursor = '';
    }
    doc.addEventListener('mouseup', handleDocumentMouseUp);

    function cleanupInteractiveControls() {
      if (controlsDisposed) return;
      controlsDisposed = true;
      if (isFullscreen) {
        closeFullscreen();
      }
      viewport.removeEventListener('wheel', handleViewportWheel, { passive: false });
      viewport.removeEventListener('mousedown', handleViewportMouseDown);
      doc.removeEventListener('mousemove', handleDocumentMouseMove);
      doc.removeEventListener('mouseup', handleDocumentMouseUp);
      doc.removeEventListener('keydown', handleFullscreenKeydown);
      unregisterDisconnect?.();
      unregisterDisconnect = null;
      if (doc[DOCUMENT_FULLSCREEN_CLOSE_KEY] === closeFullscreen) {
        delete doc[DOCUMENT_FULLSCREEN_CLOSE_KEY];
      }
    }

    if (windowRef) {
      unregisterDisconnect = registerNodeDisconnectCheck(windowRef, doc, previewNode, cleanupInteractiveControls);
    }
  }

  function reinitializeMermaidTheme() {
    mermaidInitialized = false;
    mermaidThemeKey = '';
  }

  /* ── Layout-deferred direct rendering ── */

  function waitForNextFrame(windowRef) {
    return new Promise(function (resolve) {
      if (windowRef && typeof windowRef.requestAnimationFrame === 'function') {
        windowRef.requestAnimationFrame(function () { resolve(); });
        return;
      }
      setTimeout(resolve, 16);
    });
  }

  function isHostDisplayNone(host) {
    // Affirmative-only check: computed display:none somewhere in the ancestry.
    // jsdom harnesses do not load the app stylesheets, so a bare `.hidden`
    // class does not trip this — only genuinely hidden hosts do.
    try {
      var doc = host.ownerDocument;
      var view = doc && doc.defaultView;
      if (!view || typeof view.getComputedStyle !== 'function') return false;
      for (var el = host; el && el.nodeType === 1; el = el.parentElement) {
        if (view.getComputedStyle(el).display === 'none') return true;
      }
    } catch (_e) { /* treat unreadable style state as visible */ }
    return false;
  }

  // The artifact review panel lifts .hidden (display:none) and renders the
  // selected artifact in the same synchronous tick; window.mermaid.render()
  // then measures text against a DOM that has not reflowed and fails, kicking
  // an avoidable iframe fallback (or its timeout message). Reading clientWidth
  // forces a synchronous reflow; when it still reports 0 we wait up to two
  // animation frames for layout to settle before rendering directly. A host
  // that stays provably hidden reports failure so the caller's existing
  // direct -> iframe -> message fallback chain takes over.
  async function renderMermaidDirectWhenLaidOut(host, source, options) {
    options = options || {};
    if (!host || typeof host.appendChild !== 'function') return;
    var windowRef = typeof window !== 'undefined' ? window : null;
    var attempts = 0;
    while (host.isConnected !== false && Number(host.clientWidth) === 0 && attempts < 2) {
      attempts += 1;
      await waitForNextFrame(windowRef);
    }
    if (host.isConnected === false || (Number(host.clientWidth) === 0 && isHostDisplayNone(host))) {
      if (typeof options.onFailure === 'function') {
        options.onFailure({ ok: false, error: 'Mermaid host is not laid out.' });
      }
      return;
    }
    // Dispatch through the exported api so test doubles that replace
    // renderMermaidDirect on the module object are honored.
    return api.renderMermaidDirect(host, source, options);
  }

  var api = {
    buildThemeConfig,
    createMermaidFrame,
    renderMermaidDirect,
    renderMermaidDirectWhenLaidOut,
    attachMermaidControls,
    reinitializeMermaidTheme,
  };
  return api;
});
