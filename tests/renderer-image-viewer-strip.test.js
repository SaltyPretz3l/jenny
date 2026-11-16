'use strict';
// new-test-file: the filmstrip cases share one jsdom harness with its own fake IntersectionObserver; renderer-image-viewer.test.js is near its line cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createImageViewer } = require('../renderer/features/renderer-image-viewer');
const { createOverlayManager } = require('../renderer/shell/renderer-overlay-manager');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const png = (id) => `data:image/png;base64,${Buffer.from(id).toString('base64')}`;
const art = (id, extra = {}) => ({ kind: 'artifact', sessionId: 's', artifactId: id, ...extra });

function harness(overrides = {}) {
  const dom = new JSDOM('<main id="appShell"><button id="origin">Image</button></main>');
  const doc = dom.window.document;
  const calls = [];
  const viewer = createImageViewer({ documentRef: doc, windowRef: dom.window, overlayManager: createOverlayManager({ documentRef: doc }),
    readArtifact: async (sessionId, artifactId) => { calls.push(artifactId); return { asset_data_url: png(artifactId) }; },
    getCapabilities: async () => ({ imageEditing: true, imageEditSizes: ['1024x1024'] }), onAction: async () => ({ ok: true }), ...overrides });
  const load = (width = 1024, height = 1024) => {
    const image = doc.querySelector('.image-viewer-image');
    Object.defineProperties(image, { naturalWidth: { value: width, configurable: true }, naturalHeight: { value: height, configurable: true } });
    doc.querySelector('.image-viewer-stage').getBoundingClientRect = () => ({ width: 800, height: 600, left: 0, top: 0 });
    image.dispatchEvent(new dom.window.Event('load'));
    return image;
  };
  const strip = () => doc.querySelector('.image-viewer-strip');
  const thumbs = () => [...doc.querySelectorAll('[data-image-viewer-index]')];
  return { dom, doc, calls, viewer, load, strip, thumbs, click: (action) => doc.querySelector(`[data-image-viewer-action="${action}"]`).click() };
}

test('the strip is hidden for one image and lists one labelled thumbnail per image otherwise', async (t) => {
  const one = harness(); t.after(() => one.viewer.dispose());
  await one.viewer.open({ items: [art('a')] }); assert.equal(one.strip().hidden, true); assert.equal(one.thumbs().length, 0);
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a', { title: 'Cat' }), art('b'), art('c'), { kind: 'source', src: png('d'), title: 'Pasted' }], index: 0 }); h.load();
  assert.equal(h.strip().hidden, false); assert.equal(h.strip().getAttribute('role'), 'group'); assert.equal(h.strip().getAttribute('aria-label'), 'Images in this chat');
  assert.equal(h.thumbs().length, 4);
  assert.equal(h.thumbs()[0].getAttribute('aria-label'), 'Cat, 1 of 4'); assert.equal(h.thumbs()[0].title, 'Cat');
  assert.equal(h.thumbs()[1].getAttribute('aria-label'), 'Image viewer, 2 of 4');
  assert.equal(h.thumbs()[3].querySelector('img').getAttribute('src'), png('d'), 'a source thumbnail is its own src');
  assert.equal(h.thumbs()[3].querySelector('img').getAttribute('decoding'), 'async');
  assert.deepEqual(h.thumbs().map((button) => button.getAttribute('aria-current')), ['true', null, null, null]);
});

test('aria-current follows the step, a click jumps to that image and the strip hides in edit mode', async (t) => {
  const h = harness(); t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a'), art('b'), art('c'), art('d')] }); const image = h.load(); await tick();
  const current = () => h.thumbs().findIndex((button) => button.getAttribute('aria-current') === 'true');
  h.click('next'); await tick(); h.load(); assert.equal(current(), 1);
  h.click('prev'); await tick(); h.load(); assert.equal(current(), 0);
  h.thumbs()[2].click(); await tick(); h.load();
  assert.equal(image.src, png('c')); assert.equal(current(), 2);
  h.doc.querySelector('.image-viewer-stage').focus(); h.thumbs()[2].focus();
  h.thumbs()[2].dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })); await tick(); h.load();
  assert.equal(current(), 3); assert.equal(h.doc.activeElement, h.thumbs()[3], 'focus follows the current thumbnail');
  h.thumbs()[0].click(); await tick(); h.load();
  h.click('edit'); assert.equal(h.strip().hidden, true);
  h.thumbs()[2].click(); await tick(); assert.equal(image.src, png('a'), 'a thumbnail does nothing in edit mode');
  h.click('edit-cancel'); assert.equal(h.strip().hidden, false);
});

test('artifact thumbnails use getThumbnail, else are read through the viewer cache', async (t) => {
  const h = harness({ getThumbnail: (item) => (item.artifactId === 'b' ? png('cached-b') : '') }); t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a'), art('b'), art('c')] }); h.load(); await tick();
  assert.equal(h.thumbs()[1].querySelector('img').getAttribute('src'), png('cached-b'));
  assert.equal(h.thumbs()[0].querySelector('img').getAttribute('src'), png('a'), 'no cache: read lazily (no IntersectionObserver here)');
  assert.equal(h.thumbs()[2].querySelector('img').getAttribute('src'), png('c'));
  assert.deepEqual([...h.calls].sort(), ['a', 'b', 'c'], 'each artifact is read once, shared by the viewer, the prefetch and the strip');
});

test('a failed thumbnail read leaves the button without a picture; with an IntersectionObserver reads wait until it is near', async (t) => {
  const failing = harness({ readArtifact: async () => { throw new Error('gone'); } }); t.after(() => failing.viewer.dispose());
  await failing.viewer.open({ items: [art('a'), art('b')] }); await tick();
  assert.equal(failing.thumbs().length, 2); assert.equal(failing.thumbs().every((button) => !button.querySelector('img')?.hasAttribute('src')), true);
  const observed = []; let notify;
  const h = harness(); h.dom.window.IntersectionObserver = class { constructor(callback, config) { notify = callback; observed.config = config; } observe(node) { observed.push(node); } unobserve() {} disconnect() {} };
  t.after(() => h.viewer.dispose());
  await h.viewer.open({ items: [art('a'), art('b'), art('c')] }); h.load();
  assert.equal(observed.length, 3); assert.equal(observed.config.rootMargin, '0px 200px');
  assert.equal(h.thumbs()[2].querySelector('img').hasAttribute('src'), false, 'not read before it is near');
  notify([{ isIntersecting: true, target: observed[2] }]); await tick();
  assert.equal(h.thumbs()[2].querySelector('img').getAttribute('src'), png('c'));
});
