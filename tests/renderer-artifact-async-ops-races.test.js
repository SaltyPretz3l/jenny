'use strict';

// UIUX-007: controller-level race-condition coverage for the artifact
// read/save/delete completion paths, per the audit's gate list ("dirty A to
// B/filter/session/auto-open, confirm A then select B, overlapping
// save/delete, target removed, failure, double-click, and late completion
// after disposal"). These exercise renderer-artifacts-surface-controller.js
// + renderer-artifact-async-ops.js directly with manually-resolved promises
// so the exact interleaving is deterministic (a full-shell test cannot
// reliably force "the save's network call resolves AFTER the user already
// selected a different artifact").
//
// RED-FIRST evidence: before this remediation, none of
// renderer-artifact-operation-target.js / renderer-artifact-async-ops.js
// existed, and saveSelectedArtifact/deleteSelectedArtifact applied their
// post-await results against getSelectedArtifact() with no staleness check
// at all -- every "late completion must not clobber B" assertion below would
// have failed against that code (see the session's captured RED output for
// the equivalent pre-fix run).

const { JSDOM } = require('jsdom');
const test = require('node:test');
const assert = require('node:assert/strict');
const projection = require('../renderer/features/renderer-artifacts-projection.js');
const artifactRender = require('../renderer/features/renderer-artifacts-render.js');
const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller.js');
const { createArtifactAsyncOps } = require('../renderer/features/renderer-artifact-async-ops.js');
const { createArtifactDraftStore } = require('../renderer/features/renderer-artifact-draft-store.js');
const { createArtifactOperationTarget } = require('../renderer/features/renderer-artifact-operation-target.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function generatedArtifactFixture(id, sessionId, overrides = {}) {
  return {
    id,
    sessionId,
    artifactType: 'generated_file',
    title: `Fixture ${id}`,
    timestamp: '2026-07-01T12:00:00.000Z',
    status: 'available',
    generatedFile: {
      artifactId: id,
      artifactKind: 'document',
      fileName: `${id}.md`,
      displayPath: `.jenny/artifacts/${sessionId}/${id}.md`,
      editable: true,
      status: 'available',
      language: 'markdown',
    },
    ...overrides,
  };
}

