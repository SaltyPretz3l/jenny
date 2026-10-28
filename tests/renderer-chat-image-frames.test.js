'use strict';

// Row 56 slice C: every chat image is one framed figure with its tool cluster.
// Behavioural coverage for the Python image dedupe/blocked count, the deleted
// artifact eviction, the attached/tool image load-error state and the delegated
// image actions.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const artifactCards = require('../renderer/chat/renderer-artifact-card-utils');
const figure = require('../renderer/inventory/artifact-figure');
const { escapeHtml } = require('../renderer/shared/string-utils');
const { withInventory } = require('./helpers/inventory-harness');
const { createToolDetailBody } = require('../renderer/chat/renderer-tool-detail-body');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');

const pythonModel = () => ({
  toolKind: 'python_execute', toolName: 'python_execute', callId: 'py-1', domToken: 'py-1', status: 'completed',
  metadata: {}, inputJson: '{}',
  // The stored chart also arrives as a legacy image; one remote and one UNC image are refused.
  outputText: JSON.stringify({ images: ['file:///C:/stored/chart.png', 'https://tracker.example/x.png', '\\\\server\\share\\x.png', 'file:///C:/plot.png'] }),
  trustedAttachmentImages: [{ src: 'file:///C:/stored/chart.png', id: 'chart-1' }],
});

function pythonFigures(html) {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return {
    figures: [...doc.querySelectorAll('figure.inv-artifact-figure--tool')].map((node) => ({
      src: node.querySelector('img').getAttribute('src'),
      alt: node.querySelector('img').getAttribute('alt'),
      id: node.querySelector('[data-image-viewer-open="tool"]')?.dataset.imageId || '',
    })),
    grouped: doc.querySelectorAll('.inv-artifact-figures > figure').length,
    notice: doc.body.textContent.match(/(\d+) image output\(s\) are unavailable\./)?.[1] || '',
  };
}

test('the Python detail renders one framed figure per source and counts only refused legacy images', (t) => {
  withInventory(t);
  const detail = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(pythonModel());
  const expected = {
    figures: [
      { src: 'file:///C:/stored/chart.png', alt: 'Python output image 1 of 2', id: 'chart-1' },
      { src: 'file:///C:/plot.png', alt: 'Python output image 2 of 2', id: '' },
    ],
    grouped: 2,
    notice: '2',
  };
  assert.deepEqual(pythonFigures(detail), expected);
});

test('a single Python image is not grouped and reads "Python output image"', (t) => {
  withInventory(t);
  const model = { ...pythonModel(), outputText: JSON.stringify({ images: ['data:image/png;base64,YQ=='] }), trustedAttachmentImages: [] };
  const html = createToolDetailBody({ toolCallUtils }).buildDetailBodyMarkup(model);
  assert.deepEqual(pythonFigures(html), {
    figures: [{ src: 'data:image/png;base64,YQ==', alt: 'Python output image', id: '' }], grouped: 0, notice: '',
  });
});

const generatedImage = { artifact_id: 'img-1', artifact_kind: 'image', title: 'Fox', file_name: 'img-1.png',
  display_path: '.jenny/artifacts/session-1/img-1.png', mime_type: 'image/png', session_id: 'session-1' };
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

async function withDocument(read, run) {
  const dom = new JSDOM('<body></body>');
  const previous = { document: globalThis.document, jennyShell: globalThis.jennyShell };
  artifactCards.resetArtifactImageLoaderForTests();
  globalThis.document = dom.window.document;
  globalThis.jennyShell = { artifacts: { read } };
  try { await run(dom.window.document); } finally {
    artifactCards.resetArtifactImageLoaderForTests();
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  }
}

test('a deleted artifact drops its cached image: the frame turns unavailable and a re-render never reads it again', async () => {
  let reads = 0;
  await withDocument(async () => { reads += 1; return { asset_data_url: 'data:image/png;base64,YQ==' }; }, async (doc) => {
    const render = () => artifactCards.renderArtifactCards([generatedImage], 'call-1');
    doc.body.innerHTML = render();
    await tick();
    assert.equal(doc.querySelector('img').getAttribute('src'), 'data:image/png;base64,YQ==');

    artifactCards.evictArtifactImage('session-1', 'img-1');
    const frame = doc.querySelector('.inv-artifact-figure-frame');
    assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
    assert.deepEqual([frame.getAttribute('aria-disabled'), frame.getAttribute('aria-label')], ['true', 'Image unavailable']);

    doc.body.innerHTML = render();
    await tick();
    assert.equal(reads, 1);
    assert.equal(doc.querySelector('img').hasAttribute('src'), false);
    assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
  });
});

test('an artifact known missing, or without a session, renders unavailable up front without a read', async () => {
  let reads = 0;
  await withDocument(async () => { reads += 1; return {}; }, async (doc) => {
    doc.body.innerHTML = artifactCards.renderArtifactCards([{ ...generatedImage, status: 'missing' }], 'call-1')
      + artifactCards.renderArtifactCards([{ ...generatedImage, artifact_id: 'img-2', session_id: undefined }], 'call-2');
    await tick();
    assert.equal(reads, 0);
    assert.deepEqual([...doc.querySelectorAll('figure')].map((node) => node.dataset.invArtifactImageState), ['unavailable', 'unavailable']);
    assert.deepEqual([...doc.querySelectorAll('.inv-artifact-figure-frame')].map((node) => node.getAttribute('aria-disabled')), ['true', 'true']);
  });
});

