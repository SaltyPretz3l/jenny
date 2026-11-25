'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createModelLibraryFoldersController,
} = require('../renderer/shell/renderer-model-library-folders');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createHarness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="folders"></div></body>', {
    url: 'http://localhost/',
  });
  let roots = options.roots || [];
  let runtimeRoots = options.runtimeRoots || [];
  const calls = [];
  const chooseLibraryFolder = options.chooseLibraryFolder
    || (async () => ({ ok: true, picked: false, path: '' }));
  dom.window.jennyShell = {
    llamaServer: { chooseLibraryFolder, ...(options.runtime || {}) },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
        await options.updateGate?.();
        if (payload.managed.runtimeRoots) runtimeRoots = payload.managed.runtimeRoots;
        return {
          localEngines: { openaiCompatible: { managed: payload.managed } },
        };
      },
    },
  };
  const controller = createModelLibraryFoldersController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    getRoots: () => roots,
    getLibrary: () => ({ managed: { runtimeRoots } }),
    onSettings: (localEngines) => calls.push(['settings', localEngines]),
    refresh: () => calls.push(['refresh']),
    hostId: 'folders',
  });
  controller.bind();
  return {
    dom,
    controller,
    calls,
    setRoots(nextRoots) { roots = nextRoots; },
  };
}

function click(harness, selector) {
  harness.dom.window.document.querySelector(selector).dispatchEvent(
    new harness.dom.window.MouseEvent('click', { bubbles: true })
  );
}

test('renders roots and the empty-state guidance', () => {
  const harness = createHarness({ roots: ['C:\\models\\one', 'D:\\models\\two'] });
  harness.controller.render();
  const documentRef = harness.dom.window.document;
  assert.equal(documentRef.querySelector('.model-library-folders-title').textContent, 'GGUF folders');
  assert.deepEqual(
    [...documentRef.querySelectorAll('.model-library-folders-path')].map((node) => node.textContent),
    ['C:\\models\\one', 'D:\\models\\two']
  );
  assert.equal(documentRef.querySelectorAll('[data-model-library-folder-remove]').length, 2);

  harness.setRoots([]);
  harness.controller.render();
  assert.match(documentRef.querySelector('.model-library-folders-empty').textContent, /No folders yet/);
  harness.controller.dispose();
});

test('Add chooses a folder, updates roots, syncs settings, and refreshes', async () => {
  const harness = createHarness({
    roots: ['C:\\models'],
    chooseLibraryFolder: async () => ({ ok: true, picked: true, path: 'D:\\gguf' }),
  });
  harness.controller.render();
  click(harness, '[data-model-library-folder-action="add"]');
  await flush();

  assert.deepEqual(harness.calls, [
    ['update', { managed: { libraryRoots: ['C:\\models', 'D:\\gguf'] } }],
    ['settings', { openaiCompatible: { managed: { libraryRoots: ['C:\\models', 'D:\\gguf'] } } }],
    ['refresh'],
  ]);
  harness.controller.dispose();
});

test('Remove updates settings with the indexed root filtered out', async () => {
  const harness = createHarness({ roots: ['C:\\one', 'D:\\two', 'E:\\three'] });
  harness.controller.render();
  click(harness, '[data-model-library-folder-remove="1"]');
  await flush();

  assert.deepEqual(harness.calls[0], [
    'update',
    { managed: { libraryRoots: ['C:\\one', 'E:\\three'] } },
  ]);
  harness.controller.dispose();
});

test('rapid folder removals serialize against acknowledged roots without resurrecting a folder', async (t) => {
  const harness = createHarness({ roots: ['C:/one', 'D:/two'] });
  t.after(() => { harness.controller.dispose(); harness.dom.window.close(); });
  const pending = [];
  const writes = [];
  harness.dom.window.jennyShell.engines.updateSettings = (payload) => {
    writes.push(payload.managed.libraryRoots);
    const response = deferred();
    pending.push(() => {
      harness.setRoots(payload.managed.libraryRoots);
      response.resolve({ localEngines: { openaiCompatible: { managed: payload.managed } } });
    });
    return response.promise;
  };
  harness.controller.render();
  click(harness, '[data-model-library-folder-remove="0"]');
  click(harness, '[data-model-library-folder-remove="1"]');
  await flush();
  assert.equal(writes.length, 1, 'only one folder write is in flight');
  pending.shift()();
  await flush();
  assert.deepEqual(writes, [['D:/two'], []]);
  pending.shift()();
  await flush();
  harness.controller.render();
  assert.equal(harness.dom.window.document.querySelectorAll('.model-library-folders-path').length, 0);
});

