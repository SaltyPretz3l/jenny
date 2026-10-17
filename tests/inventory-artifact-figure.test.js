'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const figure = require('../renderer/inventory/artifact-figure');

const HOSTILE = '<&"\'>';
const LABELS = Object.fromEntries(['viewAria', 'unavailable', 'copy', 'saveAs', 'reveal', 'panel', 'actions'].map((key) => [key, HOSTILE]));
const parse = (html) => new JSDOM(html).window.document;

test('generated figure escapes every value, carries one identity and keeps tools beside, not inside, the frame', () => {
  const html = figure.renderFigure({ callId: HOSTILE, artifactId: HOSTILE, sessionId: HOSTILE, imageKey: HOSTILE,
    title: HOSTILE, width: 1024, height: 768, src: HOSTILE, meta: HOSTILE, prompt: HOSTILE, labels: LABELS });
  assert.ok(!html.includes(HOSTILE));
  const doc = parse(html);
  assert.equal(doc.querySelector('figure').dataset.artifactCallId, HOSTILE);
  const img = doc.querySelector('img');
  assert.equal(img.dataset.invArtifactImageKey, HOSTILE);
  assert.equal(img.getAttribute('src'), HOSTILE);
  assert.equal(img.getAttribute('width'), '1024');
  assert.equal(doc.querySelector('.inv-artifact-figure-media').style.getPropertyValue('--inv-image-ratio').trim(), '1024 / 768');
  const frame = doc.querySelector('.inv-artifact-figure-frame');
  assert.deepEqual({ ...frame.dataset }, { imageViewerOpen: 'artifact', imageId: HOSTILE, sessionId: HOSTILE });
  assert.equal(frame.getAttribute('aria-label'), HOSTILE);
  const tools = [...doc.querySelectorAll('.inv-artifact-figure-actions button')];
  assert.deepEqual(tools.map((button) => button.dataset.imageAction), ['copy', 'save-as', 'reveal', 'panel']);
  for (const button of tools) {
    assert.equal(button.type, 'button');
    assert.deepEqual([button.dataset.imageKind, button.dataset.imageId, button.dataset.sessionId], ['artifact', HOSTILE, HOSTILE]);
    assert.equal(button.getAttribute('aria-label'), HOSTILE);
    assert.equal(button.title, HOSTILE);
    assert.equal(frame.contains(button), false);
  }
  assert.equal(doc.querySelector('.inv-artifact-figure-actions').getAttribute('role'), 'group');
});

test('generated figure omits bad dimensions and empty captions, and an id-less figure has no viewer or tools', () => {
  const doc = parse(figure.renderFigure({ width: -1, height: 1.5, state: 'unavailable', labels: LABELS }));
  const img = doc.querySelector('img');
  for (const name of ['src', 'width', 'height']) assert.equal(img.hasAttribute(name), false);
  assert.equal(doc.querySelector('figure').dataset.invArtifactImageState, 'unavailable');
  assert.equal(doc.querySelector('figcaption'), null);
  assert.equal(doc.querySelector('button'), null);
  assert.equal(doc.querySelector('.inv-artifact-figure-media').hasAttribute('style'), false);
});

test('attached and tool figures share the frame with Copy and Save as only, and degrade without an id', () => {
  const doc = parse(figure.renderSourceFigure({ kind: 'attachment', id: 'att-1', sessionId: '', src: 'file:///a.png', alt: 'cat.png', caption: 'cat.png', labels: LABELS }));
  assert.ok(doc.querySelector('figure').classList.contains('inv-artifact-figure--attachment'));
  assert.equal(doc.querySelector('.inv-artifact-figure-frame').dataset.imageViewerOpen, 'attachment');
  assert.deepEqual([...doc.querySelectorAll('[data-image-action]')].map((b) => `${b.dataset.imageAction}:${b.dataset.imageKind}:${b.dataset.imageId}`),
    ['copy:attachment:att-1', 'save-as:attachment:att-1']);
  assert.equal(doc.querySelector('.inv-artifact-figure-title').textContent, 'cat.png');
  const legacy = parse(figure.renderSourceFigure({ kind: 'tool', src: 'data:image/png;base64,AA==', alt: 'chart', labels: LABELS }));
  assert.ok(legacy.querySelector('figure').classList.contains('inv-artifact-figure--tool'));
  assert.equal(legacy.querySelector('button'), null);
  assert.equal(legacy.querySelector('img').getAttribute('alt'), 'chart');
});

