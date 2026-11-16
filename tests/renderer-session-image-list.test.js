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
    title: 'Cat', ref: { kind: 'attachment', id: 'att-1' }, origin: 'Attached by you', details: { type: 'PNG', fileName: 'Cat' } });
  assert.deepEqual(items[1], { kind: 'artifact', key: 'artifact:gen-1', sessionId: 's1', artifactId: 'gen-1', title: 'Image gen-1', origin: 'Generated' });
  assert.deepEqual(items[2], { kind: 'source', key: 'tool:plot-1', sessionId: 's1', src: 'file:///C:/attachments/plot-1.png',
    title: 'Python output image', ref: { kind: 'tool', id: 'plot-1' }, origin: 'From a tool', details: { type: 'PNG', fileName: 'plot-1.png' } });
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

test('each image says where it came from: message id, origin line with the time, and Type, File size and file name details', () => {
  const now = new Date(2026, 10, 14, 15, 0, 0);
  const sameDay = new Date(2026, 10, 14, 14, 12, 0);
  const olderDay = new Date(2026, 10, 9, 14, 12, 0);
  const time = sameDay.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const items = list([
    { id: 'm-user', role: 'user', timestamp: sameDay.toISOString(), attachments: [
      { id: 'att-1', kind: 'image', assetPath: 'C:\\managed\\x.bin', displayName: 'shot.png', mimeType: 'image/png', sizeBytes: 2048 }] },
    { id: 'm-bot', role: 'assistant', createdAt: sameDay.toISOString(), attachments: [
      { id: 'att-2', kind: 'image', assetPath: '/managed/photo.jpeg', size_bytes: 0 }] },
    { id: 'm-gen', kind: 'tool_result', created_at: sameDay.toISOString(), tool_result: {
      generated_artifacts: [image('gen-1', { display_path: 'out/fox.png' })], metadata: { provenance: { seed: 3 } } } },
    { id: 'm-py', kind: 'tool_result', timestamp: sameDay.toISOString(), tool_result: { tool_name: 'run_Python', trusted_attachment_refs: [
      { id: 'plot-1', kind: 'image', asset_path: 'C:\\attachments\\plot-1.webp' }] } },
    { id: 'm-other', kind: 'tool_result', timestamp: sameDay.toISOString(), tool_result: { tool_name: 'browser_screenshot', trusted_attachment_refs: [
      { id: 'shot-1', kind: 'image', asset_path: 'C:\\attachments\\shot-1' }] } },
    { id: 'm-old', role: 'user', timestamp: olderDay.toISOString(), attachments: [{ id: 'att-old', kind: 'image', assetPath: '/managed/old.gif' }] },
    { id: 'm-bad', role: 'user', timestamp: 'not a date', attachments: [{ id: 'att-bad', kind: 'image', assetPath: '/managed/bad.png' }] },
    { role: 'user', attachments: [{ id: 'att-none', kind: 'image', assetPath: '/managed/none.png' }] },
  ], { now });
  const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
  assert.equal(byKey['attachment:att-1'].messageId, 'm-user');
  assert.equal(byKey['attachment:att-1'].origin, `Attached by you · ${time}`);
  assert.deepEqual(byKey['attachment:att-1'].details, { type: 'PNG', bytes: 2048, fileName: 'shot.png' });
  assert.equal(byKey['attachment:att-2'].origin, `Attached · ${time}`);
  assert.deepEqual(byKey['attachment:att-2'].details, { type: 'JPEG' }, 'a zero size is not a size and the extension names the type');
  assert.equal(byKey['artifact:gen-1'].origin, `Generated · ${time}`);
  assert.deepEqual(byKey['artifact:gen-1'].details, { seed: 3, fileName: 'fox.png' });
  assert.equal(byKey['tool:plot-1'].origin, `From Python · ${time}`);
  assert.deepEqual(byKey['tool:plot-1'].details, { type: 'WebP', fileName: 'plot-1.webp' });
  assert.equal(byKey['tool:shot-1'].origin, `From a tool · ${time}`);
  assert.deepEqual(byKey['tool:shot-1'].details, { fileName: 'shot-1' });
  assert.equal(byKey['tool:shot-1'].messageId, 'm-other');
  assert.match(byKey['attachment:att-old'].origin, /^Attached by you · /);
  assert.notEqual(byKey['attachment:att-old'].origin, `Attached by you · ${olderDay.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
    'an older day carries the date');
  assert.equal(byKey['attachment:att-bad'].origin, 'Attached by you');
  assert.equal(byKey['attachment:att-none'].origin, 'Attached by you');
  assert.equal('messageId' in byKey['attachment:att-none'], false);
});