function makeHarness(t, { registryEnabled = false } = {}) {
  const dom = new JSDOM('<body></body>');
  const doc = dom.window.document;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = doc;
  globalThis.window = dom.window;
  t.after(() => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });

  const el = (tag = 'div') => {
    const node = doc.createElement(tag);
    doc.body.appendChild(node);
    return node;
  };
  const surface = {
    key: 'full',
    detailEmpty: el(), detailPanel: el(), detailKicker: el(), detailTitle: el(),
    detailPath: el(), detailStatus: el(), detailMeta: el(), detailNote: el(),
    previewContent: el(), editorShell: el(), editorHost: el(), editorFallback: el(),
    saveButton: el(), revertButton: el(), revealButton: el(), openExternalButton: el(),
    deleteButton: el(), jumpButton: el(), provenanceTimeline: el(), metaPane: el(),
    dirtyBadge: el(), stackedMeta: false,
  };

  const artifactsById = new Map();
  let selectedId = '';
  let selectedSessionId = '';
  const toasts = [];
  const renderCalls = { full: 0, split: 0 };
  const invalidateCalls = [];
  const clearSelectionCalls = [];

  const state = {
    artifacts: {
      selectedArtifactId: '',
      selectedSessionId: '',
      loadedArtifactId: '',
      loadedArtifactContent: '',
      dirtyContent: '',
      loading: false,
      savePending: false,
      lastError: '',
      deletedArtifactIds: [],
      operationGeneration: 0,
    },
    features: { featureFlags: { artifact_renderer_registry: registryEnabled === true } },
  };

  const readImpl = { fn: async (sessionId, artifactId) => ({ artifact: { artifact_id: artifactId, editable: true, status: 'available' }, content: 'disk content' }) };
  const saveImpl = { fn: async () => ({}) };
  const deleteImpl = { fn: async () => ({}) };

  dom.window.jennyShell = {
    artifacts: {
      read: (...args) => readImpl.fn(...args),
      save: (...args) => saveImpl.fn(...args),
      delete: (...args) => deleteImpl.fn(...args),
    },
  };

  function getSelectedArtifact() {
    return artifactsById.get(`${selectedSessionId}::${selectedId}`) || null;
  }
  function getArtifactByTarget(sessionId, artifactId) {
    return artifactsById.get(`${sessionId}::${artifactId}`) || null;
  }

  const controller = createArtifactSurfaceController({
    state,
    surfaces: { full: surface, split: surface },
    artifactRender,
    renderMermaidPreviewIntoHost: () => true,
    escapeHtml: (value) => String(value ?? ''),
    appendClientLog: () => {},
    showToastMessage: (message) => toasts.push(message),
    toErrorMessage: (error) => String(error?.message || error || ''),
    getSelectedArtifact,
    getArtifactByTarget,
    getArtifactReviewState: () => ({}),
    renderArtifactsPanel: () => { renderCalls.full += 1; },
    renderArtifactReviewPanel: () => { renderCalls.split += 1; },
    invalidateSessionArtifacts: (sessionId, opts) => invalidateCalls.push({ sessionId, opts }),
    // Mirrors renderer-artifacts-utils.js's real clearSelection(): it must
    // go through applySelection so the operation-target generation bumps
    // too, not just blank the local id trackers this harness uses for
    // getSelectedArtifact().
    clearSelection: () => {
      clearSelectionCalls.push(true);
      selectedId = '';
      selectedSessionId = '';
      controller.applySelection('', '');
    },
    isGeneratedFile: projection.isGeneratedFile,
    isImageArtifact: projection.isImageArtifact,
    isMarkdownGeneratedArtifact: projection.isMarkdownGeneratedArtifact,
    isMermaidGeneratedArtifact: projection.isMermaidGeneratedArtifact,
    isHtmlGeneratedArtifact: projection.isHtmlGeneratedArtifact,
    isSvgGeneratedArtifact: projection.isSvgGeneratedArtifact,
    isChartGeneratedArtifact: projection.isChartGeneratedArtifact,
    extractMermaidSourceFromToolArtifact: projection.extractMermaidSourceFromToolArtifact,
    prettyPrintJson: projection.prettyPrintJson,
    formatArtifactTimestamp: projection.formatArtifactTimestamp,
    formatArtifactStatus: projection.formatArtifactStatus,
    formatLanguageLabel: projection.formatLanguageLabel,
  });

  function registerArtifact(artifact) {
    artifactsById.set(`${artifact.sessionId}::${artifact.id}`, artifact);
  }
  function select(artifact) {
    selectedId = artifact.id;
    selectedSessionId = artifact.sessionId;
    controller.applySelection(artifact.sessionId, artifact.id);
  }

  return {
    controller, state, surface, toasts, renderCalls, invalidateCalls, clearSelectionCalls,
    readImpl, saveImpl, deleteImpl, registerArtifact, select, getSelectedArtifact,
  };
}

test('save: a late completion after selection moved to a different artifact does not overwrite the new artifact\'s loaded/dirty content', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  const b = generatedArtifactFixture('artifact-b', 'session-1');
  h.registerArtifact(a);
  h.registerArtifact(b);
  h.select(a);
  h.state.artifacts.loadedArtifactId = 'artifact-a';
  h.state.artifacts.loadedArtifactContent = 'disk-A';
  h.state.artifacts.dirtyContent = 'edited-A';

  const saveGate = deferred();
  h.saveImpl.fn = () => saveGate.promise;

  const savePromise = h.controller.saveSelectedArtifact();

  // User navigates to B before the save's network round-trip resolves.
  h.select(b);
  h.state.artifacts.loadedArtifactId = 'artifact-b';
  h.state.artifacts.loadedArtifactContent = 'disk-B';
  h.state.artifacts.dirtyContent = 'disk-B';

  saveGate.resolve({});
  await savePromise;

  assert.equal(h.state.artifacts.loadedArtifactId, 'artifact-b', 'B must remain the loaded artifact');
  assert.equal(h.state.artifacts.loadedArtifactContent, 'disk-B', 'A\'s late save completion must not overwrite B\'s loaded content');
  assert.equal(h.state.artifacts.dirtyContent, 'disk-B', 'A\'s late save completion must not overwrite B\'s dirty content');
});

