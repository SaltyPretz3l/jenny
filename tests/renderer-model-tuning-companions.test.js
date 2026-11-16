'use strict';

// new-test-file: a new lazy module (the Tune drawer's Drafter file and Vision rows); the drawer's engine tests are at their line cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');
const companions = require('../renderer/shell/renderer-model-tuning-companions');
const actionButton = require('../renderer/inventory/action-button');
const progressBar = require('../renderer/inventory/progress-bar');
const segmentedControl = require('../renderer/inventory/segmented-control');
const toggleSwitch = require('../renderer/inventory/toggle-switch');

const DRAFTER_BYTES = 1369590656;
const status = (overrides) => ({
  state: 'available', reason: '', fileName: 'mtp-Qwen3.8-27B-Q4_0.gguf', bytes: DRAFTER_BYTES, vramMb: 3072,
  gainOverBuiltInPct: null, vramOverBuiltInMb: null, fineTune: false, baseName: '', neededBytes: 0, freeBytes: 0, drive: '',
  ...overrides,
});
const projector = (overrides) => status({ fileName: 'mmproj-Qwen3.8-27B-F16.gguf', bytes: 900000000, vramMb: 922, ...overrides });
const drafterView = (overrides, opts) => companions.companionView('drafter', status(overrides), opts || { serving: false });
const visionView = (overrides, opts) => companions.companionView('vision', projector(overrides), opts || { serving: false });

test('an available drafter offers Get drafter with its size and VRAM cost', () => {
  const view = drafterView({});
  assert.equal(view.hidden, false);
  assert.equal(view.note, '1.4 GB download, checked before use. Uses about 3 GB more VRAM while MTP is on.');
  assert.deepEqual(view.action, { id: 'get', label: 'Get drafter', disabled: false });
  assert.equal(view.tone, '');
  assert.match(view.valueHtml, />None beside this model</);
});

