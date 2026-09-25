'use strict';

// W4-A review fixes: the guards around "Add GGUF model…" and ⋯ ▸ "Remove from
// library", ported from the adversarial review's proofs. Every write goes
// through main's REAL engines.updateSettings handler (registerAuxiliaryIpcHandlers
// -> writeManagedPatch -> ShellConfigService.updateManagedLlamaServer ->
// normalizeLocalEngines) in a throwaway userData dir, so every echo is exactly
// what main sends back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { createModelLibrarySectionController } = require('../renderer/shell/renderer-settings-model-library-section');
const { createModelLibraryFoldersController } = require('../renderer/shell/renderer-model-library-folders');

const OWNER_FILE = 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b\\Ternary-Bonsai-2-27B-PQ2_0.gguf';
const OWNER_TAG = 'ternary-bonsai-2-27b-pq2_0';
const OWNER_KEY = 'ternary-bonsai-2-27b-pq2-0';
const OWNER_CARD = OWNER_TAG + ':latest';
const QWEN_FILE = 'D:\\hf\\Qwen3-8B-Q4_K_M.gguf';
const QWEN_TAG = 'qwen3-8b-q4_k_m';
const QWEN_KEY = 'qwen3-8b-q4-k-m';
const ADD_FAILED = 'Could not add the model.';
const QWEN_TAKEN = 'Another model is already named qwen3-8b-q4_k_m. Rename the file, then add it.';
const OLLAMA_DOWN = { available: false, reason: 'Ollama is not running.' };

const tempDirs = [];
test.after(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function libraryEntry(tag, modelPath) {
  return { engine: 'llama-server', tag, modelPath, mtp: { mode: 'off' } };
}

function realMain(seedManaged) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'w4a-add-guards-'));
  tempDirs.push(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  if (seedManaged) service.updateManagedLlamaServer(seedManaged);
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    backendService: {},
    shellConfigService: service,
    processRef: { env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1' } },
    log: () => null,
  });
  const handler = handlers.get('engines:update-settings');
  assert.equal(typeof handler, 'function');
  return {
    service,
    managed: () => service.getLocalEngines().openaiCompatible.managed,
    updateSettings: async (payload) => handler({}, payload),
  };
}

async function flush(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

// What main's chooseGguf answers for a picked file: its folder is path.dirname.
function pickOf(filePath) {
  const api = /^[a-z]:|^\\\\/i.test(filePath) ? path.win32 : path.posix;
  return { ok: true, picked: true, path: filePath, dir: api.dirname(filePath), drafterGguf: '' };
}

// Every textContent write into the GGUF folders row's live region.
function spyLiveRegion(windowRef) {
  const writes = [];
  const text = Object.getOwnPropertyDescriptor(windowRef.Node.prototype, 'textContent');
  Object.defineProperty(windowRef.Node.prototype, 'textContent', {
    configurable: true,
    get() { return text.get.call(this); },
    set(value) {
      if (this.classList && this.classList.contains('model-library-folders-status')) writes.push(String(value));
      text.set.call(this, value);
    },
  });
  return writes;
}

function foldersHarness(options = {}) {
  const main = options.main || realMain(options.seed);
  const dom = new JSDOM('<!doctype html><body><div id="folders"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  const statuses = [];
  const liveWrites = spyLiveRegion(dom.window);
  const library = {
    get managed() { return main.managed(); },
    ollamaTags: options.ollamaTags || [],
    installed: options.installed || [],
    unavailable: options.unavailable || {},
  };
  dom.window.jennyShell = {
    llamaServer: {
      chooseGguf: options.chooseGguf || (async (payload) => { calls.push(['chooseGguf', payload]); return options.pick; }),
    },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
        return options.reply ? options.reply(payload, main) : main.updateSettings(payload);
      },
    },
    models: {
      async listOllamaTags() {
        calls.push(['listOllamaTags']);
        if (options.tagsReread instanceof Error) throw options.tagsReread;
        return options.tagsReread;
      },
      async delete(payload) { calls.push(['delete', payload]); },
    },
  };
  const controller = createModelLibraryFoldersController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    getRoots: () => main.managed().libraryRoots,
    getLibrary: () => library,
    onSettings: (localEngines) => calls.push(['settings', localEngines]),
    refresh: () => { calls.push(['refresh']); return Promise.resolve(); },
    setStatus: (message) => statuses.push(message),
    hostId: 'folders',
  });
  controller.bind();
  controller.render();
  const doc = dom.window.document;
  return {
    main, dom, doc, controller, calls, statuses, liveWrites,
    status: () => doc.querySelector('.model-library-folders-status')?.textContent || '',
    region: () => doc.querySelector('.model-library-folders-status'),
    addModelButton: () => doc.querySelector('[data-model-library-folder-action="add-model"]'),
    click: (element) => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })),
    kinds: () => calls.map((entry) => entry[0]),
    updates: () => calls.filter((entry) => entry[0] === 'update').map((entry) => entry[1]),
  };
}

