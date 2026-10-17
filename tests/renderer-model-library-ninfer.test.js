'use strict';

// Row 54 N2 Step 10: the NInfer engine block (states C1-C10, one owner per
// message while the set-up runs, the one-time suggestion, Remove, the
// watchdog row), the NInfer library rows (merge + view: "NInfer" badge, Best
// fit, Download instead of Pull) and the Models section wiring (host behind
// the flag, Download routed to the block's set-up, no Ollama pull).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryNinferController, setupFailureMessage } = require('../renderer/shell/model-library/model-library-ninfer');
const merge = require('../renderer/shell/model-library/model-library-merge');
const view = require('../renderer/shell/model-library/model-library-view');
const { createModelLibrarySectionController } = require('../renderer/shell/renderer-settings-model-library-section');

const ROW_KEY = 'qwen3.8-27b-nvfp4:latest';
const PIN = { id: 'qwen3.8-27b-nvfp4', display_name: 'Qwen3.8 27B', model_id: 'qwen3.8-27b-nvfp4', size_bytes: 23719715844, supports_mtp: true, context_windows: [16384, 32768, 65536, 131072, 153600, 262144], fp8_kv_windows: [153600, 262144], default_context_window: 65536 };
const ENGINE_BYTES = 450215373;

async function flush() {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function ninferState(overrides = {}) {
  const { install = {}, artifacts = {}, manager = {}, settings = {}, present = false, ...rest } = overrides;
  return {
    eligible: true, reason: '', enabled: true,
    runtime: {
      install: { status: 'not_installed', version: '0.9.1', download_size_bytes: ENGINE_BYTES, install: null, last_error: null, executable_present: false, ...install },
      artifacts: { status: 'idle', phase: '', artifact_id: '', download: null, last_error: null, ...artifacts },
      pins: [PIN],
    },
    installed: [{ id: PIN.id, present }],
    manager: { state: 'stopped', pid: 0, port: 0, alias: '', artifactId: '', contextSize: 0, mtp: false, runtimeLabel: '', lastError: '', hostMemoryGb: 0, stoppedBy: '', watchdogWatts: 0, watchdogTempC: 0, identityRetained: false, ...manager },
    settings: { lastUsedArtifactId: '', suggestionDismissed: false, contextSize: 65536, mtp: true, watchdog: { enabled: false, maxWatts: 460, maxTempC: 83 }, ...settings },
    ...rest,
  };
}

function blockHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ninfer"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  const uses = [];
  let state = options.state === null ? null : ninferState(options.state);
  let listener = null;
  const bridge = {
    async getState() { calls.push(['getState']); return options.ineligible ? { eligible: false, reason: 'ninfer_gpu_unsupported' } : state; },
    async setup() { calls.push(['setup']); return options.setupResult || { ok: true }; },
    async cancelSetup() { calls.push(['cancelSetup']); return { ok: true }; },
    async remove(payload) { calls.push(['remove', payload]); return { ok: true }; },
    async restart() { calls.push(['restart']); return { ok: true, status: { state: 'ready' } }; },
    async dismissSuggestion() { calls.push(['dismissSuggestion']); state = ninferState({ ...options.state, settings: { ...(options.state?.settings || {}), suggestionDismissed: true } }); return { ok: true }; },
    async updateSettings(payload) { calls.push(['updateSettings', payload]); return { ok: true }; },
    onChanged(fn) { listener = fn; return () => { listener = null; }; },
  };
  dom.window.jennyShell = { ninfer: bridge };
  let stateChanges = 0;
  const controller = createModelLibraryNinferController({
    windowRef: dom.window, documentRef: dom.window.document, hostId: 'ninfer',
    isEnabled: () => options.enabled !== false,
    onState: () => { stateChanges += 1; },
    onUse: (modelId) => uses.push(modelId),
  });
  t.after(() => controller.dispose());
  return {
    dom, calls, uses, controller, bridge,
    host: () => dom.window.document.getElementById('ninfer'),
    text: () => dom.window.document.getElementById('ninfer').textContent,
    click: (action) => dom.window.document.querySelector(`[data-ninfer-action="${action}"]`).click(),
    actions: () => [...dom.window.document.querySelectorAll('[data-ninfer-action]')].map((node) => node.dataset.ninferAction),
    setState: (next) => { state = ninferState(next); },
    emit: (payload) => { if (listener) listener(payload); },
    stateChanges: () => stateChanges,
  };
}