test('an embedded-head model with no drafter file does not say the drafter is missing (F2)', () => {
  const view = {
    eligible: true, servingEmbeddedHead: false, headroomMb: 3072,
    ggufEntry: { dir: 'G:\\m', mainGguf: 'm.gguf', drafterGguf: '', source: '', embeddedMtpLayers: 1 },
  };
  assert.equal(engineUtils.engineNote(view), 'Uses the MTP head built into this model');
  view.ggufEntry.embeddedMtpLayers = null;
  assert.equal(engineUtils.engineNote(view), 'No drafter file yet. MTP falls back to plain decoding');
  view.ggufEntry.source = 'ollama';
  view.ggufEntry.embeddedMtpLayers = 1;
  assert.match(engineUtils.engineNote(view), /^MTP drafter not found beside Ollama's copy/);
});

test('drafter states: installed, serving, built-in head, downloading, failed', () => {
  const installed = drafterView({ state: 'installed' });
  assert.match(installed.valueHtml, /<code class="model-tuning-gguf-path"[^>]*>mtp-Qwen3.8-27B-Q4_0.gguf<\/code>/);
  assert.equal(installed.note, '');
  assert.equal(installed.action, null);

  const serving = drafterView({ state: 'installed' }, { serving: true });
  assert.equal(serving.note, 'Installed. Takes effect the next time the model starts.');
  assert.deepEqual(serving.action, { id: 'restart', label: 'Restart now', disabled: false });

  const downloading = drafterView({ state: 'downloading' }, { serving: false, download: { kind: 'drafter', receivedBytes: 610e6, totalBytes: DRAFTER_BYTES } });
  assert.equal(downloading.note, 'Checked before use. Cancel keeps what is done, so the next try resumes.');
  assert.deepEqual(downloading.action, { id: 'cancel', label: 'Cancel', disabled: false });
  assert.deepEqual(downloading.progress, { receivedBytes: 610e6, totalBytes: DRAFTER_BYTES });

  const checksum = drafterView({ state: 'failed', reason: 'sha256_mismatch' });
  assert.equal(checksum.note, 'The download didn\'t match its checksum and was deleted.');
  assert.equal(checksum.tone, 'warn');
  assert.deepEqual(checksum.action, { id: 'retry', label: 'Try again', disabled: false });
  const stopped = drafterView({ state: 'failed', reason: 'timeout' });
  assert.equal(stopped.note, 'The download stopped. Try again to resume it.');
  assert.equal(stopped.tone, 'warn');
  assert.equal(stopped.action.id, 'retry');
});

test('a built-in head offers a drafter only when it measured at least 10% faster', () => {
  const offer = drafterView({ state: 'embedded', gainOverBuiltInPct: 10.8, vramOverBuiltInMb: 819 });
  assert.match(offer.valueHtml, />Using the head built into the model</);
  assert.equal(offer.note, 'MTP already works. A separate drafter is about 11% faster on this model: 1.4 GB download, about 0.8 GB more VRAM.');
  assert.deepEqual(offer.action, { id: 'get', label: 'Get drafter', disabled: false });
  assert.equal(offer.tone, '');

  const none = drafterView({ state: 'embedded', gainOverBuiltInPct: null });
  assert.equal(none.note, 'This model carries its own MTP head, so no separate file is needed.');
  assert.equal(none.tone, 'muted');
  assert.equal(none.action, null);
  assert.equal(drafterView({ state: 'embedded', gainOverBuiltInPct: null }).action, null, 'the service sends no gain below 10%');
});

test('a fine-tune offer names its base model', () => {
  const view = drafterView({ fineTune: true, baseName: 'Qwen3.8-27B' });
  assert.equal(view.note, '1.4 GB download, checked before use. Uses about 3 GB more VRAM while MTP is on. Made for Qwen3.8-27B.');
  const embedded = drafterView({ state: 'embedded', gainOverBuiltInPct: 12, vramOverBuiltInMb: 819, fineTune: true, baseName: 'Qwen3.8-27B' });
  assert.match(embedded.note, / Made for Qwen3\.8-27B\.$/);
  assert.doesNotMatch(drafterView({ fineTune: false, baseName: 'Qwen3.8-27B' }).note, /Made for/);
});

test('every unavailable reason greys the button out with its reason', () => {
  const cases = [
    ['local_only', 'Local only is on, so Jenny downloads nothing.'],
    ['ollama_copy', 'This is Ollama\'s copy. Move the model into a GGUF folder to add files beside it.'],
    ['not_in_catalog', 'Jenny doesn\'t know a drafter for this model yet. You can still put an mtp-*.gguf beside it.'],
    ['not_paired', 'Jenny wouldn\'t use this file beside the other models in this folder. Move the model into a folder of its own.'],
    ['name_taken', 'Another file already has this name beside the model. Jenny never replaces it.'],
    ['folder_rejected', 'Jenny can\'t write to this model\'s folder.'],
    ['hf_gated', 'This file needs a Hugging Face sign-in.'],
    ['busy', 'Another file is downloading. This one can start when it finishes.'],
  ];
  for (const [reason, note] of cases) {
    const view = drafterView({ state: 'unavailable', reason });
    assert.equal(view.note, note, reason);
    assert.equal(view.tone, 'muted', reason);
    assert.deepEqual(view.action, { id: 'get', label: 'Get drafter', disabled: true }, reason);
    assert.match(view.valueHtml, />None beside this model</, reason);
  }
  const space = drafterView({ state: 'unavailable', reason: 'insufficient_space', neededBytes: 1369590656, freeBytes: 600000000, drive: 'C:' });
  assert.equal(space.note, 'Needs 1.4 GB free on C:. 0.6 GB is free.');
  assert.equal(space.action.disabled, true);
});

test('vision states: installed, available, downloading, failed, unavailable', () => {
  const installed = visionView({ state: 'installed' });
  assert.match(installed.valueHtml, />mmproj-Qwen3.8-27B-F16.gguf</);
  assert.equal(installed.note, 'Images you attach are read by this model.');
  assert.equal(installed.action, null);
  assert.equal(visionView({ state: 'installed' }, { serving: true }).action.label, 'Restart now');

  const offer = visionView({ fineTune: true, baseName: 'Gemma 4' });
  assert.match(offer.valueHtml, />Off · no vision file beside this model</);
  assert.equal(offer.note, '0.9 GB download, checked before use. Uses about 0.9 GB more VRAM. Made for Gemma 4.');
  assert.deepEqual(offer.action, { id: 'get', label: 'Get vision', disabled: false });

  const downloading = visionView({ state: 'downloading' }, { serving: false, download: { kind: 'projector', receivedBytes: 420e6, totalBytes: 900e6 } });
  assert.deepEqual(downloading.action, { id: 'cancel', label: 'Cancel', disabled: false });
  assert.deepEqual(downloading.progress, { receivedBytes: 420e6, totalBytes: 900e6 });

  const failed = visionView({ state: 'failed', reason: 'sha256_mismatch' });
  assert.equal(failed.tone, 'warn');
  assert.equal(failed.action.label, 'Try again');

  const unlisted = visionView({ state: 'unavailable', reason: 'not_in_catalog' });
  assert.equal(unlisted.note, 'Jenny doesn\'t know a vision file for this model yet.');
  assert.deepEqual(unlisted.action, { id: 'get', label: 'Get vision', disabled: true });
  const space = visionView({ state: 'unavailable', reason: 'insufficient_space', neededBytes: 900000000, freeBytes: 600000000, drive: 'C:' });
  assert.equal(space.note, 'Needs 0.9 GB free on C:. 0.6 GB is free.');
});

test('a null status hides its row', () => {
  assert.equal(companions.companionView('drafter', null, {}).hidden, true);
  assert.equal(companions.companionView('vision', undefined, {}).hidden, true);
});

test('the control column carries the buttons, the bar and its bytes', () => {
  const deps = { actionButton, progressBar, escapeHtml: actionButton.escapeHtml };
  const dom = new JSDOM('<!doctype html><body></body>');
  const parse = (html) => { dom.window.document.body.innerHTML = html; return dom.window.document.body; };

  const get = parse(companions.rowControlHtml(drafterView({}), deps));
  const button = get.querySelector('.model-tuning-companion .model-tuning-row-actions button');
  assert.equal(button.textContent, 'Get drafter');
  assert.equal(button.dataset.modelTuningCompanionAction, 'get');
  assert.equal(button.dataset.modelTuningCompanionKind, 'drafter');
  assert.equal(button.classList.contains('btn--sm'), true);
  assert.equal(button.classList.contains('btn--ghost'), false);
  assert.equal(button.disabled, false);
  assert.equal(get.querySelector('.inv-progress'), null);

  const downloading = parse(companions.rowControlHtml(
    drafterView({ state: 'downloading' }, { serving: false, download: { kind: 'drafter', receivedBytes: 610e6, totalBytes: DRAFTER_BYTES } }), deps));
  assert.equal(downloading.querySelector('.inv-progress').getAttribute('aria-label'), 'Downloading the drafter file');
  assert.equal(downloading.querySelector('.inv-progress').classList.contains('inv-progress--warning'), false);
  assert.equal(downloading.querySelector('.model-tuning-companion-bytes').textContent, '610 MB of 1.4 GB');
  const cancel = downloading.querySelector('button');
  assert.equal(cancel.textContent, 'Cancel');
  assert.equal(cancel.classList.contains('btn--ghost'), true);

  const vision = parse(companions.rowControlHtml(
    visionView({ state: 'downloading' }, { serving: false, download: { kind: 'projector', receivedBytes: 420e6, totalBytes: 900e6 } }), deps));
  assert.equal(vision.querySelector('.inv-progress').getAttribute('aria-label'), 'Downloading the vision file');
  assert.equal(vision.querySelector('.model-tuning-companion-bytes').textContent, '420 MB of 0.9 GB');

  const disabled = parse(companions.rowControlHtml(drafterView({ state: 'unavailable', reason: 'local_only' }), deps));
  assert.equal(disabled.querySelector('button').disabled, true);
});

// ---- the controller over a real Engine section ----

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(fn, ms) { const id = nextId++; pending.set(id, { fn, ms }); return id; },
    clearTimeoutImpl(id) { pending.delete(id); },
    get count() { return pending.size; },
    get delays() { return [...pending.values()].map((entry) => entry.ms); },
    async fire() {
      const [id, entry] = [...pending.entries()][0] || [];
      if (!entry) return false;
      pending.delete(id);
      await entry.fn();
      return true;
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function engineHtml(engine) {
  return engineUtils.buildEngineSectionHtml({
    view: { eligible: true, effectiveModelPath: 'G:\\models\\qwen\\Qwen3.8-27B.gguf', ggufEntry: null, headroomMb: 3072, ollamaAvailable: false, ollamaFromScan: false },
    draft: { engine, mtp: false, modelPath: '', runtimePath: '', runtimeBuild: 0 },
    pending: false, statusText: '', escapeHtml: actionButton.escapeHtml,
    segmentedControl: segmentedControl.segmentedControl || segmentedControl,
    toggleSwitch: toggleSwitch.toggleSwitch || toggleSwitch,
    actionButton,
  });
}

function createHost(engine = 'llama-server') {
  const dom = new JSDOM('<!doctype html><body><div id="modelTuningDrawer"><div class="model-tuning-drawer-grid"></div>'
    + '<p class="model-tuning-drawer-status" aria-live="polite"></p></div></body>', { url: 'http://localhost/' });
  const host = dom.window.document.getElementById('modelTuningDrawer');
  host.querySelector('.model-tuning-drawer-grid').innerHTML = engineHtml(engine);
  return { dom, host, document: dom.window.document };
}

function createBridge(initial) {
  const calls = [];
  const bridge = {
    calls,
    reply: initial,
    async companionStatus(args) { calls.push(['status', args]); return bridge.reply; },
    async installCompanion(args) { calls.push(['install', args]); return bridge.installResult || { ok: true }; },
    async cancelCompanion() { calls.push(['cancel']); return { ok: true }; },
  };
  return bridge;
}

const OPTS = { tag: 'qwen3.8:27b', modelPath: 'G:\\models\\qwen\\Qwen3.8-27B.gguf', serving: false };
const row = (host, key) => host.querySelector('[data-model-tuning-row="' + key + '"]');
const noteOf = (host, key) => row(host, key).querySelector('[data-model-tuning-note]');
const clickAction = (host, key, id) => row(host, key).querySelector('[data-model-tuning-companion-action="' + id + '"]').click();

test('the Engine section renders both rows hidden and empty, in place', () => {
  const { host } = createHost();
  const keys = [...host.querySelectorAll('[data-model-tuning-row]')].map((el) => el.dataset.modelTuningRow);
  assert.deepEqual(keys, ['engine', 'mtp', 'drafter', 'modelPath', 'vision']);
  for (const key of ['drafter', 'vision']) {
    assert.equal(row(host, key).hidden, true);
    assert.equal(row(host, key).classList.contains('model-tuning-row--wide'), true);
    assert.equal(noteOf(host, key).textContent, '');
  }
  assert.equal(row(host, 'drafter').querySelector('.model-tuning-row-label').textContent, 'Drafter file');
  assert.equal(row(host, 'vision').querySelector('.model-tuning-row-label').textContent, 'Vision');
});

test('mount patches each row, unhides it, and keeps a null kind hidden', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: null, download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  assert.deepEqual(bridge.calls[0], ['status', { tag: OPTS.tag, modelPath: OPTS.modelPath }]);
  assert.equal(row(host, 'drafter').hidden, false);
  assert.equal(noteOf(host, 'drafter').textContent, '1.4 GB download, checked before use. Uses about 3 GB more VRAM while MTP is on.');
  assert.equal(noteOf(host, 'drafter').hasAttribute('data-tone'), false);
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action="get"]').textContent, 'Get drafter');
  assert.equal(row(host, 'vision').hidden, true);
});

