'use strict';

// Draft-store pruning wiring (UI/UX audit follow-up to UIUX-007): the
// draft store's header contract says deferred dirty drafts are "pruned
// alongside the rest of that session's artifact caches". These tests pin
// the wiring that makes that true: pruneArtifactDraftsForSessions (called
// by pruneSessionArtifacts in renderer-artifacts-utils.js on session
// removal) drops drafts for sessions that no longer exist, while drafts
// for surviving sessions are still restored on the next load; and
// clearArtifactDrafts (full artifacts reset / controller disposal) wipes
// everything. Without the prune, drafts for deleted sessions accumulated
// in the Map for the renderer's lifetime.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller.js');

function generatedArtifact(id, sessionId) {
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
  };
}

const DISK_CONTENT = '# clean disk content\n';

function makeController(t) {
  const previousWindow = globalThis.window;
  globalThis.window = {
    jennyShell: {
      artifacts: {
        read: async (sessionId, artifactId) => ({
          artifact: { artifact_id: artifactId, editable: true, status: 'available', language: 'markdown' },
          content: DISK_CONTENT,
        }),
      },
    },
  };
  t.after(() => {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  });
  const state = {
    artifacts: {
      selectedSessionId: '',
      selectedArtifactId: '',
      loadedArtifactId: '',
      loadedArtifactContent: '',
      dirtyContent: '',
      loading: false,
      savePending: false,
      lastError: '',
    },
    features: { featureFlags: {} },
  };
  const controller = createArtifactSurfaceController({ state, surfaces: {} });
  return { controller, state };
}

function stashDirtyDraft(controller, state, artifact, draftText) {
  state.artifacts.selectedSessionId = artifact.sessionId;
  state.artifacts.selectedArtifactId = artifact.id;
  state.artifacts.loadedArtifactId = artifact.id;
  state.artifacts.loadedArtifactContent = DISK_CONTENT;
  state.artifacts.dirtyContent = draftText;
  controller.stashDirtyArtifactIfNeeded();
}

test('pruneArtifactDraftsForSessions drops the draft of a removed session -- the next load reads the clean disk copy', async (t) => {
  const { controller, state } = makeController(t);
  const artifact = generatedArtifact('a1', 'removed-session');
  stashDirtyDraft(controller, state, artifact, '# EDITED DRAFT');

  controller.pruneArtifactDraftsForSessions(['surviving-session']);

  state.artifacts.loadedArtifactId = '';
  await controller.loadGeneratedArtifactContent(artifact);
  assert.equal(state.artifacts.dirtyContent, DISK_CONTENT, 'the pruned draft must not be restored');
  assert.equal(state.artifacts.loadedArtifactContent, DISK_CONTENT);
});

test('pruneArtifactDraftsForSessions keeps drafts for surviving sessions (Set input, as pruneSessionArtifacts passes)', async (t) => {
  const { controller, state } = makeController(t);
  const artifact = generatedArtifact('a1', 'surviving-session');
  stashDirtyDraft(controller, state, artifact, '# EDITED DRAFT');

  controller.pruneArtifactDraftsForSessions(new Set(['surviving-session']));

  state.artifacts.loadedArtifactId = '';
  await controller.loadGeneratedArtifactContent(artifact);
  assert.equal(state.artifacts.dirtyContent, '# EDITED DRAFT', 'a surviving session\'s draft must still restore after the prune');
});

test('clearArtifactDrafts wipes every deferred draft (full artifacts reset path)', async (t) => {
  const { controller, state } = makeController(t);
  const artifact = generatedArtifact('a1', 's1');
  stashDirtyDraft(controller, state, artifact, '# EDITED DRAFT');

  controller.clearArtifactDrafts();

  state.artifacts.loadedArtifactId = '';
  await controller.loadGeneratedArtifactContent(artifact);
  assert.equal(state.artifacts.dirtyContent, DISK_CONTENT, 'a cleared draft must not be restored');
});
