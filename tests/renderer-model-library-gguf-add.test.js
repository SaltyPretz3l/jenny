'use strict';

// W4b: GGUF folders ▸ "Add GGUF model…" writes one managed.perModel entry for a
// file on disk, and ⋯ ▸ "Remove from library" drops it again without touching
// the file. The main-process reply is simulated with the REAL settings
// normalizer, so the verify step runs against what main would echo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryFoldersController } = require('../renderer/shell/renderer-model-library-folders');
const { createModelLibrarySectionController } = require('../renderer/shell/renderer-settings-model-library-section');
const { createModelTuningDrawerController } = require('../renderer/shell/renderer-model-tuning-drawer');
const engineUtils = require('../renderer/shell/renderer-model-tuning-engine-utils');
const drawerFactory = require('../renderer/inventory/drawer');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const segmentedControl = require('../renderer/inventory/segmented-control');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const { normalizeLocalEngines } = require('../services/shell-config-engines');

const OWNER_DIR = 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b';
const OWNER_FILE = OWNER_DIR + '\\Ternary-Bonsai-2-27B-PQ2_0.gguf';
const OWNER_TAG = 'ternary-bonsai-2-27b-pq2_0';
const OWNER_KEY = 'ternary-bonsai-2-27b-pq2-0';
const OWNER_CARD = 'ternary-bonsai-2-27b-pq2_0:latest';
const QWEN_FILE = 'D:\\gguf\\Qwen3-8B.gguf';
const NOT_MAIN = "That file is a vision projector or MTP drafter, not a model. Choose the model's main .gguf file.";
const REMOVED = 'Removed ternary-bonsai-2-27b-pq2_0 from the library. The file is still on disk.';
const REMOVE_FAILED = 'Could not remove ternary-bonsai-2-27b-pq2_0 from the library.';

async function flush() {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function pickOf(filePath) {
  return { ok: true, picked: true, path: filePath, dir: filePath.replace(/[\\/][^\\/]*$/, ''), drafterGguf: '' };
}

function libraryEntry(tag, modelPath) {
  return { engine: 'llama-server', tag, modelPath, mtp: { mode: 'off', draftNMax: 4 } };
}

// Main's engines.updateSettings: a per-key perModel merge (null deletes), then
// the persisted-settings normalizer, echoed back as the full localEngines.
function mainReply(current, patch) {
  const perModel = { ...(current?.perModel || {}) };
  for (const [key, entry] of Object.entries(patch?.perModel || {})) {
    if (entry === null) delete perModel[key];
    else perModel[key] = entry;
  }
  return { localEngines: normalizeLocalEngines({ openaiCompatible: { managed: { ...current, ...patch, perModel } } }) };
}

function foldersHarness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="folders"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  const statuses = [];
  // Every message the row's own status span carries: markup it is rendered
  // with, or text written into it.
  const shown = [];
  const html = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  Object.defineProperty(dom.window.document.getElementById('folders'), 'innerHTML', {
    get() { return html.get.call(this); },
    set(value) {
      html.set.call(this, value);
      shown.push(this.querySelector('.model-library-folders-status')?.textContent || '');
    },
  });
  const text = Object.getOwnPropertyDescriptor(dom.window.Node.prototype, 'textContent');
  Object.defineProperty(dom.window.Node.prototype, 'textContent', {
    configurable: true,
    get() { return text.get.call(this); },
    set(value) {
      if (this.classList?.contains('model-library-folders-status')) shown.push(String(value));
      text.set.call(this, value);
    },
  });
  const library = {
    managed: { enabled: true, lastPickDir: '', libraryRoots: [], perModel: {}, ...(options.managed || {}) },
    ollamaTags: options.ollamaTags || [],
    installed: options.installed || [],
  };
  dom.window.jennyShell = {
    llamaServer: options.noPicker ? {} : {
      chooseGguf: options.chooseGguf || (async (payload) => { calls.push(['chooseGguf', payload]); return options.pick; }),
    },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
        return options.reply ? options.reply(payload, library.managed) : mainReply(library.managed, payload.managed);
      },
    },
    models: { async delete(payload) { calls.push(['delete', payload]); } },
  };
  const controller = createModelLibraryFoldersController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    getRoots: () => library.managed.libraryRoots,
    getLibrary: () => library,
    onSettings: (localEngines) => calls.push(['settings', localEngines]),
    refresh: () => {
      calls.push(['refresh']);
      return options.refreshFails ? Promise.reject(new Error('load failed')) : Promise.resolve();
    },
    // The host's status line (the section's), which only Remove may use.
    ...(options.noSetStatus ? {} : { setStatus: (message) => statuses.push(message) }),
    hostId: 'folders',
  });
  controller.bind();
  controller.render();
  return { dom, controller, calls, statuses, library, announced: () => shown.filter(Boolean) };
}

