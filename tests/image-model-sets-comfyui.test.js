'use strict';

// Row 127: ComfyUI recipes, the ComfyUI folder and ComfyUI model sets in the image model store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  saveModelSet, listModelSets, resolveModelSet, removeModelSet, setDefaultModelSet, loadRecipes, validateRecipe,
  recipeNodeTypes, validateComfyFolder, setComfyFolder, getComfyFolder, findRecipeFiles, saveComfyModelSet, loaderNameFor,
  comfyFolderHealth,
} = require('../services/image-model-sets');
const { linkDirectory } = require('./helpers/platform-skips');

function comfyFixture(t, name = 'install') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-comfy-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const folder = path.join(base, name);
  const write = (relative, bytes = 'model') => {
    const file = path.join(folder, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  write('python_embeded/python.exe', 'py');
  write('ComfyUI/main.py', 'main');
  fs.mkdirSync(path.join(folder, 'ComfyUI', 'models'), { recursive: true });
  const modelsRoot = path.join(fs.realpathSync(folder), 'ComfyUI', 'models');
  const model = (relative, bytes) => write(`ComfyUI/models/${relative}`, bytes);
  const input = {
    storePath: path.join(base, 'sets.json'), recipe: 'minimax_h3_image', label: 'MiniMax',
    diffusion: 'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors',
    text_encoder: 'text_encoders/qwen3vl_32b_minimax_h3_int8.safetensors',
    vae: 'vae/minimax_h3_image_vae.safetensors',
  };
  for (const slot of ['diffusion', 'text_encoder', 'vae']) model(input[slot], slot);
  return { base, folder, write, model, modelsRoot, input };
}

test('shipped recipe validates, lists node types, and broken recipes are named', () => {
  const { version, recipes } = loadRecipes();
  assert.equal(version, 1);
  const recipe = recipes.minimax_h3_image;
  assert.deepEqual(validateRecipe(recipe), { ok: true });
  assert.deepEqual(recipeNodeTypes(recipe), ['CLIPLoader', 'ConditioningZeroOut', 'KSampler', 'MiniMaxH3ImageConditioning', 'SaveImage', 'UNETLoader', 'VAEDecode', 'VAELoader']);
  assert.throws(() => loadRecipes({ recipesPath: 'x', fsImpl: { readFileSync: () => '{broken' } }));
  const broken = (mutate) => { const copy = structuredClone(recipe); mutate(copy); return validateRecipe(copy); };
  for (const mutate of [
    (r) => { r.slots.prompt = ['99', 'prompt']; },
    (r) => { r.slots.prompt = ['5', 'missing_input']; },
    (r) => { delete r.slots.seed; },
    (r) => { r.phase_nodes.output = '99'; },
    (r) => { r.files.vae.prefixes = []; },
    (r) => { r.files.vae.extensions = [5]; },
    (r) => { r.resolutions.push('2050x2048'); },
    (r) => { r.resolutions.push('2048'); },
    (r) => { r.size_map['1024x1024'] = '4096x4096'; },
    (r) => { r.min_total_vram_mb = 0; },
    (r) => { r.free_vram_mb = 1.5; },
    (r) => { r.locked.steps = 'six'; },
    (r) => { r.locked.cfg_scale = Infinity; },
  ]) {
    const result = broken(mutate);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recipe_invalid');
    assert.equal(typeof result.detail, 'string');
  }
  assert.equal(validateRecipe(null).reason, 'recipe_invalid');
});

test('ComfyUI folder validation checks shape, install files and models folder', (t) => {
  const { folder, modelsRoot } = comfyFixture(t);
  const ok = validateComfyFolder(folder);
  assert.equal(ok.ok, true);
  assert.equal(ok.folder, fs.realpathSync(folder));
  assert.equal(ok.pythonPath, path.join(ok.folder, 'python_embeded', 'python.exe'));
  assert.equal(ok.mainPath, path.join(ok.folder, 'ComfyUI', 'main.py'));
  assert.equal(ok.modelsRoot, modelsRoot);
  const bad = { ok: false, reason: 'comfyui_folder_invalid' };
  for (const missing of ['python_embeded/python.exe', 'ComfyUI/main.py', 'ComfyUI/models']) {
    const copy = comfyFixture(t, 'copy');
    fs.rmSync(path.join(copy.folder, ...missing.split('/')), { recursive: true });
    assert.deepEqual(validateComfyFolder(copy.folder), bad);
  }
  const wrongKind = comfyFixture(t, 'kind');
  fs.rmSync(path.join(wrongKind.folder, 'ComfyUI', 'main.py'));
  fs.mkdirSync(path.join(wrongKind.folder, 'ComfyUI', 'main.py'));
  assert.deepEqual(validateComfyFolder(wrongKind.folder), bad);
  assert.deepEqual(validateComfyFolder(path.join(folder, 'ComfyUI', 'main.py')), bad);
  assert.deepEqual(validateComfyFolder(path.join(folder, 'nope')), bad);
  // An interpreter that resolves outside the chosen folder is refused.
  const outside = path.join(fs.realpathSync(os.tmpdir()), 'elsewhere', 'python.exe');
  const escaping = { ...fs, realpathSync: (p) => (String(p).endsWith('python.exe') ? outside : fs.realpathSync(p)) };
  assert.deepEqual(validateComfyFolder(folder, { fsImpl: escaping }), bad);
  const rejectingFs = new Proxy({}, { get() { throw new Error('Unexpected filesystem access'); } });
  for (const value of ['relative', '\\\\server\\share\\ComfyUI', '\\\\?\\C:\\ComfyUI']) {
    assert.deepEqual(validateComfyFolder(value, { platform: 'win32', fsImpl: rejectingFs }), { ok: false, reason: 'root_not_local_path' });
  }
  const linked = { ...fs, realpathSync: () => '\\\\server\\share\\ComfyUI' };
  assert.deepEqual(validateComfyFolder('C:\\ComfyUI', { platform: 'win32', fsImpl: linked }), { ok: false, reason: 'root_not_local_path' });
  const posix = { ...fs, realpathSync: (p) => p, statSync: (p) => ({ isFile: () => p.endsWith('python3') || p.endsWith('main.py'), isDirectory: () => p.endsWith('models') || p === '/opt/comfy' }) };
  assert.equal(validateComfyFolder('/opt/comfy', { platform: 'linux', fsImpl: posix }).pythonPath, '/opt/comfy/python_embeded/bin/python3');
});

test('setting, reading and clearing the ComfyUI folder only touches the store', (t) => {
  const { folder, input } = comfyFixture(t);
  const { storePath } = input;
  assert.deepEqual(getComfyFolder({ storePath }), { ok: true, comfyui_folder: null });
  assert.deepEqual(setComfyFolder({ storePath, folder: path.join(folder, 'nope') }), { ok: false, reason: 'comfyui_folder_invalid' });
  assert.equal(fs.existsSync(storePath), false);
  assert.deepEqual(setComfyFolder({ storePath, folder }), { ok: true, comfyui_folder: fs.realpathSync(folder) });
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).version, 2);
  assert.equal(listModelSets({ storePath }).comfyui_folder, fs.realpathSync(folder));
  assert.deepEqual(setComfyFolder({ storePath, folder: null }), { ok: true, comfyui_folder: null });
  assert.deepEqual(getComfyFolder({ storePath }), { ok: true, comfyui_folder: null });
  fs.writeFileSync(storePath, '{broken');
  assert.equal(getComfyFolder({ storePath }).reason, 'store_corrupt');
  assert.equal(setComfyFolder({ storePath, folder }).reason, 'store_corrupt');
});

