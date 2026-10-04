'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  SLOTS, loadFamilies, familyForArchitecture, scanModelFolder, saveModelSet,
  listModelSets, resolveModelSet, removeModelSet, setDefaultModelSet,
} = require('../services/image-model-sets');

function gguf(architecture) {
  const key = Buffer.from('general.architecture');
  const data = Buffer.from(architecture);
  const header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(1n, 16);
  const keyLength = Buffer.alloc(8);
  keyLength.writeBigUInt64LE(BigInt(key.length));
  const type = Buffer.alloc(4);
  type.writeUInt32LE(8);
  const dataLength = Buffer.alloc(8);
  dataLength.writeBigUInt64LE(BigInt(data.length));
  return Buffer.concat([header, keyLength, key, type, dataLength, data]);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-image-sets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'sets.json');
  const write = (name, bytes = 'model') => {
    const file = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  const input = {
    storePath, root, family: 'qwen_image21', label: 'Test set',
    diffusion: 'diffusion_models/model.gguf', text_encoder: 'text_encoders/qwen3vl.gguf', vae: 'vae/model.safetensors',
  };
  write(input.diffusion, gguf('qwen_image21'));
  write(input.text_encoder, gguf('qwen3vl'));
  write(input.vae);
  return { root, storePath, write, input };
}

test('families load, flags and resolutions match the preset contract', () => {
  const { version, families } = loadFamilies();
  assert.equal(version, 1);
  assert.deepEqual(SLOTS, ['diffusion', 'text_encoder', 'vae']);
  assert.equal(Object.isFrozen(SLOTS), true);
  assert.deepEqual(Object.keys(families).sort(), ['qwen_image', 'qwen_image21']);
  for (const [id, family] of Object.entries(families)) {
    assert.equal(familyForArchitecture(id, families), id);
    assert.equal(family.diffusion_flag, '--diffusion-model');
    assert.equal(family.encoder_flag, '--llm');
    assert.equal(family.vae_flag, '--vae');
    assert.deepEqual(family.defaults, { steps: 20, cfg_scale: 2.5, sampler: 'euler', flow_shift: 3 });
    assert.deepEqual(family.extra_args, ['--fa', '--offload-to-cpu']);
    assert.deepEqual(family.unsupported_encoder_patterns, ['convrot', 'fp8']);
    assert.equal(family.min_total_vram_mb, 12000);
    assert.equal(family.free_vram_headroom_mb, 5000);
    assert.equal(family.resolutions.length, 8);
    for (const resolution of family.resolutions) {
      assert.equal(/^\d+x\d+$/.test(resolution), true);
      const [width, height] = resolution.split('x').map(Number);
      assert.equal(width % 32, 0);
      assert.equal(height % 32, 0);
    }
  }
  assert.equal(familyForArchitecture('llama', families), null);
  assert.equal(familyForArchitecture(null, families), null);
  assert.equal(loadFamilies({ familiesPath: 'injected', fsImpl: { readFileSync: () => '{"version":1,"families":{}}' } }).version, 1);
});

test('ComfyUI ancestors and flat GGUF architectures classify and sort', (t) => {
  const { root, write } = fixture(t);
  write('UNET/sub/z.SAFETENSORS');
  write('clip/sub/a.safetensors');
  write('flat.gguf', gguf('qwen_image'));
  write('encoder.GGUF', gguf('llama'));
  write('unknown.gguf', gguf('other'));
  write('unclassified.safetensors');
  const result = scanModelFolder(root);
  assert.equal(result.ok, true);
  assert.equal(result.root, root);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.candidates.diffusion.map((item) => item.name), ['UNET/sub/z.SAFETENSORS', 'diffusion_models/model.gguf', 'flat.gguf'].sort());
  assert.deepEqual(result.candidates.text_encoder.map((item) => item.name), ['clip/sub/a.safetensors', 'encoder.GGUF', 'text_encoders/qwen3vl.gguf']);
  assert.equal(result.candidates.diffusion.find((item) => item.name === 'flat.gguf').family_guess, 'qwen_image');
  assert.equal(result.candidates.diffusion.find((item) => item.name.startsWith('UNET')).format, 'safetensors');
  assert.equal(result.candidates.vae[0].size_bytes, 5);
  assert.equal(result.candidates.vae[0].architecture, null);
  assert.equal(scanModelFolder(path.join(root, 'UNET')).candidates.diffusion[0].name, 'sub/z.SAFETENSORS');
});