test('a warn or muted tone lands on the note', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'unavailable', reason: 'local_only' }), projector: projector({ state: 'failed', reason: 'sha256_mismatch' }), download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  assert.equal(noteOf(host, 'drafter').dataset.tone, 'muted');
  assert.equal(noteOf(host, 'vision').dataset.tone, 'warn');
  assert.equal(row(host, 'drafter').querySelector('button').disabled, true);
});

test('a missing bridge or a failed status leaves both rows hidden', async () => {
  const none = createHost();
  assert.equal(companions.mount(none.host, { ...OPTS, bridge: {}, ...createFakeTimers() }), null);
  const rejecting = createHost();
  companions.mount(rejecting.host, { ...OPTS, bridge: { async companionStatus() { throw new Error('boom'); } }, ...createFakeTimers() });
  const failing = createHost();
  companions.mount(failing.host, { ...OPTS, bridge: { async companionStatus() { return { ok: false, reason: 'ipc_failed' }; } }, ...createFakeTimers() });
  await settle();
  for (const { host } of [none, rejecting, failing]) {
    assert.equal(row(host, 'drafter').hidden, true);
    assert.equal(row(host, 'vision').hidden, true);
  }
  const bare = new JSDOM('<!doctype html><body><div id="h"></div></body>').window.document.getElementById('h');
  assert.equal(companions.mount(bare, { ...OPTS, bridge: createBridge({ ok: true }) }), null);
});

