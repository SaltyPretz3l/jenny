'use strict';

// renderer/features/renderer-artifact-file-preview.js, project slots: the chat rail previews a file
// of another registered project through workspaceFs.readProjectText / readProjectImage, read-only,
// with a failure card (never the silent reset) when the project's folder is gone.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createArtifactFilePreview } = require('../renderer/features/renderer-artifact-file-preview');
const pathOpenUtils = require('../renderer/chat/renderer-chat-path-open');

const PANEL_HTML = '<aside id="artifactReviewPanel" data-artifact-review-mode="file_preview">'
  + '<div class="artifact-review-scroll"><div id="artifactReviewDetailEmpty"></div>'
  + '<div class="artifact-review-detail-panel hidden" id="artifactReviewDetailPanel">'
  + '<span id="artifactReviewDetailKicker"></span><span id="artifactReviewDetailTitle"><span class="artifact-panel-title-text"></span></span>'
  + '<span id="artifactReviewDetailPath"></span><span id="artifactReviewDetailStatus"></span><div id="artifactReviewDetailMeta"></div>'
  + '<div id="artifactReviewProvenanceTimeline"></div><div class="artifact-preview-content hidden" id="artifactReviewPreviewContent"></div>'
  + '<div id="artifactReviewEditorShell"></div><span id="artifactReviewDirtyBadge"></span><span id="artifactReviewSaveButton"></span>'
  + '<span id="artifactReviewRevertButton"></span><span id="artifactReviewRevealButton"></span><span id="artifactReviewOpenExternalButton"></span>'
  + '<span id="artifactReviewDeleteButton"></span></div></div></aside>';

const TEXT = { ok: true, content: 'alpha\nbravo\ncharlie', truncated: false, editable: true, size: 19 };
const IMAGE = { ok: true, mime: 'image/png', base64: 'AAECAwQ=', size: 5 };

function makeHarness(t, overrides) {
  const dom = new JSDOM('<!doctype html><html><body>' + PANEL_HTML + '</body></html>', { url: 'https://jenny.local/chat' });
  const doc = dom.window.document;
  const byId = (id) => doc.getElementById(id);
  const calls = { readText: [], readImage: [], readProjectText: [], readProjectImage: [], rail: [], logs: [], ideEvents: [], defaultApp: [], projectIde: [] };
  const state = { ui: { activeView: 'chat', artifactReview: { mode: 'artifact', enabled: true, collapsed: false } } };
  const surface = {
    key: 'split',
    root: byId('artifactReviewPanel'),
    detailEmpty: byId('artifactReviewDetailEmpty'),
    detailPanel: byId('artifactReviewDetailPanel'),
    detailKicker: byId('artifactReviewDetailKicker'),
    detailTitle: byId('artifactReviewDetailTitle'),
    detailPath: byId('artifactReviewDetailPath'),
    detailStatus: byId('artifactReviewDetailStatus'),
    detailMeta: byId('artifactReviewDetailMeta'),
    detailNote: null,
    previewContent: byId('artifactReviewPreviewContent'),
    editorShell: byId('artifactReviewEditorShell'),
    saveButton: byId('artifactReviewSaveButton'),
    revertButton: byId('artifactReviewRevertButton'),
    revealButton: byId('artifactReviewRevealButton'),
    openExternalButton: byId('artifactReviewOpenExternalButton'),
    deleteButton: byId('artifactReviewDeleteButton'),
    provenanceTimeline: byId('artifactReviewProvenanceTimeline'),
    dirtyBadge: byId('artifactReviewDirtyBadge'),
    metaPane: null,
  };
  const workspaceFs = Object.assign({
    readText(payload) { calls.readText.push(payload); return Promise.resolve({ ok: true, content: 'ws\nfile', rootId: 'r', generation: 1, fileVersion: 'v', truncated: false }); },
    readImage(payload) { calls.readImage.push(payload); return Promise.resolve(IMAGE); },
    readProjectText(payload) { calls.readProjectText.push(payload); return Promise.resolve(TEXT); },
    readProjectImage(payload) { calls.readProjectImage.push(payload); return Promise.resolve(IMAGE); },
    openInDefaultApp(payload) { calls.defaultApp.push(payload); return Promise.resolve({ ok: true }); },
  }, (overrides && overrides.workspaceFs) || {});
  for (const [key, value] of Object.entries((overrides && overrides.workspaceFs) || {})) {
    if (value === undefined) delete workspaceFs[key];
  }
  dom.window.addEventListener('ide:open-file-at-line', (event) => { calls.ideEvents.push(event.detail); });
  let controller = null;
  controller = createArtifactFilePreview(Object.assign({
    state,
    windowRef: dom.window,
    dom: { artifactReviewPanel: byId('artifactReviewPanel') },
    getWorkspaceFsApi: () => workspaceFs,
    markdownUtils: { renderMarkdown: (source) => '<div class="md">' + source + '</div>', renderInlineMermaidBlocks() {} },
    codeHighlight: { getLanguageId: () => '', decorateCodeBlocks() {} },
    pathOpenUtils,
    openArtifactRail: (mode) => { calls.rail.push(mode); state.ui.artifactReview.mode = mode; },
    renderArtifactReviewPanel: () => controller.renderRailContent(surface),
    syncArtifactReviewLayout() {},
    appendClientLog: (level, event, payload) => { calls.logs.push({ level, event, payload }); },
  }, (overrides && overrides.deps) || {}));
  controller.bind();
  t.after(() => controller.dispose());
  return { dom, doc, state, calls, controller, host: surface.previewContent, surface };
}

