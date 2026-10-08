/**
 * renderer/chat/renderer-artifact-card-utils.js
 *
 * Renders generated_artifacts from tool results as type-specific
 * inline cards with quick actions (studio, open, reveal). Consumes the
 * shared artifact presentation model in renderer/features/renderer-artifact-presentation.js
 * so kind detection, titles, kickers, and action vocabulary stay aligned
 * with the shelf, catalog, and review surfaces (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactCardUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  var figure = (function resolveFigure() {
    if (typeof globalThis !== 'undefined' && globalThis.inventoryArtifactFigure) {
      return globalThis.inventoryArtifactFigure;
    }
    if (typeof require === 'function') {
      try { return require('../inventory/artifact-figure'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  const imageCache = new Map();
  const pendingImages = new Set();
  const failedImages = new Map();
  const MAX_INLINE_IMAGE_ENTRIES = 24;
  const MAX_INLINE_IMAGE_DATA_URL_CHARS = 48 * 1024 * 1024;
  const MAX_FAILED_IMAGE_ENTRIES = 256;
  const FAILED_IMAGE_TTL_MS = 5 * 60 * 1000;
  const IMAGE_RETRY_MS = 15000;
  let imageLoaderGeneration = 0;

  function retainArtifactImage(imageKey, src) {
    if (src.length > MAX_INLINE_IMAGE_DATA_URL_CHARS) return;
    imageCache.set(imageKey, src);
    let totalChars = 0;
    for (const value of imageCache.values()) totalChars += value.length;
    while (imageCache.size > MAX_INLINE_IMAGE_ENTRIES || totalChars > MAX_INLINE_IMAGE_DATA_URL_CHARS) {
      const [key, value] = imageCache.entries().next().value;
      imageCache.delete(key);
      totalChars -= value.length;
    }
  }

  function pruneFailedImages(now) {
    for (const [key, failure] of failedImages) {
      if (now - failure.failedAt >= FAILED_IMAGE_TTL_MS) failedImages.delete(key);
    }
  }

  function rememberFailedImage(imageKey, retryMs) {
    const now = Date.now();
    pruneFailedImages(now);
    failedImages.delete(imageKey);
    failedImages.set(imageKey, { failedAt: now, retryAt: now + retryMs });
    while (failedImages.size > MAX_FAILED_IMAGE_ENTRIES) failedImages.delete(failedImages.keys().next().value);
  }

  function applyArtifactImage(imageKey, src) {
    const doc = globalThis.document;
    if (!doc) return;
    for (const img of doc.querySelectorAll('img[data-inv-artifact-image-key]')) {
      if (img.getAttribute('data-inv-artifact-image-key') !== imageKey) continue;
      if (src && img.getAttribute('src') !== src) img.setAttribute('src', src);
      const figureNode = img.closest('.inv-artifact-figure');
      if (failedImages.has(imageKey)) figureNode?.setAttribute('data-inv-artifact-image-state', 'unavailable');
      else figureNode?.removeAttribute('data-inv-artifact-image-state');
    }
  }

  function requestArtifactImage(imageKey, sessionId, artifactId) {
    if (!globalThis.document || !globalThis.jennyShell?.artifacts?.read) return;
    const generation = imageLoaderGeneration;
    const scheduleApply = (src) => setTimeout(() => {
      if (generation === imageLoaderGeneration) applyArtifactImage(imageKey, src);
    }, 0);
    const now = Date.now();
    pruneFailedImages(now);
    if (imageCache.has(imageKey)) {
      const src = imageCache.get(imageKey);
      imageCache.delete(imageKey);
      imageCache.set(imageKey, src);
      scheduleApply(src);
      return;
    }
    if (pendingImages.has(imageKey)) return;
    if (failedImages.get(imageKey)?.retryAt > now) { scheduleApply(); return; }
    failedImages.delete(imageKey);
    pendingImages.add(imageKey);
    let read;
    let loadedSrc;
    try { read = globalThis.jennyShell.artifacts.read(sessionId, artifactId); }
    catch (_error) { read = Promise.reject(_error); }
    Promise.resolve(read).then((result) => {
      if (generation !== imageLoaderGeneration) return;
      const src = result?.asset_data_url || result?.assetDataUrl;
      if (typeof src !== 'string' || !/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(src)) {
        rememberFailedImage(imageKey, FAILED_IMAGE_TTL_MS);
        return;
      }
      loadedSrc = src;
      retainArtifactImage(imageKey, src);
    }).catch(() => {
      if (generation === imageLoaderGeneration) rememberFailedImage(imageKey, IMAGE_RETRY_MS);
    }).finally(() => {
      if (generation !== imageLoaderGeneration) return;
      pendingImages.delete(imageKey);
      // Hydrate this render even when its payload was too large or was evicted.
      scheduleApply(loadedSrc);
    });
  }

  function releaseInlineImages() {
    imageLoaderGeneration += 1;
    imageCache.clear();
    pendingImages.clear();
    failedImages.clear();
  }

  function resetArtifactImageLoaderForTests() {
    releaseInlineImages();
  }

  function renderImagePendingFigure(options) {
    return figure ? figure.renderPendingFigure({ ...options, labels: {
      title: jt('chat.artifactFigure.pendingTitle', 'Rendering image…'),
      note: jt('chat.artifactFigure.pendingNote', 'The chat model is paused to free the GPU. It comes back when the image is done.'),
      cancel: jt('chat.artifactFigure.cancel', 'Cancel'),
    } }) : '';
  }

  var presentation = (function resolvePresentation() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactPresentation) {
      return globalThis.rendererArtifactPresentation;
    }
    if (typeof require === 'function') {
      try { return require('../features/renderer-artifact-presentation'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  var stringUtils = (function resolveStringUtils() {
    if (typeof globalThis !== 'undefined' && globalThis.stringUtils) {
      return globalThis.stringUtils;
    }
    if (typeof require === 'function') {
      try { return require('../shared/string-utils'); } catch (_error) { /* not available */ }
    }
    return null;
  })();

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  var escapeHtml = stringUtils && typeof stringUtils.escapeHtml === 'function'
    ? stringUtils.escapeHtml
    : fallbackEscapeHtml;

  /* Navigable-source policy stays here because only inline cards create
   * <img> tags; presentation only decides whether a thumbnail exists. */
  function isAllowedArtifactImageSource(raw) {
    var src = String(raw || '').trim();
    if (!src) return false;
    if (/^data:image\//i.test(src)) return true;
    if (/^file:/i.test(src)) {
      try {
        var parsed = new URL(src);
        var host = String(parsed.hostname || '').trim().toLowerCase();
        return !host || host === 'localhost';
      } catch (_error) {
        return false;
      }
    }
    return false;
  }

  function toTrustedLocalFileUrl(raw) {
    var src = String(raw || '').trim();
    if (!src) return '';
    if (/^\\\\/.test(src)) return '';
    if (/^[a-zA-Z]:[\\/]/.test(src)) {
      return 'file:///' + src.replace(/\\/g, '/');
    }
    if (/^\//.test(src) && !/^\/\//.test(src)) {
      return 'file://' + src;
    }
    return '';
  }

  function imageSourceForThumbnail(thumbnail) {
    var raw = thumbnail ? thumbnail.assetPath : '';
    if (isAllowedArtifactImageSource(raw)) return raw;
    if (thumbnail && thumbnail.trustedLocalPath === true) {
      var fileUrl = toTrustedLocalFileUrl(raw);
      if (isAllowedArtifactImageSource(fileUrl)) return fileUrl;
    }
    return '';
  }

  var ICONS = {
    file: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    generic: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    open: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2h5v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    reveal: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 3h4l1.5 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 9h6M8 6v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    /* ⤢ "Open in panel" glyph — Tabler arrows-diagonal geometry, shared
     * with the teaser/mermaid-fallback emit sites. */
    expand: '<svg class="icon-mirror-rtl" width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2H10v2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 2L7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 10H2V7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 10l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  function cardClassForKind(kind) {
    if (kind === 'file') return 'inv-artifact-card--file';
    return 'inv-artifact-card--generic';
  }

  function artifactCardTargetAttr() {
    return '';
  }

  function iconGlyphForAction(name) {
    if (name === 'open') return ICONS.open;
    if (name === 'reveal') return ICONS.reveal;
    if (name === 'panel') return ICONS.expand;
    return '';
  }

  function renderActionButton(action, callId, pres) {
    var safeCallId = escapeHtml(callId);
    var artifactId = pres.id;
    var sessionId = pres.sessionId;
    var safeArtifactId = escapeHtml(artifactId);
    var safeSessionId = escapeHtml(sessionId);
    var disabled = !action.enabled;
    var buttonClass = action.name === 'panel'
      ? 'inv-artifact-action inv-artifact-primary'
      : 'inv-artifact-action';
    var body = action.name === 'panel' ? escapeHtml(action.label) : iconGlyphForAction(action.name);
    var disabledAttrs = disabled
      ? ' disabled title="' + escapeHtml(action.title) + '"'
      : ' title="' + escapeHtml(action.title) + '"';
    return '<button class="' + buttonClass + '" type="button"'
      + ' data-inv-artifact-action="' + escapeHtml(action.name) + '"'
      + (artifactId ? ' data-artifact-id="' + safeArtifactId + '"' : '')
      + (sessionId ? ' data-session-id="' + safeSessionId + '"' : '')
      + ' data-artifact-call-id="' + safeCallId + '"'
      + ' aria-label="' + escapeHtml(action.ariaLabel) + '"'
      + disabledAttrs
      + '>' + body + '</button>';
  }

  function renderActions(pres, callId) {
    if (!pres.actions || pres.actions.length === 0) return '';
    var html = '<div class="inv-artifact-actions">';
    for (var i = 0; i < pres.actions.length; i++) {
      html += renderActionButton(pres.actions[i], callId, pres);
    }
    html += '</div>';
    return html;
  }

  function renderImageFigure(callId, pres, artifact, options) {
    if (!figure) return '';
    const src = imageSourceForThumbnail(pres.thumbnail);
    const imageKey = `${pres.sessionId}:${pres.id}`;
    const width = artifact.width;
    const height = artifact.height;
    let meta = Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0 ? `${width} × ${height}` : '';
    const seed = options?.seed;
    if (Number.isInteger(seed) && seed >= 0) meta += (meta ? ' · ' : '') + jt('chat.artifactFigure.metaSeed', 'seed {seed}', { seed });
    // The prompt actually sent to the engine: a clamped caption line, the full text in the tooltip.
    const prompt = typeof options?.prompt === 'string' ? options.prompt.trim() : '';
    const negative = prompt && typeof options.negativePrompt === 'string' ? options.negativePrompt.trim() : '';
    let promptTitle = prompt ? `${jt('chat.artifactFigure.promptLabel', 'Prompt')}: ${prompt}` : '';
    if (negative) promptTitle += `\n${jt('chat.artifactFigure.negativePromptLabel', 'Negative prompt')}: ${negative}`;
    if (!src && pres.sessionId && pres.id) requestArtifactImage(imageKey, pres.sessionId, pres.id);
    return figure.renderFigure({ callId, artifactId: pres.id, sessionId: pres.sessionId, imageKey,
      title: pres.title, width, height, src, meta, state: failedImages.has(imageKey) ? 'unavailable' : '',
      prompt: prompt.replace(/\s+/g, ' '), promptTitle,
      labels: {
        open: jt('chat.artifactFigure.open', 'Open'),
        openAria: jt('chat.artifactFigure.openAria', 'Open {title} beside chat', { title: pres.title }),
        saveAs: jt('chat.artifactFigure.saveAs', 'Save as…'),
        copy: jt('chat.artifactFigure.copy', 'Copy'),
        reveal: jt('chat.artifactFigure.reveal', 'Show in folder'),
        unavailable: jt('chat.artifactFigure.unavailable', 'Image unavailable'),
      },
    });
  }

  function renderFileCard(callId, pres) {
    var safeCallId = escapeHtml(callId);
    var meta = escapeHtml(pres.kicker);
    return '<div class="inv-artifact-card ' + cardClassForKind('file') + '" data-artifact-call-id="' + safeCallId + '"' + artifactCardTargetAttr(pres) + '>'
      + '<div class="inv-artifact-icon">' + ICONS.file + '</div>'
      + '<div class="inv-artifact-info">'
      + '<span class="inv-artifact-title">' + escapeHtml(pres.title) + '</span>'
      + (meta ? '<span class="inv-artifact-meta">' + meta + '</span>' : '')
      + '</div>'
      + renderActions(pres, callId)
      + '</div>';
  }

  function renderGenericCard(callId, pres) {
    var safeCallId = escapeHtml(callId);
    var meta = escapeHtml(pres.kicker);
    return '<div class="inv-artifact-card ' + cardClassForKind('generic') + '" data-artifact-call-id="' + safeCallId + '"' + artifactCardTargetAttr(pres) + '>'
      + '<div class="inv-artifact-icon">' + ICONS.generic + '</div>'
      + '<div class="inv-artifact-info">'
      + '<span class="inv-artifact-title">' + escapeHtml(pres.title) + '</span>'
      + (meta ? '<span class="inv-artifact-meta">' + meta + '</span>' : '')
      + '</div>'
      + renderActions(pres, callId)
      + '</div>';
  }

  function renderArtifactCards(artifacts, callId, options) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return '';
    if (!presentation || typeof presentation.buildArtifactPresentation !== 'function') {
      return '';
    }
    var cards = [];
    var figures = [];
    for (var i = 0; i < artifacts.length; i++) {
      var artifact = artifacts[i];
      if (!artifact || typeof artifact !== 'object') continue;
      // The session store drops session_id from persisted artifacts; the row's session fills it in.
      var sessionId = artifact.session_id || artifact.sessionId || (options && options.sessionId) || '';
      var pres = presentation.buildArtifactPresentation(artifact, { mode: 'inline', sessionId: sessionId });
      var id = callId + '-art-' + i;
      if (pres.kind === presentation.KIND_IMAGE) figures.push(renderImageFigure(callId, pres, artifact, options));
      else if (pres.kind === presentation.KIND_FILE) cards.push(renderFileCard(id, pres));
      else cards.push(renderGenericCard(id, pres));
    }
    return (figures.length ? '<div class="inv-artifact-figures">' + figures.join('') + '</div>' : '')
      + (cards.length ? '<div class="inv-artifact-list">' + cards.join('') + '</div>' : '');
  }

  return {
    isAllowedArtifactImageSource: isAllowedArtifactImageSource,
    renderArtifactCards: renderArtifactCards,
    renderImagePendingFigure: renderImagePendingFigure,
    releaseInlineImages: releaseInlineImages,
    resetArtifactImageLoaderForTests: resetArtifactImageLoaderForTests,
  };
});