test('rows stay hidden while the engine is not llama-server and follow its switch', async () => {
  const { host, dom } = createHost('ollama');
  assert.equal(row(host, 'mtp').hidden, true);
  const bridge = createBridge({ ok: true, drafter: status({}), projector: projector({}), download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  assert.equal(row(host, 'drafter').hidden, true);
  host.dispatchEvent(new dom.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'modelTuningEngine', value: 'llama-server' } }));
  assert.equal(row(host, 'drafter').hidden, false);
  assert.equal(row(host, 'vision').hidden, false);
  host.dispatchEvent(new dom.window.CustomEvent('inv-segmented-change', { bubbles: true, detail: { id: 'modelTuningEngine', value: 'ollama' } }));
  assert.equal(row(host, 'drafter').hidden, true);
});

test('Get installs by kind, starts the poll, and the poll stops once nothing downloads', async () => {
  const { host } = createHost();
  const timers = createFakeTimers();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: projector({}), download: null });
  companions.mount(host, { ...OPTS, bridge, ...timers });
  await settle();
  assert.equal(timers.count, 0, 'nothing downloads, nothing polls');

  bridge.reply = { ok: true, drafter: status({ state: 'downloading' }), projector: projector({}), download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 610e6, totalBytes: DRAFTER_BYTES } };
  clickAction(host, 'drafter', 'get');
  await settle();
  assert.deepEqual(bridge.calls.find((call) => call[0] === 'install'), ['install', { tag: OPTS.tag, modelPath: OPTS.modelPath, kind: 'drafter' }]);
  assert.equal(row(host, 'drafter').querySelector('.model-tuning-companion-bytes').textContent, '610 MB of 1.4 GB');
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action="cancel"]').textContent, 'Cancel');
  assert.deepEqual(timers.delays, [1000]);

  const cancelButton = row(host, 'drafter').querySelector('[data-model-tuning-companion-action="cancel"]');
  bridge.reply = { ok: true, drafter: status({ state: 'downloading' }), projector: projector({}), download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 900e6, totalBytes: DRAFTER_BYTES } };
  await timers.fire();
  assert.equal(row(host, 'drafter').querySelector('.model-tuning-companion-bytes').textContent, '900 MB of 1.4 GB');
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action="cancel"]'), cancelButton, 'the button is not replaced on a tick');
  assert.equal(row(host, 'drafter').querySelector('.inv-progress').getAttribute('aria-valuenow'), String(900e6));
  assert.equal(timers.count, 1);

  bridge.reply = { ok: true, drafter: status({ state: 'installed' }), projector: projector({}), download: null };
  await timers.fire();
  assert.equal(timers.count, 0, 'the poll stops when the download is done');
  assert.match(row(host, 'drafter').querySelector('.model-tuning-companion').textContent, /mtp-Qwen3\.8-27B-Q4_0\.gguf/);
});

