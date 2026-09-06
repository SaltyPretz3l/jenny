/* renderer/features/renderer-artifact-operation-target.js
 *
 * Selection changes use setSelection()/clearSelection(), async work captures
 * immutable identity/generation tokens, and disposal invalidates generations.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactOperationTarget = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function normalizeId(value) {
    return String(value || '').trim();
  }

  function createArtifactOperationTarget(deps) {
    const state = deps && deps.state;
    let disposed = false;

    function ensureArtifactsState() {
      if (!state || typeof state !== 'object') return null;
      if (!state.artifacts || typeof state.artifacts !== 'object') state.artifacts = {};
      return state.artifacts;
    }

    function currentGeneration() {
      const artifacts = ensureArtifactsState();
      const value = Number(artifacts?.operationGeneration);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

    function bump() {
      const artifacts = ensureArtifactsState();
      if (!artifacts) return currentGeneration();
      artifacts.operationGeneration = currentGeneration() + 1;
      return artifacts.operationGeneration;
    }

    function currentSelection() {
      const artifacts = ensureArtifactsState();
      return {
        sessionId: normalizeId(artifacts?.selectedSessionId),
        id: normalizeId(artifacts?.selectedArtifactId),
      };
    }

    // Every selection-changing call site must route through here (or
    // clearSelection) rather than assigning selectedSessionId/
    // selectedArtifactId directly — that is the single choke point that
    // guarantees the generation bump this whole primitive depends on.
    function setSelection(sessionId, artifactId) {
      const artifacts = ensureArtifactsState();
      if (!artifacts) return currentGeneration();
      artifacts.selectedSessionId = normalizeId(sessionId);
      artifacts.selectedArtifactId = normalizeId(artifactId);
      return bump();
    }

    function clearSelection() {
      return setSelection('', '');
    }

    function capture(sessionId, artifactId) {
      return Object.freeze({
        id: normalizeId(artifactId),
        sessionId: normalizeId(sessionId),
        generation: currentGeneration(),
      });
    }

    function captureSelected() {
      const selected = currentSelection();
      return capture(selected.sessionId, selected.id);
    }

    // Generation-based staleness check: true only if nothing about the
    // selection has changed (to this target OR any other target) since the
    // token was captured, and the controller has not been disposed.
    function isCurrent(token) {
      if (!token || disposed) return false;
      return Number(token.generation) === currentGeneration();
    }

    // Identity-based check: true if `token`'s artifact is what's CURRENTLY
    // selected, regardless of how many unrelated generation bumps happened
    // in between. Used by delete to decide whether the just-deleted target's
    // removal should also clear/re-render the "selected" UI, vs. leaving a
    // since-selected different artifact alone.
    function matchesSelection(token) {
      if (!token || disposed) return false;
      const selected = currentSelection();
      return token.sessionId === selected.sessionId && token.id === selected.id;
    }

    function isDisposed() {
      return disposed;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      bump();
    }

    return {
      capture,
      captureSelected,
      setSelection,
      clearSelection,
      isCurrent,
      matchesSelection,
      isDisposed,
      dispose,
      currentGeneration,
    };
  }

  return { createArtifactOperationTarget };
});
