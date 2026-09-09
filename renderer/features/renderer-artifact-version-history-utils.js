/**
 * renderer/features/renderer-artifact-version-history-utils.js — derived
 * version history for regenerated artifacts (HTML Artifact Preview,
 * artifact_html_preview).
 *
 * Version groups are derived from projected session artifacts by filename
 * stem, capped at 20, not persisted, and selected through the existing
 * [data-artifact-select] path.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactVersionHistoryUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_VERSION_HISTORY_ENTRIES = 20;
  const MAX_PROJECTION_CACHE_SESSIONS = 8;
  // sessionId -> { messagesRef, artifacts } — same messagesRef-identity cache
  // trick renderer-artifacts-utils.js uses, so re-renders don't re-project.
  const projectionCache = new Map();
  const versionCache = new WeakMap();

  function resolveProjection() {
    if (typeof globalThis !== 'undefined' && globalThis.rendererArtifactsProjection) {
      return globalThis.rendererArtifactsProjection;
    }
    if (typeof require === 'function') {
      try { return require('./renderer-artifacts-projection'); } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  function buildArtifactVersionGroupKey(sessionId, fileName, candidateFileNames) {
    const session = String(sessionId || '').trim();
    const name = String(fileName || '').trim().toLowerCase();
    if (!session || !name) return '';
    const dotIndex = name.lastIndexOf('.');
    const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
    const extension = dotIndex > 0 ? name.slice(dotIndex) : '';
    // Treat a numeric suffix as a storage collision only when the candidate
    // set contains the corresponding unsuffixed filename.
    const suffixMatch = stem.match(/^(.*)-\d{1,4}$/);
    const unsuffixedName = suffixMatch ? `${suffixMatch[1]}${extension}` : '';
    const candidates = candidateFileNames instanceof Set ? candidateFileNames : new Set();
    const baseStem = suffixMatch && candidates.has(unsuffixedName) ? suffixMatch[1] : stem;
    return `${session}::${baseStem}::${extension}`;
  }

  function artifactFileName(artifact) {
    const file = artifact?.generatedFile || null;
    if (!file || artifact?.artifactType !== 'generated_file') return '';
    return String(file.fileName || '').trim()
      || String(file.displayPath || '').trim().replace(/\\/g, '/').split('/').pop()
      || '';
  }

  function artifactVersionKey(artifact, candidateFileNames) {
    return buildArtifactVersionGroupKey(artifact?.sessionId, artifactFileName(artifact), candidateFileNames);
  }

  function getSessionArtifacts(sessionId, state) {
    const key = String(sessionId || '').trim();
    const messages = state?.messagesBySession?.get?.(key);
    if (!key || !Array.isArray(messages)) return null;
    const cached = projectionCache.get(key);
    if (cached && cached.messagesRef === messages) return cached.artifacts;
    const projection = resolveProjection();
    if (!projection || typeof projection.buildArtifactsFromMessages !== 'function') return null;
    let artifacts;
    try {
      artifacts = projection.buildArtifactsFromMessages(messages, { sessionId: key });
    } catch (_error) {
      return null;
    }
    projectionCache.delete(key);
    projectionCache.set(key, { messagesRef: messages, artifacts });
    while (projectionCache.size > MAX_PROJECTION_CACHE_SESSIONS) {
      projectionCache.delete(projectionCache.keys().next().value);
    }
    return artifacts;
  }

  function compareOldestFirst(left, right) {
    const byTimestamp = String(left?.timestamp || '').trim().localeCompare(String(right?.timestamp || '').trim());
    return byTimestamp !== 0 ? byTimestamp : String(left?.id || '').localeCompare(String(right?.id || ''));
  }

  /**
   * @returns {null | {index: number, count: number, prevId: string, nextId: string}}
   *   1-based index into the (bounded) oldest-first version group. null = no
   *   selector (unkeyable artifact, missing state, or fell off the cap window).
   */
  function resolveArtifactVersionInfo(artifact, state) {
    const projected = getSessionArtifacts(artifact?.sessionId, state);
    if (!projected) return null;
    const deleted = state?.artifacts?.deletedArtifactIds || [];
    const signature = JSON.stringify(deleted);
    let cached = versionCache.get(projected);
    if (!cached || cached.signature !== signature) {
      cached = { signature, byId: new Map() };
      versionCache.set(projected, cached);
    }
    const selectedId = String(artifact?.id || artifact?.generatedFile?.artifactId || '').trim();
    if (cached.byId.has(selectedId)) return cached.byId.get(selectedId);
    const artifacts = resolveProjection()?.filterDeletedArtifacts?.(projected, deleted, artifact?.sessionId) || projected;
    if (!artifacts.length) return null;
    const candidateFileNames = new Set(projected.map(artifactFileName).map((name) => name.toLowerCase()).filter(Boolean));
    const groupKey = artifactVersionKey(artifact, candidateFileNames);
    if (!groupKey) return null;
    const group = artifacts
      .filter((entry) => artifactVersionKey(entry, candidateFileNames) === groupKey)
      .sort(compareOldestFirst)
      .slice(-MAX_VERSION_HISTORY_ENTRIES);
    group.forEach((entry, position) => cached.byId.set(String(entry.id || '').trim(), {
      index: position + 1,
      count: group.length,
      prevId: position > 0 ? String(group[position - 1]?.id || '') : '',
      nextId: position < group.length - 1 ? String(group[position + 1]?.id || '') : '',
    }));
    if (!cached.byId.has(selectedId)) cached.byId.set(selectedId, null);
    return cached.byId.get(selectedId);
  }

  return {
    MAX_VERSION_HISTORY_ENTRIES,
    buildArtifactVersionGroupKey,
    resolveArtifactVersionInfo,
  };
});