test('a download whose status keeps failing hides its rows and stops polling', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'downloading' }), projector: null, download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 1, totalBytes: DRAFTER_BYTES } });
  const timers = createFakeTimers();
  companions.mount(host, { ...OPTS, bridge, ...timers });
  await settle();
  bridge.reply = { ok: false, reason: 'unknown_model' };
  await timers.fire();
  await timers.fire();
  assert.equal(row(host, 'drafter').hidden, false, 'two misses keep the last status');
  await timers.fire();
  assert.equal(row(host, 'drafter').hidden, true);
  assert.equal(timers.count, 0, 'and the poll ends');
});

test('Get on vision asks for the projector kind', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: null, projector: projector({}), download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  clickAction(host, 'vision', 'get');
  await settle();
  assert.deepEqual(bridge.calls.find((call) => call[0] === 'install')[1].kind, 'projector');
});

test('Cancel asks the bridge to cancel, then refreshes', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'downloading' }), projector: null, download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 1, totalBytes: DRAFTER_BYTES } });
  const timers = createFakeTimers();
  companions.mount(host, { ...OPTS, bridge, ...timers });
  await settle();
  bridge.reply = { ok: true, drafter: status({}), projector: null, download: null };
  clickAction(host, 'drafter', 'cancel');
  await settle();
  assert.equal(bridge.calls.some((call) => call[0] === 'cancel'), true);
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action="get"]').textContent, 'Get drafter');
  assert.equal(timers.count, 0);
});

