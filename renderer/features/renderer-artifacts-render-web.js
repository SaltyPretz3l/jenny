/**
 * renderer/features/renderer-artifacts-render-web.js – html + svg artifact
 * kind renderers (WS2 registry, new kinds behind artifact_renderer_registry).
 *
 * These run in the PRIVILEGED renderer, so both kinds sanitize strictly:
 * html through the dedicated HTML_ARTIFACT_SANITIZE DOMPurify profile (no
 * scripts, no event handlers, no style attributes, no data attrs), svg
 * through the same sanitizeMermaidSvgMarkup pipeline Mermaid output uses.
 * A sandbox-iframe preview (HTML Artifact Preview, Wave 3) is the documented
 * escalation for richer HTML — never a looser profile here.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRenderWeb = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function resolveDOMPurify() {
    if (typeof globalThis !== 'undefined' && typeof globalThis.DOMPurify !== 'undefined') return globalThis.DOMPurify;
    try {
      const createDOMPurify = require('dompurify');
      if (typeof window !== 'undefined') return createDOMPurify(window);
      try {
        const { JSDOM } = require('jsdom');
        return createDOMPurify(new JSDOM('').window);
      } catch (_e2) { /* jsdom unavailable */ }
      return null;
    } catch (_e) { /* dompurify unavailable */ }
    return null;
  }

  function resolveSvgSanitizer() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererMermaidSanitizeUtils) {
      return globalThis.rendererMermaidSanitizeUtils;
    }
    try { return require('./renderer-mermaid-sanitize-utils'); } catch (_e) { /* unavailable */ }
    return null;
  }

  // Strict allowlist for HTML artifacts rendered in the privileged renderer.
  // Mirrors the chat markdown SANITIZE_CONFIG posture: structural/text markup
  // only — no scripts, iframes, forms, styles, or event handlers.
  const HTML_ARTIFACT_SANITIZE = {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'u',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'a',
      'code', 'pre',
      'blockquote',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
      'hr', 'span', 'div', 'img', 'figure', 'figcaption',
      'sup', 'sub', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside',
    ],
    // No 'target': artifact links must not open new windows from the
    // privileged renderer (reverse-tabnabbing surface); rel stays for
    // harmless annotations.
    ALLOWED_ATTR: ['class', 'href', 'rel', 'alt', 'src', 'title', 'colspan', 'rowspan'],
    FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    ALLOW_DATA_ATTR: false,
  };

  function sanitizeHtmlArtifactMarkup(rawHtml) {
    const purify = resolveDOMPurify();
    if (!purify || typeof purify.sanitize !== 'function') return '';
    return purify.sanitize(String(rawHtml || ''), HTML_ARTIFACT_SANITIZE);
  }

  function applyKindNotes(surface, deps, editable, editMode, kindLabel) {
    const { state, setDetailNote } = deps;
    if (state.artifacts.lastError) {
      setDetailNote(surface, state.artifacts.lastError, true);
    } else if (state.artifacts.loading) {
      setDetailNote(surface, 'Loading artifact...');
    } else if (editable) {
      setDetailNote(
        surface,
        editMode
          ? `Editing ${kindLabel} source. Save writes back to the session scratch file.`
          : `Sanitized ${kindLabel} preview with source and edit access below.`
      );
    } else {
      setDetailNote(surface, `Read-only ${kindLabel} artifact. You can inspect the source below.`);
    }
  }

  function enterEditMode(surface, file, editable, deps, fallbackLanguage) {
    const { state, ensureEditor, getPreferredEditorValue } = deps;
    surface.editorShell.classList.remove('hidden');
    ensureEditor(surface.key)?.setDocument({
      value: getPreferredEditorValue(),
      language: file?.language || fallbackLanguage,
      readOnly: !editable || state.artifacts.loading || Boolean(state.artifacts.lastError),
    }).catch(() => {});
  }

  function buildKindToolbar(kind, editMode, editable, deps) {
    const { state, escapeHtml, renderArtifactViewModeButton } = deps;
    if (state.features?.featureFlags?.artifact_panel_v3 === true || typeof renderArtifactViewModeButton !== 'function') return '';
    return '<div class="artifact-preview-mermaid-toolbar">'
      + renderArtifactViewModeButton(kind, 'preview', !editMode, 'Preview', state.artifacts.loading, escapeHtml)
      + renderArtifactViewModeButton(kind, 'edit', editMode, editable ? 'Edit Source' : 'View Source', state.artifacts.loading, escapeHtml)
      + '</div>';
  }

  function renderWebKind(ctx, kind, kindLabel, sanitizeMarkup, fallbackLanguage) {
    const { surface, file, editable, deps } = ctx;
    const { escapeHtml, getPreferredEditorValue, getArtifactViewMode } = deps;
    const source = getPreferredEditorValue();
    const editMode = (typeof getArtifactViewMode === 'function' ? getArtifactViewMode(kind) : 'preview') === 'edit';
    const toolbar = buildKindToolbar(kind, editMode, editable, deps);
    applyKindNotes(surface, deps, editable, editMode, kindLabel);

    surface.previewContent.classList.remove('hidden');
    if (editMode) {
      surface.previewContent.innerHTML = toolbar + `<div class="artifacts-empty">Editing ${escapeHtml(kindLabel)} source below. Switch back to Preview to re-render.</div>`;
      enterEditMode(surface, file, editable, deps, fallbackLanguage);
      return;
    }

    surface.editorShell.classList.add('hidden');
    if (!source.trim()) {
      surface.previewContent.innerHTML = toolbar + `<div class="artifacts-empty">Preview unavailable. ${escapeHtml(kindLabel)} source is empty.</div>`;
      return;
    }
    const sanitized = sanitizeMarkup(source);
    if (!String(sanitized || '').trim()) {
      surface.previewContent.innerHTML = (
        toolbar + `<div class="artifacts-empty">Preview unavailable. ${escapeHtml(kindLabel)} source is shown below.</div>`
        + `<pre class="artifact-preview-pre">${escapeHtml(source)}</pre>`
      );
      return;
    }
    surface.previewContent.innerHTML = (
      toolbar + `<div class="artifact-preview-web-shell" data-artifact-web-kind="${escapeHtml(kind)}">`
      + sanitized
      + '</div>'
    );
  }

  // artifact_html_preview is default-on with an environment rollback. Module
  // absence or flag-off still falls back to sanitized inline rendering.
  function resolveHtmlPreviewModule() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactHtmlPreviewRender) {
      return globalThis.rendererArtifactHtmlPreviewRender;
    }
    try { return require('./renderer-artifact-html-preview-render'); } catch (_e) { /* unavailable */ }
    return null;
  }

  function renderWebKindWithPreview(ctx, kind, kindLabel, sanitizeMarkup, fallbackLanguage) {
    const preview = resolveHtmlPreviewModule();
    if (preview
      && typeof preview.shouldRenderHtmlPreview === 'function'
      && typeof preview.renderHtmlPreviewKind === 'function'
      && preview.shouldRenderHtmlPreview(ctx, kind) === true) {
      preview.renderHtmlPreviewKind(ctx, kind);
      return;
    }
    renderWebKind(ctx, kind, kindLabel, sanitizeMarkup, fallbackLanguage);
  }

  function renderHtmlArtifactKind(ctx) {
    renderWebKindWithPreview(ctx, 'html', 'HTML', sanitizeHtmlArtifactMarkup, 'html');
  }

  function renderSvgArtifactKind(ctx) {
    const sanitizer = resolveSvgSanitizer();
    const purify = resolveDOMPurify();
    // Fail CLOSED like the html kind: sanitizeMermaidSvgMarkup degrades to a
    // regex strip without DOMPurify (fine for mermaid's own trusted-ish
    // output, not for arbitrary artifact SVG — SMIL <set>/<animate> vectors
    // survive the regex path). No DOMPurify -> no preview, source fallback.
    const sanitizeSvg = sanitizer
      && typeof sanitizer.sanitizeMermaidSvgMarkup === 'function'
      && purify && typeof purify.sanitize === 'function'
      ? (source) => sanitizer.sanitizeMermaidSvgMarkup(source)
      : () => '';
    // An svg carrying <script> is executable and may route to the sandbox
    // iframe (flag-gated); inert svg always stays on this inline path.
    renderWebKindWithPreview(ctx, 'svg', 'SVG', sanitizeSvg, 'xml');
  }

  return {
    HTML_ARTIFACT_SANITIZE,
    sanitizeHtmlArtifactMarkup,
    renderHtmlArtifactKind,
    renderSvgArtifactKind,
  };
});
