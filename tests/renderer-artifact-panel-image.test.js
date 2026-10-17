'use strict';

// Row 56 slice B: the artifact panel's image view. The body (image button,
// details, prompt copy), the header (View full screen, Copy image), the More
// rows (Save as, Show in folder, Open externally), the projection's details
// and per-image dedupe, and the controller's image-cache fixes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createArtifactManager } = require('../renderer/features/renderer-artifacts-utils');
const { createArtifactPanelV2 } = require('../renderer/features/renderer-artifact-panel-v2-render');
const { createArtifactSurfaceController } = require('../renderer/features/renderer-artifacts-surface-controller');
const { renderImageArtifactKind } = require('../renderer/features/renderer-artifacts-render-image');
const projection = require('../renderer/features/renderer-artifacts-projection');
const artifactRender = require('../renderer/features/renderer-artifacts-render');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const DATA_URL = 'data:image/png;base64,AA==';

function imageEntry(id, extra = {}) {
  return { artifact_id: id, artifact_kind: 'image', title: `${id}.png`, display_path: `.jenny/artifacts/s/${id}.png`,
    absolute_path: '[redacted:path]', width: 640, height: 480, ...extra };
}

function imageMessage(id, entries, extra = {}) {
  return { id, role: 'tool', kind: 'tool_result', timestamp: '2026-10-14T10:00:00.000Z',
    tool_result: { call_id: `call-${id}`, tool_name: 'generate_image', generated_artifacts: entries, ...extra } };
}

function installViewer(t, { open = async () => true } = {}) {
  const calls = { open: [], run: [] };
  const previous = globalThis.rendererImageViewerController;
  globalThis.rendererImageViewerController = {
    open: (target) => { calls.open.push(target); return open(target); },
    run: async (action, target) => { calls.run.push([action, target]); return { ok: true }; },
  };
  t.after(() => { globalThis.rendererImageViewerController = previous; });
  return calls;
}