test('saving a ComfyUI set checks folder, recipe, names and recipe file patterns', (t) => {
  const { folder, input, model, modelsRoot } = comfyFixture(t);
  const { storePath } = input;
  assert.deepEqual(saveComfyModelSet(input), { ok: false, reason: 'comfyui_folder_missing' });
  setComfyFolder({ storePath, folder });
  assert.deepEqual(saveComfyModelSet({ ...input, recipe: 'nope' }), { ok: false, reason: 'unknown_recipe' });
  for (const name of ['../x', '/x', 'a\\b', 'vae/../vae/x', '']) {
    assert.deepEqual(saveComfyModelSet({ ...input, vae: name }), { ok: false, reason: 'invalid_name' });
  }
  model('vae/minimax_h3_image_pruned.safetensors');
  model('diffusion_models/other_model.safetensors');
  model('diffusion_models/minimax_h3_image_x.gguf');
  model('flat_minimax_h3_image.safetensors');
  for (const diffusion of ['vae/minimax_h3_image_pruned.safetensors', 'diffusion_models/other_model.safetensors', 'diffusion_models/minimax_h3_image_x.gguf', 'flat_minimax_h3_image.safetensors']) {
    assert.deepEqual(saveComfyModelSet({ ...input, diffusion }), { ok: false, reason: 'recipe_file_mismatch' });
  }
  assert.deepEqual(saveComfyModelSet({ ...input, vae: 'vae/minimax_h3_image_vae_missing.safetensors' }), { ok: false, reason: 'file_missing' });
  assert.equal(listModelSets({ storePath }).sets.length, 0);
  const saved = saveComfyModelSet(input, { now: () => 77 });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.set, {
    id: saved.set.id, label: 'MiniMax', backend: 'comfyui', recipe: 'minimax_h3_image', root: modelsRoot, created_at: 77,
    files: { diffusion: { name: input.diffusion, size_bytes: 9 }, text_encoder: { name: input.text_encoder, size_bytes: 12 }, vae: { name: input.vae, size_bytes: 3 } },
  });
  assert.match(saved.set.id, /^[a-f0-9]{12}$/);
  const listed = listModelSets({ storePath });
  assert.equal(listed.default_id, saved.set.id);
  assert.equal(listed.sets[0].backend, 'comfyui');
  assert.equal(saveComfyModelSet({ ...input, label: 'again' }).set.id, saved.set.id);
  assert.equal(listModelSets({ storePath }).sets.length, 1);
  // The same files saved as an sd.cpp set never share an id with the ComfyUI set.
  const sdcpp = saveModelSet({
    storePath, root: modelsRoot, label: 'same files', family: 'qwen_image21',
    diffusion: input.diffusion, text_encoder: input.text_encoder, vae: input.vae,
  }, { readArchitecture: () => 'qwen_image21' });
  assert.equal(sdcpp.ok, true);
  assert.notEqual(sdcpp.set.id, saved.set.id);
  assert.equal(sdcpp.set.backend, 'sdcpp');
  assert.deepEqual(listModelSets({ storePath }).sets.map((set) => set.backend), ['comfyui', 'sdcpp']);
  // Removal and default selection work for both backends.
  assert.deepEqual(setDefaultModelSet(sdcpp.set.id, { storePath }), { ok: true });
  assert.deepEqual(removeModelSet(saved.set.id, { storePath }), { ok: true });
  assert.deepEqual(listModelSets({ storePath }).sets.map((set) => set.id), [sdcpp.set.id]);
  assert.equal(listModelSets({ storePath }).comfyui_folder, fs.realpathSync(folder));
});

