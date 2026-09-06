'use strict';

/* W7 image preview tabs: extension routing through versioned readImage, the
 * .ide-image-pane overlay (data: URL only - never innerHTML of file bytes),
 * zoom controls, status-bar suppression, and external-change reloads. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  settle,
} = require('./helpers/renderer-ide-harness');

const FILES = { 'assets/logo.png': 'PNGBYTES', 'notes.txt': 'text' };

function imagePane(harness) {
  return harness.getDom().ideEditorHost.querySelector('.ide-image-pane');
}

test('opening an image routes through versioned readImage into the image pane', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('assets/logo.png');
  await settle();

  assert.deepEqual(harness.bridge.calls.readImage.map((call) => call.path), ['assets/logo.png']);
  assert.deepEqual(harness.bridge.calls.readFileBase64, [], 'legacy base64 lane is not touched');
  assert.deepEqual(harness.bridge.calls.readFile, [], 'text read lane never touched');
  const pane = imagePane(harness);
  assert.ok(pane, 'image pane created');
  assert.equal(pane.classList.contains('hidden'), false);
  const img = pane.querySelector('img.ide-image-el');
  assert.match(img.src, /^data:image\/png;base64,/);
  assert.ok(
    img.src.includes(Buffer.from('PNGBYTES').toString('base64')),
    'payload bytes rendered as a data URL'
  );
  // Tab exists like any file tab; status bar suppressed, breadcrumbs kept.
  assert.ok(harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="assets/logo.png"]'));
  assert.equal(harness.getDom().ideStatusBar.classList.contains('hidden'), true);
  assert.equal(harness.getDom().ideBreadcrumbs.classList.contains('hidden'), false);
});

test('switching between image and text tabs toggles the pane', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('assets/logo.png');
  await harness.controller.openFile('notes.txt');
  await settle();
  assert.equal(imagePane(harness).classList.contains('hidden'), true, 'text tab hides the pane');
  assert.equal(harness.getDom().ideStatusBar.classList.contains('hidden'), false);

  harness.getDom().ideTabStrip.querySelector('[data-ide-tab-path="assets/logo.png"]').click();
  await settle();
  assert.equal(imagePane(harness).classList.contains('hidden'), false);
});

test('zoom controls update the meta readout; saving an image is refused', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('assets/logo.png');
  await settle();
  const pane = imagePane(harness);
  const meta = pane.querySelector('.ide-image-meta');
  assert.match(meta.textContent, /fit$/);

  pane.querySelector('[data-ide-image-zoom="100"]').click();
  assert.match(meta.textContent, /100%$/);
  pane.querySelector('[data-ide-image-zoom="in"]').click();
  assert.match(meta.textContent, /125%$/);
  pane.querySelector('[data-ide-image-zoom="fit"]').click();
  assert.match(meta.textContent, /fit$/);

  const saved = await harness.controller.saveActiveFile();
  assert.equal(saved, false, 'image tabs have no save path');
  assert.deepEqual(harness.bridge.calls.writeFile, []);
});

test('external image change reloads through the versioned image lane', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { ...FILES } } });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('assets/logo.png');
  await settle();
  harness.bridge.state.files['assets/logo.png'] = 'NEWBYTES';
  harness.bridge.emitChange({ changes: [{ relPath: 'assets/logo.png', kind: 'modified' }] });
  await settle();
  assert.equal(harness.bridge.calls.readImage.length, 2, 'reloaded through readImage');
  const img = imagePane(harness).querySelector('img.ide-image-el');
  assert.ok(img.src.includes(Buffer.from('NEWBYTES').toString('base64')));
});
