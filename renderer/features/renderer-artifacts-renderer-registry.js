/**
 * renderer/features/renderer-artifacts-renderer-registry.js – Artifact renderer
 * registry + kind resolver (WS2, gated by artifact_renderer_registry).
 *
 * A small extensible dispatch table so the artifact review panel and the
 * Artifacts view render every artifact kind through one seam instead of the
 * surface-controller's fat if/else. Kind resolution is pure first-match over
 * the injected projection predicates; renderers receive one ctx object:
 *
 *   renderKind({ surface, artifact, file, editable, deps })
 *
 * View mode is NOT snapshotted into ctx — renderers that need it read
 * deps.getArtifactViewMode(kind) so there is one source of truth.
 *
 * `register('chart', fn)` is the extension point — e.g. a future charting
 * runtime replaces the shipped chart stub without touching the dispatcher.
 * Renderer failures are contained: render() returns false instead of letting
 * an exception cross into the surface controller.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRendererRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  const RENDER_KINDS = Object.freeze([
    'mermaid', 'chart', 'code', 'markdown', 'html', 'svg', 'image', 'text',
  ]);
  const BUILTIN_KIND_SET = new Set(RENDER_KINDS);
  const PLUGIN_KIND = /^[a-z][a-z0-9_-]{0,63}:[a-z][a-z0-9_.-]{0,63}$/;
  const pluginRenderers = new Map();

  /**
   * First-match kind resolution over a projected artifact. Precedence mirrors
   * the legacy dispatcher: image artifacts, then generated files
   * (mermaid → markdown → html → svg → chart → code), then tool output
   * (mermaid-bearing → mermaid, else text). Missing predicates degrade to the
   * legacy defaults (code for generated, text otherwise) — never throw.
   */
  function resolveArtifactRenderKind(artifact, deps = {}) {
    if (!artifact || typeof artifact !== 'object') return 'text';
    const pluginKind = normalizeKind(artifact.pluginArtifactKind || artifact.artifactKind);
    if (pluginKind.includes(':') && pluginRenderers.has(pluginKind)) return pluginKind;
    const check = (name) => typeof deps[name] === 'function' && deps[name](artifact) === true;
    if (check('isImageArtifact')) return 'image';
    if (check('isGeneratedFile')) {
      if (check('isMermaidGeneratedArtifact')) return 'mermaid';
      if (check('isMarkdownGeneratedArtifact')) return 'markdown';
      if (check('isHtmlGeneratedArtifact')) return 'html';
      if (check('isSvgGeneratedArtifact')) return 'svg';
      if (check('isChartGeneratedArtifact')) return 'chart';
      return 'code';
    }
    if (typeof deps.extractMermaidSourceFromToolArtifact === 'function'
        && String(deps.extractMermaidSourceFromToolArtifact(artifact) || '').trim()) {
      return 'mermaid';
    }
    return 'text';
  }

  function normalizeKind(kind) {
    return String(kind || '').trim().toLowerCase();
  }

  function createArtifactRendererRegistry(builtins = {}) {
    const renderers = new Map();
    if (builtins && typeof builtins === 'object') {
      for (const [kind, renderKind] of Object.entries(builtins)) {
        const token = normalizeKind(kind);
        if (token && typeof renderKind === 'function') {
          renderers.set(token, renderKind);
        }
      }
    }

    function warn(message, detail) {
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(`[artifact-renderer-registry] ${message}`, detail);
      }
    }

    function register(kind, renderKind) {
      const token = normalizeKind(kind);
      if (!token || typeof renderKind !== 'function') {
        warn('register() rejected — kind must be a non-empty string and renderKind a function', { kind });
        return false;
      }
      renderers.set(token, renderKind);
      return true;
    }

    function has(kind) {
      return renderers.has(normalizeKind(kind));
    }

    function get(kind) {
      const token = normalizeKind(kind);
      return pluginRenderers.get(token) || renderers.get(token) || null;
    }

    function kinds() {
      const listed = new Set(RENDER_KINDS);
      for (const token of renderers.keys()) listed.add(token);
      for (const token of pluginRenderers.keys()) listed.add(token);
      return [...listed];
    }

    /**
     * Dispatch ctx to the kind's renderer, falling back to `text` for an
     * unknown kind. Returns true when a renderer ran to completion, false
     * when none exists or the renderer threw (contained here so a broken
     * kind cannot take down the artifact surface render pass).
     */
    function render(kind, ctx) {
      const token = normalizeKind(kind);
      const renderKind = pluginRenderers.get(token) || renderers.get(token) || renderers.get('text');
      if (typeof renderKind !== 'function') return false;
      try {
        renderKind(ctx);
        return true;
      } catch (err) {
        warn(`renderer for kind "${normalizeKind(kind)}" threw; render skipped`, err);
        const fallback = renderers.get('text');
        if (renderKind !== fallback && typeof fallback === 'function') {
          try { fallback(ctx); return true; } catch (_fallbackError) { /* contained */ }
        }
        return false;
      }
    }

    return { register, has, get, kinds, render };
  }

  function registerPluginRenderer(kind, renderKind) {
    const token = normalizeKind(kind);
    if (!PLUGIN_KIND.test(token) || BUILTIN_KIND_SET.has(token) || typeof renderKind !== 'function') return false;
    pluginRenderers.set(token, renderKind);
    return true;
  }

  function clearPluginRenderers() { pluginRenderers.clear(); }

  return {
    RENDER_KINDS,
    resolveArtifactRenderKind,
    createArtifactRendererRegistry,
    registerPluginRenderer,
    clearPluginRenderers,
  };
});