test('ineligible card: nothing renders, the library gets no NInfer input, and the kill switch empties the host', async (t) => {
  const h = blockHarness(t, { ineligible: true });
  h.controller.bind();
  await flush();
  assert.equal(h.host().innerHTML, '');
  assert.equal(h.controller.libraryInput(), null);
  const off = blockHarness(t, { enabled: false });
  off.controller.bind();
  await flush();
  assert.equal(off.host().innerHTML, '');
  assert.equal(off.controller.libraryInput(), null);
});

test('not set up: C1-C4 with sizes through the formatter, and Set up starts the one set-up without holding the block', async (t) => {
  const h = blockHarness(t);
  h.controller.bind();
  await flush();
  assert.match(h.text(), /NInfer engine/);
  assert.match(h.text(), /built only for the RTX 5090/);
  assert.match(h.text(), /Not set up/);
  assert.match(h.text(), /Not set up · recommended for this card/);
  const title = h.host().querySelector('.model-library-folders-title');
  assert.equal(title.nextElementSibling.textContent, 'Recommended');
  assert.ok(title.nextElementSibling.matches('.inv-badge.inv-badge--sm'));
  assert.ok(title.nextElementSibling.nextElementSibling.matches('.model-library-image-engine-help'));
  assert.match(h.text(), /Installs the engine \(429\.4 MB, github\.com\), then downloads Qwen3\.8 27B \(22\.1 GB, huggingface\.co\)/);
  assert.deepEqual(h.actions(), ['setup']);
  assert.equal(h.dom.window.document.querySelector('[data-ninfer-action="setup"]').textContent.trim(), 'Set up NInfer · about 22.5 GB');
  assert.equal(h.text().includes('Power watchdog'), false, 'no watchdog row before the runtime exists');
  h.click('setup');
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'setup'), [['setup']]);
  const input = h.controller.libraryInput();
  assert.equal(input.pins[0].id, PIN.id);
  assert.equal(input.installed[0].present, false);
  assert.equal(input.settingUp, false);
});

test('setting up: one status row owns the message through both steps, Cancel is the only action, the row reports settingUp', async (t) => {
  const h = blockHarness(t, { state: { install: { status: 'installing', install: { phase: 'downloading', done: 104857600, total: ENGINE_BYTES } } } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Setting up · step 1 of 2 · engine 100 MB of 429\.4 MB/);
  assert.ok(h.host().querySelector('progress, [role="progressbar"], .inv-progress, .inv-progress-bar'), 'a progress bar renders for the download');
  assert.match(h.text(), /Chats keep working meanwhile\. A cancelled download resumes where it stopped\./);
  assert.deepEqual(h.actions(), ['cancel-setup']);
  assert.equal(h.controller.libraryInput().settingUp, true);
  for (const [phase, expected] of [['verifying', /step 1 of 2 · Checking the fingerprint…/], ['extracting', /step 1 of 2 · Unpacking…/]]) {
    h.setState({ install: { status: 'installing', install: { phase, done: 0, total: 0 } } });
    h.emit({ source: 'runtime' });
    await flush();
    assert.match(h.text(), expected);
  }
  h.setState({ install: { status: 'installed', executable_present: true }, artifacts: { status: 'downloading', phase: 'stream', download: { done: 5368709120, total: PIN.size_bytes, resumed_from: 0 } } });
  h.emit({ source: 'runtime' });
  await flush();
  assert.match(h.text(), /Setting up · step 2 of 2 · Qwen3\.8 27B 5 GB of 22\.1 GB/);
  h.setState({ install: { status: 'installed', executable_present: true }, artifacts: { status: 'downloading', phase: 'verify', download: { done: PIN.size_bytes, total: PIN.size_bytes } } });
  h.emit({ source: 'runtime' });
  await flush();
  assert.match(h.text(), /step 2 of 2 · Checking the fingerprint…/);
  h.click('cancel-setup');
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'cancelSetup'));
});