// Add GGUF model… reports beside its buttons, like Add folder…, once per
// outcome, and never on the host's status line.
function said(h) {
  assert.deepEqual(h.statuses, [], 'nothing reaches the host status line');
  return h.announced();
}

async function clickAddModel(h) {
  const button = h.dom.window.document.querySelector('[data-model-library-folder-action="add-model"]');
  assert.ok(button, 'the Add GGUF model… button renders');
  button.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  await flush();
}

async function addWith(options) {
  const h = foldersHarness(options);
  await clickAddModel(h);
  h.controller.dispose();
  return h;
}

const kinds = (h) => h.calls.map((entry) => entry[0]);
const updates = (h) => h.calls.filter((entry) => entry[0] === 'update').map((entry) => entry[1]);

test('Add folder… and Add GGUF model… share one actions line in the GGUF folders row', () => {
  const h = foldersHarness();
  const row = h.dom.window.document.querySelector('.model-library-folders');
  assert.deepEqual([...row.children].map((child) => child.className), [
    'model-library-folders-title', 'model-library-folders-list', 'model-library-folders-actions', 'model-library-folders-status',
  ]);
  const buttons = [...row.querySelector('.model-library-folders-actions').children];
  assert.deepEqual(buttons.map((button) => button.textContent), ['Add folder…', 'Add GGUF model…']);
  assert.deepEqual(buttons.map((button) => button.className), ['btn btn--sm', 'btn btn--sm']);
  assert.deepEqual(buttons.map((button) => button.dataset.modelLibraryFolderAction), ['add', 'add-model']);
  h.controller.dispose();
});

test('a cancelled pick writes nothing and shows no status', async () => {
  for (const pick of [{ ok: true, picked: false, path: '' }, { ok: true }, null, undefined]) {
    const h = await addWith({ pick });
    assert.deepEqual(kinds(h), ['chooseGguf'], JSON.stringify(pick));
    assert.deepEqual(said(h), []);
    assert.equal(h.dom.window.document.querySelector('.model-library-folders-status').textContent, '');
  }
});

test('the picker opens at the last pick folder, else the first library root', async () => {
  const cases = [
    [{ lastPickDir: 'D:\\gguf\\last', libraryRoots: ['E:\\lib'] }, 'D:\\gguf\\last'],
    [{ lastPickDir: '', libraryRoots: ['E:\\lib', 'F:\\more'] }, 'E:\\lib'],
    [{ lastPickDir: '', libraryRoots: [] }, ''],
  ];
  for (const [managed, defaultPath] of cases) {
    const h = await addWith({ managed, pick: { ok: true, picked: false, path: '' } });
    assert.deepEqual(h.calls[0], ['chooseGguf', { defaultPath }]);
  }
});

test('a picked model is written with the exact payload, verified, synced and announced', async () => {
  const h = await addWith({ pick: pickOf(OWNER_FILE) });
  assert.deepEqual(updates(h), [{
    managed: {
      enabled: true,
      lastPickDir: OWNER_DIR,
      perModel: { [OWNER_KEY]: { engine: 'llama-server', tag: OWNER_TAG, modelPath: OWNER_FILE, mtp: { mode: 'off' } } },
    },
  }]);
  // Synced first, then ONE refresh re-lists local GGUFs (the new file's size).
  assert.deepEqual(kinds(h), ['chooseGguf', 'update', 'settings', 'refresh']);
  const synced = h.calls.find((entry) => entry[0] === 'settings')[1];
  assert.equal(synced.openaiCompatible.managed.perModel[OWNER_KEY].modelPath, OWNER_FILE);
  // Announced exactly once, beside the buttons.
  assert.deepEqual(said(h), ['Added ternary-bonsai-2-27b-pq2_0.']);
});

test('a refresh that fails never turns a reflected Add into a failure', async () => {
  const h = await addWith({ pick: pickOf(OWNER_FILE), refreshFails: true });
  assert.deepEqual(kinds(h), ['chooseGguf', 'update', 'settings', 'refresh']);
  assert.deepEqual(said(h), ['Added ternary-bonsai-2-27b-pq2_0.']);
});

