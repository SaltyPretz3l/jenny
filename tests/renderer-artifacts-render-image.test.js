'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { renderImageArtifactKind } = require('../renderer/features/renderer-artifacts-render-image');

function useViewer(t, open) {
  const calls = [];
  const previous = globalThis.rendererImageViewerController;
  globalThis.rendererImageViewerController = { open: (target) => { calls.push(target); return open ? open(target) : true; } };
  t.after(() => { globalThis.rendererImageViewerController = previous; });
  return calls;
}

test('only canonical artifact-backed panel images receive the viewer entry with source session', async (t) => {
  const calls = useViewer(t);
  for (const sourceKind of ['generated_artifact', 'attachment', 'workspace']) {
    calls.length = 0;
    const doc = new JSDOM('<div id="editor"></div><div id="preview"></div>').window.document;
    const surface = { editorShell: doc.getElementById('editor'), previewContent: doc.getElementById('preview') };
    const artifact = { id: 'image-id', sessionId: 'source-session', sourceKind, title: 'Image', image: { artifactId: 'canonical-image-id' } };
    renderImageArtifactKind({ surface, artifact, deps: { state: { artifacts: {} }, escapeHtml, setDetailNote() {},
      resolveImagePreviewUrl: () => 'data:image/png;base64,aA==', hasImageArtifactLoadFailed: () => false,
      isGeneratedImageArtifactReadRequired: () => false } });
    assert.ok(surface.previewContent.querySelector('img'));
    const button = surface.previewContent.querySelector('button');
    assert.equal(Boolean(button), sourceKind === 'generated_artifact');
    if (button) {
      surface.previewContent.querySelector('img').click(); await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(calls, [{ sessionId: 'source-session', select: { kind: 'artifact', id: 'canonical-image-id' }, contextNode: button }],
        'clicking the panel image opens the viewer');
    }
  }
});

test('viewer launcher failure becomes a generic panel note', async (t) => {
  useViewer(t, () => { throw new Error('C:/private'); });
  const doc = new JSDOM('<div id="editor"></div><div id="preview"></div>').window.document;
  const surface = { editorShell: doc.getElementById('editor'), previewContent: doc.getElementById('preview') };
  const notes = [];
  renderImageArtifactKind({ surface, artifact: { sourceKind: 'generated_artifact', sessionId: 's', image: { id: 'i' } },
    deps: { state: { artifacts: {} }, escapeHtml, setDetailNote: (...args) => notes.push(args),
      resolveImagePreviewUrl: () => 'data:image/png;base64,aA==', hasImageArtifactLoadFailed: () => false,
      isGeneratedImageArtifactReadRequired: () => false } });
  surface.previewContent.querySelector('button').click(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notes.at(-1), [surface, 'Image unavailable', true]);
});
