'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibraryImageEngineController,
  quantOf,
} = require('../renderer/shell/model-library/model-library-image-engine');

async function flush() {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

const FAMILIES = { qwen_image21: { label: 'Qwen-Image 2.1' }, qwen_image: { label: 'Qwen-Image' } };

function engineState(overrides = {}) {
  return {
    engine_tag: 'master-929-3f8527a',
    status: 'not_installed',
    source: null,
    install: null,
    last_error: null,
    custom_executable: null,
    download_size_bytes: 337915440,
    license: { name: 'MIT', url: '' },
    handoff: { active: false, retained: false, closing: false },
    model_sets: { sets: [], default_id: null },
    families: FAMILIES,
    ...overrides,
  };
}

function scanResult() {
  return {
    ok: true,
    root: 'G:\\models\\image\\qwen',
    truncated: false,
    candidates: {
      diffusion: [
        { name: 'qwen-image-2.1-Q4_K_M.gguf', size_bytes: 12 * 1073741824, slot: 'diffusion', family_guess: 'qwen_image21', format: 'gguf' },
        { name: 'qwen-image-2.1-Q8_0.gguf', size_bytes: 21 * 1073741824, slot: 'diffusion', family_guess: 'qwen_image21', format: 'gguf' },
      ],
      text_encoder: [{ name: 'encoders/Qwen3VL-8B-Q4_K_M.gguf', size_bytes: 5 * 1073741824, slot: 'text_encoder', family_guess: null, format: 'gguf' }],
      vae: [{ name: 'vae/qwen-image-2.1-vae.safetensors', size_bytes: 300000000, slot: 'vae', family_guess: null, format: 'safetensors' }],
    },
  };
}

function savedSet(id, quant, isDefault) {
  return {
    id, label: '', family: 'qwen_image21', root: 'G:\\models\\image\\qwen',
    files: {
      diffusion: { name: `qwen-image-2.1-${quant}.gguf`, size_bytes: 12 * 1073741824 },
      text_encoder: { name: 'encoders/Qwen3VL-8B-Q4_K_M.gguf', size_bytes: 5 * 1073741824 },
      vae: { name: 'vae/qwen-image-2.1-vae.safetensors', size_bytes: 300000000 },
    },
    created_at: 1,
    _default: isDefault,
  };
}

function createHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="imageEngine"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  let state = engineState(options.state);
  let listener = null;
  const bridge = {
    async getState() { calls.push(['getState']); return state; },
    async install(payload) { calls.push(['install', payload]); return options.install ? options.install() : { ok: true }; },
    async cancelInstall() { calls.push(['cancelInstall']); return { ok: true }; },
    async remove(payload) { calls.push(['remove', payload]); return { ok: true }; },
    async chooseRuntime() { calls.push(['chooseRuntime']); return options.chooseRuntime ? options.chooseRuntime() : { ok: true }; },
    async clearRuntime() { calls.push(['clearRuntime']); return { ok: true }; },
    async chooseModelFolder() { calls.push(['chooseModelFolder']); return options.chooseModelFolder ? options.chooseModelFolder() : scanResult(); },
    async scanModels(payload) { calls.push(['scanModels', payload]); return scanResult(); },
    async saveModelSet(payload) { calls.push(['saveModelSet', payload]); return options.saveModelSet ? options.saveModelSet(payload) : { ok: true }; },
    async removeModelSet(payload) { calls.push(['removeModelSet', payload]); return { ok: true }; },
    async setDefaultModelSet(payload) { calls.push(['setDefaultModelSet', payload]); return { ok: true }; },
    async reconcile() { calls.push(['reconcile']); return { ok: true }; },
    onChanged(handler) { listener = handler; return () => { listener = null; }; },
  };
  dom.window.jennyShell = { imageEngine: bridge };
  let enabled = options.enabled !== false;
  const controller = createModelLibraryImageEngineController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    hostId: 'imageEngine',
    isEnabled: () => enabled,
  });
  t.after(() => controller.dispose());
  return {
    dom, controller, calls,
    document: dom.window.document,
    setState(next) { state = engineState(next); },
    emit(next) { if (listener) listener(next); },
    hasListener() { return typeof listener === 'function'; },
    setEnabled(value) { enabled = value; },
    text() { return dom.window.document.getElementById('imageEngine').textContent; },
    button(action) { return dom.window.document.querySelector(`[data-image-engine-action="${action}"]`); },
    click(action) {
      const node = this.button(action);
      assert.ok(node, `expected a "${action}" button`);
      node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    select(slot, value) {
      const node = dom.window.document.querySelector(`select[data-image-engine-slot="${slot}"]`);
      assert.ok(node, `expected a "${slot}" select`);
      node.value = value;
      node.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    },
  };
}

