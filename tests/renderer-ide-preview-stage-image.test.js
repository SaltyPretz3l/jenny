'use strict';

// new-test-file: renderer-ide-preview-stage.test.js would pass the 600-line cap; image previews are their own lane (readImage, no text read).
/* Row 199 C4: png/jpg/gif/webp previews render one <img> through readImage; failures land bounded state cards. */

const test = require('node:test');
const assert = require('node:assert/strict');

const ideState = require('../renderer/features/renderer-ide-state');
const { makeStage, cleanupGlobals, settle } = require('./helpers/ide-preview-stage-harness');

const PNG_B64 = 'iVBORw0KGgo=';
const imageOk = () => ({ ok: true, mime: 'image/png', base64: PNG_B64, size: 8 });
// Past the stage's 200 ms debounce for disk changes to an image.
const afterDebounce = () => new Promise((resolve) => setTimeout(resolve, 260)).then(settle);

test('image files are previewable and render one <img> through readImage (no text read)', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ readImageImpl: imageOk });
  t.after(() => h.stage.dispose());
  const outcomes = [];
  h.stage.open('shots/home.png', { onRendered: (outcome) => outcomes.push(outcome) });
  assert.deepEqual(outcomes, [], 'an image path is accepted, not reported unsupported');
  h.stage.sync(true);
  await settle();
  assert.deepEqual(h.calls.readImage, [{ path: 'shots/home.png' }]);
  assert.equal(h.calls.readText.length, 0, 'images never take the text read lane');
  const images = h.hostEl.querySelectorAll('img');
  assert.equal(images.length, 1);
  assert.equal(images[0].getAttribute('src'), `data:image/png;base64,${PNG_B64}`);
  assert.equal(images[0].getAttribute('alt'), 'home.png');
  assert.equal(h.hostEl.querySelector('[data-preview-state]'), null);
  // The load event settles the pending report as loaded.
  images[0].dispatchEvent(new h.dom.window.Event('load'));
  assert.deepEqual(outcomes, [{ render: 'loaded' }]);
  for (const name of ['a.jpg', 'a.jpeg', 'a.gif', 'a.webp']) {
    ideState.setPreviewPath(h.ide, name);
    h.stage.sync(true);
    await settle();
    assert.equal(h.hostEl.querySelectorAll('img').length, 1, name);
  }
  assert.equal(h.calls.readImage.length, 5);
});

test('an image the browser cannot decode reports failed in a bounded state card', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ readImageImpl: imageOk });
  t.after(() => h.stage.dispose());
  const outcomes = [];
  h.stage.open('shots/bad.png', { onRendered: (outcome) => outcomes.push(outcome) });
  h.stage.sync(true);
  await settle();
  h.hostEl.querySelector('img').dispatchEvent(new h.dom.window.Event('error'));
  assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'frame-failed');
  assert.equal(h.hostEl.querySelector('img'), null);
  assert.deepEqual(outcomes, [{ render: 'failed', detail: 'frame_failed' }]);
});

test('readImage failures show bounded states and report failed; svg stays unsupported', async (t) => {
  cleanupGlobals(t);
  const failures = {
    'gone.png': { ok: false, code: 'CMP-WORKSPACEFS-0004' },
    'huge.png': { ok: false, code: 'CMP-WORKSPACEFS-0012' },
    'fake.png': { ok: false, code: 'CMP-WORKSPACEFS-0014' },
  };
  const h = makeStage({ readImageImpl: ({ path }) => failures[path] || imageOk() });
  t.after(() => h.stage.dispose());
  const expected = { 'gone.png': 'missing', 'huge.png': 'too-large', 'fake.png': 'unsupported' };
  for (const [name, state] of Object.entries(expected)) {
    const outcomes = [];
    h.stage.open(name, { onRendered: (outcome) => outcomes.push(outcome) });
    h.stage.sync(true);
    await settle();
    assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, state, name);
    assert.equal(h.hostEl.querySelector('img'), null, name);
    assert.deepEqual(outcomes, [{ render: 'failed', detail: state }], name);
  }
  const unsupported = [];
  h.stage.open('logo.svg', { onRendered: (outcome) => unsupported.push(outcome) });
  assert.deepEqual(unsupported, [{ render: 'failed', detail: 'unsupported' }]);
});

test('an image read that throws or returns a non-image lands the bounded missing state', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ readImageImpl: ({ path }) => {
    if (path === 'boom.png') throw new Error('bridge down');
    return { ok: true, mime: 'text/html', base64: 'PGI+', size: 3 };
  } });
  t.after(() => h.stage.dispose());
  for (const name of ['boom.png', 'weird.png']) {
    h.stage.open(name);
    h.stage.sync(true);
    await settle();
    assert.equal(h.hostEl.querySelector('[data-preview-state]').dataset.previewState, 'missing', name);
    assert.equal(h.hostEl.querySelector('img'), null, name);
  }
});

test('a disk change with the same file version keeps the shown image; a new version remounts it', async (t) => {
  cleanupGlobals(t);
  let fileVersion = 'v1';
  const h = makeStage({ readImageImpl: () => ({ ...imageOk(), rootId: 'r', generation: 1, fileVersion }) });
  t.after(() => h.stage.dispose());
  h.stage.open('shots/home.png');
  h.ide.activeStageSurface = 'preview';
  h.stage.sync(true);
  await settle();
  const first = h.hostEl.querySelector('img');
  first.dispatchEvent(new h.dom.window.Event('load'));
  h.stage.handleExternalChange({ relPath: 'shots/home.png', kind: 'changed' });
  await afterDebounce();
  assert.equal(h.calls.readImage.length, 2);
  assert.equal(h.hostEl.querySelector('img'), first, 'an unchanged version is not remounted');
  fileVersion = 'v2';
  h.stage.handleExternalChange({ relPath: 'shots/home.png', kind: 'changed' });
  await afterDebounce();
  assert.equal(h.calls.readImage.length, 3);
  assert.notEqual(h.hostEl.querySelector('img'), first, 'a new version remounts');
});

test('an image error that arrives after a newer render still lets the same version remount', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ readImageImpl: () => ({ ...imageOk(), rootId: 'r', generation: 1, fileVersion: 'v1' }) });
  t.after(() => h.stage.dispose());
  h.stage.open('shots/home.png');
  h.ide.activeStageSurface = 'preview';
  h.stage.sync(true);
  await settle();
  const broken = h.hostEl.querySelector('img');
  h.stage.handleExternalChange({ relPath: 'shots/home.png', kind: 'changed' });
  broken.dispatchEvent(new h.dom.window.Event('error'));
  await afterDebounce();
  assert.notEqual(h.hostEl.querySelector('img'), broken, 'the broken image is replaced, not kept by the unchanged skip');
});

test('a burst of disk changes to the previewed image reads it once', async (t) => {
  cleanupGlobals(t);
  const h = makeStage({ readImageImpl: () => ({ ...imageOk(), rootId: 'r', generation: 1, fileVersion: 'v1' }) });
  t.after(() => h.stage.dispose());
  h.stage.open('shots/home.png');
  h.ide.activeStageSurface = 'preview';
  h.stage.sync(true);
  await settle();
  for (let i = 0; i < 5; i += 1) h.stage.handleExternalChange({ relPath: 'shots/home.png', kind: 'changed' });
  await afterDebounce();
  assert.equal(h.calls.readImage.length, 2, 'one read for the open, one for the whole burst');
});
