/**
 * renderer/features/renderer-artifact-html-preview-render.js — executable-HTML
 * live-preview renderer + chrome (HTML Artifact Preview, artifact_html_preview,
 * default-on with an internal environment rollback).
 * renderer-artifacts-render-web.js delegates here from its
 * html/svg kinds when shouldRenderHtmlPreview() says so; every other case
 * (flag off, edit mode, inert svg, blank/loading/errored artifact) falls
 * through to the WS2 strict-DOMPurify inline path byte-identically.
 *
 * Chrome per design-specs/HTML_PREVIEW_CHROME_SPEC.md (owner-approved
 * F2-minimal featherweight strip + V2 ghost stepper): a bare flex strip above
 * the frame host — play glyph + muted label left, ghost chevron stepper +
 * v{k}/{n} right (stepper only when >=2 versions). States replace the label
 * text in place: "Running…" -> "Live preview" / "Preview failed — showing
 * code" (with the WS2 code listing rendered into the host as the fallback).
 *
 * Version stepping emits inventory actionButtons carrying
 * data-artifact-select, so clicks ride the existing artifact-selection
 * delegation and re-enter the WS2 registry render for the chosen version.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactHtmlPreviewRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Tabler geometry per the spec: player-play 11x11 for the strip label,
  // chevron-left/right 16x16 for the ghost stepper. All currentColor.
  const PLAY_GLYPH_SVG = '<svg class="artifact-html-preview-glyph" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16l13 -8z"></path></svg>';
  const CHEVRON_LEFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6l6 6"></path></svg>';
  const CHEVRON_RIGHT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6l-6 6"></path></svg>';

  // Expando keys on the stable surface.previewContent node (survives its own
  // innerHTML reassignment across renders) — see the re-render-churn guard in
  // renderHtmlPreviewKind below.
  const PREVIEW_SIGNATURE_KEY = '__jennyHtmlPreviewSignature';
  const PREVIEW_HANDLE_KEY = '__jennyHtmlPreviewHandle';

  function resolveModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* not available */ }
    }
    return null;
  }

  function isPreviewFlagEnabled(state) {
    return state?.features?.featureFlags?.artifact_html_preview === true;
  }

  function hasLiveFrameForArtifact(ctx, kind) {
    const node = ctx?.surface?.previewContent || null;
    const held = node ? node[PREVIEW_SIGNATURE_KEY] : '';
    return typeof held === 'string'
      && held.startsWith(`${kind}::${String(ctx?.artifact?.id || '')}::`)
      && Boolean(node.querySelector?.('[data-html-preview-host]'));
  }

  /**
   * Routing predicate for renderer-artifacts-render-web.js. False routes the
   * kind to the WS2 inline path unchanged, which is what keeps flag-off (and
   * every inert/edit/loading case) byte-identical.
   */
  function shouldRenderHtmlPreview(ctx, kind) {
    const deps = ctx?.deps || {};
    const state = deps.state || {};
    if (!isPreviewFlagEnabled(state)) return false;
    if (state.artifacts?.lastError) return false;
    const mode = typeof deps.getArtifactViewMode === 'function' ? deps.getArtifactViewMode(kind) : 'preview';
    if (mode === 'edit') return false;
    // Every turn settle replaces the session messages, which resets the
    // loaded artifact content and re-reads it behind a loading interstitial
    // (notifySessionMessagesReplaced -> invalidateSessionArtifacts ->
    // resetLoadedState -> preloadSelectedArtifact). Routing that interstitial
    // to the inline path would tear down the live settled iframe just to
    // rebuild it identically after the read — a full frame teardown+boot per
    // turn (the per-turn preview blink). Keep claiming the render so
    // renderHtmlPreviewKind can hold the existing frame; a first load with no
    // frame yet still falls through to the inline loading note.
    if (state.artifacts?.loading) return hasLiveFrameForArtifact(ctx, kind);
    const source = typeof deps.getPreferredEditorValue === 'function' ? String(deps.getPreferredEditorValue() || '') : '';
    if (!source.trim()) return false;
    const projection = resolveModule('rendererArtifactsProjection', './renderer-artifacts-projection');
    if (!projection || typeof projection.isExecutableHtmlArtifact !== 'function') return false;
    return projection.isExecutableHtmlArtifact(ctx?.artifact, source) === true;
  }

  function buildVersionStepper(artifact, state, escapeHtml) {
    const versionHistory = resolveModule('rendererArtifactVersionHistoryUtils', './renderer-artifact-version-history-utils');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    if (!versionHistory || typeof versionHistory.resolveArtifactVersionInfo !== 'function'
      || typeof actionButton !== 'function') {
      return '';
    }
    const info = versionHistory.resolveArtifactVersionInfo(artifact, state);
    // Spec: at one version the right cluster is empty — no placeholder, no v1/1.
    if (!info || info.count < 2) return '';
    const step = (label, glyph, targetId, disabled) => actionButton({
      plain: true,
      className: 'artifact-html-preview-step',
      ariaLabel: label,
      title: label,
      disabled,
      dataset: disabled || !targetId ? {} : { 'artifact-select': targetId },
      trustedHtml: glyph,
    });
    return '<span class="artifact-html-preview-versions">'
      + step('Previous version', CHEVRON_LEFT_SVG, info.prevId, info.index <= 1)
      + `<span class="artifact-html-preview-count">v${escapeHtml(String(info.index))}/${escapeHtml(String(info.count))}</span>`
      + step('Next version', CHEVRON_RIGHT_SVG, info.nextId, info.index >= info.count)
      + '</span>';
  }

  function renderHtmlPreviewKind(ctx, kind) {
    const { surface, artifact, editable, deps } = ctx;
    const { state, escapeHtml, setDetailNote, getPreferredEditorValue } = deps;
    const frameUtils = resolveModule('rendererHtmlArtifactFrameUtils', './renderer-html-artifact-frame-utils');
    const source = String(getPreferredEditorValue() || '');

    // Mid-reload interstitial (turn-settle artifact re-read): the loaded/dirty
    // content is reset, so the signature below would compare against an empty
    // source and rebuild. Hold the live frame untouched; the post-load render
    // reconciles against the real content — identical content is a signature
    // match (frame survives, zero blink), changed content rebuilds.
    if (state?.artifacts?.loading && hasLiveFrameForArtifact(ctx, kind)) {
      return;
    }

    // renderSelectedArtifactDetail re-runs on every renderAll() pass (every
    // streamed chat token while the review panel is open beside an active
    // turn) with the same selected artifact. createHtmlArtifactFrame's
    // postMessage handshake is asynchronous; rebuilding the iframe from
    // scratch on every incidental repaint starves it of an uninterrupted
    // window to settle, degrading a healthy artifact to "Preview failed"
    // purely from repaint churn (queue #15). Reuse the live/settled frame
    // when nothing it depends on has actually changed.
    const signature = `${kind}::${String(artifact?.id || '')}::${editable ? '1' : '0'}::${source}`;
    if (surface.previewContent[PREVIEW_SIGNATURE_KEY] === signature
      && surface.previewContent.querySelector('[data-html-preview-host]')) {
      return;
    }
    surface.previewContent[PREVIEW_HANDLE_KEY]?.dispose?.();
    surface.previewContent[PREVIEW_SIGNATURE_KEY] = signature;
    surface.previewContent[PREVIEW_HANDLE_KEY] = null;

    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    const toolbar = state.features?.featureFlags?.artifact_panel_v3 === true || typeof deps.renderArtifactViewModeButton !== 'function'
      ? ''
      : '<div class="artifact-preview-mermaid-toolbar">'
        + deps.renderArtifactViewModeButton(kind, 'preview', true, 'Preview', state.artifacts?.loading, escapeHtml)
        + deps.renderArtifactViewModeButton(kind, 'edit', false, editable ? 'Edit Source' : 'View Source', state.artifacts?.loading, escapeHtml)
        + '</div>';
    surface.previewContent.innerHTML = (
      toolbar + '<div class="artifact-html-preview-strip">'
      + PLAY_GLYPH_SVG
      + '<span class="artifact-html-preview-label" data-html-preview-label>Running…</span>'
      + buildVersionStepper(artifact, state, escapeHtml)
      + '</div>'
      + '<div class="artifact-html-preview-host" data-html-preview-host></div>'
    );
    if (typeof setDetailNote === 'function') {
      setDetailNote(surface, 'Sandboxed live preview. Scripts run in an isolated frame with no network access.');
    }

    const hostEl = surface.previewContent.querySelector('[data-html-preview-host]');
    const labelEl = surface.previewContent.querySelector('[data-html-preview-label]');
    let failed = false;

    function showCodeFallback(errorText) {
      failed = true;
      if (labelEl && labelEl.isConnected) {
        // errorText is attacker-influenced frame content — assigned via
        // textContent only, capped so the strip stays one line.
        const detail = typeof errorText === 'string' && errorText.trim()
          ? `: ${errorText.trim().slice(0, 200)}`
          : '';
        labelEl.textContent = `Preview failed — showing code${detail}`;
        labelEl.classList.add('artifact-html-preview-label--failed');
      }
      if (hostEl && hostEl.isConnected) {
        hostEl.classList.add('artifact-html-preview-host--failed');
        hostEl.innerHTML = `<pre class="artifact-preview-pre">${escapeHtml(source)}</pre>`;
      }
    }

    if (!frameUtils || typeof frameUtils.createHtmlArtifactFrame !== 'function' || !hostEl) {
      showCodeFallback();
      return;
    }
    surface.previewContent[PREVIEW_HANDLE_KEY] = frameUtils.createHtmlArtifactFrame(hostEl, source, {
      requestKey: artifact?.id,
      sizing: 'fill',
      onSuccess: () => {
        if (!failed && labelEl && labelEl.isConnected) {
          labelEl.textContent = 'Live preview';
        }
      },
      onFailure: (payload) => {
        if (!failed) showCodeFallback(payload?.error);
      },
    });
  }

  return {
    shouldRenderHtmlPreview,
    renderHtmlPreviewKind,
  };
});