test('a cancelled picker does not update settings', async () => {
  const harness = createHarness({
    chooseLibraryFolder: async () => ({ ok: true, picked: false, path: '' }),
  });
  harness.controller.render();
  click(harness, '[data-model-library-folder-action="add"]');
  await flush();

  assert.deepEqual(harness.calls, []);
  harness.controller.dispose();
});

test('picker failure renders a bounded status message', async () => {
  const harness = createHarness({
    chooseLibraryFolder: async () => { throw new Error('dialog failed'); },
  });
  harness.controller.render();
  click(harness, '[data-model-library-folder-action="add"]');
  await flush();

  assert.equal(
    harness.dom.window.document.querySelector('.model-library-folders-status').textContent,
    'Could not open the folder picker.'
  );
  harness.controller.dispose();
});

test('a network folder says how to use it and saves nothing', async (t) => {
  const harness = createHarness({
    chooseLibraryFolder: async () => ({ ok: false, reason: 'network_path' }),
  });
  t.after(() => harness.controller.dispose());
  harness.controller.render();
  click(harness, '[data-model-library-folder-action="add"]');
  await flush();

  assert.deepEqual(harness.calls, []);
  assert.equal(
    harness.dom.window.document.querySelector('.model-library-folders-status').textContent,
    "Jenny can't use network locations here. Map the share to a drive letter, then choose it from that drive."
  );
});

test('dispose ignores a late picker result', async () => {
  const picker = deferred();
  const harness = createHarness({ chooseLibraryFolder: () => picker.promise });
  harness.controller.render();
  click(harness, '[data-model-library-folder-action="add"]');
  harness.controller.dispose();
  picker.resolve({ ok: true, picked: true, path: 'D:\\late' });
  await flush();

  assert.deepEqual(harness.calls, []);
});

test('addModel is exposed so the Manage drawer or the Library can start an Add GGUF model pick', async () => {
  const h = createHarness();
  assert.equal(typeof h.controller.addModel, 'function');
  // No file picker on the bridge: the pick reports itself instead of throwing.
  await h.controller.addModel();
});

// ---- Row 142: the "llama-server builds" list under the GGUF folders ----

const RUNTIME_BLOCK = '[data-runtime-folders]';
const runtimeText = (harness, selector) => [...harness.dom.window.document.querySelectorAll(`${RUNTIME_BLOCK} ${selector}`)].map((node) => node.textContent);
const status = (harness) => harness.dom.window.document.querySelector('.model-library-folders-status').textContent;

function runtimeBridge(extra = {}) {
  return {
    chooseRuntimeFolder: async () => ({ ok: true, picked: true, path: 'D:\\new-builds' }),
    runtimeFolderSummary: async () => ({ ok: true, folders: [] }),
    ...extra,
  };
}

test('runtime folders list their saved folders, with what Jenny found once main has said', async () => {
  const harness = createHarness({
    runtimeRoots: ['D:\\r1', 'E:\\r2', 'F:\\r3'],
    runtime: runtimeBridge({
      runtimeFolderSummary: async () => ({ ok: true, folders: [{ path: 'D:\\r1', builds: 3, newest: 12098 }, { path: 'E:\\r2', builds: 1, newest: 12098 }, { path: 'F:\\r3', builds: 0, newest: 0 }] }),
    }),
  });
  harness.controller.render();
  assert.deepEqual(runtimeText(harness, '.model-library-folders-title'), ['llama-server builds']);
  assert.deepEqual(runtimeText(harness, '.model-library-folders-path'), ['D:\\r1', 'E:\\r2', 'F:\\r3']);
  assert.deepEqual(runtimeText(harness, '.model-library-folders-builds'), [], 'no counts while the summary is pending');
  await flush();
  assert.deepEqual(runtimeText(harness, '.model-library-folders-builds'), ['3 builds · newest 12098', '1 build · 12098', 'No builds found']);
  assert.equal(harness.dom.window.document.querySelectorAll(`${RUNTIME_BLOCK} [data-runtime-folder-remove]`).length, 3);
  harness.controller.dispose();
});

