'use strict';

// WS3 Step 12 — the `panel` verb on the data-inv-artifact-action flow:
// handleArtifactAction('panel') routes to openArtifactTarget with the
// 'inline-open-panel' source tag (and the shipped 'studio' verb keeps its
// 'transcript-studio' tag).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createShellRuntimeController } = require('../renderer/shell/renderer-shell-runtime-utils');

function makeController() {
  const calls = [];
  const controller = createShellRuntimeController({
    state: { currentSessionId: 'session-1', sessions: [] },
    windowRef: {},
    callbacks: {
      openArtifactTarget: async (...args) => { calls.push(args); return true; },
      showToastMessage: () => {},
      appendClientLog: () => {},
    },
  });
  return { controller, calls };
}

describe('handleArtifactAction panel verb (WS3)', () => {
  test('panel routes to openArtifactTarget with the inline-open-panel source', async () => {
    const { controller, calls } = makeController();
    await controller.handleArtifactAction({ action: 'panel', artifactId: 'artifact-1' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'artifact-1');
    assert.deepEqual(calls[0][1], { source: 'inline-open-panel' });
  });

  test('panel with no artifact id does not open', async () => {
    const { controller, calls } = makeController();
    await controller.handleArtifactAction({ action: 'panel', artifactId: '' });
    assert.equal(calls.length, 0);
  });
});
