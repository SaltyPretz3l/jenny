'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture, failed, png, FAMILY } = require('./helpers/image-generate-fixture');
const { createImageGenerateTool } = require('../services/tools/builtin/image-generate-tool');

const NO_GPU = ['suspend', 'register', 'run', 'artifact', 'restore'];

function rendered(f) {
  const run = f.calls.find(([kind]) => kind === 'run');
  assert.ok(run, 'the render ran');
  return [run[1].expectedWidth, run[1].expectedHeight];
}

test('the manifest schema has one size enum and no width/height enums', () => {
  const manifest = require('../services/tools/tool-manifest.json');
  const families = require('../config/sdcpp-families.json').families;
  const descriptor = manifest.tools.find(({ name }) => name === 'image_generate');
  const { size, width, height } = descriptor.parameters.properties;
  assert.equal(size.type, 'string');
  assert.equal(size.default, '1024x1024');
  for (const family of Object.values(families)) assert.deepEqual(size.enum, family.resolutions);
  for (const legacy of [width, height]) {
    assert.equal(legacy.type, 'integer');
    assert.equal(legacy.enum, undefined);
    assert.ok(legacy.description.includes('size'));
  }
  assert.equal(descriptor.parameters.required.includes('size'), false);
});

test('size selects the render dimensions', async (t) => {
  const f = fixture(t);
  const result = await f.tool.execute({ ...f.input, size: '1472x1120' }, f.context);
  assert.equal(result.isError, false);
  assert.deepEqual(rendered(f), [1472, 1120]);
});

test('other spellings of a size mean the same pair', async (t) => {
  for (const size of ['1472 x 1120', '1472X1120', '1472*1120', '1472×1120', ' 1472x1120 ']) {
    const f = fixture(t);
    const result = await f.tool.execute({ ...f.input, size }, f.context);
    assert.equal(result.isError, false, size);
    assert.deepEqual(rendered(f), [1472, 1120], size);
  }
});

test('legacy width and height still map to the same pair, and neither means the default', async (t) => {
  const legacy = fixture(t);
  await legacy.tool.execute({ ...legacy.input, width: 1472, height: 1120 }, legacy.context);
  assert.deepEqual(rendered(legacy), [1472, 1120]);
  const bare = fixture(t);
  await bare.tool.execute(bare.input, bare.context);
  assert.deepEqual(rendered(bare), [1024, 1024]);
});

test('size together with the same width and height is accepted', async (t) => {
  const f = fixture(t);
  await f.tool.execute({ ...f.input, size: '1472x1120', width: 1472, height: 1120 }, f.context);
  assert.deepEqual(rendered(f), [1472, 1120]);
});

test('size that conflicts with width or height fails before any GPU work', async (t) => {
  for (const extra of [{ width: 1024, height: 1024 }, { width: 1024 }, { height: 1024 }]) {
    const f = fixture(t);
    const result = await f.tool.execute({ ...f.input, size: '1472x1120', ...extra }, f.context);
    failed(result, 'image_invalid_params');
    assert.equal(result.metadata.failure_class, 'bad_arguments');
    assert.equal(result.metadata.effects, 'none');
    assert.equal(result.content.includes('\n'), false);
    assert.equal(f.calls.some(([kind]) => NO_GPU.includes(kind)), false);
  }
});

test('an unsupported size or pair fails, lists the supported sizes and never falls back', async (t) => {
  const cases = [{ size: '1344x1344' }, { size: 'huge' }, { size: 1024 }, { size: '' }, { size: '1024x' },
    { width: 1024, height: 1120 }, { width: 1472, height: 1472 }, { width: 512, height: 512 }];
  for (const extra of cases) {
    const f = fixture(t);
    const result = await f.tool.execute({ ...f.input, ...extra }, f.context);
    failed(result, 'image_invalid_params');
    assert.equal(result.metadata.failure_class, 'bad_arguments');
    assert.equal(result.metadata.effects, 'none');
    assert.equal(result.content.includes('\n'), false);
    for (const size of f.dependencies.loadFamilies().families.test_family.resolutions) {
      assert.ok(result.content.includes(size), result.content);
      assert.ok(result.metadata.remediation.includes(size));
    }
    assert.ok(result.metadata.remediation.includes('size'));
    assert.equal(f.calls.some(([kind]) => NO_GPU.includes(kind)), false);
  }
});

test('an edit keeps the source size when no size is sent and accepts a size that equals it', async (t) => {
  const reference = async () => ({ artifactId: 'original', width: 1472, height: 1120, region: null,
    buffer: png(1472, 1120) });
  const editable = (extra) => {
    const f = fixture(t, { readReference: reference });
    f.paths.vision_projector = path.join(f.root, 'vision.gguf');
    f.dependencies.loadFamilies = () => ({ families: { test_family: { ...FAMILY, vision_flag: '--llm_vision' } } });
    return { f, tool: createImageGenerateTool(f.dependencies), input: { ...f.input, source_artifact_id: 'original', ...extra } };
  };
  const keep = editable({});
  await keep.tool.execute(keep.input, keep.f.context);
  assert.deepEqual(rendered(keep.f), [1472, 1120]);
  const same = editable({ size: '1472x1120' });
  await same.tool.execute(same.input, same.f.context);
  assert.deepEqual(rendered(same.f), [1472, 1120]);
  const other = editable({ size: '1024x1024' });
  failed(await other.tool.execute(other.input, other.f.context), 'image_edit_size_unsupported');
  assert.equal(other.f.calls.some(([kind]) => NO_GPU.includes(kind)), false);
});