test('only a reflected Add refreshes: every other outcome leaves the library lists alone', async () => {
  const outcomes = [
    ['cancel', { pick: { ok: true, picked: false, path: '' } }],
    ['picker failure', { pick: { ok: false, reason: 'not_gguf' } }],
    ['projector', { pick: pickOf(OWNER_DIR + '\\mmproj-Ternary-Bonsai-2-27B-F16.gguf') }],
    ['no tag', { pick: pickOf('G:\\models\\mock-7b.gguf') }],
    ['already added', { pick: pickOf(QWEN_FILE), managed: { perModel: { 'qwen3-8b': libraryEntry('qwen3-8b', QWEN_FILE) } } }],
    ['name taken', { pick: pickOf(QWEN_FILE), ollamaTags: ['qwen3:8b'] }],
    ['not reflected', { pick: pickOf(OWNER_FILE), reply: (payload, managed) => mainReply(managed, {}) }],
    ['write threw', { pick: pickOf(OWNER_FILE), reply: () => { throw new Error('ipc down'); } }],
  ];
  for (const [label, options] of outcomes) {
    const h = await addWith(options);
    assert.equal(kinds(h).includes('refresh'), false, label);
  }
});

test('picker failures read not_gguf as not a GGUF and anything else as a picker failure', async () => {
  const cases = [
    [{ pick: { ok: false, reason: 'not_gguf' } }, 'That file is not a GGUF model.'],
    [{ pick: { ok: false, reason: 'EACCES: permission denied' } }, 'Could not open the file picker.'],
    [{ pick: { ok: false } }, 'Could not open the file picker.'],
    [{ chooseGguf: async () => { throw new Error('dialog failed'); } }, 'Could not open the file picker.'],
    [{ noPicker: true }, 'Could not open the file picker.'],
  ];
  for (const [options, message] of cases) {
    const h = await addWith(options);
    assert.deepEqual(updates(h), []);
    assert.deepEqual(said(h), [message]);
  }
});

test('a vision projector or MTP drafter pick is refused before any write', async () => {
  for (const file of [
    OWNER_DIR + '\\Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    OWNER_DIR + '\\mmproj-Ternary-Bonsai-2-27B-F16.gguf',
    'G:\\models\\gemma4\\mtp-gemma4.gguf',
    'G:\\models\\bonsai\\Bonsai mmproj F16.gguf',
  ]) {
    const h = await addWith({ pick: pickOf(file) });
    assert.deepEqual(updates(h), [], file);
    assert.deepEqual(said(h), [NOT_MAIN], file);
  }
});

test('a file that yields no tag cannot be added', async () => {
  for (const file of ['G:\\models\\mock-7b.gguf', 'G:\\---.gguf', 'G:\\m\\' + 'z'.repeat(129) + '.gguf']) {
    const h = await addWith({ pick: pickOf(file) });
    assert.deepEqual(updates(h), [], file);
    assert.deepEqual(said(h), ['Could not add the model.'], file);
  }
});

test('collisions are checked in order: same file, same name, then an Ollama or installed owner', async () => {
  const taken = 'Another model is already named qwen3-8b. Rename the file, then add it.';
  const pick = pickOf(QWEN_FILE);
  const cases = [
    // 1. The same key already names this very file (any separator or drive case),
    //    even when Ollama also lists the name: nothing to add.
    [{ managed: { perModel: { 'qwen3-8b': libraryEntry('qwen3-8b', 'd:/GGUF/qwen3-8b.GGUF') } }, ollamaTags: ['qwen3:8b'] },
      'qwen3-8b is already in the library.'],
    [{ managed: { perModel: { 'qwen3-8b': libraryEntry('qwen3:8b', QWEN_FILE) } } }, 'qwen3:8b is already in the library.'],
    // 2. The same key names another file.
    [{ managed: { perModel: { 'qwen3-8b': libraryEntry('qwen3:8b', 'D:\\other\\Qwen3-8B-Q8_0.gguf') } } }, taken],
    [{ managed: { perModel: { 'qwen3-8b': { engine: 'ollama', tag: 'qwen3:8b', modelPath: '', mtp: { mode: 'off' } } } } }, taken],
    // 3. An Ollama tag or an installed card owns the key.
    [{ ollamaTags: ['qwen3:8b'] }, taken],
    [{ ollamaTags: [{ name: 'Qwen3:8B', size: 5 }] }, taken],
    [{ installed: [{ id: 'qwen3:8b', engine_type: 'vllm' }] }, taken],
    [{ installed: [{ id: 'qwen3-8b', engine_type: 'openai-compatible' }] }, taken],
  ];
  for (const [options, message] of cases) {
    const h = await addWith({ pick, ...options });
    assert.deepEqual(updates(h), [], message);
    assert.deepEqual(said(h), [message]);
  }
  // Neighbours under other keys are no collision.
  const h = await addWith({ pick, ollamaTags: ['qwen3:14b'], installed: [{ id: 'qwen3:14b', engine_type: 'ollama' }] });
  assert.equal(updates(h).length, 1);
  assert.deepEqual(said(h), ['Added qwen3-8b.']);
});