test('set-up failures read as C8 sentences (engine vs model, resume point, fingerprint, disk), a cancel is not a failure', async (t) => {
  assert.equal(setupFailureMessage('download_failed', 'engine'), 'github.com could not be reached. Nothing was changed.');
  assert.equal(setupFailureMessage('download_inactivity', 'model', { resumeFrom: 3221225472 }), 'huggingface.co could not be reached. The download will resume from 3 GB.');
  assert.equal(setupFailureMessage('digest_mismatch', 'model'), 'The download did not match the expected fingerprint and was deleted. Nothing was changed.');
  assert.equal(setupFailureMessage('ninfer_disk_space', 'model', { needed: PIN.size_bytes }), 'Not enough free disk space: NInfer needs 22.1 GB.');
  const failed = blockHarness(t, { state: { install: { status: 'installed', executable_present: true }, artifacts: { last_error: 'download_failed', download: { done: 1073741824, total: PIN.size_bytes } } } });
  failed.controller.bind();
  await flush();
  assert.match(failed.text(), /Not set up · huggingface\.co could not be reached\. The download will resume from 1 GB\./);
  assert.equal(failed.dom.window.document.querySelector('[data-ninfer-action="setup"]').textContent.trim(), 'Retry');
  const cancelled = blockHarness(t, { state: { artifacts: { last_error: 'cancelled' } } });
  cancelled.controller.bind();
  await flush();
  assert.match(cancelled.text(), /Set-up cancelled\. It resumes where it stopped\./);
  assert.deepEqual(cancelled.actions(), ['setup']);
});

test('ready: C6 with Use and Not now once; Not now persists; the watchdog row appears; Use hands the model id to the library', async (t) => {
  const h = blockHarness(t, { state: { install: { status: 'installed', executable_present: true }, present: true } });
  h.controller.bind();
  await flush();
  assert.match(h.text(), /Ready · 0\.9\.1 · NInfer runs Qwen3\.8 27B about 2\.5× faster on long prompts on this card\./);
  assert.equal(h.text().includes('Recommended'), false);
  assert.equal(h.host().querySelector('.inv-badge'), null);
  assert.deepEqual(h.actions(), ['use', 'not-now', 'remove-ask']);
  assert.equal(h.dom.window.document.querySelector('[data-ninfer-action="use"]').textContent.trim(), 'Use Qwen3.8 27B on NInfer');
  assert.match(h.text(), /Power watchdog/);
  assert.match(h.text(), /Stops NInfer after 3 s above 460 W or 83 °C/);
  const input = h.controller.libraryInput();
  assert.equal(input.installed[0].present, true);
  assert.equal(input.settings.mtp, true);
  h.click('use');
  assert.deepEqual(h.uses, [PIN.model_id]);
  h.click('not-now');
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'dismissSuggestion'));
  assert.equal(h.text().includes('NInfer runs Qwen3.8 27B'), false, 'the suggestion shows once');
  assert.deepEqual(h.actions(), ['remove-ask']);
  assert.match(h.text(), /Ready · 0\.9\.1/);
});

