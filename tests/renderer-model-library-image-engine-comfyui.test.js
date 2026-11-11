'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryImageEngineController } = require('../renderer/shell/model-library/model-library-image-engine');

const GB = 1073741824;
const FOLDER = 'G:\\ComfyUI\\ComfyUI_windows_portable';
const DIFFUSION = 'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors';
const ENCODER_AWQ = 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const ENCODER_FP8 = 'text_encoders/qwen3vl_32b_minimax_h3_fp8.safetensors';
const VAE = 'vae/minimax_h3_vae.safetensors';

async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function file(name, gb) { return { name, size_bytes: Math.round(gb * GB) }; }

function recipe(overrides = {}) {
  return {
    label: 'MiniMax-H3-Image', min_version: '0.45.0', version_ok: true, steps: 6, truncated: false, added: false,
    slots: { diffusion: [file(DIFFUSION, 20)], text_encoder: [file(ENCODER_AWQ, 14.6)], vae: [file(VAE, 0.6)] },
    ...overrides,
  };
}

function health(overrides = {}, recipeOverrides = {}) {
  return { folder: FOLDER, ok: true, reason: '', version: '0.45.0', recipes: { minimax_h3_image: recipe(recipeOverrides) }, ...overrides };
}

function engineState(overrides = {}) {
  return {
    engine_tag: 'master-929-3f8527a', status: 'not_installed', source: null, install: null, last_error: null,
    custom_executable: null, download_size_bytes: 337915440, license: { name: 'MIT', url: '' },
    handoff: { active: false, retained: false, closing: false },
    model_sets: { sets: [], default_id: null },
    families: { qwen_image21: { label: 'Qwen-Image 2.1' } },
    comfyui: { enabled: true, health: null },
    recipes: { minimax_h3_image: { label: 'MiniMax-H3-Image', min_comfyui_version: '0.45.0', steps: 6 } },
    ...overrides,
  };
}

function comfySet(overrides = {}) {
  return {
    id: 'abcdef012345', label: '', backend: 'comfyui', recipe: 'minimax_h3_image', root: FOLDER,
    files: { diffusion: file(DIFFUSION, 20), text_encoder: file(ENCODER_AWQ, 14.6), vae: file(VAE, 0.6) },
    created_at: 1, ...overrides,
  };
}

function sdSet() {
  return {
    id: '0123456789ab', label: '', backend: 'sdcpp', family: 'qwen_image21', root: 'G:\\models',
    files: { diffusion: file('qwen-image-2.1-Q4_K_M.gguf', 12), text_encoder: file('enc.gguf', 5), vae: file('vae.safetensors', 0.3) },
    created_at: 1,
  };
}

function createHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="imageEngine"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  let state = engineState(options.state);
  const run = (name, payload, fallback) => { calls.push([name, payload]); return options[name] ? options[name](payload) : fallback; };
  const bridge = {
    async getState() { calls.push(['getState']); return state; },
    async chooseComfyFolder() { return run('chooseComfyFolder', undefined, { ok: true, health: health() }); },
    async checkComfyFolder() { return run('checkComfyFolder', undefined, { ok: true, health: health() }); },
    async saveComfySet(payload) { return run('saveComfySet', payload, { ok: true, set: comfySet() }); },
    onChanged() { return () => {}; },
  };
  dom.window.jennyShell = { imageEngine: bridge };
  const controller = createModelLibraryImageEngineController({ windowRef: dom.window, documentRef: dom.window.document, hostId: 'imageEngine' });
  t.after(() => controller.dispose());
  const document = dom.window.document;
  return {
    dom, controller, calls, document,
    setState(next) { state = engineState(next); },
    text() { return document.getElementById('imageEngine').textContent; },
    button(action) { return document.querySelector(`[data-image-engine-action="${action}"]`); },
    comfyStatus() { return document.querySelector('.model-library-image-engine-comfy-status'); },
    recipeRows() { return [...document.querySelectorAll('.model-library-image-engine-recipe')]; },
    click(action) {
      const node = this.button(action);
      assert.ok(node, `expected a "${action}" button`);
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    pick(slot, value) {
      const node = document.querySelector(`select[data-image-engine-slot$=":${slot}"]`);
      assert.ok(node, `expected a "${slot}" select`);
      node.value = value;
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
    async open() { controller.bind(); await flush(); },
  };
}

test('ComfyUI only: sd.cpp not installed still shows the ComfyUI block and the Model sets list', async (t) => {
  const h = createHarness(t);
  await h.open();
  const titles = [...h.document.querySelectorAll('.model-library-image-engine-subtitle')].map((node) => node.textContent);
  assert.deepEqual(titles, ['stable-diffusion.cpp', 'ComfyUI', 'Model sets']);
  assert.match(h.text(), /Not installed/);
  assert.match(h.text(), /No sets yet/);
  assert.equal(h.button('choose-folder'), null);
  assert.equal(h.button('choose-comfy-folder').textContent, 'Choose ComfyUI folder…');
});

test('kill switch off: no ComfyUI block, the Model sets list stays', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: false, health: null }, recipes: {}, model_sets: { sets: [sdSet()], default_id: '0123456789ab' } } });
  await h.open();
  assert.equal(h.comfyStatus(), null);
  assert.equal(h.button('choose-comfy-folder'), null);
  const titles = [...h.document.querySelectorAll('.model-library-image-engine-subtitle')].map((node) => node.textContent);
  assert.deepEqual(titles, ['stable-diffusion.cpp', 'Model sets']);
  assert.equal(h.document.querySelectorAll('.model-library-image-engine-set').length, 1);
});