test('with no runtime folder the list says what Jenny uses instead', () => {
  const harness = createHarness({ runtime: runtimeBridge() });
  harness.controller.render();
  assert.match(runtimeText(harness, '.model-library-folders-empty')[0], /^None yet · Jenny uses the bundled build and any build you chose in Tune\./);
  harness.controller.dispose();
});

test('Add runtime folder opens the dialog first, then saves the list with the picked folder appended', async () => {
  const harness = createHarness({ runtimeRoots: ['D:\\r1'], runtime: runtimeBridge() });
  harness.controller.render();
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  const updates = harness.calls.filter((call) => call[0] === 'update');
  assert.deepEqual(updates.map((call) => call[1]), [{ managed: { runtimeRoots: ['D:\\r1', 'D:\\new-builds'] } }]);
  assert.equal(status(harness), 'Added D:\\new-builds.');
  assert.deepEqual(runtimeText(harness, '.model-library-folders-path'), ['D:\\r1', 'D:\\new-builds']);
  harness.controller.dispose();
});

test('a cancelled dialog and a folder already in the list save nothing', async () => {
  const harness = createHarness({ runtimeRoots: ['D:\\new-builds'], runtime: runtimeBridge() });
  harness.controller.render();
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  assert.equal(harness.calls.filter((call) => call[0] === 'update').length, 0);
  assert.equal(status(harness), 'D:\\new-builds is already in the list.');
  harness.dom.window.jennyShell.llamaServer.chooseRuntimeFolder = async () => ({ ok: true, picked: false, path: '' });
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  assert.equal(harness.calls.filter((call) => call[0] === 'update').length, 0);
  harness.controller.dispose();
});

test('a network folder and a link folder are refused in plain words, and nothing is saved', async () => {
  const harness = createHarness({ runtime: runtimeBridge({ chooseRuntimeFolder: async () => ({ ok: false, reason: 'network_path' }) }) });
  harness.controller.render();
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  assert.equal(status(harness), 'Jenny can\'t run programs from a network folder.');
  harness.dom.window.jennyShell.llamaServer.chooseRuntimeFolder = async () => ({ ok: false, reason: 'link_folder' });
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  assert.equal(status(harness), 'Choose the folder itself, not a link to it.');
  assert.equal(harness.calls.filter((call) => call[0] === 'update').length, 0);
  harness.controller.dispose();
});

test('flag_off from the dialog hides the whole block', async () => {
  const harness = createHarness({ runtime: runtimeBridge({ chooseRuntimeFolder: async () => ({ ok: false, reason: 'flag_off' }) }) });
  harness.controller.render();
  click(harness, '[data-runtime-folder-action="add"]');
  await flush();
  assert.equal(harness.dom.window.document.querySelector(RUNTIME_BLOCK), null);
  harness.controller.dispose();
});

test('Remove saves the list without that folder, in order', async () => {
  const gate = deferred();
  const harness = createHarness({ runtimeRoots: ['D:\\r1', 'E:\\r2', 'F:\\r3'], runtime: runtimeBridge(), updateGate: () => gate.promise });
  harness.controller.render();
  click(harness, `${RUNTIME_BLOCK} [data-runtime-folder-remove="0"]`);
  await flush();
  click(harness, `${RUNTIME_BLOCK} [data-runtime-folder-remove="1"]`);
  await flush();
  assert.equal(harness.calls.filter((call) => call[0] === 'update').length, 1, 'the second write waits for the first');
  gate.resolve();
  await flush();
  await flush();
  const lists = harness.calls.filter((call) => call[0] === 'update').map((call) => call[1].managed.runtimeRoots);
  assert.deepEqual(lists, [['E:\\r2', 'F:\\r3'], ['F:\\r3']], 'each write starts from the saved list');
  harness.controller.dispose();
});