test('scan skips symlinked directories', (t) => {
  const { root, write } = fixture(t);
  write('outside/hidden.gguf', gguf('qwen_image21'));
  const link = path.join(root, 'diffusion_models', 'linked');
  try { fs.symlinkSync(path.join(root, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    assert.equal(['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code), true);
    t.skip('Symlink creation is not permitted');
    return;
  }
  const result = scanModelFolder(root);
  assert.equal(result.ok, true);
  assert.equal(result.candidates.diffusion.some((item) => item.name.includes('linked')), false);
});

test('scan bounds entries, depth, and candidates per slot', (t) => {
  const { root, write } = fixture(t);
  write('diffusion_models/a.safetensors');
  write('diffusion_models/deep/further/hidden.safetensors');
  assert.equal(scanModelFolder(root, { limits: { maxEntries: 1 } }).truncated, true);
  assert.equal(scanModelFolder(root, { limits: { maxPerSlot: 1 } }).candidates.diffusion.length, 1);
  const shallow = scanModelFolder(root, { limits: { maxDepth: 1 } });
  assert.equal(shallow.candidates.diffusion.some((item) => item.name.includes('hidden')), false);
  assert.equal(scanModelFolder(root, { limits: { maxEntries: 0 } }).truncated, true);
});

test('root shape is checked before filesystem access; mapped drives are allowed', () => {
  let calls = 0;
  const rejectingFs = new Proxy({}, { get() { calls += 1; throw new Error('Unexpected filesystem access'); } });
  for (const root of ['\\\\server\\share', 'relative', '\\\\?\\C:\\models', '\\\\.\\C:\\models']) {
    assert.deepEqual(scanModelFolder(root, { platform: 'win32', fsImpl: rejectingFs }), { ok: false, reason: 'root_not_local_path' });
  }
  assert.equal(calls, 0);
  const emptyDir = () => ({ readSync: () => null, closeSync() {} });
  const fsImpl = { realpathSync: (p) => p, statSync: () => ({ isDirectory: () => true }), opendirSync: emptyDir };
  assert.equal(scanModelFolder('Z:\\models', { platform: 'win32', fsImpl }).ok, true);
  assert.deepEqual(scanModelFolder('Z:\\models', { platform: 'win32', fsImpl: { ...fsImpl, statSync: () => ({ isDirectory: () => false }) } }), { ok: false, reason: 'root_not_directory' });
  // A local-looking directory link that resolves to a share is never listed.
  let listed = 0;
  const linked = { ...fsImpl, realpathSync: () => '\\\\server\\share\\models', opendirSync: () => { listed += 1; return emptyDir(); } };
  assert.deepEqual(scanModelFolder('C:\\models\\picked-link', { platform: 'win32', fsImpl: linked }), { ok: false, reason: 'root_not_local_path' });
  assert.equal(listed, 0);
});

test('save rejects invalid names, missing files, unknown families, and incompatible models', (t) => {
  const { input, write } = fixture(t);
  for (const name of ['../x', '/x', 'C:/x', 'a\\b', 'a/../x', 'a\0b', '']) {
    assert.deepEqual(saveModelSet({ ...input, vae: name }), { ok: false, reason: 'invalid_name' });
  }
  assert.deepEqual(saveModelSet({ ...input, root: 'relative' }), { ok: false, reason: 'root_not_local_path' });
  assert.deepEqual(saveModelSet({ ...input, vae: 'missing' }), { ok: false, reason: 'file_missing' });
  assert.deepEqual(saveModelSet({ ...input, family: 'unknown' }), { ok: false, reason: 'unknown_family' });
  assert.deepEqual(saveModelSet({ ...input, family: 'qwen_image' }), { ok: false, reason: 'family_mismatch' });
  write('text_encoders/qwen3vl_8b_int8_convrot.safetensors');
  assert.deepEqual(saveModelSet({ ...input, text_encoder: 'text_encoders/qwen3vl_8b_int8_convrot.safetensors' }), { ok: false, reason: 'image_text_encoder_unsupported' });
  write('text_encoders/QWEN_FP8.safetensors');
  assert.equal(saveModelSet({ ...input, text_encoder: 'text_encoders/QWEN_FP8.safetensors' }).reason, 'image_text_encoder_unsupported');
  assert.equal(fs.existsSync(input.storePath), false);
});

test('save enforces realpath containment for symlink escapes', (t) => {
  const { input, root } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-image-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'vae.safetensors'), 'outside');
  try { fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error;
    assert.equal(['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code), true);
    t.skip('Symlink creation is not permitted');
    return;
  }
  assert.deepEqual(saveModelSet({ ...input, vae: 'escape/vae.safetensors' }), { ok: false, reason: 'name_escapes_root' });
});

test('save persists atomically, stable IDs replace entries, and first set is default', (t) => {
  const { input, storePath } = fixture(t);
  const events = [];
  const fsImpl = {
    ...fs,
    writeFileSync(file, ...args) { events.push(['write', file]); return fs.writeFileSync(file, ...args); },
    renameSync(from, to) { events.push(['rename', from, to]); return fs.renameSync(from, to); },
  };
  const saved = saveModelSet(input, { fsImpl, now: () => 1234 });
  assert.equal(saved.ok, true);
  assert.equal(saved.set.created_at, 1234);
  const paths = SLOTS.map((slot) => fs.realpathSync(path.join(input.root, input[slot])));
  const sizes = paths.map((file) => fs.statSync(file).size);
  const expectedId = crypto.createHash('sha256').update([...paths, ...sizes].join('\n')).digest('hex').slice(0, 12);
  assert.equal(saved.set.id, expectedId);
  assert.deepEqual(events, [['write', `${storePath}.part`], ['rename', `${storePath}.part`, storePath]]);
  assert.equal(fs.existsSync(`${storePath}.part`), false);
  assert.equal(listModelSets({ storePath }).default_id, saved.set.id);
  assert.equal(saveModelSet({ ...input, label: 'Updated' }).set.id, saved.set.id);
  assert.equal(listModelSets({ storePath }).sets.length, 1);
  assert.equal(listModelSets({ storePath }).sets[0].label, 'Updated');
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).version, 1);
});

test('save caps sets at sixteen, while replacement remains allowed', (t) => {
  const { input, storePath, write } = fixture(t);
  const ids = [];
  for (let index = 0; index < 16; index += 1) {
    const vae = `vae/${index}.safetensors`;
    write(vae);
    const saved = saveModelSet({ ...input, vae });
    assert.equal(saved.ok, true);
    ids.push(saved.set.id);
  }
  write('vae/overflow.safetensors');
  assert.deepEqual(saveModelSet({ ...input, vae: 'vae/overflow.safetensors' }), { ok: false, reason: 'too_many_sets' });
  assert.equal(saveModelSet({ ...input, vae: 'vae/0.safetensors', label: 'replacement' }).ok, true);
  assert.equal(listModelSets({ storePath }).sets.length, 16);
  assert.equal(listModelSets({ storePath }).default_id, ids[0]);
});

test('safetensors diffusion saves without probing a GGUF architecture', (t) => {
  const { input, write } = fixture(t);
  write('diffusion_models/model.safetensors');
  let probes = 0;
  const result = saveModelSet({ ...input, diffusion: 'diffusion_models/model.safetensors' }, {
    families: loadFamilies().families,
    readArchitecture() { probes += 1; return null; },
  });
  assert.equal(result.ok, true);
  assert.equal(probes, 0);
  assert.equal(result.set.files.diffusion.name, 'diffusion_models/model.safetensors');
});

test('resolve returns paths and rejects changed sizes or missing files', (t) => {
  const { input, storePath, write } = fixture(t);
  const saved = saveModelSet(input);
  const resolved = resolveModelSet(saved.set.id, { storePath });
  assert.equal(resolved.ok, true);
  for (const slot of SLOTS) assert.equal(resolved.paths[slot], path.join(input.root, ...input[slot].split('/')));
  write(input.vae, 'changed size');
  assert.deepEqual(resolveModelSet(saved.set.id, { storePath }), { ok: false, reason: 'image_model_set_stale' });
  fs.unlinkSync(path.join(input.root, input.vae));
  assert.equal(resolveModelSet(saved.set.id, { storePath }).reason, 'image_model_set_stale');
});

test('default and removal mutate only the store; missing store is empty', (t) => {
  const { input, storePath, write } = fixture(t);
  assert.deepEqual(listModelSets({ storePath }), { sets: [], default_id: null });
  const first = saveModelSet(input).set;
  write('vae/second.safetensors');
  const second = saveModelSet({ ...input, vae: 'vae/second.safetensors' }).set;
  const files = [...SLOTS.map((slot) => path.join(input.root, input[slot])), path.join(input.root, 'vae/second.safetensors')];
  const before = files.map((file) => fs.statSync(file).mtimeMs);
  assert.deepEqual(setDefaultModelSet(second.id, { storePath }), { ok: true });
  assert.equal(listModelSets({ storePath }).default_id, second.id);
  assert.deepEqual(removeModelSet(second.id, { storePath }), { ok: true });
  assert.equal(listModelSets({ storePath }).default_id, first.id);
  assert.deepEqual(removeModelSet(first.id, { storePath }), { ok: true });
  assert.deepEqual(listModelSets({ storePath }), { sets: [], default_id: null });
  assert.deepEqual(files.map((file) => fs.statSync(file).mtimeMs), before);
  assert.equal(files.every((file) => fs.existsSync(file)), true);
  for (const action of [resolveModelSet, removeModelSet, setDefaultModelSet]) {
    assert.equal(action('missing', { storePath }).reason, 'model_set_not_found');
  }
});

test('corrupt stores fail without changing their bytes', (t) => {
  const { input, storePath } = fixture(t);
  for (const bytes of ['{broken', '{"version":2,"sets":[],"default_id":null}', '{"version":1,"sets":[{}],"default_id":null}']) {
    fs.writeFileSync(storePath, bytes);
    assert.deepEqual(listModelSets({ storePath }), { ok: false, reason: 'store_corrupt' });
    assert.deepEqual(saveModelSet(input), { ok: false, reason: 'store_corrupt' });
    for (const action of [resolveModelSet, removeModelSet, setDefaultModelSet]) {
      assert.deepEqual(action('missing', { storePath }), { ok: false, reason: 'store_corrupt' });
    }
    assert.equal(fs.readFileSync(storePath, 'utf8'), bytes);
    assert.equal(fs.existsSync(`${storePath}.part`), false);
  }
});