test('no folder: Not set up, one secondary choose button and the explanation', async (t) => {
  const h = createHarness(t);
  await h.open();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'default');
  assert.match(h.comfyStatus().textContent, /Status\s*Not set up/);
  assert.match(h.button('choose-comfy-folder').className, /btn--sm/);
  assert.doesNotMatch(h.button('choose-comfy-folder').className, /btn--primary/);
  assert.equal(h.button('check-comfy-folder'), null);
  assert.match(h.text(), /Choose the ComfyUI_windows_portable folder you already use\. Jenny reads its models folder and never changes it\./);
  assert.equal(h.recipeRows().length, 0);
});

test('a pending check shows the pending tone with the checking line', async (t) => {
  let finish;
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health() } }, checkComfyFolder: () => new Promise((resolve) => { finish = resolve; }) });
  await h.open();
  h.click('check-comfy-folder');
  await flush();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'pending');
  assert.ok(h.comfyStatus().classList.contains('inv-status-row--with-spinner'));
  assert.match(h.comfyStatus().textContent, /Checking the folder…/);
  assert.equal(h.button('check-comfy-folder').disabled, true);
  finish({ ok: true, health: health() });
  await flush();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'success');
});

test('an invalid folder reads as danger with the path, Change folder and Check again', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({ ok: false, reason: 'comfyui_folder_invalid', version: '', folder: 'D:\\Downloads\\ComfyUI', recipes: {} }) } } });
  await h.open();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'danger');
  assert.match(h.comfyStatus().textContent, /Not a ComfyUI portable folder · python_embeded and ComfyUI\\main\.py were not found/);
  assert.equal(h.document.querySelector('.model-library-image-engine-folder .model-library-folders-path').textContent, 'D:\\Downloads\\ComfyUI');
  assert.equal(h.button('choose-comfy-folder').textContent, 'Change folder…');
  assert.match(h.button('check-comfy-folder').className, /btn--ghost/);
  assert.match(h.text(), /Pick the folder that holds run_nvidia_gpu\.bat\. Installs made with git are not supported yet\./);
  assert.equal(h.recipeRows().length, 0);
});

test('a network folder reuses the mapped-drive sentence', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({ ok: false, reason: 'root_not_local_path', version: '', folder: '\\\\server\\share\\ComfyUI', recipes: {} }) } } });
  await h.open();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'danger');
  assert.match(h.comfyStatus().textContent, /Map the share to a drive letter/);
  assert.doesNotMatch(h.comfyStatus().textContent, /python_embeded/);
});

test('a too-old ComfyUI warns, names the update step and offers no Add button', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({ version: '0.43.2' }, { version_ok: false }) } } });
  await h.open();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'warning');
  assert.match(h.comfyStatus().textContent, /ComfyUI 0\.43\.2 · MiniMax-H3-Image needs 0\.45\.0 or newer/);
  assert.match(h.recipeRows()[0].textContent, /Update ComfyUI first \(update\\update_comfyui\.bat\), then Check again\./);
  assert.equal(h.button('add-comfy-set'), null);
});