test('at eight folders Add runtime folder is disabled and says why', () => {
  const eight = Array.from({ length: 8 }, (_, index) => `D:\\r${index}`);
  const harness = createHarness({ runtimeRoots: eight, runtime: runtimeBridge() });
  harness.controller.render();
  const add = harness.dom.window.document.querySelector('[data-runtime-folder-action="add"]');
  assert.equal(add.disabled, true);
  assert.equal(add.title, 'Up to 8 folders');
  harness.controller.dispose();
});

test('without the runtime folder dialog on the bridge there is no block', () => {
  const harness = createHarness();
  harness.controller.render();
  assert.equal(harness.dom.window.document.querySelector(RUNTIME_BLOCK), null);
  harness.controller.dispose();
});

// Row 194: the host turns main's plan and the section's card size into the add step's estimate.
const TOO_BIG = { ok: true, inside: false, file: 'Big-70B-Q4_K_M.gguf', companions: [], sizeBytes: 40 * 1024 ** 3, sourceDirName: 'Downloads', destRoot: 'D:\\gguf', destDir: 'D:\\gguf\\Big', crossVolume: true, freeBytes: 500e9, fit: { ctx: 32768, needMb: 48000, smallNeedMb: 46000 } };

function addHarness(t, options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="folders"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  dom.window.jennyShell = {
    llamaServer: {
      async chooseGguf() { return { ok: true, picked: true, path: 'C:\\Users\\me\\Downloads\\Big-70B-Q4_K_M.gguf', dir: 'C:\\Users\\me\\Downloads' }; },
      async planGgufImport() { return options.plan || TOO_BIG; },
      async importGguf() { calls.push(['import']); return { ok: true }; },
      async ggufImportStatus() { return { ok: true, active: false }; },
      async chooseLibraryFolder() { return { ok: true, picked: false, path: '' }; },
    },
    engines: { async updateSettings(payload) { calls.push(['update', payload]); return { localEngines: { openaiCompatible: { managed: payload.managed } } }; } },
  };
  const controller = createModelLibraryFoldersController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    getRoots: () => ['D:\\gguf'],
    getLibrary: () => ({ managed: { perModel: {} }, ollamaTags: [], installed: [] }),
    refresh: () => Promise.resolve(),
    hostId: 'folders',
    getCardMb: () => options.cardMb,
    showFits: () => calls.push(['showFits']),
  });
  t.after(() => controller.dispose());
  controller.bind();
  controller.render();
  const document = dom.window.document;
  const click = (selector) => document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  return { calls, document, click, add: () => click('[data-model-library-folder-action="add-model"]') };
}

test('a file too large for the card shows the warning through the host, and Show models that fit reaches the section', async (t) => {
  const h = addHarness(t, { cardMb: 16 * 1024 });
  h.add();
  await flush();
  await flush();
  const note = h.document.querySelector('.model-library-add-fit');
  assert.match(note.textContent, /Big-70B-Q4_K_M\.gguf \(40 GB\) is too large for your graphics card\./);
  assert.match(note.textContent, /Needs about 46\.9 GB at a 32K context · 30\.9 GB more than this card has/);
  assert.match(note.textContent, /A smaller context does not fix it: at 8K it still needs about 44\.9 GB\./);
  assert.deepEqual(h.calls, [], 'nothing is saved or moved before the answers');
  h.click('[data-model-library-add-action="show-fits"]');
  await flush();
  assert.deepEqual(h.calls, [['showFits']]);
  assert.equal(h.document.querySelector('.model-library-add-fit'), null);
});

test('an unknown card size, or a file that fits, adds as it did before', async (t) => {
  for (const cardMb of [undefined, 0, 64 * 1024]) {
    const h = addHarness(t, { cardMb });
    h.add();
    await flush();
    await flush();
    assert.equal(h.document.querySelector('.model-library-add-fit'), null, `card ${cardMb}`);
    assert.match(h.document.querySelector('.model-library-add').textContent, /is in Downloads\. Move it to/, `card ${cardMb}: today's question`);
  }
});
