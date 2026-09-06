/**
 * renderer/chat/renderer-citation-chips-utils.js
 *
 * Inline source-citation chip markup (UMD) — C1 "title pills" per
 * docs/plans/executor-handoffs/design-specs/CITATION_CHIPS_SPEC.md. Renders a
 * bounded row of <a class="citation-chip"> pills beneath an assistant turn
 * that cited the web (the persisted `source_citations` turn-event kind).
 *
 * Untrusted-input contract (AGENTS.md §11): refs arrive through the bounded
 * collector-side normalizer (services/backend/tool-result-source-metadata.js),
 * and EVERY field is additionally HTML-escaped here at render time; the url
 * scheme is re-checked defensively. <a>/<span> only — no form controls.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCitationChipsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackEscapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Tabler `world` geometry, 12x12, stroke 1.6 (spec: no favicons — never an
  // external image fetch from chat markup).
  const WORLD_GLYPH_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><circle cx="6" cy="6" r="4.6" stroke="currentColor" stroke-width="1.2"/><path d="M1.4 6h9.2" stroke="currentColor" stroke-width="1.2"/><path d="M6 1.4c1.5 1.3 2.2 2.9 2.2 4.6S7.5 9.3 6 10.6C4.5 9.3 3.8 7.7 3.8 6S4.5 2.7 6 1.4z" stroke="currentColor" stroke-width="1.2"/></svg>';

  // Marker cleanup: gpt-oss (at minimum) echoes the tool's `web:N` citation
  // ids back into the visible answer as bracketed markers — ASCII `[web:N]`
  // or the fullwidth CJK corner brackets `【web:N】` it favors, both
  // optionally comma-joining several ids (`[web:1,7]`). The chip row above
  // already surfaces every cited source, so a leaked marker is pure noise
  // once chips exist; strip it (and one leading space, so punctuation right
  // after the marker doesn't end up with a stray gap) rather than leaving
  // the raw token in the rendered text. Case-insensitive defensively; the
  // literal `web:` requirement keeps this from ever touching unrelated
  // bracketed text (markdown links, "[webinar: 1]", etc).
  const CITATION_MARKER_PATTERN = /\s?[[【]\s*web:\s*\d+(?:\s*,\s*\d+)*\s*[\]】]/gi;

  function stripCitationMarkers(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return raw;
    return raw.replace(CITATION_MARKER_PATTERN, '');
  }

  function safeHttpUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (_error) {
      return null;
    }
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return parsed;
  }

  function renderCitationChips(options) {
    const settings = options && typeof options === 'object' ? options : {};
    const refs = Array.isArray(settings.refs) ? settings.refs : [];
    if (!refs.length) return '';
    const escapeHtml = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : fallbackEscapeHtml;
    const chips = [];
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object') continue;
      const parsed = safeHttpUrl(ref.url);
      if (!parsed) continue; // defensive re-check; the normalizer is upstream
      const url = parsed.toString();
      const title = String(ref.title == null ? '' : ref.title).trim();
      const snippet = String(ref.snippet == null ? '' : ref.snippet).trim();
      // Spec: missing title -> hostname pill text; tooltip carries the snippet
      // (or the full URL when no snippet exists).
      const pillText = title || String(parsed.hostname || '');
      const tooltip = snippet || url;
      chips.push(
        `<a class="citation-chip" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tooltip)}">`
        + WORLD_GLYPH_SVG
        + `<span class="citation-chip-title">${escapeHtml(pillText)}</span>`
        + '</a>'
      );
    }
    if (!chips.length) return '';
    return `<div class="citation-chips-row">${chips.join('')}</div>`;
  }

  return { renderCitationChips, stripCitationMarkers };
});
