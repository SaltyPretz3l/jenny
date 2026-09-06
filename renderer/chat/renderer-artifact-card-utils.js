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

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }
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
    image: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="6" r="1.25" stroke="currentColor" stroke-width="1"/><path d="M1.5 11l3.5-3 3 2.5 2-1.5 4.5 3" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>',
    file: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 2h7l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M10 2v3h3" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
    generic: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 8h6M8 5v6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    open: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M6 3H3v10h10v-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 2h5v5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 2L7 9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    reveal: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 3h4l1.5 1.5H14a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M5 9h6M8 6v6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
    /* ⤢ "Open in panel" glyph — Tabler arrows-diagonal geometry, shared
     * with the teaser/mermaid-fallback emit sites. */
    expand: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M7.5 2H10v2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 2L7 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M4.5 10H2V7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 10l3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  };

  function cardClassForKind(kind) {
    if (kind === 'image') return 'inv-artifact-card--image';
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

  function renderImageCard(callId, pres) {
    var src = escapeHtml(imageSourceForThumbnail(pres.thumbnail));
    var safeCallId = escapeHtml(callId);
    var preview = src
      ? '<img class="inv-artifact-thumb" src="' + src + '" alt="' + escapeHtml(pres.title) + '" loading="lazy">'
      : '<div class="inv-artifact-thumb-placeholder">' + ICONS.image + '</div>';
    return '<div class="inv-artifact-card ' + cardClassForKind('image') + '" data-artifact-call-id="' + safeCallId + '"' + artifactCardTargetAttr(pres) + '>'
      + '<div class="inv-artifact-preview">' + preview + '</div>'
      + '<div class="inv-artifact-info">'
      + '<span class="inv-artifact-title">' + escapeHtml(pres.title) + '</span>'
      + renderActions(pres, callId)
      + '</div>'
      + '</div>';
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

  function renderArtifactCards(artifacts, callId) {
    if (!Array.isArray(artifacts) || artifacts.length === 0) return '';
    if (!presentation || typeof presentation.buildArtifactPresentation !== 'function') {
      return '';
    }
    var cards = [];
    for (var i = 0; i < artifacts.length; i++) {
      var artifact = artifacts[i];
      if (!artifact || typeof artifact !== 'object') continue;
      var sessionId = artifact.session_id || artifact.sessionId || '';
      var pres = presentation.buildArtifactPresentation(artifact, { mode: 'inline', sessionId: sessionId });
      var id = callId + '-art-' + i;
      if (pres.kind === presentation.KIND_IMAGE) cards.push(renderImageCard(id, pres));
      else if (pres.kind === presentation.KIND_FILE) cards.push(renderFileCard(id, pres));
      else cards.push(renderGenericCard(id, pres));
    }
    if (cards.length === 0) return '';
    return '<div class="inv-artifact-list">' + cards.join('') + '</div>';
  }

  return {
    isAllowedArtifactImageSource: isAllowedArtifactImageSource,
    renderArtifactCards: renderArtifactCards,
  };
});