test('serving, crashed, watchdog-stopped and could-not-start states carry their copy and recovery action', async (t) => {
  const base = { install: { status: 'installed', executable_present: true }, present: true, settings: { suggestionDismissed: true } };
  const serving = blockHarness(t, { state: { ...base, manager: { state: 'ready', port: 8034, alias: PIN.model_id, artifactId: PIN.id, runtimeLabel: '0.9.1', mtp: true } } });
  serving.controller.bind();
  await flush();
  assert.match(serving.text(), /Ready · 0\.9\.1 · serving Qwen3\.8 27B on :8034 · MTP/);
  assert.deepEqual(serving.actions(), ['remove-ask']);
  assert.equal(serving.controller.libraryInput().manager.state, 'ready');
  const crashed = blockHarness(t, { state: { ...base, manager: { state: 'crashed', lastError: 'ninfer_exited:1' } } });
  crashed.controller.bind();
  await flush();
  assert.match(crashed.text(), /stopped unexpectedly\. It restarts with your next message\./);
  assert.deepEqual(crashed.actions(), ['restart', 'remove-ask']);
  crashed.click('restart');
  await flush();
  assert.ok(crashed.calls.some((call) => call[0] === 'restart'));
  const tripped = blockHarness(t, { state: { ...base, manager: { state: 'crashed', lastError: 'ninfer_watchdog_tripped', stoppedBy: 'watchdog', watchdogWatts: 595, watchdogTempC: 71 } } });
  tripped.controller.bind();
  await flush();
  assert.match(tripped.text(), /Stopped by the power watchdog \(595 W, 71 °C\)\. Restart it once the card has cooled\./);
  assert.deepEqual(tripped.actions(), ['restart', 'remove-ask']);
  const memory = blockHarness(t, { state: { ...base, manager: { state: 'stopped', lastError: 'ninfer_host_memory', hostMemoryGb: 24 } } });
  memory.controller.bind();
  await flush();
  assert.match(memory.text(), /NInfer couldn't reserve 24 GB of system memory\. Close other apps or wait a minute, then press Use again\./);
  assert.deepEqual(memory.actions(), ['restart', 'remove-ask']);
  const starting = blockHarness(t, { state: { ...base, manager: { state: 'starting' } } });
  starting.controller.bind();
  await flush();
  assert.match(starting.text(), /Starting NInfer…/);
  assert.deepEqual(starting.actions(), [], 'nothing to press mid-transition');
});

test('Remove asks inline (C10) with the model-file checkbox, Keep it backs out, Remove sends the opt-in and the checkbox', async (t) => {
  const h = blockHarness(t, { state: { install: { status: 'installed', executable_present: true }, present: true, settings: { suggestionDismissed: true } } });
  h.controller.bind();
  await flush();
  h.click('remove-ask');
  assert.match(h.text(), /Remove NInfer\? Chats switch back to your other models\./);
  assert.match(h.text(), /Also delete the Qwen3\.8 27B model file \(22\.1 GB\)/);
  assert.deepEqual(h.actions(), ['confirm-remove', 'keep']);
  assert.equal(h.text().includes('Power watchdog'), false, 'the confirm replaces the watchdog row');
  h.click('keep');
  assert.deepEqual(h.actions(), ['remove-ask']);
  h.click('remove-ask');
  const box = h.dom.window.document.querySelector('[data-ninfer-field="delete-model"]');
  box.checked = true;
  box.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  h.click('confirm-remove');
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'remove'), [['remove', { confirmed: true, deleteModel: true }]]);
});

test('the watchdog row saves the toggle and both bounded thresholds through updateSettings', async (t) => {
  const h = blockHarness(t, { state: { install: { status: 'installed', executable_present: true }, present: true, settings: { suggestionDismissed: true } } });
  h.controller.bind();
  await flush();
  h.host().dispatchEvent(new h.dom.window.CustomEvent('inv-toggle-change', { bubbles: true, detail: { id: 'ninferWatchdogEnabled', checked: true } }));
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'updateSettings').pop(), ['updateSettings', { watchdog: { enabled: true, maxWatts: 460, maxTempC: 83 } }]);
  const watts = h.dom.window.document.querySelector('[data-ninfer-field="watchdog-watts"]');
  watts.value = '5000';
  watts.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'updateSettings').pop()[1], { watchdog: { enabled: false, maxWatts: 1000, maxTempC: 83 } }, 'watts clamp to the bound; the toggle reflects main\'s answer');
  const temp = h.dom.window.document.querySelector('[data-ninfer-field="watchdog-temp"]');
  temp.value = '75';
  temp.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'updateSettings').pop()[1], { watchdog: { enabled: false, maxWatts: 460, maxTempC: 75 } });
});

test('change events re-read the state once at a time, the library is told, and dispose unsubscribes', async (t) => {
  const h = blockHarness(t);
  h.controller.bind();
  await flush();
  const before = h.calls.filter((call) => call[0] === 'getState').length;
  const changesBefore = h.stateChanges();
  h.emit({ source: 'manager', state: 'starting' });
  h.emit({ source: 'manager', state: 'ready' });
  h.emit({ source: 'runtime' });
  await flush();
  const after = h.calls.filter((call) => call[0] === 'getState').length;
  assert.ok(after - before >= 1 && after - before <= 2, `one read in flight, at most one queued (saw ${after - before})`);
  assert.ok(h.stateChanges() > changesBefore);
  h.controller.dispose();
  const atDispose = h.calls.length;
  h.emit({ source: 'runtime' });
  await flush();
  assert.equal(h.calls.length, atDispose, 'no reads after dispose');
});