async function addWith(options) {
  const h = foldersHarness(options);
  h.click(h.addModelButton());
  await flush();
  h.controller.dispose();
  return h;
}

// The real Settings section, wired to real main for engine writes; `live`
// holds what the next load reads.
function sectionHarness(t, options = {}) {
  const main = options.main || realMain(options.seed);
  const dom = new JSDOM(`<!doctype html><body>
      <nav class="settings-nav"><button data-settings-section="models">Models</button></nav>
      <section class="settings-card" data-settings-section="models">
      <div id="modelLibrarySectionToolbarHost"></div>
      <div class="settings-note model-library-section-status" aria-live="polite"></div>
      <div id="modelLibrarySectionHost"></div>
    </section>
  </body>`, { pretendToBeVisual: true, url: 'http://localhost/' });
  const windowRef = dom.window;
  const calls = [];
  const liveWrites = spyLiveRegion(windowRef);
  const live = {
    installedPayload: options.installedPayload || { data: options.installed || [] },
    ollamaTagsPayload: options.ollamaTagsPayload || { data: options.ollamaTags || [] },
    pick: options.pick || { ok: true, picked: false, path: '' },
  };
  const state = {
      features: { featureFlags: { model_management_ui: true, llama_server_acceleration: true } },
    localEngines: main.service.getLocalEngines(),
    status: { model: options.activeModel || '' },
    offline: { preferredLocalModel: options.preferredLocalModel || '' },
      ui: { activeSettingsSection: 'models' },
  };
  windowRef.jennyShell = {
    models: {
      list: async () => live.installedPayload,
      listOllamaTags: async () => live.ollamaTagsPayload,
      load: async (payload) => { calls.push(['load', payload]); return { status: 'ok' }; },
      unload: async () => ({ status: 'ok' }),
      delete: async (payload) => { calls.push(['delete', payload]); return { status: 'deleted' }; },
    },
    offline: {
      getDiagnostics: async () => ({ modelRecommendations: options.recommendations || [] }),
      updateSettings: async (payload) => payload,
    },
    engines: {
      updateSettings: async (payload) => {
        calls.push(['update', payload]);
        if (options.holdUpdate) await options.holdUpdate(payload);
        return options.reply ? options.reply(payload, main) : main.updateSettings(payload);
      },
    },
    llamaServer: {
      listLocalGgufs: async () => ({ ok: true, entries: [] }),
      getStatus: async () => ({ ok: true, state: 'stopped', ...(options.status || {}) }),
      chooseGguf: async (payload) => {
        calls.push(['chooseGguf', payload]);
        return typeof live.pick === 'function' ? live.pick(payload) : live.pick;
      },
      chooseLibraryFolder: async () => ({ ok: true, picked: false, path: '' }),
    },
    features: { onChanged: () => () => {} },
  };
  const controller = createModelLibrarySectionController({
    state,
    windowRef,
    documentRef: windowRef.document,
    refreshModelPickers: async () => {},
    openModelTuning: (...args) => calls.push(['tune', ...args]),
    setupService: { subscribePullProgress: () => () => {} },
    inventoryContextMenu: { show(config) { calls.push(['menu', config]); }, hide() {} },
  });
  t.after(() => controller.dispose());
  const doc = windowRef.document;
  const card = doc.querySelector('.settings-card');
  const rows = () => [...card.querySelectorAll('[data-model-key]')];
  const row = (key) => rows().find((el) => el.getAttribute('data-model-key') === key);
  const click = (element) => element.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
  const menuButton = (key) => row(key).querySelector('[data-model-card-action="menu"]');
  const menuFor = (key) => {
    click(menuButton(key));
    return calls.filter((entry) => entry[0] === 'menu').pop()[1].items;
  };
  return {
    main, doc, windowRef, calls, state, live, controller, card, rows, row, click, menuButton, menuFor, liveWrites,
    keys: () => rows().map((el) => el.getAttribute('data-model-key')),
    meta: (key) => row(key)?.querySelector('.model-row-meta')?.textContent,
    labels: (key) => menuFor(key).map((item) => item.label),
    statusLine: () => card.querySelector('.model-library-section-status').textContent,
    foldersLine: () => card.querySelector('.model-library-folders-status')?.textContent,
    addModelButton: () => card.querySelector('[data-model-library-folder-action="add-model"]'),
  };
}