test('a name that would share another model\'s card is taken too', async () => {
  // "mistral" and "mistral:latest" are one card under two perModel keys.
  const pick = pickOf('D:\\gguf\\Mistral.gguf');
  const taken = 'Another model is already named mistral. Rename the file, then add it.';
  for (const options of [
    { ollamaTags: ['mistral:latest'] },
    { installed: [{ id: 'mistral:latest', engine_type: 'ollama' }] },
    { managed: { perModel: { 'mistral-latest': libraryEntry('mistral:latest', 'D:\\other\\Mistral-Q8_0.gguf') } } },
  ]) {
    const h = await addWith({ pick, ...options });
    assert.deepEqual(updates(h), [], JSON.stringify(options));
    assert.deepEqual(said(h), [taken], JSON.stringify(options));
  }
  const same = await addWith({ pick, managed: { perModel: { 'mistral-latest': libraryEntry('mistral:latest', 'd:/GGUF/mistral.gguf') } } });
  assert.deepEqual(updates(same), []);
  assert.deepEqual(said(same), ['mistral:latest is already in the library.']);
});

test('a write the runtime does not reflect reports addFailed', async () => {
  const dropped = await addWith({ pick: pickOf(OWNER_FILE), reply: (payload, managed) => mainReply(managed, {}) });
  assert.deepEqual(said(dropped), ['Could not add the model.']);
  // The echo is still the truth: the library mirrors it.
  assert.deepEqual(kinds(dropped), ['chooseGguf', 'update', 'settings']);

  const renamed = await addWith({
    pick: pickOf(OWNER_FILE),
    reply: (payload, managed) => mainReply(managed, {
      perModel: { [OWNER_KEY]: { ...payload.managed.perModel[OWNER_KEY], tag: 'Ternary-Bonsai-2-27B-PQ2_0' } },
    }),
  });
  assert.deepEqual(said(renamed), ['Could not add the model.']);

  for (const reply of [() => { throw new Error('ipc down'); }, () => null, () => ({ ok: false })]) {
    const h = await addWith({ pick: pickOf(OWNER_FILE), reply });
    assert.deepEqual(said(h), ['Could not add the model.']);
    assert.equal(kinds(h).includes('settings'), false);
  }
});

test('a pick that settles after dispose writes nothing', async () => {
  let settlePick;
  const h = foldersHarness({ chooseGguf: () => new Promise((resolve) => { settlePick = resolve; }) });
  h.dom.window.document.querySelector('[data-model-library-folder-action="add-model"]')
    .dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  h.controller.dispose();
  settlePick(pickOf(OWNER_FILE));
  await flush();
  assert.deepEqual(updates(h), []);
  assert.deepEqual(said(h), []);
});

test('removeLibraryModel sends only the null entry and never deletes the file', async () => {
  const h = foldersHarness({ managed: { lastUsedTag: OWNER_KEY, perModel: { [OWNER_KEY]: libraryEntry(OWNER_TAG, OWNER_FILE) } } });
  assert.equal(await h.controller.removeLibraryModel(OWNER_TAG), true);
  assert.deepEqual(updates(h), [{ managed: { perModel: { [OWNER_KEY]: null } } }]);
  assert.equal(kinds(h).includes('delete'), false);
  const synced = h.calls.find((entry) => entry[0] === 'settings')[1];
  assert.equal(Object.hasOwn(synced.openaiCompatible.managed.perModel, OWNER_KEY), false);
  // Remove runs from a card's ⋯ menu: it reports on the host's status line.
  assert.deepEqual(h.statuses, [REMOVED]);
  assert.deepEqual(h.announced(), []);
  h.controller.dispose();
  // With no host line it falls back to the row's own span.
  const own = foldersHarness({ noSetStatus: true, managed: { perModel: { [OWNER_KEY]: libraryEntry(OWNER_TAG, OWNER_FILE) } } });
  assert.equal(await own.controller.removeLibraryModel(OWNER_TAG), true);
  assert.deepEqual(own.announced(), [REMOVED]);
  own.controller.dispose();
});

