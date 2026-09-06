/**
 * renderer/features/renderer-artifacts-render-mermaid.js – mermaid artifact
 * kind entry for the WS2 renderer registry.
 *
 * Thin by design: the generated-file implementation stays in
 * renderer-artifacts-render.js (it already lives in a sibling and carries the
 * scoped raw-primitive budget for its toolbar markup), and the tool-output
 * implementation stays controller-local beside the legacy dispatch. Both
 * arrive pre-bound through ctx.deps, so the registry path and the legacy
 * flag-off path run the identical functions.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactsRenderMermaid = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  function renderMermaidArtifactKind(ctx) {
    const { surface, artifact, file, editable, deps } = ctx;
    if (typeof deps.isGeneratedFile === 'function' && deps.isGeneratedFile(artifact)) {
      if (typeof deps.renderMermaidGeneratedArtifact === 'function') {
        deps.renderMermaidGeneratedArtifact(surface, artifact, file, editable);
      }
      return;
    }
    if (typeof deps.renderMermaidToolOutputArtifact === 'function') {
      deps.renderMermaidToolOutputArtifact(surface, artifact);
    }
  }

  return { renderMermaidArtifactKind };
});