test('pending figure reserves the image ratio, numeric strings included, and escapes its labels', () => {
  for (const [opts, ratio] of [[{}, '1 / 1'], [{ width: 0, height: 768 }, '1 / 1'], [{ width: 1024, height: 768 }, '1024 / 768'], [{ width: '512', height: '512' }, '512 / 512']]) {
    const html = figure.renderPendingFigure({ ...opts, labels: { title: HOSTILE, note: HOSTILE, cancel: HOSTILE } });
    assert.ok(!html.includes(HOSTILE));
    const doc = parse(html);
    assert.equal(doc.querySelector('.inv-artifact-figure-placeholder').style.aspectRatio, ratio);
    assert.equal(doc.querySelector('[data-inv-image-cancel]').textContent, HOSTILE);
  }
});

test('the markdown reference opens the viewer through the shared image attributes', () => {
  const button = parse(figure.renderViewerButton({ sessionId: 's', artifactId: 'a"1', label: 'View image' })).querySelector('button');
  assert.deepEqual({ ...button.dataset }, { imageViewerOpen: 'artifact', imageId: 'a"1', sessionId: 's' });
});

test('generation details map provenance, drop empty values and render escaped rows for the panel', () => {
  const details = figure.generationDetails({ duration_ms: 65600, metadata: { provenance: {
    image_prompt: ' a <b>boat</b> ', image_negative_prompt: 'blur', seed: '42', steps: 28, cfg_scale: 2.5, family: 'qwen-image', quant: 'Q4_K_M' } } },
  { display_path: 'C:\\images\\boat.png' });
  assert.deepEqual(details, { prompt: 'a <b>boat</b>', negativePrompt: 'blur', seed: 42, steps: 28, cfgScale: 2.5,
    model: 'qwen-image · Q4_K_M', seconds: 66, fileName: 'boat.png' });
  assert.equal(figure.generationDetails({}, {}), null);
  // F9: a saved label wins over the opaque set id.
  assert.equal(figure.generationDetails({ metadata: { provenance: { model_set_id: 'set-9f2c', model_label: 'Qwen-Image · Q4_K_M',
    family: 'qwen-image', quant: 'Q4_K_M' } } }, {}).model, 'Qwen-Image · Q4_K_M');
  assert.equal(figure.generationDetails({ metadata: { provenance: { model_set_id: 'set-9f2c' } } }, {}).model, undefined);
  assert.deepEqual(figure.detailRows(details, '1024 × 1024').map(([label]) => label), ['Size', 'Seed', 'Steps', 'Model', 'Time', 'File']);
  assert.deepEqual(figure.detailRows({ seed: 0 }, ''), [['Seed', '0']]);
  const html = figure.renderDetails(details, '1024 × 1024');
  assert.ok(!html.includes('<b>'));
  const doc = parse(html);
  assert.equal(doc.querySelector('.inv-image-details-prompt').textContent, 'a <b>boat</b>');
  assert.equal(doc.querySelector('.inv-image-details-prompt--avoid').textContent, 'blur');
  assert.ok(doc.querySelector('[data-image-copy-prompt]').getAttribute('aria-label'));
  assert.equal(doc.querySelectorAll('dt').length, 6);
  assert.equal(figure.renderDetails(null, ''), '');
  assert.equal(parse(figure.renderDetails({ seed: 7 }, '')).querySelector('[data-image-copy-prompt]'), null);
});
