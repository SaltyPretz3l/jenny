'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trackDirectory } = require('./helpers/resource-cleanup');
const { png } = require('./helpers/image-generate-fixture');
const preview = require('../services/image-render-preview');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-render-preview-'));
  trackDirectory(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('the preview path is the engine\'s %03d pattern, refused when the scratch path holds a %', () => {
  const pattern = preview.previewPathPattern(path.join('C:', 'profile', 'image-engine-scratch'), 'img_abc');
  assert.ok(pattern.endsWith(`img_abc-preview-%03d.png`));
  assert.equal(preview.previewPathPattern(path.join('C:', 'Users', '100%', 'scratch'), 'img_abc'), '');
  assert.equal(preview.previewFrameName('img_abc', 7), 'img_abc-preview-007.png');
});

test('about ten frames per render whatever the step count', () => {
  assert.deepEqual([1, 4, 20, 30, 50, 100].map(preview.previewInterval), [1, 1, 2, 3, 5, 10]);
  assert.equal(preview.previewInterval(undefined), 1);
});

test('the reader sends each newest complete frame once and skips a frame still being written', (t) => {
  const root = scratch(t);
  const reader = preview.createPreviewReader({ scratchDir: root, opId: 'img_abc' });
  const frame = (index) => path.join(root, preview.previewFrameName('img_abc', index));
  assert.equal(reader.next(), '');

  fs.writeFileSync(frame(0), png(8, 4));
  const first = reader.next();
  assert.ok(first.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(first.split(',')[1], 'base64'), png(8, 4));
  assert.equal(reader.next(), '', 'a frame is sent once');

  // Frame 2 is partial (the engine is still writing it): frame 1 is sent instead.
  fs.writeFileSync(frame(1), png(8, 5));
  fs.writeFileSync(frame(2), png(8, 6).subarray(0, 40));
  assert.deepEqual(Buffer.from(reader.next().split(',')[1], 'base64'), png(8, 5));
  fs.writeFileSync(frame(2), png(8, 6));
  assert.deepEqual(Buffer.from(reader.next().split(',')[1], 'base64'), png(8, 6));

  assert.deepEqual(preview.listPreviewFrames(root, 'img_abc'), [frame(0), frame(1), frame(2)]);
});

test('oversized and non-PNG frames are never sent', (t) => {
  const root = scratch(t);
  const reader = preview.createPreviewReader({ scratchDir: root, opId: 'img_abc' });
  fs.writeFileSync(path.join(root, preview.previewFrameName('img_abc', 0)), png(600, 4));
  assert.equal(reader.next(), '', 'larger than a preview edge');
  fs.writeFileSync(path.join(root, preview.previewFrameName('img_abc', 1)), Buffer.from('<svg/>'));
  assert.equal(reader.next(), '');
});