test('load failure while installing a restored draft keeps the draft recoverable for retry', async (t) => {
  const dom = new JSDOM('<body></body>');
  const previousWindow = globalThis.window;
  globalThis.window = dom.window;
  t.after(() => { globalThis.window = previousWindow; });

  const artifact = generatedArtifactFixture('artifact-draft', 'session-1');
  const state = { artifacts: { operationGeneration: 0 } };
  const target = createArtifactOperationTarget({ state });
  target.setSelection(artifact.sessionId, artifact.id);
  const drafts = createArtifactDraftStore();
  drafts.stash(artifact.sessionId, artifact.id, 'restored draft');
  const installedValues = [];
  let rejectInstall = true;
  dom.window.jennyShell = {
    artifacts: {
      read: async () => ({ artifact: artifact.generatedFile, content: 'disk content' }),
    },
  };
  const ops = createArtifactAsyncOps({
    state,
    surfaces: { full: {} },
    artifactOperationTarget: target,
    draftStore: drafts,
    isGeneratedFile: () => true,
    ensureEditor: () => ({
      setDocument: async ({ value }) => {
        installedValues.push(value);
        if (rejectInstall) {
          rejectInstall = false;
          throw new Error('editor install failed');
        }
      },
    }),
  });

  await ops.loadGeneratedArtifactContent(artifact);
  await ops.loadGeneratedArtifactContent(artifact);

  assert.deepEqual(installedValues, ['restored draft', 'restored draft']);
});

test('save failure: an error toast fires, but a since-navigated-away B does not inherit A\'s lastError', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  const b = generatedArtifactFixture('artifact-b', 'session-1');
  h.registerArtifact(a);
  h.registerArtifact(b);
  h.select(a);
  h.state.artifacts.loadedArtifactId = 'artifact-a';
  h.state.artifacts.loadedArtifactContent = 'disk-A';
  h.state.artifacts.dirtyContent = 'edited-A';

  const saveGate = deferred();
  h.saveImpl.fn = () => saveGate.promise;
  const savePromise = h.controller.saveSelectedArtifact();

  h.select(b);
  h.state.artifacts.lastError = '';

  saveGate.reject(new Error('disk full'));
  await savePromise;

  assert.match(h.toasts.join(' | '), /disk full/, 'a save failure must still surface a toast');
  assert.equal(h.state.artifacts.lastError, '', 'B\'s lastError must not be set by A\'s failed save');
});

test('delete: the target confirmed at dialog-open time is deleted even after selection moves to B; B is left untouched', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  const b = generatedArtifactFixture('artifact-b', 'session-1');
  h.registerArtifact(a);
  h.registerArtifact(b);
  h.select(a);

  // Modal captures the target the moment it opens (A is selected).
  const capturedToken = h.controller.captureSelectedTarget();
  assert.equal(capturedToken.id, 'artifact-a');

  const deleteGate = deferred();
  const deleteCalls = [];
  h.deleteImpl.fn = (sessionId, artifactId) => { deleteCalls.push({ sessionId, artifactId }); return deleteGate.promise; };

  const deletePromise = h.controller.deleteSelectedArtifact(capturedToken);

  // Selection moves to B before the user confirms/the delete resolves.
  h.select(b);
  h.state.artifacts.loadedArtifactId = 'artifact-b';
  h.state.artifacts.loadedArtifactContent = 'disk-B';
  h.state.artifacts.dirtyContent = 'disk-B';

  deleteGate.resolve({});
  await deletePromise;

  assert.deepEqual(deleteCalls, [{ sessionId: 'session-1', artifactId: 'artifact-a' }], 'A must be the one deleted, never B');
  assert.equal(h.clearSelectionCalls.length, 0, 'B is still selected -- deleting A must not clear the live selection');
  assert.equal(h.state.artifacts.loadedArtifactId, 'artifact-b', 'B\'s loaded state must be untouched by A\'s deletion');
  assert.deepEqual(h.invalidateCalls[h.invalidateCalls.length - 1], { sessionId: 'session-1', opts: { preserveLoaded: true } });
});