// Fix 1 (P01): Tune saves an Ollama model's llama-server setting under its
// Ollama tag; that entry is no library GGUF, even while Ollama is not listing.
test('while Ollama is not listing, an Ollama model\'s engine setting is no Local GGUF card', async (t) => {
  const gemma = { engine: 'llama-server', tag: 'gemma4:12b', modelPath: 'G:\\gguf\\gemma-4-12b\\gemma-4-12b-it-Q4_K_M.gguf', mtp: { mode: 'mtp', draftNMax: 4 } };
  const h = sectionHarness(t, {
    seed: { enabled: true, lastUsedTag: 'gemma4:12b', perModel: { 'gemma4-12b': gemma, mistral: libraryEntry('mistral', 'D:\\gguf\\Mistral.gguf') } },
    ollamaTagsPayload: OLLAMA_DOWN,
  });
  h.controller.bind();
  await flush();
  assert.equal(h.row('gemma4:12b'), undefined, 'the Ollama model has no card while Ollama is down');
  assert.deepEqual(h.keys(), ['mistral:latest']);
  assert.deepEqual(h.labels('mistral:latest'), ['Remove from library', 'Copy tag']);
  // And Remove from library itself refuses any tag that is not a library GGUF's.
  const folders = foldersHarness({ main: h.main });
  assert.equal(await folders.controller.removeLibraryModel('gemma4:12b'), false);
  assert.deepEqual(folders.updates(), []);
  assert.deepEqual(folders.statuses, ['Could not remove gemma4:12b from the library.']);
  folders.controller.dispose();
  assert.deepEqual(h.main.managed().perModel['gemma4-12b'], gemma);
});

// Fix 2 (P02b): tags the load could not read are read again before the Add's
// collision check; a user without Ollama can still add.
test('an Add re-reads Ollama tags the load could not read, and a tag with the name refuses it', async () => {
  const h = await addWith({
    seed: { enabled: true },
    unavailable: { ollamaTags: 'Ollama is not running.' },
    tagsReread: { data: [{ name: 'qwen3:8b-q4_K_M', size: 5e9 }] },
    pick: pickOf(QWEN_FILE),
  });
  assert.deepEqual(h.kinds(), ['chooseGguf', 'listOllamaTags']);
  assert.equal(h.status(), QWEN_TAKEN);
  assert.equal(h.main.managed().perModel[QWEN_KEY], undefined);
});