test('all files found: one click on Add set sends the matched names', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health() } } });
  await h.open();
  assert.equal(h.comfyStatus().getAttribute('data-status-tone'), 'success');
  assert.match(h.comfyStatus().textContent, /ComfyUI 0\.45\.0 · portable/);
  const row = h.recipeRows()[0];
  assert.match(row.querySelector('.model-library-image-engine-set-name').textContent, /^MiniMax-H3-Image$/);
  assert.equal(row.querySelector('.model-library-image-engine-set-meta').textContent, 'All 3 files found · 35.2 GB · 6 steps, fixed');
  assert.equal(h.button('add-comfy-set').textContent, 'Add set');
  assert.match(h.button('add-comfy-set').className, /btn--primary/);
  assert.equal(h.document.querySelector('select[data-image-engine-slot]'), null);
  assert.match(h.text(), /For each image Jenny starts this ComfyUI in the background without custom nodes, then closes it\. A ComfyUI window you have open is left alone\./);
  h.click('add-comfy-set');
  await flush();
  assert.deepEqual(h.calls.find(([m]) => m === 'saveComfySet')[1], { recipe: 'minimax_h3_image', diffusion: DIFFUSION, text_encoder: ENCODER_AWQ, vae: VAE });
});

test('two text encoders: only that slot shows a picker and Add set sends the chosen one', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({}, { slots: {
    diffusion: [file(DIFFUSION, 20)], text_encoder: [file(ENCODER_AWQ, 14.6), file(ENCODER_FP8, 31.2)], vae: [file(VAE, 0.6)],
  } }) } } });
  await h.open();
  assert.equal(h.document.querySelectorAll('select').length, 1);
  assert.match(h.recipeRows()[0].textContent, /2 text encoders match · pick one · 35\.2 GB/);
  const select = h.document.querySelector('select');
  assert.equal(select.value, ENCODER_AWQ);
  assert.match(select.closest('label').textContent, /Text encoder/);
  assert.deepEqual([...select.options].map((option) => option.textContent), [
    `${ENCODER_AWQ} · 14.6 GB`, `${ENCODER_FP8} · 31.2 GB`,
  ]);
  h.pick('text_encoder', ENCODER_FP8);
  assert.match(h.recipeRows()[0].textContent, /2 text encoders match · pick one · 51\.8 GB/);
  assert.equal(h.document.querySelector('select').value, ENCODER_FP8);
  h.click('add-comfy-set');
  await flush();
  assert.equal(h.calls.find(([m]) => m === 'saveComfySet')[1].text_encoder, ENCODER_FP8);
});

test('a missing file names the folder it goes in and Add set stays disabled', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({}, { slots: { diffusion: [file(DIFFUSION, 20)], text_encoder: [], vae: [file(VAE, 0.6)] } }) } } });
  await h.open();
  assert.match(h.recipeRows()[0].textContent, /Text encoder missing · add it to models\\text_encoders/);
  assert.equal(h.button('add-comfy-set').disabled, true);
  h.button('add-comfy-set').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(h.calls.some(([m]) => m === 'saveComfySet'), false);
});

test('an added recipe says so and has no button; a truncated listing says the folder is too big', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({}, { added: true, truncated: true }) } } });
  await h.open();
  assert.equal(h.recipeRows()[0].querySelector('.model-library-image-engine-set-meta').textContent, 'Added · 35.2 GB · 6 steps, fixed');
  assert.equal(h.button('add-comfy-set'), null);
  assert.match(h.text(), /The folder has more files than Jenny lists\./);
});

test('a failed save explains itself in the note line and a success asks main again', async (t) => {
  const reasons = ['recipe_file_mismatch', 'file_missing', 'too_many_sets', 'comfyui_folder_missing'];
  let next = 0;
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health() } }, saveComfySet: () => (next < reasons.length ? { ok: false, reason: reasons[next++] } : { ok: true, set: comfySet() }) });
  await h.open();
  const note = () => h.document.querySelector('.model-library-image-engine-note').textContent;
  h.click('add-comfy-set');
  await flush();
  assert.equal(note(), 'Those files changed since the check. Check again.');
  h.click('add-comfy-set');
  await flush();
  assert.equal(note(), 'Those files changed since the check. Check again.');
  h.click('add-comfy-set');
  await flush();
  assert.equal(note(), 'Remove a saved set first (16 at most).');
  h.click('add-comfy-set');
  await flush();
  assert.equal(note(), 'The model set could not be saved.');
  const reads = h.calls.filter(([m]) => m === 'getState').length;
  h.click('add-comfy-set');
  await flush();
  assert.equal(note(), 'Saved.');
  assert.equal(h.calls.filter(([m]) => m === 'getState').length, reads + 1);
});