test('polling stops after dispose and when the rows leave the page', async () => {
  const first = createHost();
  const timers = createFakeTimers();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'downloading' }), projector: null, download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 1, totalBytes: DRAFTER_BYTES } });
  const controller = companions.mount(first.host, { ...OPTS, bridge, ...timers });
  await settle();
  assert.equal(timers.count, 1);
  controller.dispose();
  assert.equal(timers.count, 0);
  const afterDispose = bridge.calls.length;
  await timers.fire();
  assert.equal(bridge.calls.length, afterDispose, 'a disposed controller reads nothing more');

  const second = createHost();
  const gone = createFakeTimers();
  companions.mount(second.host, { ...OPTS, bridge, ...gone });
  await settle();
  assert.equal(gone.count, 1);
  const calls = bridge.calls.length;
  second.host.querySelector('.model-tuning-drawer-grid').innerHTML = '';
  await gone.fire();
  assert.equal(bridge.calls.length, calls, 'no read once the rows are gone');
  assert.equal(gone.count, 0, 'and the poll ends');
});

test('mounting a host again binds one listener only', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: null, download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  clickAction(host, 'drafter', 'get');
  await settle();
  assert.equal(bridge.calls.filter((call) => call[0] === 'install').length, 1);
});

test('a drawer re-render of the same model repaints the rows before the status answers', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: null, download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  host.querySelector('.model-tuning-drawer-grid').innerHTML = engineHtml('llama-server');
  bridge.companionStatus = () => new Promise(() => {});
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  assert.equal(row(host, 'drafter').hidden, false, 'painted from the last status at once');
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action="get"]').textContent, 'Get drafter');
  const other = createHost();
  companions.mount(other.host, { ...OPTS, tag: 'other:1b', bridge, ...createFakeTimers() });
  assert.equal(row(other.host, 'drafter').hidden, true, 'another model starts hidden');
});