// The real manager, surface controller, image kind and Canvas chrome.
function setup(t, { messages, read } = {}) {
  const dom = new JSDOM('<body><div id="workspace"><div id="chatView"><aside id="artifactReviewPanel"></aside></div></div></body>', { url: 'https://jenny.test' });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const doc = dom.window.document;
  const state = { currentSessionId: 's', ui: { activeView: 'chat', artifactReview: {} }, artifacts: { autoOpenedSessionIds: [], deletedArtifactIds: [] },
    messagesBySession: new Map([['s', messages || [imageMessage('m1', [imageEntry('img-a')], { metadata: { provenance: { image_prompt: 'a red fox', seed: 7 } }, duration_ms: 4000 })]]]),
    features: { featureFlags: {} } };
  dom.window.localStorage.setItem('jenny.artifactReview.v1', JSON.stringify({ enabled: true, collapsed: false, width: 420 }));
  const reads = [];
  dom.window.jennyShell = { artifacts: { read: (sessionId, artifactId) => { reads.push(artifactId); return read ? read(artifactId) : Promise.resolve({ asset_data_url: DATA_URL }); } } };
  const panelEl = doc.getElementById('artifactReviewPanel');
  const toasts = [];
  const chrome = createArtifactPanelV2({ panelEl, state, windowRef: dom.window, showToastMessage: (...args) => toasts.push(args) });
  chrome.installed();
  const nodes = Object.fromEntries([...doc.querySelectorAll('[id]')].map((node) => [node.id, node]));
  nodes.workspace.getBoundingClientRect = () => ({ width: 800 });
  const manager = createArtifactManager({ state, dom: nodes, callbacks: {
    getActiveSession: () => ({ id: 's' }), escapeHtml: (value) => String(value || '').replaceAll('<', '&lt;'), appendClientLog: () => {},
    showToastMessage: (...args) => toasts.push(args), panelV2: chrome,
  } });
  const copies = [];
  chrome.connect({ getArtifacts: () => manager.getArtifactsForSession('s'), getSelectedArtifactSource: () => manager.getSelectedArtifactSource(),
    copySelectedArtifact: () => copies.push('text'), selectArtifact: (id) => manager.selectArtifact(id) });
  manager.bind(); chrome.bind();
  t.after(() => { manager.dispose(); chrome.dispose(); dom.window.close(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const q = (selector) => panelEl.querySelector(selector);
  const menuLabels = () => [...doc.querySelectorAll('.inv-context-menu-item')].map((node) => node.textContent);
  const menuItem = (label) => [...doc.querySelectorAll('.inv-context-menu-item')].find((node) => node.textContent === label);
  return { dom, doc, state, manager, panelEl, q, reads, toasts, copies, menuLabels, menuItem };
}

test('the image body has no note, opens the viewer from the image and shows the generation details', async (t) => {
  const viewer = installViewer(t);
  const h = setup(t);
  h.manager.renderArtifactReviewPanel();
  await settle();
  const note = h.doc.getElementById('artifactReviewDetailNote');
  assert.equal(note.textContent, '');
  assert.equal(note.classList.contains('hidden'), true);
  const button = h.q('.artifact-preview-image-open');
  assert.equal(button.getAttribute('aria-label'), 'View full screen');
  assert.equal(button.dataset.artifactKey, 's:img-a');
  const img = button.querySelector('img.artifact-preview-image');
  assert.equal(img.getAttribute('src'), DATA_URL);
  const details = h.q('.inv-image-details');
  assert.match(details.textContent, /a red fox/);
  assert.match(details.textContent, /640 × 480/);
  assert.match(details.textContent, /img-a\.png/);

  img.click();
  await settle();
  assert.equal(viewer.open.length, 1);
  assert.deepEqual(viewer.open[0].select, { kind: 'artifact', id: 'img-a' });
  assert.equal(viewer.open[0].sessionId, 's');
  assert.equal(viewer.open[0].contextNode, h.q('[data-artifact-panel-fullscreen]'), 'focus returns to the persistent header button');

  h.manager.renderArtifactReviewPanel();
  assert.equal(h.q('img.artifact-preview-image'), img, 'the same image is not rebuilt');
  h.q('.artifact-preview-image-open').click();
  await settle();
  assert.equal(viewer.open.length, 2, 'one delegated listener, not one per render');
});

test('copy prompt writes the prompt and confirms it', async (t) => {
  installViewer(t);
  const h = setup(t);
  const written = [];
  const previousShell = globalThis.jennyShell;
  globalThis.jennyShell = { clipboard: { writeText: async (text) => { written.push(text); } } };
  t.after(() => { globalThis.jennyShell = previousShell; });
  h.manager.renderArtifactReviewPanel();
  await settle();
  h.q('[data-image-copy-prompt]').click();
  await settle();
  assert.deepEqual(written, ['a red fox']);
  assert.equal(h.toasts.at(-1)[0], 'Prompt copied');
});

test('a viewer that cannot open reports it by toast', async (t) => {
  installViewer(t, { open: async () => false });
  const h = setup(t);
  h.manager.renderArtifactReviewPanel();
  await settle();
  h.q('.artifact-preview-image-open').click();
  await settle();
  assert.equal(h.toasts.at(-1)[0], 'Image unavailable');
  assert.equal(h.toasts.at(-1)[1].tone, 'danger');
});

test('the header shows View full screen and Copy image for an available generated image', async (t) => {
  const viewer = installViewer(t);
  const h = setup(t);
  h.manager.renderArtifactReviewPanel();
  await settle();
  const fullscreen = h.q('[data-artifact-panel-fullscreen]');
  const copy = h.q('[data-artifact-panel-v2-copy]');
  assert.equal(fullscreen.classList.contains('hidden'), false);
  assert.equal(copy.disabled, false);
  assert.equal(copy.getAttribute('aria-label'), 'Copy image');
  copy.click();
  await settle();
  assert.deepEqual(viewer.run, [['copy', { kind: 'artifact', id: 'img-a', sessionId: 's' }]]);
  assert.deepEqual(h.copies, [], 'the text copy path is not used for an image');
  fullscreen.click();
  await settle();
  assert.equal(viewer.open.length, 1);
  assert.equal(viewer.open[0].contextNode, fullscreen);
});

test('More lists Save as, Show in folder and Open externally for an image, and Copy image when narrow', async (t) => {
  const viewer = installViewer(t);
  const h = setup(t);
  h.manager.renderArtifactReviewPanel();
  await settle();
  h.q('[data-artifact-panel-overflow]').click();
  const labels = h.menuLabels();
  for (const label of ['Save as…', 'Show in folder', 'Open externally']) assert.ok(labels.includes(label), `${label} in ${labels}`);
  assert.equal(labels.includes('Delete artifact'), false);
  assert.equal(labels.includes('Copy image'), false, 'the header shows Copy while wide');
  for (const label of ['Save as…', 'Show in folder', 'Open externally']) {
    if (!h.menuItem(label)) h.q('[data-artifact-panel-overflow]').click();
    h.menuItem(label).click();
    await settle();
  }
  const target = { kind: 'artifact', id: 'img-a', sessionId: 's' };
  assert.deepEqual(viewer.run, [['save-as', target], ['reveal', target], ['open', target]]);

  h.panelEl.dataset.panelNarrow = 'true';
  h.q('[data-artifact-panel-overflow]').click();
  h.menuItem('Copy image').click();
  await settle();
  assert.deepEqual(viewer.run.at(-1), ['copy', target]);
});

test('an image that failed to load gets no image actions, and a text artifact keeps the text copy', async (t) => {
  installViewer(t);
  const tool = { id: 'm2', role: 'tool', kind: 'tool_result', timestamp: '2026-10-14T09:00:00.000Z',
    tool_result: { call_id: 'call-text', tool_name: 'run_command', output_text: 'hello' } };
  const h = setup(t, { messages: [imageMessage('m1', [imageEntry('img-a')]), tool], read: () => Promise.reject(new Error('gone')) });
  h.manager.renderArtifactReviewPanel();
  await settle();
  assert.match(h.q('#artifactReviewPreviewContent').textContent, /Image unavailable/);
  assert.equal(h.q('[data-artifact-panel-fullscreen]').classList.contains('hidden'), true);
  assert.equal(h.q('[data-artifact-panel-v2-copy]').disabled, true);
  h.q('[data-artifact-panel-overflow]').click();
  assert.equal(h.menuLabels().includes('Save as…'), false);

  const textId = h.manager.getArtifactsForSession('s').find((artifact) => artifact.artifactType === 'tool_output').id;
  h.manager.selectArtifact(textId);
  const copy = h.q('[data-artifact-panel-v2-copy]');
  assert.equal(h.q('[data-artifact-panel-fullscreen]').classList.contains('hidden'), true);
  assert.equal(copy.getAttribute('aria-label'), 'Copy');
  copy.click();
  assert.deepEqual(h.copies, ['text']);
});

test('the loading text shows once, in the body, only while this image is being read', async (t) => {
  installViewer(t);
  let release;
  const h = setup(t, { read: () => new Promise((resolve) => { release = () => resolve({ asset_data_url: DATA_URL }); }) });
  h.manager.renderArtifactReviewPanel();
  assert.match(h.q('#artifactReviewPreviewContent').textContent, /Loading image preview/);
  assert.equal(h.doc.getElementById('artifactReviewDetailNote').textContent, '');
  release();
  await settle();
  assert.equal(h.q('img.artifact-preview-image').getAttribute('src'), DATA_URL);
});

test('a re-selected image keeps the read that was already in flight', async (t) => {
  installViewer(t);
  const pending = new Map();
  const h = setup(t, {
    messages: [imageMessage('m1', [imageEntry('img-a')]), { ...imageMessage('m2', [imageEntry('img-b')]), timestamp: '2026-10-14T09:00:00.000Z' }],
    read: (id) => new Promise((resolve) => pending.set(id, () => resolve({ asset_data_url: DATA_URL }))),
  });
  h.manager.selectArtifact('img-a');
  h.manager.selectArtifact('img-b');
  h.manager.selectArtifact('img-a');
  pending.get('img-a')();
  await settle();
  assert.deepEqual(h.reads.filter((id) => id === 'img-a'), ['img-a'], 'no second read');
  assert.equal(h.q('img.artifact-preview-image')?.getAttribute('src'), DATA_URL, 'the stale-token result is shown, not dropped');
});

function controllerSetup(t) {
  const dom = new JSDOM('<body></body>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  t.after(() => { controller.dispose(); globalThis.window = previousWindow; globalThis.document = previousDocument; });
  const doc = dom.window.document;
  const el = () => doc.body.appendChild(doc.createElement('div'));
  const surface = { key: 'split', detailEmpty: el(), detailPanel: el(), detailKicker: el(), detailTitle: el(), detailPath: el(), detailStatus: el(),
    detailMeta: el(), detailNote: el(), previewContent: el(), editorShell: el(), editorHost: el(), editorFallback: el(), saveButton: el(),
    revertButton: el(), revealButton: el(), openExternalButton: el(), deleteButton: el(), jumpButton: el(), provenanceTimeline: el(), metaPane: el(), dirtyBadge: el() };
  let reads = 0;
  dom.window.jennyShell = { artifacts: { read: async () => { reads += 1; return { asset_data_url: DATA_URL }; } } };
  let selected = null;
  const state = { artifacts: { loading: false, lastError: '' } };
  const controller = createArtifactSurfaceController({
    state, surfaces: { split: surface }, artifactRender, getSelectedArtifact: () => selected,
    isGeneratedFile: projection.isGeneratedFile, isImageArtifact: projection.isImageArtifact,
  });
  const select = (artifact) => { selected = artifact; controller.applySelection(artifact.sessionId, artifact.id); };
  const image = (id, extra = {}) => ({ id, sessionId: 's', artifactType: 'image', sourceKind: 'generated_artifact', status: 'available',
    title: id, image: { artifactId: id, assetPath: '', requiresArtifactRead: true }, ...extra });
  return { controller, surface, select, image, reads: () => reads };
}

test('an image decode error marks the image that failed, not the one selected since', async (t) => {
  installViewer(t);
  const h = controllerSetup(t);
  const a = h.image('img-a', { image: { artifactId: 'img-a', assetPath: 'C:/ws/.jenny/artifacts/s/a.png' } });
  const b = h.image('img-b', { image: { artifactId: 'img-b', assetPath: 'C:/ws/.jenny/artifacts/s/b.png' } });
  h.select(a);
  h.controller.renderSelectedArtifactDetail(h.surface, a);
  const failedImg = h.surface.previewContent.querySelector('img.artifact-preview-image');
  h.select(b);
  h.controller.handleImagePreviewError({ target: failedImg });
  h.controller.renderSelectedArtifactDetail(h.surface, b);
  assert.ok(h.surface.previewContent.querySelector('img.artifact-preview-image'), 'the selected image still shows');
  h.controller.renderSelectedArtifactDetail(h.surface, a);
  assert.equal(h.surface.previewContent.querySelector('img.artifact-preview-image'), null, 'the failed image is marked');
});

test('the image cache evicts the least recently shown image', async (t) => {
  const h = controllerSetup(t);
  const images = Array.from({ length: 9 }, (_, index) => h.image(`img-${index}`));
  for (const artifact of images.slice(0, 8)) await h.controller.loadGeneratedImageArtifactAsset(artifact);
  h.controller.renderSelectedArtifactDetail(h.surface, images[0]);
  await h.controller.loadGeneratedImageArtifactAsset(images[8]);
  assert.equal(h.reads(), 9);
  await h.controller.loadGeneratedImageArtifactAsset(images[0]);
  assert.equal(h.reads(), 9, 'the recently shown image stays cached');
  await h.controller.loadGeneratedImageArtifactAsset(images[1]);
  assert.equal(h.reads(), 10, 'the oldest unshown image was evicted');
});

test('message attachments open the viewer by attachment id', async (t) => {
  const viewer = installViewer(t);
  const doc = new JSDOM('<div id="editor"></div><div id="preview"></div>').window.document;
  const surface = { editorShell: doc.getElementById('editor'), previewContent: doc.getElementById('preview') };
  renderImageArtifactKind({ surface, artifact: { id: 'art-1', sessionId: 's', sourceKind: 'message_attachment', status: 'available', title: 'Pasted', image: { id: 'att-1' } },
    deps: { state: { artifacts: {} }, escapeHtml: (value) => String(value), setDetailNote() {}, resolveImagePreviewUrl: () => 'file:///C:/a.png',
      hasImageArtifactLoadFailed: () => false, isGeneratedImageArtifactReadRequired: () => false, isImageArtifactLoading: () => false } });
  surface.previewContent.querySelector('.artifact-preview-image-open').click();
  await settle();
  assert.deepEqual(viewer.open[0].select, { kind: 'attachment', id: 'att-1' });
});

test('projection keeps every image of one call and carries its generation details', () => {
  const artifacts = projection.buildArtifactsFromMessages([imageMessage('m1', [imageEntry('img-a'), imageEntry('img-b')],
    { metadata: { provenance: { image_prompt: 'two cats', steps: 20 } }, duration_ms: 2000 })], { sessionId: 's' });
  assert.deepEqual(artifacts.map((artifact) => artifact.id).sort(), ['img-a', 'img-b']);
  const a = artifacts.find((artifact) => artifact.id === 'img-a');
  assert.deepEqual(a.image.details, { prompt: 'two cats', steps: 20, seconds: 2, fileName: 'img-a.png' });
  const bare = projection.buildArtifactsFromMessages([imageMessage('m1', [imageEntry('img-c', { display_path: '' })])], { sessionId: 's' });
  assert.equal('details' in bare[0].image, false, 'no details without provenance or a file name');
});

test('a session refresh keeps the loaded image instead of reading it again', async (t) => {
  installViewer(t);
  const h = setup(t);
  h.manager.selectArtifact('img-a');
  await settle();
  assert.equal(h.q('img.artifact-preview-image')?.getAttribute('src'), DATA_URL);
  h.manager.invalidateSessionArtifacts('s', { preserveLoaded: true });
  h.manager.renderArtifactReviewPanel();
  await settle();
  assert.deepEqual(h.reads, ['img-a'], 'one read across the refresh');
  assert.equal(h.q('img.artifact-preview-image')?.getAttribute('src'), DATA_URL);
});

test('a refresh that keeps the decoded image still updates its alt text and details', () => {
  const doc = new JSDOM('<div id="editor"></div><div id="preview"></div>').window.document;
  const surface = { editorShell: doc.getElementById('editor'), previewContent: doc.getElementById('preview') };
  const render = (title, details) => renderImageArtifactKind({ surface,
    artifact: { id: 'art-1', sessionId: 's', sourceKind: 'generated_artifact', status: 'available', title, image: { artifactId: 'img-1', details } },
    deps: { state: { artifacts: {} }, escapeHtml: (value) => String(value), setDetailNote() {}, resolveImagePreviewUrl: () => 'file:///C:/a.png',
      hasImageArtifactLoadFailed: () => false, isGeneratedImageArtifactReadRequired: () => false, isImageArtifactLoading: () => false } });
  render('Boat', undefined);
  const img = surface.previewContent.querySelector('.artifact-preview-image');
  assert.equal(surface.previewContent.querySelector('.inv-image-details'), null);
  render('Sailboat', { prompt: 'a boat at dusk', seed: 7 });
  assert.equal(surface.previewContent.querySelector('.artifact-preview-image'), img, 'the decoded image is kept');
  assert.equal(img.alt, 'Sailboat');
  assert.equal(surface.previewContent.querySelector('.inv-image-details-prompt').textContent, 'a boat at dusk');
  render('Sailboat', { prompt: 'a boat at dawn', seed: 7 });
  assert.equal(surface.previewContent.querySelectorAll('.inv-image-details').length, 1);
  assert.equal(surface.previewContent.querySelector('.inv-image-details-prompt').textContent, 'a boat at dawn');
});
