'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller.js');

function imageArtifact(sessionId = 'session-1') {
  return {
    id: 'image-1',
    sessionId,
    artifactType: 'image',
    sourceKind: 'generated_artifact',
    status: 'available',
    image: { artifactId: 'generated-image-1', requiresArtifactRead: true, assetPath: '' },
  };
}

function makeHarness(t) {
  const previousWindow = globalThis.window;
  const state = { artifacts: { operationGeneration: 0, loading: false, lastError: '' } };
  let reads = 0;
  globalThis.window = {
    jennyShell: {
      artifacts: {
        read: async () => {
          reads += 1;
          if (reads === 1) throw new Error('temporary bridge failure');
          return { asset_data_url: 'data:image/png;base64,AA==' };
        },
      },
    },
  };
  const controller = createArtifactSurfaceController({
    state,
    surfaces: {},
    artifactRender: {},
    isImageArtifact: (artifact) => artifact?.artifactType === 'image',
    renderArtifactsPanel: () => {},
    renderArtifactReviewPanel: () => {},
  });
  t.after(() => {
    controller.dispose();
    globalThis.window = previousWindow;
  });
  return { controller, state, reads: () => reads };
}

test('reselecting a generated image permits retry after a transient read failure', async (t) => {
  const h = makeHarness(t);
  const artifact = imageArtifact();
  h.controller.applySelection(artifact.sessionId, artifact.id);
  await h.controller.loadGeneratedImageArtifactAsset(artifact);
  assert.equal(h.reads(), 1);
  assert.match(h.state.artifacts.lastError, /temporary bridge failure/);

  h.controller.applySelection(artifact.sessionId, artifact.id);
  await h.controller.loadGeneratedImageArtifactAsset(artifact);

  assert.equal(h.reads(), 2);
  assert.equal(h.state.artifacts.lastError, '');
});

test('session pruning removes generated-image failure state', async (t) => {
  const h = makeHarness(t);
  const artifact = imageArtifact('removed-session');
  await h.controller.loadGeneratedImageArtifactAsset(artifact);
  assert.equal(h.reads(), 1);

  h.controller.pruneImageArtifactDataForSessions(new Set(['kept-session']));
  await h.controller.loadGeneratedImageArtifactAsset(artifact);

  assert.equal(h.reads(), 2);
});