// --- the NInfer rows through merge + view ---

function mergeWith(ninfer, extra = {}) {
  return merge.mergeModelLibrary({
    installed: [], ollamaTags: [], recommendations: [], fitEstimates: [],
    hardware: { gpu: { type: 'cuda', name: 'NVIDIA GeForce RTX 5090', vram_mb: 32607 } },
    memory: { totalMb: 65536, availableMb: 40000 }, catalogMeta: null, activeModel: '', preferredLocalModel: '',
    ninfer, ...extra,
  });
}

function ninferInput(overrides = {}) {
  return {
    pins: [PIN], installed: [{ id: PIN.id, present: false }],
    manager: { state: 'stopped', alias: '', port: 0, artifactId: '', identityRetained: false, mtp: false, lastError: '' },
    settingUp: false, settings: { mtp: true, contextSize: 65536 }, ...overrides,
  };
}

test('merge: an NInfer pin is a Best-fit card for this GPU that downloads through the block, with no NInfer input the grid is untouched', () => {
  assert.deepEqual(mergeWith(null).cards, []);
  const [card] = mergeWith(ninferInput()).cards;
  assert.equal(card.key, `${PIN.model_id}:latest`);
  assert.equal(card.tag, PIN.model_id);
  assert.equal(card.displayName, 'Qwen3.8 27B');
  assert.equal(card.selectedEngine, 'ninfer');
  assert.equal(card.installed, false);
  assert.equal(card.recommended, true);
  assert.equal(card.fitState, 'fits');
  assert.equal(card.downloadSizeMb, 22621);
  assert.equal(card.engineType, 'openai-compatible');
  assert.equal(card.ninferArtifactId, PIN.id);
  assert.equal(card.mtp.enabled, true);
  assert.equal(card.ninferSetupRunning, false);
  const installed = mergeWith(ninferInput({ installed: [{ id: PIN.id, present: true }] })).cards[0];
  assert.equal(installed.installed, true);
  assert.equal(installed.sizeBytes, PIN.size_bytes);
  assert.equal(installed.source, 'installed');
  const serving = mergeWith(ninferInput({ installed: [{ id: PIN.id, present: true }], manager: { state: 'ready', alias: PIN.model_id, port: 8034, artifactId: PIN.id, identityRetained: false, mtp: true, lastError: '' } })).cards[0];
  assert.equal(serving.serving, true);
  assert.equal(serving.servingPort, 8034);
  assert.equal(serving.active, true);
  const paused = mergeWith(ninferInput({ installed: [{ id: PIN.id, present: true }], manager: { state: 'stopped', alias: PIN.model_id, port: 0, artifactId: PIN.id, identityRetained: true, mtp: true, lastError: '' } })).cards[0];
  assert.equal(paused.servingPaused, true);
  const noMtp = mergeWith(ninferInput({ settings: { mtp: false, contextSize: 65536 } })).cards[0];
  assert.equal(noMtp.mtp.enabled, false);
});

// Gate 2026-10-14 F18: the engine lists the served NInfer model as installed,
// and that bare card ("Size unknown · Not in catalog") won over the pin card.
test('merge: an installed NInfer model shows as its pin card, active when loaded and preferred when chosen', () => {
  const ninfer = ninferInput({ installed: [{ id: PIN.id, present: true }] });
  const cards = mergeWith(ninfer, {
    installed: [{ id: PIN.model_id, engine_type: 'openai-compatible', loaded: true }],
    preferredLocalModel: PIN.model_id,
  }).cards;
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.selectedEngine, 'ninfer');
  assert.equal(card.displayName, 'Qwen3.8 27B');
  assert.equal(card.sizeBytes, PIN.size_bytes);
  assert.equal(card.contextLength, 65536);
  assert.equal(card.active, true);
  assert.equal(card.preferredLocal, true);
});

