/** Pure Artifact Panel V3 view-capability resolution. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactViewCapabilities = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function callPredicate(predicates, name, artifact) {
    return typeof predicates?.[name] === 'function' && predicates[name](artifact) === true;
  }

  function languageToken(artifact) {
    var file = artifact?.generatedFile || {};
    return String(file.language || '').trim().toLowerCase();
  }

  function fileNameToken(artifact) {
    var file = artifact?.generatedFile || {};
    return String(file.fileName || file.displayPath || '').trim().toLowerCase();
  }

  function resolveArtifactViewKind(artifact, predicates) {
    if (!artifact) return '';
    var language = languageToken(artifact);
    var fileName = fileNameToken(artifact);
    if (artifact.artifactType === 'image' || callPredicate(predicates, 'isImageArtifact', artifact)) return 'image';
    if (callPredicate(predicates, 'isMarkdownGeneratedArtifact', artifact) || ['markdown', 'md'].includes(language) || /\.(md|markdown)$/.test(fileName)) return 'markdown';
    if (callPredicate(predicates, 'isMermaidGeneratedArtifact', artifact) || ['mermaid', 'mmd'].includes(language) || /\.mmd$/.test(fileName)) return 'mermaid';
    if (callPredicate(predicates, 'isHtmlGeneratedArtifact', artifact) || ['html', 'htm'].includes(language) || /\.html?$/.test(fileName)) return 'html';
    if (callPredicate(predicates, 'isSvgGeneratedArtifact', artifact) || language === 'svg' || /\.svg$/.test(fileName)) return 'svg';
    if (callPredicate(predicates, 'isChartGeneratedArtifact', artifact) || ['chart', 'vega', 'vega-lite'].includes(language) || /\.(chart|vl)\.json$/.test(fileName)) return 'chart';
    if (artifact.artifactType === 'generated_file') return 'code';
    if (typeof predicates?.extractMermaidSourceFromToolArtifact === 'function'
      && predicates.extractMermaidSourceFromToolArtifact(artifact)) return 'mermaid';
    return 'text';
  }

  function resolveArtifactViewCapabilities(artifact, predicates) {
    var kind = resolveArtifactViewKind(artifact, predicates || {});
    if (['markdown', 'mermaid', 'html', 'svg', 'chart'].includes(kind)) {
      return { hasPreview: true, hasCode: true, defaultView: 'preview', kind: kind };
    }
    if (kind === 'image') return { hasPreview: true, hasCode: false, defaultView: 'preview', kind: kind };
    return { hasPreview: false, hasCode: true, defaultView: 'code', kind: kind || 'text' };
  }

  return { resolveArtifactViewCapabilities: resolveArtifactViewCapabilities, resolveArtifactViewKind: resolveArtifactViewKind };
});