test('an Add still lands when the Ollama tags stay unreadable, and loaded tags are not re-read', async () => {
  for (const tagsReread of [OLLAMA_DOWN, new Error('ipc down'), null]) {
    const h = await addWith({ seed: { enabled: true }, unavailable: { ollamaTags: 'Ollama is not running.' }, tagsReread, pick: pickOf(QWEN_FILE) });
    assert.deepEqual(h.kinds().slice(0, 3), ['chooseGguf', 'listOllamaTags', 'update'], String(tagsReread));
    assert.equal(h.status(), `Added ${QWEN_TAG}.`);
  }
  const loaded = await addWith({ seed: { enabled: true }, tagsReread: { data: [{ name: 'qwen3:8b-q4_K_M' }] }, pick: pickOf(QWEN_FILE) });
  assert.equal(loaded.kinds().includes('listOllamaTags'), false);
  assert.equal(loaded.status(), `Added ${QWEN_TAG}.`);
});

test('in the section, the Add checks the Ollama tags the load could not read', async (t) => {
  const h = sectionHarness(t, { seed: { enabled: true }, ollamaTagsPayload: OLLAMA_DOWN, pick: pickOf(QWEN_FILE) });
  h.controller.bind();
  await flush();
  assert.match(h.statusLine(), /Ollama is not running\./);
  h.live.ollamaTagsPayload = { data: [{ name: 'qwen3:8b-q4_K_M', size: 5e9 }] };
  h.click(h.addModelButton());
  await flush();
  assert.equal(h.foldersLine(), QWEN_TAKEN);
  assert.equal(h.calls.some((entry) => entry[0] === 'update'), false);
});

// Fix 3 (P02c): a library model that later meets a model sharing its card
// ("mistral" beside Ollama's "mistral:latest") keeps a card of its own.
test('a library model keeps its own card and Remove after Ollama pulls a same-named model', async (t) => {
  const h = sectionHarness(t, { seed: { enabled: true }, pick: pickOf('D:\\gguf\\Mistral.gguf') });
  h.controller.bind();
  await flush();
  h.click(h.addModelButton());
  await flush();
  assert.equal(h.foldersLine(), 'Added mistral.');
  h.live.ollamaTagsPayload = { data: [{ name: 'mistral:latest', size: 4e9 }] };
  h.live.installedPayload = { data: [{ id: 'mistral:latest', size: 4e9, engine_type: 'ollama' }] };
  await h.controller.refresh({ force: true });
  await flush();
  assert.deepEqual(h.keys().sort(), ['mistral', 'mistral:latest']);
  assert.match(h.meta('mistral'), /^Local GGUF · /);
  assert.doesNotMatch(h.meta('mistral:latest'), /Local GGUF/);
  assert.deepEqual(h.labels('mistral'), ['Remove from library', 'Copy tag']);
  assert.deepEqual(h.labels('mistral:latest'), ['Remove…', 'Copy tag']);
  h.click(h.addModelButton());
  await flush();
  assert.equal(h.foldersLine(), 'mistral is already in the library.');
  h.click(h.row('mistral').querySelector('[data-model-card-action="use"]'));
  await flush();
  assert.deepEqual(h.calls.find((entry) => entry[0] === 'load')[1], { model: 'mistral', engine_type: 'openai-compatible' });
  await h.menuFor('mistral')[0].action();
  await flush();
  assert.equal(h.main.managed().perModel.mistral, undefined);
  assert.deepEqual(h.keys(), ['mistral:latest']);
  assert.equal(h.statusLine(), 'Removed mistral from the library. The file is still on disk.');
});