test('removeLibraryModel fails unless the returned perModel has lost the key', async () => {
  const managed = { perModel: { [OWNER_KEY]: libraryEntry(OWNER_TAG, OWNER_FILE) } };
  for (const reply of [
    (payload, current) => mainReply(current, {}),
    () => { throw new Error('ipc down'); },
    () => ({ ok: false }),
    () => ({ localEngines: { openaiCompatible: { managed: {} } } }),
  ]) {
    const h = foldersHarness({ managed, reply });
    assert.equal(await h.controller.removeLibraryModel(OWNER_TAG), false);
    assert.deepEqual(updates(h), [{ managed: { perModel: { [OWNER_KEY]: null } } }]);
    assert.deepEqual(h.statuses, [REMOVE_FAILED]);
    h.controller.dispose();
  }
});

function sectionHarness(t, options = {}) {
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
  const state = {
    features: { featureFlags: { model_management_ui: true, llama_server_acceleration: true } },
    localEngines: normalizeLocalEngines({ openaiCompatible: { managed: {
      enabled: true, perModel: options.perModel || { [OWNER_KEY]: libraryEntry(OWNER_TAG, OWNER_FILE) },
    } } }),
    status: { model: options.activeModel || '' },
    offline: { preferredLocalModel: '' },
    ui: { activeSettingsSection: 'models' },
  };
  let saved = state.localEngines; // main's own copy of the settings
  windowRef.jennyShell = {
    models: {
      list: async () => ({ data: options.installed || [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }] }),
      listOllamaTags: async () => ({ data: options.ollamaTags || [] }),
      delete: async (payload) => { calls.push(['delete', payload]); return { status: 'deleted' }; },
    },
    offline: { getDiagnostics: async () => ({ modelRecommendations: [] }) },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
        const reply = mainReply(saved.openaiCompatible.managed, payload.managed);
        saved = reply.localEngines;
        return reply;
      },
    },
    llamaServer: {
      // Main's `persisted` source: each SAVED model path whose file is on disk
      // (options.fileSizes) is listed under its own folder.
      listLocalGgufs: async () => {
        calls.push(['listLocalGgufs']);
        const sizes = options.fileSizes || {};
        return { ok: true, entries: Object.values(saved.openaiCompatible.managed.perModel)
          .filter((entry) => sizes[entry.modelPath])
          .map((entry) => ({
            tag: entry.tag,
            source: 'persisted',
            dir: entry.modelPath.replace(/[\\/][^\\/]*$/, ''),
            mainGguf: entry.modelPath.split(/[\\/]/).pop(),
            drafterGguf: '',
            sizeBytes: sizes[entry.modelPath],
          })) };
      },
      getStatus: async () => ({ ok: true, state: 'stopped', ...(options.status || {}) }),
      chooseGguf: async () => options.pick || { ok: true, picked: false, path: '' },
    },
    features: { onChanged: () => () => {} },
  };
  const controller = createModelLibrarySectionController({
    state,
    windowRef,
    documentRef: windowRef.document,
    openModelTuning: (...args) => calls.push(['tune', ...args]),
    setupService: { subscribePullProgress: () => () => {} },
    inventoryContextMenu: { show(config) { calls.push(['menu', config]); }, hide() {} },
  });
  t.after(() => controller.dispose());
  const card = windowRef.document.querySelector('.settings-card');
  const row = (key) => [...card.querySelectorAll('[data-model-key]')].find((el) => el.getAttribute('data-model-key') === key);
  const click = (element) => element.dispatchEvent(new windowRef.MouseEvent('click', { bubbles: true }));
  const menuFor = (key) => {
    click(row(key).querySelector('[data-model-card-action="menu"]'));
    return calls.filter((entry) => entry[0] === 'menu').pop()[1].items;
  };
  const statusLine = () => card.querySelector('.model-library-section-status').textContent;
  // Every write to the section status line, and the GGUF folders row's own span.
  const lineWrites = [];
  const text = Object.getOwnPropertyDescriptor(windowRef.Node.prototype, 'textContent');
  Object.defineProperty(card.querySelector('.model-library-section-status'), 'textContent', {
    get() { return text.get.call(this); },
    set(value) {
      lineWrites.push(String(value));
      text.set.call(this, value);
    },
  });
  const foldersLine = () => card.querySelector('.model-library-folders-status').textContent;
  return { controller, windowRef, calls, state, card, row, click, menuFor, statusLine, lineWrites, foldersLine };
}

