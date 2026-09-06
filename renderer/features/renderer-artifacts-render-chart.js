/**
 * renderer/features/renderer-artifacts-render-chart.js – chart artifact kind
 * STUB + extension point (WS2 registry). No charting engine ships in this
 * build: a chart artifact is a JSON spec (Vega-Lite / Chart.js shaped). When
 * a runtime is installed at window.jennyChartRuntime ({ render({host, spec}) }),
 * rendering is delegated to it; otherwise the spec itself is shown. Replacing
 * this stub is a registry.register('chart', fn) call — the documented
 * extension point.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererArtifactsRenderChart = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFence) {

  const surfaceRenderGates = new WeakMap();

  function beginSurfaceRender(surface) {
    let gate = surfaceRenderGates.get(surface);
    if (!gate) {
      gate = asyncFence.createGenerationGate();
      surfaceRenderGates.set(surface, gate);
    }
    gate.bump();
    return { gate, token: gate.capture() };
  }

  function resolveChartRuntime() {
    return (typeof globalThis !== 'undefined' && globalThis.jennyChartRuntime) || null;
  }

  function parseChartSpec(source) {
    const trimmed = String(source || '').trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_err) {
      return null;
    }
  }

  function renderSpecFallback(surface, spec, source, deps) {
    const { escapeHtml, setDetailNote, prettyPrintJson } = deps;
    setDetailNote(
      surface,
      spec
        ? 'Chart spec preview. No chart runtime is installed; showing the JSON spec.'
        : 'Chart artifact could not be parsed as JSON. Showing the raw source.'
    );
    surface.previewContent.innerHTML = (
      '<div class="artifacts-empty">Chart rendering is an extension point - no runtime installed.</div>'
      + `<pre class="artifact-preview-pre">${escapeHtml(prettyPrintJson(source))}</pre>`
    );
  }

  function renderChartArtifactKind(ctx) {
    const { surface, artifact, deps } = ctx;
    const { escapeHtml, setDetailNote, prettyPrintJson, getPreferredEditorValue, getArtifactViewMode } = deps;
    const renderTarget = beginSurfaceRender(surface);
    const source = getPreferredEditorValue();
    const spec = parseChartSpec(source);
    surface.editorShell.classList.add('hidden');
    surface.previewContent.classList.remove('hidden');
    if ((typeof getArtifactViewMode === 'function' ? getArtifactViewMode('chart') : 'preview') === 'edit') {
      setDetailNote(surface, 'Viewing the chart JSON spec.');
      surface.previewContent.innerHTML = `<pre class="artifact-preview-pre">${escapeHtml(prettyPrintJson(source))}</pre>`;
      return;
    }

    const runtime = resolveChartRuntime();
    if (spec && runtime && typeof runtime.render === 'function') {
      const hostId = `${surface.key}-artifact-chart-${String(artifact.id || 'preview').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase()}`;
      surface.previewContent.innerHTML = `<div class="artifact-preview-chart-host" id="${escapeHtml(hostId)}"></div>`;
      const host = typeof document !== 'undefined' ? document.getElementById(hostId) : null;
      try {
        const result = runtime.render({ host, spec });
        if (result && typeof result.then === 'function') {
          setDetailNote(surface, 'Rendering chart with the installed chart runtime.');
          return Promise.resolve(result).then(function onRendered() {
            if (!renderTarget.gate.isCurrent(renderTarget.token)
              || !host?.isConnected || !surface.previewContent.contains(host)) return;
            setDetailNote(surface, 'Chart rendered by the installed chart runtime.');
          }, function onRenderFailed() {
            if (!renderTarget.gate.isCurrent(renderTarget.token)
              || !host?.isConnected || !surface.previewContent.contains(host)) return;
            renderSpecFallback(surface, spec, source, deps);
          });
        }
        setDetailNote(surface, 'Chart rendered by the installed chart runtime.');
        return;
      } catch (_err) {
        /* fall through to the spec view */
      }
    }

    renderSpecFallback(surface, spec, source, deps);
  }

  return { renderChartArtifactKind };
});
