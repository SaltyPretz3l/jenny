/* renderer/features/renderer-artifact-async-ops.js
 *
 * Async artifact operations capture {id, sessionId, generation}, reject
 * stale or disposed completions, and accept the delete-confirm modal's
 * explicit target.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactAsyncOps = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createArtifactAsyncOps(deps) {
    const noop = () => {};
    const {
      state: inputState,
      surfaces = {},
      artifactOperationTarget,
      draftStore,
      getSelectedArtifact = () => null,
      getArtifactByTarget = null,
      isGeneratedFile = (artifact) => artifact?.artifactType === 'generated_file',
      isMermaidGeneratedArtifact = () => false,
      ensureEditor = () => null,
      getExistingEditor = () => null,
      getPreferredEditorValue = () => '',
      resetLoadedState = noop,
      bumpArtifactDocumentRevision = noop,
      renderArtifactsPanel = noop,
      renderArtifactReviewPanel = noop,
      invalidateSessionArtifacts = noop,
      clearSelectionUi = noop,
      showToastMessage = null,
      toErrorMessage = null,
    } = deps || {};
    const state = inputState && typeof inputState === 'object' ? inputState : { artifacts: {} };
    if (!state.artifacts || typeof state.artifacts !== 'object') state.artifacts = {};

    const inFlightDeletes = new Set();

    function formatError(error, fallback) {
      return typeof toErrorMessage === 'function'
        ? toErrorMessage(error)
        : String(error?.message || error || fallback || 'Unknown error.');
    }

    // Resolves a token to an artifact object. getArtifactByTarget (owned by
    // renderer-artifacts-utils.js, which holds the session artifact lists)
    // can resolve ANY target by identity; without it, resolution only
    // succeeds when the token still matches the live selection — the same
    // reach the pre-remediation getSelectedArtifact()-only code had.
    function resolveTarget(token) {
      if (!token) return null;
      if (typeof getArtifactByTarget === 'function') {
        const resolved = getArtifactByTarget(token.sessionId, token.id);
        if (resolved) return resolved;
      }
      const current = getSelectedArtifact();
      if (current && String(current.sessionId || '') === token.sessionId && String(current.id || '') === token.id) {
        return current;
      }
      return null;
    }

    // Replaces the old discardDirtyArtifactIfNeeded(): that function ran
    // AFTER selectedArtifactId/selectedSessionId already pointed at the NEW
    // target, so getSelectedArtifact() inside it read the wrong artifact,
    // and its unconditional dirtyContent reset lost the leaving artifact's
    // edit with no Save/Discard/Cancel decision. This must be called BEFORE
    // the selection changes: it reads the CURRENT (about-to-be-left)
    // target's dirty state and defers it into the draft store instead of
    // discarding it.
    function stashDirtyArtifactIfNeeded() {
      const sessionId = String(state.artifacts.selectedSessionId || '').trim();
      const artifactId = String(state.artifacts.selectedArtifactId || '').trim();
      state.artifacts.lastError = '';
      if (!sessionId || !artifactId) return;
      const isDirty = state.artifacts.loadedArtifactId === artifactId
        && state.artifacts.dirtyContent !== state.artifacts.loadedArtifactContent;
      if (!isDirty) return;
      draftStore.stash(sessionId, artifactId, state.artifacts.dirtyContent);
    }

    async function loadGeneratedArtifactContent(artifact) {
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file) return;
      const isMermaidFile = isMermaidGeneratedArtifact(artifact);
      const token = artifactOperationTarget.capture(artifact.sessionId, artifact.id);
      state.artifacts.loading = true;
      state.artifacts.lastError = '';
      renderArtifactsPanel();
      renderArtifactReviewPanel();
      let restoredDraft = null;
      try {
        const initialStatus = String(file.status || '').trim().toLowerCase();
        if (initialStatus !== 'available') {
          if (!artifactOperationTarget.isCurrent(token)) return;
          state.artifacts.loadedArtifactId = file.artifactId;
          state.artifacts.loadedArtifactContent = '';
          state.artifacts.dirtyContent = '';
          bumpArtifactDocumentRevision();
          await Promise.all(Object.keys(surfaces).map((key) => getExistingEditor(key)?.setDocument({
            value: '',
            language: file.language || 'plaintext',
            readOnly: true,
          }) || Promise.resolve()));
          return;
        }
        const payload = await window.jennyShell.artifacts.read(artifact.sessionId, file.artifactId);
        if (artifactOperationTarget.isDisposed()) return;
        if (!artifactOperationTarget.isCurrent(token)) return;
        const resolvedArtifact = payload?.artifact && typeof payload.artifact === 'object'
          ? payload.artifact
          : file;
        const resolvedStatus = String(resolvedArtifact.status || file.status || '').trim().toLowerCase();
        const canEditInline = resolvedArtifact.editable === true && resolvedStatus === 'available';
        const diskContent = String(payload?.content || '');
        // A stashed draft (left behind by a prior navigation away from this
        // exact artifact while it was dirty) takes priority over the fresh
        // disk read — that is the "defer, don't discard" contract. Single
        // use: once restored, the live editor owns it again.
        restoredDraft = draftStore.take(artifact.sessionId, artifact.id);
        const content = restoredDraft != null ? restoredDraft : diskContent;
        state.artifacts.loadedArtifactId = file.artifactId;
        state.artifacts.loadedArtifactContent = diskContent;
        state.artifacts.dirtyContent = content;
        bumpArtifactDocumentRevision();
        const updateEditor = isMermaidFile ? getExistingEditor : ensureEditor;
        await Promise.all(Object.keys(surfaces).map((key) => updateEditor(key)?.setDocument({
          value: content,
          language: resolvedArtifact.language || file.language || 'plaintext',
          readOnly: !canEditInline,
        }) || Promise.resolve()));
      } catch (error) {
        if (artifactOperationTarget.isDisposed()) return;
        if (!artifactOperationTarget.isCurrent(token)) return;
        if (restoredDraft != null) {
          draftStore.stash(artifact.sessionId, artifact.id, restoredDraft);
        }
        resetLoadedState();
        state.artifacts.lastError = formatError(error, 'Artifact load failed.');
      } finally {
        if (!artifactOperationTarget.isDisposed() && artifactOperationTarget.isCurrent(token)) {
          state.artifacts.loading = false;
          renderArtifactsPanel();
          renderArtifactReviewPanel();
        }
      }
    }

    async function saveSelectedArtifact() {
      const artifact = getSelectedArtifact();
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file || file.editable !== true) return;
      const token = artifactOperationTarget.capture(artifact.sessionId, artifact.id);
      const content = getPreferredEditorValue();
      state.artifacts.savePending = true;
      state.artifacts.lastError = '';
      renderArtifactsPanel();
      renderArtifactReviewPanel();
      try {
        await window.jennyShell.artifacts.save(artifact.sessionId, file.artifactId, content);
        if (artifactOperationTarget.isDisposed()) return;
        // A late completion after the user navigated to a different artifact
        // must not overwrite that artifact's loaded/dirty content — the
        // save itself already succeeded on disk regardless.
        if (artifactOperationTarget.isCurrent(token)) {
          state.artifacts.loadedArtifactId = file.artifactId;
          state.artifacts.loadedArtifactContent = content;
          state.artifacts.dirtyContent = content;
          bumpArtifactDocumentRevision();
        }
        invalidateSessionArtifacts(artifact.sessionId, { preserveLoaded: true });
        showToastMessage?.('Artifact saved.', { title: 'Artifacts', tone: 'success' });
      } catch (error) {
        if (artifactOperationTarget.isDisposed()) return;
        const message = formatError(error, 'Artifact save failed.');
        if (artifactOperationTarget.isCurrent(token)) {
          state.artifacts.lastError = message;
        }
        showToastMessage?.(message, { title: 'Artifact Save Failed', tone: 'danger' });
      } finally {
        if (!artifactOperationTarget.isDisposed()) {
          state.artifacts.savePending = false;
          renderArtifactsPanel();
          renderArtifactReviewPanel();
        }
      }
    }

    function revertSelectedArtifact() {
      const artifact = getSelectedArtifact();
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file) return;
      state.artifacts.lastError = '';
      state.artifacts.dirtyContent = state.artifacts.loadedArtifactContent || '';
      bumpArtifactDocumentRevision();
      draftStore.discard(artifact.sessionId, artifact.id);
      for (const key of Object.keys(surfaces)) {
        getExistingEditor(key)?.setDocument({ value: state.artifacts.loadedArtifactContent || '', language: file.language || 'plaintext', readOnly: file.editable !== true || artifact.status === 'missing' }).catch(() => {}); /* fire-and-forget */
      }
      renderArtifactsPanel();
      renderArtifactReviewPanel();
    }

    async function revealSelectedArtifact() {
      const artifact = getSelectedArtifact();
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file) return;
      try {
        await window.jennyShell.artifacts.reveal(artifact.sessionId, file.artifactId);
      } catch (error) {
        if (artifactOperationTarget.isDisposed()) return;
        showToastMessage?.(formatError(error, 'Reveal failed.'), { title: 'Reveal Failed', tone: 'danger' });
      }
    }

    async function openSelectedArtifactExternal() {
      const artifact = getSelectedArtifact();
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file) return;
      try {
        const result = await window.jennyShell.artifacts.openExternal(artifact.sessionId, file.artifactId);
        if (artifactOperationTarget.isDisposed()) return;
        if (result && result.ok === false) {
          const message = String(result.result || result.message || 'Open externally failed.');
          showToastMessage?.(message, { title: 'Open External Failed', tone: 'danger' });
        }
      } catch (error) {
        if (artifactOperationTarget.isDisposed()) return;
        showToastMessage?.(formatError(error, 'Open externally failed.'), { title: 'Open External Failed', tone: 'danger' });
      }
    }

    // explicitToken (from the delete-confirm modal's captured target) is the
    // fix for the modal-names-A-deletes-B defect: the modal captures a token
    // when it OPENS, and that exact token — not whatever is selected when
    // the user clicks Confirm — decides what gets deleted.
    async function deleteSelectedArtifact(explicitToken) {
      const artifact = resolveTarget(explicitToken);
      const file = artifact?.generatedFile || null;
      if (!artifact || !isGeneratedFile(artifact) || !file) return;
      const token = explicitToken;
      const opKey = `${artifact.sessionId}::${artifact.id}`;
      if (inFlightDeletes.has(opKey)) return; // double-click / re-entrancy guard
      inFlightDeletes.add(opKey);
      try {
        await window.jennyShell.artifacts.delete(artifact.sessionId, file.artifactId);
        if (artifactOperationTarget.isDisposed()) return;
        if (!Array.isArray(state.artifacts.deletedArtifactIds)) state.artifacts.deletedArtifactIds = [];
        if (!state.artifacts.deletedArtifactIds.includes(opKey)) state.artifacts.deletedArtifactIds.push(opKey);
        draftStore.discard(artifact.sessionId, artifact.id);
        const wasSelected = artifactOperationTarget.matchesSelection(token);
        invalidateSessionArtifacts(artifact.sessionId, { preserveLoaded: !wasSelected });
        if (wasSelected) {
          clearSelectionUi();
        }
        renderArtifactsPanel();
        renderArtifactReviewPanel();
        showToastMessage?.('Artifact deleted.', { title: 'Artifacts', tone: 'success' });
      } catch (error) {
        if (artifactOperationTarget.isDisposed()) return;
        showToastMessage?.(formatError(error, 'Delete failed.'), { title: 'Delete Failed', tone: 'danger' });
      } finally {
        inFlightDeletes.delete(opKey);
      }
    }

    function dispose() {
      artifactOperationTarget.dispose();
      inFlightDeletes.clear();
    }

    return {
      stashDirtyArtifactIfNeeded,
      loadGeneratedArtifactContent,
      saveSelectedArtifact,
      revertSelectedArtifact,
      revealSelectedArtifact,
      openSelectedArtifactExternal,
      deleteSelectedArtifact,
      dispose,
    };
  }

  return { createArtifactAsyncOps };
});
