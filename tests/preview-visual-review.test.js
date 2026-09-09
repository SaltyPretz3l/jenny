'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { capture, PNG } = require('./helpers/preview-capture-fixture');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { encodePreviewImage, MAX_PREVIEW_IMAGE_BYTES } = require('../services/preview-vision-image');
const { sanitizeBridgeMetadata } = require('../services/backend/electron-tool-bridge');

test.afterEach(cleanupTrackedResources);
async function workspace() {
  const root = createTrackedTempDir('preview-vision-');
  await fs.writeFile(`${root}/index.html`, '<button id="inspect">Inspect</button>');
  return root;
}

for (const viewport of ['desktop', 'mobile', 'tablet']) {
  test(`capture flows through executor and bridge at ${viewport}`, async () => {
    const root = await workspace();
    const { result, calls } = await capture(root, { viewport });
    assert.equal(result.success, true);
    assert.deepEqual(calls, ['open', 'click', 'capture', 'close']);
    assert.equal(result.preview_image.call_id, 'capture_1');
    assert.deepEqual(Buffer.from(result.preview_image.data_base64, 'base64'), PNG);
    const artifact = result.generated_artifacts[0];
    assert.deepEqual(await fs.readFile(`${root}/${artifact.display_path}`), PNG);
    assert.equal(JSON.stringify(result.metadata).includes(PNG.toString('base64')), false);
    assert.equal(result.output.includes(PNG.toString('base64')), false);
  });
}
test('partial capture/save failures and screenshot=false are honest', async () => {
  const root = await workspace();
  const save = await capture(root, { saveError: true });
  assert.ok(save.result.preview_image);
  assert.match(save.result.output, /Screenshot save failed/);
  const failed = await capture(root, { captureError: true });
  assert.equal(failed.result.preview_image, undefined);
  assert.match(failed.result.output, /Screenshot capture failed/);
  const plain = await capture(root, { screenshot: false });
  assert.equal(plain.result.preview_image, undefined);
  assert.deepEqual(plain.result.generated_artifacts, []);
});
test('full screenshot storage still supplies fresh pixels through the bridge', async () => {
  const root = await workspace();
  for (let i = 0; i < 4; i += 1) await capture(root);
  const { result, calls } = await capture(root);
  assert.deepEqual(calls, ['open', 'click', 'capture', 'close']);
  assert.deepEqual(Buffer.from(result.preview_image.data_base64, 'base64'), PNG);
  assert.deepEqual(result.generated_artifacts, []);
  assert.match(result.output, /Screenshot save failed.*storage is full/);
  assert.equal(result.metadata.artifact_status, 'unavailable');
});
test('native encoding resizes oversized captures and rejects invalid captures', () => {
  const oversized = Buffer.concat([PNG, Buffer.alloc(MAX_PREVIEW_IMAGE_BYTES)]);
  const image = { toPNG: () => oversized, resize: ({ width }) => {
    assert.equal(width, 1);
    return { toPNG: () => PNG };
  } };
  assert.deepEqual(encodePreviewImage(image).buffer, PNG);
  assert.equal(encodePreviewImage({ toPNG: () => Buffer.from('bad') }), null);
  assert.equal(encodePreviewImage({ toPNG: () => oversized }), null);
});
test('nested image-shaped metadata cannot leak image bytes', () => {
  assert.deepEqual(sanitizeBridgeMetadata({ preview_image: { data_base64: 'secret' },
    nested: { previewImage: { buffer: 'secret' }, safe: 1 } }), { nested: { safe: 1 } });
});