test('served and active, an own-card library model keeps its alias and its Active badge', async (t) => {
  const h = sectionHarness(t, {
    seed: { enabled: true, perModel: { mistral: libraryEntry('mistral', 'D:\\gguf\\Mistral.gguf') } },
    installed: [{ id: 'mistral', engine_type: 'openai-compatible' }, { id: 'mistral:latest', size: 4e9, engine_type: 'ollama' }],
    ollamaTags: [{ name: 'mistral:latest', size: 4e9 }],
    status: { state: 'ready', alias: 'mistral', port: 8093 },
    activeModel: 'mistral',
    preferredLocalModel: 'mistral',
  });
  h.controller.bind();
  await flush();
  assert.deepEqual(h.keys().sort(), ['mistral', 'mistral:latest']);
  assert.equal(h.row('mistral').getAttribute('data-active'), 'true');
  assert.equal(h.row('mistral:latest').getAttribute('data-active'), 'false');
  assert.doesNotMatch(h.meta('mistral:latest'), /default for local inference/, 'the default is the library model, not Ollama\'s');
  assert.match(h.meta('mistral'), /^Local GGUF/);
  assert.equal(h.row('mistral:latest').querySelector('.model-row-name').textContent, 'mistral:latest');
  h.click(h.row('mistral:latest').querySelector('[data-model-card-action="use"]'));
  await flush();
  assert.deepEqual(h.calls.find((entry) => entry[0] === 'load')[1], { model: 'mistral:latest', engine_type: 'ollama' });
});

// Fix 4 (P07): llama.cpp loads a split model from its first shard only.
const shard = (index) => `E:\\hf\\GLM-4.6-UD-Q2_K_XL\\GLM-4.6-UD-Q2_K_XL-${index}-of-00003.gguf`;

test('a pick of any shard adds the model by its first shard', async () => {
  const h = await addWith({ seed: { enabled: true }, pick: pickOf(shard('00002')) });
  assert.equal(h.status(), 'Added glm-4.6-ud-q2_k_xl.');
  assert.equal(h.updates()[0].managed.perModel['glm-4-6-ud-q2-k-xl'].modelPath, shard('00001'));
  assert.equal(h.main.managed().perModel['glm-4-6-ud-q2-k-xl'].modelPath, shard('00001'));
  for (const index of ['00001', '00003']) {
    const again = await addWith({ main: h.main, pick: pickOf(shard(index)) });
    assert.equal(again.status(), 'glm-4.6-ud-q2_k_xl is already in the library.', index);
    assert.deepEqual(again.updates(), [], index);
  }
  // Case and padding stay as the pick spells them.
  const upper = await addWith({ seed: { enabled: true }, pick: pickOf('E:\\hf\\X-Q4-00004-OF-00005.GGUF') });
  assert.equal(upper.updates()[0].managed.perModel['x-q4'].modelPath, 'E:\\hf\\X-Q4-00001-OF-00005.GGUF');
  // A shard saved before this guard still names the same model.
  const seeded = await addWith({
    seed: { enabled: true, perModel: { 'glm-4-6-ud-q2-k-xl': libraryEntry('glm-4.6-ud-q2_k_xl', shard('00002')) } },
    pick: pickOf(shard('00001')),
  });
  assert.equal(seeded.status(), 'glm-4.6-ud-q2_k_xl is already in the library.');
});

// Fix 5 (P05): every operation keeps its own answer.
test('a Remove from library answered after an Add GGUF model… click is still applied', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let closePicker;
  const h = sectionHarness(t, {
    seed: { enabled: true, perModel: { [OWNER_KEY]: libraryEntry(OWNER_TAG, OWNER_FILE) } },
    holdUpdate: (payload) => (payload.managed?.perModel?.[OWNER_KEY] === null ? gate : null),
    pick: () => new Promise((resolve) => { closePicker = resolve; }),
  });
  h.controller.bind();
  await flush();
  const removal = h.menuFor(OWNER_CARD)[0].action();
  await flush();
  h.click(h.addModelButton());
  await flush();
  release();
  await removal;
  await flush();
  assert.equal(h.row(OWNER_CARD), undefined);
  assert.equal(h.statusLine(), `Removed ${OWNER_TAG} from the library. The file is still on disk.`);
  assert.equal(Object.hasOwn(h.state.localEngines.openaiCompatible.managed.perModel, OWNER_KEY), false);
  closePicker({ ok: true, picked: false, path: '' });
  await flush();
  assert.equal(h.foldersLine(), '');
});