test('choosing a folder: cancel is silent, a refused folder says why, success refreshes', async (t) => {
  const answers = [{ ok: false, reason: 'cancelled' }, { ok: false, reason: 'comfyui_folder_invalid' }, { ok: false, reason: 'image_engine_path_rejected' }, { ok: true, health: health() }];
  const h = createHarness(t, { chooseComfyFolder: () => answers.shift() });
  await h.open();
  const note = () => h.document.querySelector('.model-library-image-engine-note').textContent;
  h.click('choose-comfy-folder');
  await flush();
  assert.equal(note(), '');
  h.click('choose-comfy-folder');
  await flush();
  assert.match(note(), /not a ComfyUI portable folder/i);
  h.click('choose-comfy-folder');
  await flush();
  assert.match(note(), /Map the share to a drive letter/);
  const reads = h.calls.filter(([m]) => m === 'getState').length;
  h.click('choose-comfy-folder');
  await flush();
  assert.equal(note(), '');
  assert.equal(h.calls.filter(([m]) => m === 'getState').length, reads + 1);
});

test('Check again calls checkComfyFolder and then refreshes', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health() } } });
  await h.open();
  const reads = h.calls.filter(([m]) => m === 'getState').length;
  h.click('check-comfy-folder');
  await flush();
  assert.equal(h.calls.filter(([m]) => m === 'checkComfyFolder').length, 1);
  assert.equal(h.calls.filter(([m]) => m === 'getState').length, reads + 1);
});

test('sets list: the engine leads the meta line and a ComfyUI set is named by its recipe and quant', async (t) => {
  const h = createHarness(t, { state: {
    status: 'installed', comfyui: { enabled: true, health: health() },
    model_sets: { sets: [comfySet(), sdSet()], default_id: 'abcdef012345' },
  } });
  await h.open();
  const rows = [...h.document.querySelectorAll('.model-library-image-engine-set')];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector('.model-library-image-engine-set-name').textContent, 'MiniMax-H3-Image · INT8');
  assert.equal(rows[0].querySelector('.model-library-image-engine-set-meta').textContent, 'ComfyUI · 35.2 GB · Default');
  assert.equal(rows[1].querySelector('.model-library-image-engine-set-name').textContent, 'Qwen-Image 2.1 · Q4_K_M');
  assert.equal(rows[1].querySelector('.model-library-image-engine-set-meta').textContent, 'stable-diffusion.cpp · 17.3 GB');
});

test('a ComfyUI set of an unknown recipe falls back to the recipe id and a stored label wins', async (t) => {
  const h = createHarness(t, { state: {
    recipes: {}, model_sets: { sets: [comfySet({ recipe: 'future_recipe' }), comfySet({ id: 'fedcba543210', label: 'My draw set' })], default_id: null },
  } });
  await h.open();
  const names = [...h.document.querySelectorAll('.model-library-image-engine-set-name')].map((node) => node.textContent);
  assert.deepEqual(names, ['future_recipe · INT8', 'My draw set']);
});

test('focus returns to Check again and to the encoder select after a re-render', async (t) => {
  const h = createHarness(t, { state: { comfyui: { enabled: true, health: health({}, { slots: {
    diffusion: [file(DIFFUSION, 20)], text_encoder: [file(ENCODER_AWQ, 14.6), file(ENCODER_FP8, 31.2)], vae: [file(VAE, 0.6)],
  } }) } } });
  await h.open();
  h.button('check-comfy-folder').focus();
  h.click('check-comfy-folder');
  await flush();
  assert.equal(h.document.activeElement, h.button('check-comfy-folder'));
  h.document.querySelector('select').focus();
  h.pick('text_encoder', ENCODER_FP8);
  assert.equal(h.document.activeElement, h.document.querySelector('select'));
  assert.equal(h.document.activeElement.value, ENCODER_FP8);
});

test('an added recipe shows the saved set size, a vanished file asks for a check, and a failed check says so', async (t) => {
  const saved = comfySet({ files: { diffusion: file(DIFFUSION, 10), text_encoder: file(ENCODER_AWQ, 5), vae: file(VAE, 1) } });
  const h = createHarness(t, {
    state: { comfyui: { enabled: true, health: health({}, { added: true }) }, model_sets: { sets: [saved], default_id: saved.id } },
    checkComfyFolder: () => ({ ok: false, reason: 'store_corrupt' }),
  });
  await h.open();
  assert.match(h.recipeRows()[0].textContent, /Added · 16\.0 GB · 6 steps, fixed/);
  h.click('check-comfy-folder');
  await flush();
  assert.match(h.text(), /Could not read that folder\./);

  const g = createHarness(t, {
    state: { comfyui: { enabled: true, health: health() } },
    saveComfySet: () => ({ ok: false, reason: 'file_missing' }),
  });
  await g.open();
  g.click('add-comfy-set');
  await flush();
  assert.match(g.text(), /Those files changed since the check\. Check again\./);
});
