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
  test('the retired viewer verb neither opens the viewer nor the panel; images open through the viewer controller', async () => {
    const opened = [];
    const panel = [];
    const controller = createShellRuntimeController({
      state: { currentSessionId: 'other-pane', sessions: [] },
      windowRef: { rendererImageViewerController: { open: async (target) => opened.push(target) } },
      callbacks: { openArtifactTarget: async (...args) => panel.push(args) },
    });
    await controller.handleArtifactAction({ action: 'viewer', artifactId: 'image-a', sessionId: 'source-pane', contextNode: {} });
    assert.deepEqual([opened, panel], [[], []]);
  });

  test('a panel open that resolves false shows the unavailable toast', async () => {
    const toasts = [];
    const controller = createShellRuntimeController({
      state: { currentSessionId: 'session-1', sessions: [] },
      windowRef: {},
      callbacks: { openArtifactTarget: async () => false, showToastMessage: (message, options) => toasts.push([message, options.title]) },
    });
    await controller.handleArtifactAction({ action: 'panel', artifactId: 'artifact-1' });
    assert.deepEqual(toasts, [['This artifact action is unavailable for the selected entry.', 'Artifact Action Unavailable']]);
  });

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