test('delete: target removed mid-flight -- a concurrent load for the same artifact discards its stale result once deleted', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  h.registerArtifact(a);
  h.select(a);

  const readGate = deferred();
  h.readImpl.fn = () => readGate.promise;
  const loadPromise = h.controller.loadGeneratedArtifactContent(a);

  const token = h.controller.captureSelectedTarget();
  const deleteGate = deferred();
  h.deleteImpl.fn = () => deleteGate.promise;
  const deletePromise = h.controller.deleteSelectedArtifact(token);
  deleteGate.resolve({});
  await deletePromise;

  // The read for A resolves AFTER A has already been deleted (and selection
  // cleared as part of that, since A was still selected at delete time).
  readGate.resolve({ artifact: { artifact_id: 'artifact-a', editable: true, status: 'available' }, content: 'stale disk content' });
  await loadPromise;

  assert.notEqual(h.state.artifacts.loadedArtifactId, 'artifact-a', 'a load for a deleted target must not apply its stale content');
});

test('double-click delete: two concurrent calls for the same target only call the delete IPC once', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  h.registerArtifact(a);
  h.select(a);

  const deleteGate = deferred();
  let callCount = 0;
  h.deleteImpl.fn = () => { callCount += 1; return deleteGate.promise; };

  const token = h.controller.captureSelectedTarget();
  const first = h.controller.deleteSelectedArtifact(token);
  const second = h.controller.deleteSelectedArtifact(token);
  deleteGate.resolve({});
  await Promise.all([first, second]);

  assert.equal(callCount, 1, 'a re-entrant delete for the same in-flight target must not call the IPC twice');
});

test('overlapping save+delete: delete wins on disk; the late save completion does not resurrect/overwrite the deleted artifact\'s state', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  h.registerArtifact(a);
  h.select(a);
  h.state.artifacts.loadedArtifactId = 'artifact-a';
  h.state.artifacts.loadedArtifactContent = 'disk-A';
  h.state.artifacts.dirtyContent = 'edited-A';

  const saveGate = deferred();
  h.saveImpl.fn = () => saveGate.promise;
  const savePromise = h.controller.saveSelectedArtifact();

  const token = h.controller.captureSelectedTarget();
  const deleteGate = deferred();
  h.deleteImpl.fn = () => deleteGate.promise;
  const deletePromise = h.controller.deleteSelectedArtifact(token);
  deleteGate.resolve({});
  await deletePromise;

  assert.equal(h.state.artifacts.selectedArtifactId, '', 'delete must clear the selection (A was still selected)');

  saveGate.resolve({});
  await savePromise;

  assert.notEqual(h.state.artifacts.loadedArtifactId, 'artifact-a', 'a save completing after its target was deleted must not resurrect that artifact\'s loaded state');
});

test('late completion after disposal: no state mutation and no further render calls', async (t) => {
  const h = makeHarness(t);
  const a = generatedArtifactFixture('artifact-a', 'session-1');
  h.registerArtifact(a);
  h.select(a);
  h.state.artifacts.loadedArtifactId = 'artifact-a';
  h.state.artifacts.loadedArtifactContent = 'disk-A';
  h.state.artifacts.dirtyContent = 'edited-A';

  const saveGate = deferred();
  h.saveImpl.fn = () => saveGate.promise;
  const savePromise = h.controller.saveSelectedArtifact();

  h.controller.dispose();
  const snapshot = JSON.parse(JSON.stringify(h.state.artifacts));
  const rendersBeforeDispose = h.renderCalls.full;

  saveGate.resolve({});
  await savePromise;

  assert.deepEqual(h.state.artifacts, snapshot, 'a completion arriving after dispose() must not mutate state at all');
  assert.equal(h.renderCalls.full, rendersBeforeDispose, 'a completion arriving after dispose() must not trigger further renders');
});