test('saving refuses a ComfyUI file that escapes the models folder through a link', (t) => {
  const { folder, input, base, modelsRoot } = comfyFixture(t);
  setComfyFolder({ storePath: input.storePath, folder });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'minimax_h3_image_evil.safetensors'), 'evil');
  linkDirectory(outside, path.join(modelsRoot, 'diffusion_models', 'linked'));
  assert.deepEqual(saveComfyModelSet({ ...input, diffusion: 'diffusion_models/linked/minimax_h3_image_evil.safetensors' }), { ok: false, reason: 'name_escapes_root' });
});

test('resolving a ComfyUI set returns loader names and goes stale when the install changes', (t) => {
  const { folder, input, model, modelsRoot } = comfyFixture(t);
  const { storePath } = input;
  setComfyFolder({ storePath, folder });
  const nested = 'diffusion_models/sub/minimax_h3_image_nested.safetensors';
  model(nested);
  const saved = saveComfyModelSet({ ...input, diffusion: nested });
  assert.equal(saved.ok, true);
  const resolved = resolveModelSet(saved.set.id, { storePath });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.set.backend, 'comfyui');
  assert.equal(resolved.paths.diffusion, path.join(modelsRoot, 'diffusion_models', 'sub', 'minimax_h3_image_nested.safetensors'));
  assert.deepEqual(resolved.comfy, {
    folder: fs.realpathSync(folder), pythonPath: path.join(fs.realpathSync(folder), 'python_embeded', 'python.exe'),
    mainPath: path.join(fs.realpathSync(folder), 'ComfyUI', 'main.py'), modelsRoot,
    loaderNames: {
      diffusion: ['sub', 'minimax_h3_image_nested.safetensors'].join(path.sep),
      text_encoder: 'qwen3vl_32b_minimax_h3_int8.safetensors', vae: 'minimax_h3_image_vae.safetensors',
    },
  });
  assert.equal(loaderNameFor('diffusion_models/sub/x.safetensors', 'win32'), 'sub\\x.safetensors');
  assert.equal(loaderNameFor('diffusion_models/sub/x.safetensors', 'linux'), 'sub/x.safetensors');
  assert.equal(loaderNameFor('vae/x.safetensors', 'win32'), 'x.safetensors');
  const stale = { ok: false, reason: 'image_model_set_stale' };

  model(input.vae, 'changed size');
  assert.deepEqual(resolveModelSet(saved.set.id, { storePath }), stale);
  model(input.vae, 'vae');
  assert.equal(resolveModelSet(saved.set.id, { storePath }).ok, true);

  const other = comfyFixture(t, 'other');
  assert.equal(setComfyFolder({ storePath, folder: other.folder }).ok, true);
  assert.deepEqual(resolveModelSet(saved.set.id, { storePath }), stale);
  assert.equal(setComfyFolder({ storePath, folder }).ok, true);
  assert.equal(resolveModelSet(saved.set.id, { storePath }).ok, true);

  fs.rmSync(path.join(folder, 'ComfyUI', 'main.py'));
  assert.deepEqual(resolveModelSet(saved.set.id, { storePath }), stale);
  fs.writeFileSync(path.join(folder, 'ComfyUI', 'main.py'), 'main');
  assert.equal(resolveModelSet(saved.set.id, { storePath }).ok, true);

  assert.deepEqual(setComfyFolder({ storePath, folder: null }), { ok: true, comfyui_folder: null });
  assert.deepEqual(resolveModelSet(saved.set.id, { storePath }), stale);
  assert.equal(listModelSets({ storePath }).sets.length, 1);
});