test('a failed start is announced and the row refreshes', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: null, download: null });
  companions.mount(host, { ...OPTS, bridge, ...createFakeTimers() });
  await settle();
  bridge.installResult = { ok: false, reason: 'hf_gated' };
  clickAction(host, 'drafter', 'get');
  await settle();
  assert.equal(host.querySelector('.model-tuning-drawer-status').textContent, 'This file needs a Hugging Face sign-in.');
});

test('a finished install is announced once and offers Restart now while serving', async () => {
  const { host } = createHost();
  const timers = createFakeTimers();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'downloading' }), projector: projector({}), download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 1, totalBytes: DRAFTER_BYTES } });
  let restarts = 0;
  companions.mount(host, { ...OPTS, serving: true, restart: async () => { restarts += 1; return true; }, bridge, ...timers });
  await settle();
  const statusLine = host.querySelector('.model-tuning-drawer-status');
  assert.equal(statusLine.textContent, '');
  bridge.reply = { ok: true, drafter: status({ state: 'installed' }), projector: projector({}), download: null };
  await timers.fire();
  assert.equal(statusLine.textContent, 'Drafter file installed.');
  assert.equal(noteOf(host, 'drafter').textContent, 'Installed. Takes effect the next time the model starts.');
  statusLine.textContent = '';
  await timers.fire();
  assert.equal(statusLine.textContent, '', 'the same install is not announced twice');

  clickAction(host, 'drafter', 'restart');
  await settle();
  assert.equal(restarts, 1);
  assert.equal(noteOf(host, 'drafter').textContent, '');
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action]'), null);
});

test('an installed file that was already there offers no Restart now', async () => {
  const { host } = createHost();
  const bridge = createBridge({ ok: true, drafter: status({ state: 'installed' }), projector: null, download: null });
  companions.mount(host, { ...OPTS, serving: true, restart: async () => true, bridge, ...createFakeTimers() });
  await settle();
  assert.equal(row(host, 'drafter').querySelector('[data-model-tuning-companion-action]'), null);
  assert.equal(noteOf(host, 'drafter').textContent, '');
});

test('a failed download is announced with its reason', async () => {
  const { host } = createHost();
  const timers = createFakeTimers();
  const bridge = createBridge({ ok: true, drafter: null, projector: projector({ state: 'downloading' }), download: { kind: 'projector', tag: OPTS.tag, receivedBytes: 1, totalBytes: 900e6 } });
  companions.mount(host, { ...OPTS, bridge, ...timers });
  await settle();
  bridge.reply = { ok: true, drafter: null, projector: projector({ state: 'failed', reason: 'sha256_mismatch' }), download: null };
  await timers.fire();
  assert.equal(host.querySelector('.model-tuning-drawer-status').textContent, 'The download didn\'t match its checksum and was deleted.');
  assert.equal(noteOf(host, 'vision').dataset.tone, 'warn');
});

test('focus follows a re-rendered button, or falls back to the row value', async () => {
  const { host, document } = createHost();
  document.body.append(host);
  const timers = createFakeTimers();
  const bridge = createBridge({ ok: true, drafter: status({}), projector: null, download: null });
  companions.mount(host, { ...OPTS, bridge, ...timers });
  await settle();
  row(host, 'drafter').querySelector('[data-model-tuning-companion-action="get"]').focus();
  bridge.reply = { ok: true, drafter: status({ state: 'downloading' }), projector: null, download: { kind: 'drafter', tag: OPTS.tag, receivedBytes: 1, totalBytes: DRAFTER_BYTES } };
  clickAction(host, 'drafter', 'get');
  await settle();
  assert.equal(document.activeElement.dataset.modelTuningCompanionAction, 'cancel');

  bridge.reply = { ok: true, drafter: status({ state: 'installed' }), projector: null, download: null };
  await timers.fire();
  assert.equal(document.activeElement.hasAttribute('data-model-tuning-companion-file'), true, 'no button left: the value holds focus');
});