test('a Local GGUF card menu leads with Remove from library, which drops only the entry', async (t) => {
  const h = sectionHarness(t);
  h.controller.bind();
  await flush();
  const items = h.menuFor(OWNER_CARD);
  assert.deepEqual(items.map((item) => item.label), ['Remove from library', 'Copy tag']);
  assert.equal(items[0].danger, true);
  assert.equal(items[0].disabled, false);
  await items[0].action();
  await flush();
  assert.deepEqual(h.calls.filter((entry) => entry[0] === 'update').map((entry) => entry[1]),
    [{ managed: { perModel: { [OWNER_KEY]: null } } }]);
  assert.equal(h.calls.some((entry) => entry[0] === 'delete'), false);
  assert.equal(h.statusLine(), REMOVED);
  assert.equal(h.foldersLine(), '');
  assert.equal(h.row(OWNER_CARD), undefined);
  assert.ok(h.row('installed:1b'));
});

test('Remove from library is disabled while the model is active or serving', async (t) => {
  const active = sectionHarness(t, { activeModel: OWNER_TAG });
  const serving = sectionHarness(t, { status: { state: 'ready', alias: OWNER_TAG, port: 8093 } });
  active.controller.bind();
  serving.controller.bind();
  await flush();
  for (const h of [active, serving]) {
    const items = h.menuFor(OWNER_CARD);
    assert.deepEqual(items.map((item) => item.label), ['Remove from library', 'Copy tag']);
    assert.equal(items[0].disabled, true);
  }
});

test('every other card keeps Remove… and never offers Remove from library', async (t) => {
  const h = sectionHarness(t, {
    installed: [{ id: 'installed:1b', size: 1024, engine_type: 'ollama' }, { id: 'served:7b', engine_type: 'openai-compatible' }],
  });
  h.controller.bind();
  await flush();
  const ollama = h.menuFor('installed:1b');
  assert.deepEqual(ollama.map((item) => item.label), ['Remove…', 'Copy tag']);
  assert.equal(ollama[0].disabled, false);
  const served = h.menuFor('served:7b');
  assert.deepEqual(served.map((item) => item.label), ['Remove…', 'Copy tag']);
  assert.equal(served[0].disabled, true);
});

test('Tune passes engineTypeHint for Local GGUF cards only', async (t) => {
  const h = sectionHarness(t);
  h.controller.bind();
  await flush();
  h.click(h.row(OWNER_CARD).querySelector('[data-model-card-action="tune"]'));
  h.click(h.row('installed:1b').querySelector('[data-model-card-action="tune"]'));
  const tunes = h.calls.filter((entry) => entry[0] === 'tune');
  assert.deepEqual(tunes.map((entry) => [entry[1], entry[3].engineTypeHint]),
    [[OWNER_TAG, 'openai-compatible'], ['installed:1b', '']]);
  assert.equal(tunes[0][3].displayName, OWNER_TAG);
  assert.equal(tunes[0][3].engines.llamaServer.modelPath, OWNER_FILE);
});

test('Add GGUF model… in the section lands the card and reports beside its button', async (t) => {
  const h = sectionHarness(t, { perModel: {}, pick: pickOf(OWNER_FILE) });
  h.controller.bind();
  await flush();
  assert.equal(h.row(OWNER_CARD), undefined);
  h.click(h.card.querySelector('[data-model-library-folder-action="add-model"]'));
  await flush();
  assert.equal(h.foldersLine(), 'Added ternary-bonsai-2-27b-pq2_0.');
  assert.deepEqual(h.lineWrites.filter(Boolean), [], 'the section line never carries an Add outcome');
  assert.match(h.row(OWNER_CARD).querySelector('.model-row-meta').textContent, /^Local GGUF · /);

  const taken = sectionHarness(t, { perModel: {}, pick: pickOf(QWEN_FILE), ollamaTags: [{ name: 'qwen3:8b' }] });
  taken.controller.bind();
  await flush();
  taken.click(taken.card.querySelector('[data-model-library-folder-action="add-model"]'));
  await flush();
  assert.equal(taken.foldersLine(), 'Another model is already named qwen3-8b. Rename the file, then add it.');
  assert.deepEqual(taken.lineWrites.filter(Boolean), []);
  assert.equal(taken.calls.some((entry) => entry[0] === 'update'), false);
});