test('finding recipe files lists only matching regular files within two levels', (t) => {
  const { folder, input, model } = comfyFixture(t);
  const { storePath } = input;
  assert.deepEqual(findRecipeFiles({ storePath, recipe: 'minimax_h3_image' }), { ok: false, reason: 'comfyui_folder_missing' });
  setComfyFolder({ storePath, folder });
  assert.deepEqual(findRecipeFiles({ storePath, recipe: 'nope' }), { ok: false, reason: 'unknown_recipe' });
  model('unet/MiniMax_H3_Image_upper.SAFETENSORS', '1234');
  model('diffusion_models/a/b/minimax_h3_image_two.safetensors');
  model('diffusion_models/a/b/c/minimax_h3_image_three.safetensors');
  model('diffusion_models/other.safetensors');
  model('diffusion_models/minimax_h3_image_x.gguf');
  model('vae/unrelated.safetensors');
  model('clip/qwen3vl_32b_minimax_h3_clip.safetensors');
  model('loras/minimax_h3_image_lora.safetensors');
  const found = findRecipeFiles({ storePath, recipe: 'minimax_h3_image' });
  assert.equal(found.ok, true);
  assert.equal(found.root, validateComfyFolder(folder).modelsRoot);
  assert.deepEqual(found.candidates.diffusion, [
    { name: 'diffusion_models/a/b/minimax_h3_image_two.safetensors', size_bytes: 5 },
    { name: `diffusion_models/${path.basename(input.diffusion)}`, size_bytes: 9 },
    { name: 'unet/MiniMax_H3_Image_upper.SAFETENSORS', size_bytes: 4 },
  ]);
  assert.deepEqual(found.candidates.text_encoder.map((entry) => entry.name), ['clip/qwen3vl_32b_minimax_h3_clip.safetensors', input.text_encoder]);
  assert.deepEqual(found.candidates.vae.map((entry) => entry.name), [input.vae]);
  assert.equal(found.truncated, true);
  const bounded = findRecipeFiles({ storePath, recipe: 'minimax_h3_image' }, { limits: { maxPerSlot: 1 } });
  assert.equal(bounded.candidates.diffusion.length, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(findRecipeFiles({ storePath, recipe: 'minimax_h3_image' }, { limits: { maxEntries: 0 } }).truncated, true);
  assert.equal(findRecipeFiles({ storePath, recipe: 'minimax_h3_image' }, { limits: { maxEntries: -1 } }).reason, 'invalid_limits');
});

test('finding recipe files skips linked directories', (t) => {
  const { folder, input, base, modelsRoot } = comfyFixture(t);
  setComfyFolder({ storePath: input.storePath, folder });
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'minimax_h3_image_evil.safetensors'), 'evil');
  linkDirectory(outside, path.join(modelsRoot, 'diffusion_models', 'linked'));
  linkDirectory(outside, path.join(modelsRoot, 'unet'));
  const found = findRecipeFiles({ storePath: input.storePath, recipe: 'minimax_h3_image' });
  assert.equal(found.candidates.diffusion.some((entry) => /evil|linked|unet/.test(entry.name)), false);
});