test('view: the row shows Best fit and the NInfer badge (with MTP), the action reads Download and hides while the set-up runs', () => {
  const [card] = mergeWith(ninferInput()).cards;
  const row = new JSDOM(view.buildModelRow(card, { actions: ['use', 'unload', 'tune', 'pull', 'menu'], pull: {}, activation: {} })).window.document;
  assert.match(row.querySelector('.model-row-title').textContent, /Best fit/);
  assert.match(row.querySelector('.model-row-title').textContent, /NInfer · MTP/);
  assert.equal(row.querySelector('.model-row-title').textContent.includes('MTP ready'), false);
  assert.match(row.querySelector('.model-row-meta').textContent, /22\.1 GB download/);
  const download = row.querySelector('[data-model-card-action="pull"]');
  assert.equal(download.textContent.trim(), 'Download');
  assert.equal(download.dataset.modelTag, PIN.model_id);
  const running = new JSDOM(view.buildModelRow({ ...card, ninferSetupRunning: true }, { actions: ['use', 'pull', 'tune'], pull: {}, activation: {} })).window.document;
  assert.equal(running.querySelector('[data-model-card-action]'), null, 'the block owns the message while the set-up runs');
  const [installed] = mergeWith(ninferInput({ installed: [{ id: PIN.id, present: true }] })).cards;
  const ready = new JSDOM(view.buildModelRow(installed, { actions: ['use', 'unload', 'tune', 'pull', 'menu'], pull: {}, activation: {} })).window.document;
  assert.deepEqual([...ready.querySelectorAll('[data-model-card-action]')].map((node) => node.dataset.modelCardAction), ['use', 'tune', 'menu']);
  const serving = new JSDOM(view.buildModelRow({ ...installed, active: true, serving: true, servingPort: 8034 }, { actions: ['use', 'unload', 'tune', 'pull', 'menu'], pull: {}, activation: {} })).window.document;
  assert.match(serving.querySelector('.model-row-title').textContent, /Active.*Serving on :8034.*NInfer · MTP/);
  const plain = new JSDOM(view.buildModelCard(card, { compact: true, actions: ['use', 'pull'], pull: {}, activation: {} })).window.document;
  assert.equal(plain.querySelector('[data-model-card-action="pull"]').textContent.trim(), 'Download');
});

// --- the Models section wiring ---

