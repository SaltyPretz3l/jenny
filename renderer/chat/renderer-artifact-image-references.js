/* Resolve already-sanitized Markdown images through canonical session metadata. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/artifact-figure'));
    return;
  }
  root.rendererArtifactImageReferences = factory(root.inventoryArtifactFigure);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (figure) {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const turnOf = (message) => String(message?.turn_id || message?.turnId || message?.parent_stream_id || '').trim();
  const sessionOf = (message) => String(message?.session_id || message?.sessionId || '').trim();

  function normalizeDisplayPath(value) {
    let text = String(value || '').trim();
    text = text.replace(/\\/g, '/');
    if (!text || Array.from(text).some((char) => char.charCodeAt(0) < 32)
      || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(text)) return '';
    const parts = text.split('/');
    if (parts.includes('..')) return '';
    return parts.filter((part) => part && part !== '.').join('/');
  }

  function buildImageReferenceContext(messages, message, sessionId) {
    const all = Array.isArray(messages) ? messages : [];
    const session = String(sessionId || sessionOf(message)).trim();
    const artifacts = [];
    const turn = turnOf(message);
    let index = all.indexOf(message);
    if (index < 0 && message?.id) index = all.findIndex((entry) => entry?.id === message.id);
    if (index < 0) index = all.length;
    let start = index;
    while (start > 0 && all[start]?.role !== 'user') start -= 1;
    let end = index + 1;
    while (end < all.length && all[end]?.role !== 'user') end += 1;
    let hasGeneratedImage = false;
    if (!session || (sessionOf(message) && sessionOf(message) !== session)) return { sessionId: session, artifacts, hasGeneratedImage };
    for (let i = 0; i < all.length; i += 1) {
      const entry = all[i];
      if (sessionOf(entry) && sessionOf(entry) !== session) continue;
      const result = entry?.tool_result;
      const sameTurn = turn && turnOf(entry) ? turnOf(entry) === turn : i >= start && i < end;
      if (sameTurn && (result?.tool_name === 'image_generate' || entry?.tool_call?.tool_name === 'image_generate')) hasGeneratedImage = true;
      for (const artifact of Array.isArray(result?.generated_artifacts) ? result.generated_artifacts : []) {
        if (artifact?.artifact_kind !== 'image' || !artifact.artifact_id) continue;
        if (sessionOf(artifact) && sessionOf(artifact) !== session) continue;
        artifacts.push(artifact);
        if (sameTurn) hasGeneratedImage = true;
      }
    }
    return { sessionId: session, artifacts, hasGeneratedImage };
  }

  function rewriteImageReferences(html, context = {}) {
    if (typeof html !== 'string' || !/<img\b/i.test(html)) return html;
    const doc = context.documentRef || globalThis.document;
    if (!doc || !figure) return html;
    const template = doc.createElement('template');
    template.innerHTML = html;
    let changed = false;
    for (const img of template.content.querySelectorAll('img')) {
      const src = String(img.getAttribute('src') || '').trim();
      // Leave remote and approved embedded image sources to the Markdown sanitizer.
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(src) && !/^(?:file:|sandbox:|[a-z]:[\\/])/i.test(src)) continue;
      const normalized = normalizeDisplayPath(src);
      let decoded = normalized; try { decoded = normalizeDisplayPath(decodeURIComponent(src)); } catch (_error) { /* literal percent path */ }
      const artifact = context.sessionId && (context.artifacts || []).find((entry) => {
        if (sessionOf(entry) && sessionOf(entry) !== context.sessionId) return false;
        return entry.artifact_kind === 'image' && normalized
          && (src === entry.artifact_id || [normalized, decoded].includes(normalizeDisplayPath(entry.display_path)));
      });
      if (!artifact && !context.hasGeneratedImage) continue;
      const replacement = doc.createElement('template');
      replacement.innerHTML = artifact
        ? figure.renderViewerButton({ sessionId: context.sessionId, artifactId: artifact.artifact_id,
          label: jt('chat.artifactFigure.viewImage', 'View image') })
        : figure.renderUnavailableReference(jt('chat.artifactFigure.referenceUnavailable', 'Image reference unavailable.'));
      // An image may have been wrapped in a link by Markdown. Remove that wrapper
      // to avoid nested interactive controls or navigation to the original path.
      const anchor = img.closest('a');
      if (anchor && /^(?:https?:|\/\/)/i.test(anchor.getAttribute('href') || '')) {
        img.replaceWith(doc.createTextNode(img.getAttribute('alt') || jt('chat.artifactFigure.viewImage', 'View image')));
        anchor.after(replacement.content);
      } else {
        if (anchor) anchor.replaceWith(...anchor.childNodes);
        img.replaceWith(replacement.content);
      }
      changed = true;
    }
    return changed ? template.innerHTML : html;
  }

  function createRewriter(messages, message, sessionId, documentRef) {
    let context;
    return html => {
      if (typeof html !== 'string' || !/<img\b/i.test(html)) return html;
      context ||= buildImageReferenceContext(messages, message, sessionId);
      return rewriteImageReferences(html, { ...context, documentRef });
    };
  }
  return { buildImageReferenceContext, rewriteImageReferences, createRewriter };
});