const VERSION_FILE = 'ComfyUI/comfyui_version.py';

test('folder health is null without a saved folder and names an invalid one without scanning', (t) => {
  const { folder, input } = comfyFixture(t);
  const { storePath } = input;
  assert.equal(comfyFolderHealth({ storePath }), null);
  setComfyFolder({ storePath, folder });
  fs.rmSync(path.join(folder, 'ComfyUI', 'main.py'));
  assert.deepEqual(comfyFolderHealth({ storePath }), {
    folder: fs.realpathSync(folder), ok: false, reason: 'comfyui_folder_invalid', version: '', recipes: {},
  });
  fs.writeFileSync(storePath, '{broken');
  assert.deepEqual(comfyFolderHealth({ storePath }), { ok: false, reason: 'store_corrupt' });
});

test('folder health reports the version, per-recipe candidates and whether a set was added', (t) => {
  const { folder, input, write } = comfyFixture(t);
  const { storePath } = input;
  setComfyFolder({ storePath, folder });
  write(VERSION_FILE, '"""x"""\n__version__ = "0.45.0"\n');
  const health = comfyFolderHealth({ storePath });
  assert.equal(health.ok, true);
  assert.equal(health.reason, '');
  assert.equal(health.folder, fs.realpathSync(folder));
  assert.equal(health.version, '0.45.0');
  assert.deepEqual(Object.keys(health.recipes), ['minimax_h3_image']);
  const entry = health.recipes.minimax_h3_image;
  assert.equal(entry.label, 'MiniMax-H3-Image');
  assert.equal(entry.min_version, '0.45.0');
  assert.equal(entry.version_ok, true);
  assert.equal(entry.steps, 6);
  assert.equal(entry.truncated, false);
  assert.equal(entry.added, false);
  assert.deepEqual(entry.slots, {
    diffusion: [{ name: input.diffusion, size_bytes: 9 }],
    text_encoder: [{ name: input.text_encoder, size_bytes: 12 }],
    vae: [{ name: input.vae, size_bytes: 3 }],
  });
  assert.equal(saveComfyModelSet(input).ok, true);
  assert.equal(comfyFolderHealth({ storePath }).recipes.minimax_h3_image.added, true);
  // A recipe id the saved set does not name is not marked added.
  const { recipes } = loadRecipes();
  const other = comfyFolderHealth({ storePath }, { recipes: { other_recipe: recipes.minimax_h3_image } });
  assert.equal(other.recipes.other_recipe.added, false);
});