test('a second Add GGUF model… click while the picker is open is ignored, and the first pick lands', async () => {
  const pickers = [];
  const h = foldersHarness({ seed: { enabled: true }, chooseGguf: () => new Promise((resolve) => { pickers.push(resolve); }) });
  const button = h.addModelButton();
  h.click(button);
  h.click(button);
  await flush();
  h.click(h.addModelButton());
  await flush();
  assert.equal(pickers.length, 1);
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-disabled'), false);
  pickers[0](pickOf(QWEN_FILE));
  await flush();
  assert.equal(h.updates().length, 1);
  assert.equal(h.status(), `Added ${QWEN_TAG}.`);
  h.click(h.addModelButton());
  await flush();
  assert.equal(pickers.length, 2, 'once the pick settled, the next click opens the picker');
  pickers[1]({ ok: true, picked: false, path: '' });
  await flush();
  h.controller.dispose();
});

// Fix 6 (P06): one live region, written once per outcome, never rebuilt; the
// control that started the operation keeps (or gets back) the focus.
test('Add outcomes keep focus on Add GGUF model… and are written once into one live region', async () => {
  const cases = [
    ['already added', { seed: { enabled: true, perModel: { [QWEN_KEY]: libraryEntry(QWEN_TAG, QWEN_FILE) } }, pick: pickOf(QWEN_FILE) }, `${QWEN_TAG} is already in the library.`],
    ['picker failure', { seed: { enabled: true }, pick: { ok: false, reason: 'not_gguf' } }, 'That file is not a GGUF model.'],
    ['name taken', { seed: { enabled: true }, ollamaTags: ['qwen3:8b-q4_K_M'], pick: pickOf(QWEN_FILE) }, QWEN_TAKEN],
    ['no tag', { seed: { enabled: true }, pick: pickOf('D:\\hf\\mock-7b.gguf') }, ADD_FAILED],
    ['added', { seed: { enabled: true }, pick: pickOf(QWEN_FILE) }, `Added ${QWEN_TAG}.`],
  ];
  for (const [label, options, message] of cases) {
    const h = foldersHarness(options);
    const region = h.region();
    const button = h.addModelButton();
    button.focus();
    h.click(button);
    await flush();
    assert.equal(h.doc.activeElement, button, `${label}: focus stays on the button`);
    assert.equal(h.region(), region, `${label}: the same live region`);
    assert.deepEqual(h.liveWrites.filter(Boolean), [message], label);
    h.controller.render();
    assert.equal(h.region(), region, `${label}: render keeps the live region`);
    assert.equal(region.textContent, message, label);
    h.controller.dispose();
  }
});

test('in the section, an Add keeps one live region through every re-render and focus on its button', async (t) => {
  const h = sectionHarness(t, { seed: { enabled: true }, pick: pickOf(QWEN_FILE) });
  h.controller.bind();
  await flush();
  const regions = new Set();
  const observer = new h.windowRef.MutationObserver(() => {
    const span = h.card.querySelector('.model-library-folders-status');
    if (span && span.textContent) regions.add(span);
  });
  observer.observe(h.card, { childList: true, subtree: true, characterData: true });
  h.addModelButton().focus();
  h.click(h.addModelButton());
  await flush();
  assert.equal(h.foldersLine(), `Added ${QWEN_TAG}.`);
  assert.equal(h.doc.activeElement, h.addModelButton(), 'focus is on the re-rendered Add GGUF model… button');
  const next = JSON.parse(JSON.stringify(h.main.service.getLocalEngines()));
  next.openaiCompatible.managed.libraryRoots = ['E:\\other'];
  h.controller.syncEngineSettings(next);
  await flush();
  h.click(h.card.querySelector('[data-model-library-section-action="refresh"]'));
  await flush();
  observer.disconnect();
  assert.equal(regions.size, 1);
  assert.deepEqual(h.liveWrites.filter(Boolean), [`Added ${QWEN_TAG}.`]);
  assert.equal(h.foldersLine(), `Added ${QWEN_TAG}.`);
});