function bindTimeline(markup, deps = {}) {
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="chatTimeline">${markup}</div></body>`);
  const chatTimeline = dom.window.document.getElementById('chatTimeline');
  const errors = [];
  const cleanups = [];
  const bindings = createTranscriptEventBindings({
    chatTimeline, state: {}, thinkingController: {}, getSessionId: () => 'sess_pane',
    showComposerActionError: (error, title) => errors.push([error.message, title]), ...deps,
  });
  bindings.bindTranscriptEvents((target, name, handler, options) => {
    target.addEventListener(name, handler, options);
    cleanups.push(() => target.removeEventListener(name, handler, options));
  });
  return { window: dom.window, chatTimeline, errors, cleanup: () => cleanups.forEach((fn) => fn()) };
}

const sourceFigure = (kind, id) => figure.renderSourceFigure({ kind, id, sessionId: '', src: 'file:///C:/gone.png', alt: 'Gone',
  labels: { viewAria: 'View Gone', unavailable: 'Image unavailable', copy: 'Copy image', saveAs: 'Save as…', actions: 'Image actions' } });

test('an attached or tool image whose file fails to load shows the unavailable state; the listener is removed on cleanup', () => {
  const { window, chatTimeline, cleanup } = bindTimeline(sourceFigure('attachment', 'att-1') + sourceFigure('tool', 'chart-1')
    + '<figure class="inv-artifact-figure"><img class="inv-artifact-figure-image" data-inv-artifact-image-key="s:a"></figure>');
  const [attached, tool, generated] = chatTimeline.querySelectorAll('figure');
  attached.querySelector('img').dispatchEvent(new window.Event('error'));
  generated.querySelector('img').dispatchEvent(new window.Event('error'));
  assert.equal(attached.dataset.invArtifactImageState, 'unavailable');
  assert.equal(attached.querySelector('.inv-artifact-figure-frame').getAttribute('aria-disabled'), 'true');
  assert.equal(generated.hasAttribute('data-inv-artifact-image-state'), false, 'generated images belong to the card loader');
  cleanup();
  tool.querySelector('img').dispatchEvent(new window.Event('error'));
  assert.equal(tool.hasAttribute('data-inv-artifact-image-state'), false);
});

test('image tools route panel to the artifact action and everything else to the viewer controller', async () => {
  const runs = [];
  const panels = [];
  const generated = figure.renderFigure({ callId: 'c', artifactId: 'img-1', sessionId: 'sess_src', imageKey: 'sess_src:img-1', title: 'Fox',
    labels: { viewAria: 'View Fox', unavailable: 'Image unavailable', copy: 'Copy image', saveAs: 'Save as…', reveal: 'Show in folder', panel: 'Open beside chat', actions: 'Image actions' } });
  const { window, chatTimeline, errors } = bindTimeline(generated + sourceFigure('attachment', 'att-1'), {
    handleArtifactAction: async (payload) => { panels.push(payload); },
  });
  window.rendererImageViewerController = { run: async (action, target) => { runs.push([action, target]); } };
  const tool = (selector) => chatTimeline.querySelector(selector);
  tool('[data-image-kind="artifact"][data-image-action="panel"]').click();
  tool('[data-image-kind="artifact"][data-image-action="reveal"]').click();
  tool('[data-image-kind="attachment"][data-image-action="save-as"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(panels, [{ action: 'panel', artifactId: 'img-1', sessionId: 'sess_src', contextNode: tool('[data-image-action="panel"]') }]);
  assert.deepEqual(runs, [
    ['reveal', { kind: 'artifact', id: 'img-1', sessionId: 'sess_src' }],
    ['save-as', { kind: 'attachment', id: 'att-1', sessionId: 'sess_pane' }],
  ]);
  delete window.rendererImageViewerController;
  tool('[data-image-kind="attachment"][data-image-action="copy"]').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [['Image unavailable', 'Artifact Action Failed']]);
});

test('the pending image Cancel stops once: it turns busy and disabled after the first click', async () => {
  let stops = 0;
  const { chatTimeline } = bindTimeline(figure.renderPendingFigure({ labels: { title: 'Rendering', note: '', cancel: 'Cancel' } }), {
    handleStopActiveStream: async () => { stops += 1; },
  });
  const cancel = chatTimeline.querySelector('[data-inv-image-cancel]');
  cancel.click();
  cancel.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.deepEqual([cancel.getAttribute('aria-busy'), cancel.disabled], ['true', true]);
});

test('a figure rebuilt unavailable is disabled from its markup and never opens the viewer', async () => {
  const opens = [];
  const labels = { viewAria: 'View Fox', unavailable: 'Image unavailable', copy: 'Copy image', saveAs: 'Save as…', reveal: 'Show in folder', panel: 'Open beside chat', actions: 'Image actions' };
  const render = (artifactId, state) => figure.renderFigure({ callId: artifactId, artifactId, sessionId: 's', imageKey: `s:${artifactId}`, title: 'Fox', state, labels });
  const { window, chatTimeline } = bindTimeline(render('gone', 'unavailable') + render('ok', ''));
  window.rendererImageViewerController = { open: async (request) => { opens.push(request.select.id); return true; } };
  const [gone, ok] = chatTimeline.querySelectorAll('.inv-artifact-figure-frame');
  assert.deepEqual([gone.getAttribute('aria-disabled'), gone.getAttribute('aria-label'), gone.dataset.invArtifactViewAria], ['true', 'Image unavailable', 'View Fox']);
  gone.click();
  ok.click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opens, ['ok']);
});