test('folder health compares dotted versions and treats an unreadable version as compatible', (t) => {
  const { folder, input, write } = comfyFixture(t);
  const { storePath } = input;
  setComfyFolder({ storePath, folder });
  const versionOk = () => comfyFolderHealth({ storePath }).recipes.minimax_h3_image.version_ok;
  const versionOf = () => comfyFolderHealth({ storePath }).version;
  write(VERSION_FILE, '__version__ = "0.43.2"\n');
  assert.equal(versionOf(), '0.43.2');
  assert.equal(versionOk(), false);
  write(VERSION_FILE, "__version__ = '0.9.9'\n");
  assert.equal(versionOk(), false);
  write(VERSION_FILE, '__version__ = "0.45"\n');
  assert.equal(versionOk(), true);
  write(VERSION_FILE, '__version__ = "0.46.0rc1"\n');
  assert.equal(versionOk(), true);
  write(VERSION_FILE, '__version__ = "1.0.0"\n');
  assert.equal(versionOk(), true);
  // Anything the pattern does not accept, and a missing file, give no version and no blocker.
  for (const text of ['no version here', '__version__ = "abc"\n', '__version__ = 0.45.0\n', `${' '.repeat(5000)}__version__ = "0.45.0"\n`]) {
    write(VERSION_FILE, text);
    assert.equal(versionOf(), '', text.slice(0, 20));
    assert.equal(versionOk(), true);
  }
  fs.rmSync(path.join(folder, ...VERSION_FILE.split('/')));
  assert.equal(versionOf(), '');
  assert.equal(versionOk(), true);
  write(VERSION_FILE, '__version__ = "0.45.0"\n');
  const throwing = { ...fs, openSync: (file, ...rest) => { if (String(file).endsWith('comfyui_version.py')) throw new Error('denied'); return fs.openSync(file, ...rest); } };
  const denied = comfyFolderHealth({ storePath }, { fsImpl: throwing });
  assert.equal(denied.version, '');
  assert.equal(denied.ok, true);
});

test('folder health lists every matching file sorted and ignores a version file that resolves outside the install', (t) => {
  const { folder, input, model, base, write } = comfyFixture(t);
  const { storePath } = input;
  setComfyFolder({ storePath, folder });
  model('text_encoders/qwen3vl_32b_minimax_h3_a.safetensors', 'aa');
  model('clip/qwen3vl_32b_minimax_h3_b.safetensors', 'b');
  const slot = comfyFolderHealth({ storePath }).recipes.minimax_h3_image.slots.text_encoder;
  assert.deepEqual(slot.map((entry) => entry.name), [
    'clip/qwen3vl_32b_minimax_h3_b.safetensors', 'text_encoders/qwen3vl_32b_minimax_h3_a.safetensors', input.text_encoder,
  ]);
  const outside = path.join(base, 'elsewhere.py');
  fs.writeFileSync(outside, '__version__ = "9.9.9"\n');
  write(VERSION_FILE, '__version__ = "0.45.0"\n');
  const escaping = { ...fs, realpathSync: (p) => (String(p).endsWith('comfyui_version.py') ? outside : fs.realpathSync(p)) };
  assert.equal(comfyFolderHealth({ storePath }, { fsImpl: escaping }).version, '');
});