test('after Remove from library focus goes to the card in its place, or back to its own ⋯ on failure', async (t) => {
  const perModel = {};
  for (const tag of ['alpha', 'bravo', 'charlie']) perModel[tag] = libraryEntry(tag, `D:\\gguf\\${tag}.gguf`);
  const kept = new Set(); // main keeps bravo once: that Remove fails, the next one works
  const h = sectionHarness(t, {
    seed: { enabled: true, perModel },
    reply: (payload, main) => (payload.managed?.perModel?.bravo === null && kept.size === 0 && kept.add('bravo')
      ? { localEngines: main.service.getLocalEngines() } : main.updateSettings(payload)),
  });
  h.controller.bind();
  await flush();
  assert.deepEqual(h.keys(), ['alpha:latest', 'bravo:latest', 'charlie:latest']);
  const removeVia = async (key) => {
    const items = h.menuFor(key);
    h.menuButton(key).focus(); // the menu hands focus back to ⋯ before it runs the item
    await items[0].action();
    await flush();
  };
  await removeVia('alpha:latest');
  assert.deepEqual(h.keys(), ['bravo:latest', 'charlie:latest']);
  assert.equal(h.doc.activeElement, h.menuButton('bravo:latest'), 'the next card takes the focus');
  await removeVia('charlie:latest');
  assert.equal(h.doc.activeElement, h.menuButton('bravo:latest'), 'the last card hands focus to the one before it');
  await removeVia('bravo:latest');
  assert.equal(h.statusLine(), 'Could not remove bravo from the library.');
  assert.equal(h.doc.activeElement, h.menuButton('bravo:latest'), 'a failed Remove keeps focus on its own ⋯');
  await removeVia('bravo:latest');
  assert.deepEqual(h.keys(), []);
  assert.equal(h.doc.activeElement?.getAttribute('aria-pressed'), 'true', 'with no card left, the pressed filter chip');
});

// Fix 7 (P03): main routes these ids to another engine whatever the pin says.
test('a file named like an id main routes to another engine cannot be added', async () => {
  for (const file of ['D:\\hf\\GPT-5-Distill-Qwen3-8B-Q4_K_M.gguf', 'D:\\hf\\gpt-5.gguf', 'D:\\hf\\gpt-6-astra.gguf']) {
    const h = await addWith({ seed: { enabled: true }, pick: pickOf(file) });
    assert.equal(h.status(), ADD_FAILED, file);
    assert.deepEqual(h.updates(), [], file);
  }
  const near = await addWith({ seed: { enabled: true }, pick: pickOf('D:\\hf\\gpt-50.gguf') });
  assert.equal(near.status(), 'Added gpt-50.');
});

// Fix 8 (P04): the folder chooseGguf answers, never one main would reject
// (that would wipe the saved folder).
test('the Add saves the folder the picker answered, and keeps the saved one otherwise', async () => {
  const saved = { enabled: true, lastPickDir: 'D:\\gguf\\last' };
  const root = await addWith({ seed: saved, pick: pickOf('C:\\model.gguf') });
  assert.equal(root.updates()[0].managed.lastPickDir, 'C:\\');
  assert.equal(root.main.managed().lastPickDir, 'C:\\');
  for (const pick of [{ ...pickOf('C:\\model.gguf'), dir: 'C:' }, { ...pickOf('C:\\model.gguf'), dir: '' }, { ok: true, picked: true, path: 'C:\\model.gguf' }]) {
    const h = await addWith({ seed: saved, pick });
    assert.equal(Object.hasOwn(h.updates()[0].managed, 'lastPickDir'), false, JSON.stringify(pick));
    assert.equal(h.main.managed().lastPickDir, 'D:\\gguf\\last', JSON.stringify(pick));
    assert.equal(h.status(), 'Added model.');
  }
  const posix = await addWith({ seed: saved, pick: pickOf('/model.gguf') });
  assert.equal(posix.updates()[0].managed.lastPickDir, '/');
});