test('not installed: install button carries the download size and no model controls show', async (t) => {
  const h = createHarness(t);
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Image engine/);
  assert.match(h.text(), /Status/);
  assert.match(h.text(), /Not installed/);
  assert.equal(h.button('install').textContent, 'Install engine… (322 MB)');
  assert.ok(h.button('choose-runtime'));
  assert.equal(h.button('choose-folder'), null);
  assert.match(h.text(), /Downloads from github\.com/);
  assert.doesNotMatch(h.text(), /huggingface/i);
});

test('install sends the opt-in payload only and a failure reason becomes a plain sentence', async (t) => {
  const h = createHarness(t, { install: () => ({ ok: false, reason: 'hash_mismatch' }) });
  h.controller.bind();
  await flush();
  h.click('install');
  await flush();
  assert.deepEqual(h.calls.filter(([m]) => m === 'install'), [['install', { confirmed: true }]]);
  assert.match(h.text(), /did not match the expected fingerprint/);
});

test('installing: progress row, cancel button and no remove', async (t) => {
  const h = createHarness(t, { state: { status: 'installing', install: { phase: 'downloading', downloaded_bytes: 118 * 1048576, total_bytes: 322 * 1048576, asset_index: 0, asset_count: 1 } } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Downloading · 118 of 322 MB/);
  assert.ok(h.document.querySelector('.inv-status-row--with-progress'));
  assert.ok(h.button('cancel-install'));
  assert.equal(h.button('remove'), null);
  h.click('cancel-install');
  await flush();
  assert.ok(h.calls.some(([m]) => m === 'cancelInstall'));
});

test('installed: remove asks once inline, keep it backs out, confirm sends the opt-in payload', async (t) => {
  const h = createHarness(t, { state: { status: 'installed', source: 'managed' } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Installed · master-929-3f8527a/);
  h.click('remove');
  assert.match(h.text(), /Remove the image engine\? Saved model sets stay\./);
  h.click('keep');
  assert.equal(h.button('confirm-remove'), null);
  assert.equal(h.calls.filter(([m]) => m === 'remove').length, 0);
  h.click('remove');
  h.click('confirm-remove');
  await flush();
  assert.deepEqual(h.calls.filter(([m]) => m === 'remove'), [['remove', { confirmed: true }]]);
});

test('choose folder fills the three slots, detects the family from the diffusion file, and save sends the picks', async (t) => {
  const h = createHarness(t, { state: { status: 'installed', source: 'managed' } });
  h.controller.bind();
  await flush();
  h.click('choose-folder');
  await flush();
  assert.match(h.text(), /G:\\models\\image\\qwen/);
  const selects = [...h.document.querySelectorAll('select')];
  assert.equal(selects.length, 4);
  assert.equal(h.document.querySelector('select[data-image-engine-slot="diffusion"]').value, 'qwen-image-2.1-Q4_K_M.gguf');
  assert.match(h.text(), /Qwen-Image 2\.1 \(read from the model file\)/);
  assert.equal(h.document.getElementById('imageEngineSlot-family').disabled, true);
  h.select('diffusion', 'qwen-image-2.1-Q8_0.gguf');
  h.click('save-set');
  await flush();
  const save = h.calls.find(([m]) => m === 'saveModelSet');
  assert.deepEqual(save[1], {
    root: 'G:\\models\\image\\qwen',
    diffusion: 'qwen-image-2.1-Q8_0.gguf',
    text_encoder: 'encoders/Qwen3VL-8B-Q4_K_M.gguf',
    vae: 'vae/qwen-image-2.1-vae.safetensors',
    family: 'qwen_image21',
    label: '',
  });
  assert.match(h.text(), /Saved\./);
});

test('a network folder pick is refused with the mapped-drive sentence and a save failure is explained', async (t) => {
  const h = createHarness(t, {
    state: { status: 'custom', source: 'custom', custom_executable: 'G:\\tools\\sd-cli.exe' },
    chooseModelFolder: () => ({ ok: false, reason: 'image_engine_path_rejected' }),
    saveModelSet: () => ({ ok: false, reason: 'image_text_encoder_unsupported' }),
  });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Using your own sd-cli\.exe · G:\\tools\\sd-cli\.exe/);
  assert.ok(h.button('clear-runtime'));
  h.click('choose-folder');
  await flush();
  assert.match(h.text(), /Map the share to a drive letter/);
  assert.equal(h.document.querySelector('select'), null);
  assert.equal(h.button('rescan'), null);
});

test('saved sets list with a Default chip, make default and remove send the id', async (t) => {
  const h = createHarness(t, { state: {
    status: 'installed', source: 'managed',
    model_sets: { sets: [savedSet('0123456789ab', 'Q4_K_M'), savedSet('abcdef012345', 'Q8_0')], default_id: '0123456789ab' },
  } });
  h.controller.bind();
  await flush();
  const rows = [...h.document.querySelectorAll('.model-library-image-engine-set')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Qwen-Image 2\.1 · Q4_K_M/);
  assert.match(rows[0].textContent, /Default/);
  assert.equal(rows[0].querySelector('[data-image-engine-action="make-default"]'), null);
  assert.ok(rows[1].querySelector('[data-image-engine-action="make-default"]'));
  rows[1].querySelector('[data-image-engine-action="make-default"]').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.deepEqual(h.calls.find(([m]) => m === 'setDefaultModelSet')[1], { id: 'abcdef012345' });
  // Every action re-renders the section, so the earlier row handles are detached.
  const rowsAfter = [...h.document.querySelectorAll('.model-library-image-engine-set')];
  rowsAfter[0].querySelector('[data-image-engine-action="remove-set"]').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.deepEqual(h.calls.find(([m]) => m === 'removeModelSet')[1], { id: '0123456789ab' });
});

test('a retained lease shows Clean up now instead of the engine actions and calls reconcile', async (t) => {
  const h = createHarness(t, { state: { status: 'installed', source: 'managed', handoff: { active: false, retained: true, closing: false } } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /did not finish cleanly/);
  assert.ok(h.button('reconcile'));
  assert.equal(h.button('remove'), null);
  h.click('reconcile');
  await flush();
  assert.ok(h.calls.some(([m]) => m === 'reconcile'));
});

test('a failed install reads as not installed with the reason and offers Retry', async (t) => {
  const h = createHarness(t, { state: { status: 'error', last_error: 'download_failed' } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Not installed · github\.com could not be reached/);
  assert.equal(h.button('install').textContent, 'Retry');
});

// F24: the user's own Cancel is not a failure.
test('a cancelled install reads as cancelled and offers the install button again', async (t) => {
  const h = createHarness(t, { state: { status: 'error', last_error: 'cancelled' } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Install cancelled\./);
  assert.doesNotMatch(h.text(), /could not be installed/);
  assert.equal(h.button('install').textContent, 'Install engine… (322 MB)');
  assert.ok(h.button('choose-runtime'));
});

test('change events re-render from main and the kill switch empties the host; dispose unsubscribes', async (t) => {
  const h = createHarness(t);
  h.controller.bind();
  await flush();
  assert.equal(h.hasListener(), true);
  h.setState({ status: 'installed', source: 'managed' });
  h.emit({ status: 'installed', source: 'managed', engine_tag: 'master-929-3f8527a' });
  await flush();
  assert.match(h.text(), /Installed · master-929-3f8527a/);
  h.setEnabled(false);
  h.controller.render();
  assert.equal(h.text(), '');
  h.controller.dispose();
  assert.equal(h.hasListener(), false);
});

test('keyboard focus returns to the control that ran the action, including per-set buttons and slot selects', async (t) => {
  const h = createHarness(t, { state: {
    status: 'installed', source: 'managed',
    model_sets: { sets: [savedSet('0123456789ab', 'Q4_K_M'), savedSet('abcdef012345', 'Q8_0')], default_id: '0123456789ab' },
  } });
  h.controller.bind();
  await flush();
  h.button('choose-folder').focus();
  h.click('choose-folder');
  await flush();
  assert.equal(h.document.activeElement, h.button('choose-folder'));
  const secondDefault = h.document.querySelector('[data-image-engine-action="make-default"][data-image-engine-set="abcdef012345"]');
  secondDefault.focus();
  secondDefault.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(h.document.activeElement.getAttribute('data-image-engine-action'), 'make-default');
  const select = h.document.querySelector('select[data-image-engine-slot="diffusion"]');
  select.focus();
  h.select('diffusion', 'qwen-image-2.1-Q8_0.gguf');
  assert.equal(h.document.activeElement, h.document.querySelector('select[data-image-engine-slot="diffusion"]'));
});

test('a refused state read still re-enables the controls, and a rebind paints from the cached state', async (t) => {
  const h = createHarness(t);
  let refuse = false;
  const original = h.dom.window.jennyShell.imageEngine.getState;
  h.dom.window.jennyShell.imageEngine.getState = async () => { h.calls.push(['getState']); return refuse ? { ok: false, reason: 'image_engine_unavailable' } : original(); };
  h.controller.bind();
  await flush();
  refuse = true;
  h.click('choose-runtime');
  await flush();
  assert.equal(h.button('choose-runtime').disabled, false, 'the pending state cleared without a fresh state');
  assert.match(h.text(), /Not installed/);
  const reads = h.calls.filter(([m]) => m === 'getState').length;
  // A parent re-render replaces the host element.
  const old = h.document.getElementById('imageEngine');
  const fresh = h.document.createElement('div');
  fresh.id = 'imageEngine';
  old.replaceWith(fresh);
  h.controller.bind();
  assert.match(h.text(), /Install engine…/);
  await flush();
  assert.equal(h.calls.filter(([m]) => m === 'getState').length, reads, 'no bridge round trip for a cached rebind');
});

test('a second action while one is pending is ignored', async (t) => {
  let release;
  const h = createHarness(t, { chooseRuntime: () => new Promise((resolve) => { release = resolve; }) });
  h.controller.bind();
  await flush();
  h.click('choose-runtime');
  await flush();
  assert.equal(h.button('install').disabled, true);
  h.button('install').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.equal(h.calls.filter(([m]) => m === 'install').length, 0);
  release({ ok: true });
  await flush();
  assert.equal(h.button('install').disabled, false);
});

test('an install started here stays cancellable while it runs', async (t) => {
  let finish;
  const h = createHarness(t, { install: () => new Promise((resolve) => { finish = resolve; }) });
  h.controller.bind();
  await flush();
  h.click('install');
  await flush();
  const installing = { status: 'installing', install: { phase: 'downloading', downloaded_bytes: 1048576, total_bytes: 322 * 1048576, asset_index: 0, asset_count: 1 } };
  h.setState(installing);
  h.emit(installing);
  await flush();
  assert.equal(h.button('cancel-install').disabled, false);
  h.click('cancel-install');
  await flush();
  assert.equal(h.calls.filter(([m]) => m === 'cancelInstall').length, 1);
  finish({ ok: false, reason: 'cancelled' });
  await flush();
});

test('quantOf reads the quant token from a file name', () => {
  assert.equal(quantOf('qwen-image-2.1-Q4_K_M.gguf'), 'Q4_K_M');
  assert.equal(quantOf('model-bf16.safetensors'), 'BF16');
  assert.equal(quantOf('plain.safetensors'), '');
});