function sectionHarness(t, { flag = true, ninferState: ninferOverrides = {}, ineligible = false } = {}) {
  const dom = new JSDOM(`<!doctype html><body>
    <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
    <section class="settings-card settings-section-active" data-settings-section="models">
      <div class="settings-card-header"><h3>Models</h3></div>
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
      <div id="modelLibrarySectionExtrasHost"></div>
    </section></body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window: windowRef } = dom;
  const calls = [];
  const state = { features: { featureFlags: { ninfer: flag } }, status: { model: '' }, offline: { preferredLocalModel: '' }, ui: { activeSettingsSection: 'models' } };
  let featureChanged = null;
  windowRef.jennyShell = {
    models: {
      async list() { return { data: [] }; },
      async listOllamaTags() { return { data: [] }; },
      async load(payload) { calls.push(['load', payload]); return { status: 'ok', model: typeof payload === 'string' ? payload : payload.model }; },
      async unload() { return { status: 'ok', model: '' }; },
      async delete() { return { status: 'deleted' }; },
    },
    offline: {
      async getDiagnostics() { return { hardwareProfile: { gpu: { type: 'cuda', name: 'NVIDIA GeForce RTX 5090', vram_mb: 32607 } }, memory: { totalMb: 65536, availableMb: 40000 }, modelRecommendations: [], catalogMeta: null }; },
      async updateSettings(payload) { return payload; },
    },
    engines: { async updateSettings(payload) { return { localEngines: { openaiCompatible: { managed: payload.managed } } }; } },
    llamaServer: { async listLocalGgufs() { return { ok: true, entries: [] }; }, async getStatus() { return { ok: true, state: 'stopped' }; } },
    features: { onChanged(listener) { featureChanged = listener; return () => { featureChanged = null; }; } },
    ninfer: {
      async getState() { calls.push(['ninfer.getState']); return ineligible ? { eligible: false, reason: 'ninfer_gpu_unsupported' } : ninferState(ninferOverrides); },
      async setup() { calls.push(['ninfer.setup']); return { ok: true }; },
      onChanged() { calls.push(['ninfer.subscribe']); return () => calls.push(['ninfer.unsubscribe']); },
    },
  };
  const controller = createModelLibrarySectionController({
    state, windowRef, documentRef: windowRef.document,
    appendClientLog: () => {}, refreshModelPickers: async () => {}, openModelTuning: (...args) => calls.push(['tune', ...args]), openDiagnostics: () => {},
    setupService: { subscribePullProgress() { return () => {}; }, async startOllamaPull(payload) { calls.push(['startOllamaPull', payload]); return { requestId: payload.requestId, status: 'running' }; }, async cancelOllamaPull() { return { cancelled: true }; } },
    inventoryContextMenu: { show() {}, hide() {} },
  });
  t.after(() => controller.dispose());
  return { controller, windowRef, document: windowRef.document, calls, state, featureChanged: () => featureChanged };
}

test('section: behind the flag the block renders in the extras host, the NInfer row downloads through the block and Use loads the model id', async (t) => {
  const h = sectionHarness(t);
  h.controller.bind();
  await flush();
  await flush();
  const host = h.document.getElementById('modelLibraryNinferHost');
  assert.ok(host, 'the NInfer host renders behind the flag');
  assert.match(host.textContent, /NInfer engine/);
  assert.ok(h.calls.some((call) => call[0] === 'ninfer.subscribe'));
  const row = h.document.querySelector(`.model-row[data-model-key="${ROW_KEY}"]`);
  assert.ok(row, 'the NInfer row joins the grid');
  assert.match(row.textContent, /Best fit/);
  const download = row.querySelector('[data-model-card-action="pull"]');
  assert.equal(download.textContent.trim(), 'Download');
  download.dispatchEvent(new h.windowRef.MouseEvent('click', { bubbles: true }));
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'ninfer.setup'), 'Download runs the block set-up');
  assert.equal(h.calls.some((call) => call[0] === 'startOllamaPull'), false, 'never an Ollama pull');
  assert.equal(h.state.modelRecommendation, null, 'an NInfer row is no Ollama pull recommendation');
  const off = sectionHarness(t, { flag: false });
  off.controller.bind();
  await flush();
  assert.equal(off.document.getElementById('modelLibraryNinferHost'), null);
  assert.equal(off.document.querySelector(`.model-row[data-model-key="${ROW_KEY}"]`), null);
  const ineligible = sectionHarness(t, { ineligible: true });
  ineligible.controller.bind();
  await flush();
  await flush();
  assert.equal(ineligible.document.getElementById('modelLibraryNinferHost').innerHTML, '');
  assert.equal(ineligible.document.querySelector(`.model-row[data-model-key="${ROW_KEY}"]`), null, 'zero NInfer DOM on an ineligible card');
});

test('section: Use on the installed NInfer row says C7 and loads through openai-compatible; Tune carries the NInfer hint', async (t) => {
  const h = sectionHarness(t, { ninferState: { install: { status: 'installed', executable_present: true }, present: true, settings: { suggestionDismissed: true } } });
  h.controller.bind();
  await flush();
  await flush();
  const row = h.document.querySelector(`.model-row[data-model-key="${ROW_KEY}"]`);
  row.querySelector('[data-model-card-action="use"]').dispatchEvent(new h.windowRef.MouseEvent('click', { bubbles: true }));
  assert.equal(h.document.querySelector('.model-library-section-status').textContent, 'Switching to Qwen3.8 27B on NInfer… llama-server stops first so the GPU is free.');
  await flush();
  assert.deepEqual(h.calls.filter((call) => call[0] === 'load'), [['load', { model: PIN.model_id, engine_type: 'openai-compatible' }]]);
  h.document.querySelector(`.model-row[data-model-key="${ROW_KEY}"] [data-model-card-action="tune"]`).dispatchEvent(new h.windowRef.MouseEvent('click', { bubbles: true }));
  const tune = h.calls.find((call) => call[0] === 'tune');
  assert.equal(tune[1], PIN.model_id);
  assert.equal(tune[3].engineTypeHint, 'openai-compatible');
  assert.deepEqual(tune[3].ninfer, { artifactId: PIN.id, modelId: PIN.model_id, contextWindows: PIN.context_windows, fp8KvWindows: [153600, 262144], supportsMtp: true });
});