// Fix 9 (P08): main keeps 64 perModel entries, so a 65th would evict one.
test('with 64 saved models an Add of a new one is refused instead of evicting another', async () => {
  const perModel = {};
  for (let index = 0; index < 63; index += 1) {
    const tag = 'model-' + String(index).padStart(2, '0');
    perModel[tag] = libraryEntry(tag, `D:\\gguf\\${tag}.gguf`);
  }
  perModel['zephyr-7b'] = libraryEntry('zephyr:7b', 'D:\\gguf\\zephyr-7b.Q4_K_M.gguf');
  const full = realMain({ enabled: true, perModel });
  assert.equal(Object.keys(full.managed().perModel).length, 64);
  const refused = await addWith({ main: full, pick: pickOf('D:\\hf\\Bonsai-8B.gguf') });
  assert.equal(refused.status(), ADD_FAILED);
  assert.deepEqual(refused.updates(), []);
  assert.ok(full.managed().perModel['zephyr-7b']);
  delete perModel['model-00'];
  const roomy = realMain({ enabled: true, perModel });
  const landed = await addWith({ main: roomy, pick: pickOf('D:\\hf\\Bonsai-8B.gguf') });
  assert.equal(landed.status(), 'Added bonsai-8b.');
  assert.equal(Object.keys(roomy.managed().perModel).length, 64);
  assert.ok(roomy.managed().perModel['zephyr-7b']);
});

// Fix 10 (P10): a failed Add leaves nothing behind.
test('an Add main kept only half of is rolled back, so the name stays free', async () => {
  const h = await addWith({ seed: { enabled: true }, pick: pickOf('D:\\gguf\\foo\nbar.gguf') });
  assert.equal(h.status(), ADD_FAILED);
  assert.deepEqual(h.updates()[1], { managed: { perModel: { 'foo-bar': null } } });
  assert.equal(h.main.managed().perModel['foo-bar'], undefined);
  assert.deepEqual(h.liveWrites.filter(Boolean), [ADD_FAILED]);
  const again = await addWith({ main: h.main, pick: pickOf('D:\\gguf\\foo-bar.gguf') });
  assert.equal(again.status(), 'Added foo-bar.');
});

test('a write main did not keep needs no rollback; an unreadable answer is rolled back blind', async () => {
  const dropped = await addWith({
    seed: { enabled: true },
    pick: pickOf(QWEN_FILE),
    reply: (payload, main) => ({ localEngines: main.service.getLocalEngines() }),
  });
  assert.equal(dropped.updates().length, 1);
  assert.equal(dropped.status(), ADD_FAILED);
  for (const lose of [() => null, () => { throw new Error('reply lost'); }]) {
    let writes = 0;
    const lost = await addWith({
      seed: { enabled: true },
      pick: pickOf(QWEN_FILE),
      // Main saves the entry, but its answer never arrives.
      reply: async (payload, main) => {
        writes += 1;
        const reply = await main.updateSettings(payload);
        return writes === 1 ? lose() : reply;
      },
    });
    assert.deepEqual(lost.updates()[1], { managed: { perModel: { [QWEN_KEY]: null } } });
    assert.equal(lost.main.managed().perModel[QWEN_KEY], undefined);
    assert.equal(lost.status(), ADD_FAILED);
  }
});