test('a file outside every GGUF folder shows its size right after Add, and the status stays', async (t) => {
  const h = sectionHarness(t, { perModel: {}, pick: pickOf(OWNER_FILE), fileSizes: { [OWNER_FILE]: 7206168928 } });
  h.controller.bind();
  await flush();
  const lists = () => h.calls.filter((entry) => entry[0] === 'listLocalGgufs').length;
  const before = lists();
  h.click(h.card.querySelector('[data-model-library-folder-action="add-model"]'));
  await flush();
  assert.equal(lists() - before, 1, 'exactly one refresh re-lists local GGUFs');
  assert.equal(h.row(OWNER_CARD).querySelector('.model-row-meta').textContent, 'Local GGUF · 6.7 GB');
  // The refresh rewrites only the section line, so the announcement beside the
  // buttons still stands, and the section line never carried it.
  assert.equal(h.foldersLine(), 'Added ternary-bonsai-2-27b-pq2_0.');
  assert.deepEqual(h.lineWrites.filter(Boolean), []);
});

// The two below exercise the Tune drawer side of W4b (engineTypeHint and the
// no-Ollama hint), which the W4-B slice implements in the drawer and its utils.
test('Tune on an unserved Local GGUF card opens the Engine section with Apply live', async (t) => {
  const h = sectionHarness(t);
  h.controller.bind();
  await flush();
  h.click(h.row(OWNER_CARD).querySelector('[data-model-card-action="tune"]'));
  const [, modelId, , options] = h.calls.find((entry) => entry[0] === 'tune');

  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  dom.window.jennyShell = {
    modelTuning: { getState: async () => ({ contextLengthSteps: [4096, 8192] }), update: async () => ({ status: 'applied' }) },
    engines: { getSettings: async () => ({ localEngines: h.state.localEngines, accelerationCatalog: { families: [] } }) },
    llamaServer: { listLocalGgufs: async () => ({ ok: true, entries: [] }), getStatus: async () => ({ ok: true, state: 'stopped' }) },
  };
  const drawer = createModelTuningDrawerController({
    // A Local GGUF that is not served is in no model list and is not the active model.
    state: { features: { featureFlags: { llama_server_acceleration: true } }, modelList: { data: [] }, status: { model: '' } },
    windowRef: dom.window,
    documentRef: dom.window.document,
    drawerFactory,
    inventory: { selectField, textField, actionButton, segmentedControl, toggleSwitch },
  });
  t.after(() => drawer.dispose());
  await drawer.open(modelId, null, options);
  const host = dom.window.document.getElementById('modelTuningDrawer');
  assert.ok(host.querySelector('[data-model-tuning-engine]'), 'the Engine section renders');
  assert.equal(host.querySelector('.model-tuning-drawer-warning'), null);
  const temperature = host.querySelector('[data-model-tuning-field="temperature"]');
  temperature.value = '0.5';
  temperature.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(host.querySelector('[data-action="save-model-tuning"]').disabled, false);
});

test('the Engine hint says why Ollama is greyed out, and only then', () => {
  const hint = (ollamaAvailable) => JSDOM.fragment(engineUtils.buildEngineSectionHtml({
    view: { ollamaAvailable, effectiveModelPath: OWNER_FILE, eligible: false, familyMtp: 'no', ggufEntry: null },
    draft: { engine: 'llama-server', mtp: false, modelPath: OWNER_FILE },
    pending: false,
    statusText: '',
    segmentedControl: segmentedControl.segmentedControl || segmentedControl,
    toggleSwitch: toggleSwitch.toggleSwitch || toggleSwitch,
    actionButton,
    escapeHtml: actionButton.escapeHtml,
  })).querySelector('.model-tuning-section-hint').textContent;
  assert.equal(hint(false), "Ollama doesn't have this model, so it runs on Jenny's own llama-server.");
  assert.equal(hint(true), "Ollama or Jenny's own llama-server. llama-server can speed up verified models with multi-token prediction.");
});