const stateKind = (h) => (h.host.querySelector('[data-file-preview-state]') || { getAttribute: () => null }).getAttribute('data-file-preview-state');
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('project slots', () => {
  test('a project target reads through readProjectText and renders the numbered lines, read-only', async (t) => {
    const h = makeHarness(t);
    const taken = await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: '2026/plan.md', line: 2, column: 1 });
    assert.equal(taken, true);
    assert.deepEqual(h.calls.rail, ['file_preview']);
    assert.deepEqual(h.calls.readProjectText, [{ projectId: 'p-notes', path: '2026/plan.md', intent: 'preview', maxBytes: 512000 }]);
    assert.equal(h.calls.readText.length, 0);
    assert.deepEqual(h.controller.getFilePreviewTarget(), { path: '2026/plan.md', line: 2, column: 1, projectId: 'p-notes' });
    assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 3);
    // Read-only: no editable surface, and every artifact-mode edit/save/write control stays hidden.
    assert.equal(h.host.querySelectorAll('textarea, input, [contenteditable], [data-file-preview-save], [data-file-preview-edit]').length, 0);
    for (const button of [h.surface.saveButton, h.surface.revertButton, h.surface.deleteButton, h.surface.openExternalButton, h.surface.revealButton]) {
      assert.ok(button.classList.contains('hidden'));
    }
    assert.ok(h.surface.editorShell.classList.contains('hidden'));
  });

  test('a project image reads through readProjectImage', async (t) => {
    const h = makeHarness(t);
    assert.equal(await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'img/a.png' }), true);
    assert.deepEqual(h.calls.readProjectImage, [{ projectId: 'p-notes', path: 'img/a.png' }]);
    assert.equal(h.calls.readImage.length, 0);
    assert.ok(h.host.querySelector('.artifact-file-preview-image img'));
  });

  test('Try again re-reads with the project id, and a later workspace target clears it', async (t) => {
    const h = makeHarness(t, { workspaceFs: { readProjectText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0004' }) } });
    await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md' });
    assert.equal(stateKind(h), 'not-found');
    h.host.querySelector('[data-file-preview-retry]').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flush();
    assert.equal(stateKind(h), 'not-found');
    assert.equal(h.controller.getFilePreviewTarget().projectId, 'p-notes');
    assert.equal(await h.controller.openFilePreviewTarget({ path: 'a.md' }), true);
    assert.deepEqual(h.controller.getFilePreviewTarget(), { path: 'a.md', line: null, column: null });
    assert.equal(h.calls.readText.length, 1, 'the same file with no project id reads the workspace');
  });

  test('ROOT_MISSING on a project slot shows a failure card instead of resetting the rail', async (t) => {
    const h = makeHarness(t, { workspaceFs: { readProjectText: () => Promise.resolve({ ok: false, code: 'CMP-WORKSPACEFS-0001', error_code: 'CMP-WORKSPACEFS-0001', message: 'x' }) } });
    const taken = await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md' });
    assert.equal(taken, true);
    assert.equal(h.state.ui.artifactReview.mode, 'file_preview', 'the rail is not handed back');
    assert.equal(stateKind(h), 'root-missing');
    assert.match(h.host.querySelector('.artifact-file-preview-note').textContent, /project folder/i);
    assert.doesNotMatch(h.host.textContent, /No workspace folder is set/);
  });

  test('a missing bridge method (hosted browser) is a failure card, not a throw', async (t) => {
    for (const workspaceFs of [{ readProjectText: undefined }, { readProjectText: () => { throw new Error('torn down'); } }]) {
      const h = makeHarness(t, { workspaceFs });
      assert.equal(await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md' }), true);
      assert.ok(h.host.querySelector('[data-file-preview-state]'), 'a state card');
      assert.equal(h.host.querySelectorAll('.artifact-file-preview-row').length, 0);
    }
    const noApi = makeHarness(t, { deps: { getWorkspaceFsApi: () => null } });
    assert.equal(await noApi.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md' }), true);
    assert.ok(noApi.host.querySelector('[data-file-preview-state]'));
  });

  test('a present but invalid project id is refused, never read from the workspace', async (t) => {
    const h = makeHarness(t);
    for (const projectId of ['', '   ', 7, {}, false]) {
      assert.equal(await h.controller.openFilePreviewTarget({ projectId, path: 'a.md' }), false, JSON.stringify(projectId));
    }
    assert.equal(h.calls.readText.length + h.calls.readProjectText.length, 0);
    assert.equal(await h.controller.openFilePreviewTarget({ projectId: null, path: 'a.md' }), true, 'null means no project');
    assert.equal(h.calls.readText.length, 1);
  });

  test('a project path is validated like a workspace one', async (t) => {
    const h = makeHarness(t);
    for (const path of ['../x.md', 'C:/x.md', '/etc/x', '']) {
      assert.equal(await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path }), false, path);
    }
    assert.equal(h.calls.readProjectText.length, 0);
  });

  test('Open in IDE for a project slot re-enters the open-file event with its project id and never the OS app', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md', line: 3 });
    h.host.querySelector('[data-file-preview-open-ide]').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.deepEqual(h.calls.ideEvents, [{ projectId: 'p-notes', path: 'a.md', line: 3, column: null, preferIde: true }]);
    assert.deepEqual(h.calls.defaultApp, [], 'an unclaimed project open never degrades to the default app');
  });

  test('a project slot keeps its absolute path; a later workspace target drops it', async (t) => {
    const h = makeHarness(t);
    await h.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md', display: 'D:\\notes\\a.md' });
    assert.deepEqual(h.controller.getFilePreviewTarget(), { path: 'a.md', line: null, column: null, projectId: 'p-notes', display: 'D:\\notes\\a.md' });
    await h.controller.openFilePreviewTarget({ path: 'a.md', display: 'ignored' });
    assert.deepEqual(h.controller.getFilePreviewTarget(), { path: 'a.md', line: null, column: null });
  });

  test('a workspace root commit leaves a project slot alone but still resets a workspace slot', async (t) => {
    const project = makeHarness(t);
    await project.controller.openFilePreviewTarget({ projectId: 'p-notes', path: 'a.md' });
    project.controller.handleWorkspaceRootCommitted();
    assert.equal(project.state.ui.artifactReview.mode, 'file_preview');
    assert.equal(project.controller.getFilePreviewTarget().projectId, 'p-notes');
    const workspace = makeHarness(t);
    await workspace.controller.openFilePreviewTarget({ path: 'a.md' });
    workspace.controller.handleWorkspaceRootCommitted();
    assert.equal(workspace.state.ui.artifactReview.mode, 'artifact');
    assert.equal(workspace.controller.getFilePreviewTarget(), null);
  });

  test('a non-project failure log never carries the path or project id', async (t) => {
    const h = makeHarness(t, { workspaceFs: { readProjectText: () => Promise.resolve({ ok: false, error_code: 'CMP-WORKSPACEFS-0004' }) } });
    await h.controller.openFilePreviewTarget({ projectId: 'p-secret', path: 'private/plan.md' });
    const logged = JSON.stringify(h.calls.logs);
    assert.ok(logged.includes('CMP-WORKSPACEFS-0004'));
    assert.equal(/p-secret|private/.test(logged), false);
  });
});
