'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listSessionImages } = require('../renderer/chat/renderer-session-image-list');
const { toFileAssetUrl } = require('../renderer/chat/renderer-transcript-attachments');

const list = (messages, options = {}) => listSessionImages(messages, { sessionId: 's1', toFileUrl: toFileAssetUrl, ...options });
const generated = (artifacts, extra = {}) => ({ kind: 'tool_result', tool_result: { generated_artifacts: artifacts, ...extra } });
const image = (id, extra = {}) => ({ artifact_id: id, artifact_kind: 'image', title: `Image ${id}`, ...extra });

test('attached, generated and tool-output images list in timeline order with stable keys', () => {
  const items = list([
    { role: 'user', attachments: [
      { id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\cat.png', displayName: 'Cat' },
      { id: 'txt-1', kind: 'text', assetPath: 'C:\\managed\\notes.txt' },
    ] },
    generated([image('gen-1')]),
    { role: 'assistant', content: 'no images here' },
    { kind: 'tool_result', tool_result: { trusted_attachment_refs: [
      { id: 'plot-1', kind: 'image', asset_path: 'C:\\attachments\\plot-1.png' },
      { id: 'chart-1', kind: 'chart', asset_path: '/attachments/chart-1.png' },
    ] } },
    { role: 'user', attachments: [{ id: 'att-2', kind: 'image', assetPath: '/managed/dog.png' }] },
  ]);
  assert.deepEqual(items.map((item) => item.key), ['attachment:att-1', 'artifact:gen-1', 'tool:plot-1', 'tool:chart-1', 'attachment:att-2']);
  assert.deepEqual(items[0], { kind: 'source', key: 'attachment:att-1', sessionId: 's1', src: 'file:///C:/managed/cat.png',
    title: 'Cat', ref: { kind: 'attachment', id: 'att-1' } });
  assert.deepEqual(items[1], { kind: 'artifact', key: 'artifact:gen-1', sessionId: 's1', artifactId: 'gen-1', title: 'Image gen-1' });
  assert.deepEqual(items[2], { kind: 'source', key: 'tool:plot-1', sessionId: 's1', src: 'file:///C:/attachments/plot-1.png',
    title: 'Python output image', ref: { kind: 'tool', id: 'plot-1' } });
  assert.equal(items[4].title, 'Image attachment');
});

test('generation details map every provenance field and omit missing ones', () => {
  const [full, partial, fileOnly, bare] = list([
    generated([image('full', { display_path: '.jenny/artifacts/s1/fox.png' })], {
      duration_ms: 12600,
      metadata: { provenance: { image_prompt: 'a fox', image_negative_prompt: 'blur', seed: 0, steps: 20, cfg_scale: 4.5,
        model_set_id: 'flux-schnell', family: 'flux', quant: 'Q4_K' } },
    }),
    generated([image('partial')], { duration_ms: 0, metadata: { provenance: { image_prompt: 'a cat', family: 'sdxl', seed: '' } } }),
    generated([image('file', { display_path: 'out\\owl.png' })]),
    generated([image('bare')], { duration_ms: 3000 }),
  ]);
  assert.deepEqual(full.details, { prompt: 'a fox', negativePrompt: 'blur', seed: 0, steps: 20, cfgScale: 4.5,
    model: 'flux · Q4_K', seconds: 13, fileName: 'fox.png' });
  assert.deepEqual(partial.details, { prompt: 'a cat', model: 'sdxl' });
  assert.deepEqual(fileOnly.details, { fileName: 'owl.png' });
  assert.equal('details' in bare, false, 'no provenance and no file name means no details');
});

test('deleted, unavailable and non-image artifacts are skipped', () => {
  const items = list([generated([
    image('kept'),
    image('deleted'),
    image('missing', { status: 'missing' }),
    image('pending', { status: 'pending' }),
    { artifact_id: 'doc', artifact_kind: 'document', title: 'Notes' },
    image(''),
  ])], { deletedArtifactIds: ['s1::deleted', 'other::kept'] });
  assert.deepEqual(items.map((item) => item.key), ['artifact:kept']);
});

test('duplicates keep the first entry and unusable sources are skipped', () => {
  const items = list([
    { role: 'user', attachments: [
      { id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\first.png' },
      { id: 'att-no-path', kind: 'image' },
      { kind: 'image', assetPath: 'C:\\managed\\no-id.png' },
      { id: 'att-remote', kind: 'image', assetPath: 'https://example.invalid/x.png' },
    ] },
    { role: 'user', attachments: [{ id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\second.png' }] },
    generated([image('gen-1', { title: 'First' }), image('gen-1', { title: 'Second' })]),
    { kind: 'tool_result', tool_result: { trusted_attachment_refs: [
      { id: 'page-1', kind: 'pdf_page', asset_path: 'C:\\attachments\\page-1.png' },
      { kind: 'image', asset_path: 'C:\\attachments\\no-id.png' },
      { id: 'no-path', kind: 'image' },
    ] } },
  ]);
  assert.deepEqual(items.map((item) => item.key), ['attachment:att-1', 'artifact:gen-1']);
  assert.equal(items[0].src, 'file:///C:/managed/first.png');
  assert.equal(items[1].title, 'First');
  assert.deepEqual(list(null), []);
});
