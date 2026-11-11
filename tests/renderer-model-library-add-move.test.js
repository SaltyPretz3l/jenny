'use strict';

// Row 107: GGUF folders ▸ "Add GGUF model…" ▸ Move and add. A file outside every
// GGUF folder gets one inline question; main's replies are stubbed and the
// settings echo runs through the REAL normalizer, as in the add tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createModelLibraryFoldersController } = require('../renderer/shell/renderer-model-library-folders');
const { normalizeLocalEngines } = require('../services/shell-config-engines');

const PICKED = 'C:\\Users\\me\\Downloads\\LFM3-Omni-2B-F16.gguf';
const MOVED_DIR = 'G:\\llmmodels\\gguf\\LFM3-Omni-2B';
const MOVED = MOVED_DIR + '\\LFM3-Omni-2B-F16.gguf';
const TAG = 'lfm3-omni-2b-f16';

async function flush() {
  for (let index = 0; index < 6; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function outsidePlan(extra = {}) {
  return {
    ok: true, inside: false, architecture: 'lfm3', archSupport: 'yes', file: 'LFM3-Omni-2B-F16.gguf',
    companions: [], sizeBytes: 3466628608, sourceDirName: 'Downloads', destRoot: 'G:\\llmmodels\\gguf',
    destDir: MOVED_DIR, crossVolume: true, freeBytes: 500e9, ...extra,
  };
}

function harness(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="folders"></div></body>', { url: 'http://localhost/' });
  const calls = [];
  const library = { managed: { enabled: true, lastPickDir: '', libraryRoots: ['G:\\llmmodels\\gguf'], perModel: {} }, ollamaTags: [], installed: [] };
  dom.window.jennyShell = {
    llamaServer: {
      async chooseGguf(payload) { calls.push(['chooseGguf', payload]); return { ok: true, picked: true, path: PICKED, dir: 'C:\\Users\\me\\Downloads' }; },
      async planGgufImport(payload) { calls.push(['plan', payload]); return options.plan || outsidePlan(); },
      importGguf(payload) {
        calls.push(['import', payload]);
        return options.importGguf ? options.importGguf(payload) : Promise.resolve({ ok: true, modelPath: MOVED, dir: MOVED_DIR, moved: ['LFM3-Omni-2B-F16.gguf'] });
      },
      async ggufImportStatus() { return { ok: true, active: false }; },
      async cancelGgufImport() { calls.push(['cancel']); return { ok: true, cancelled: true }; },
      async chooseLibraryFolder() { calls.push(['chooseFolder']); return { ok: true, picked: true, path: 'E:\\models' }; },
    },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
        const perModel = { ...library.managed.perModel, ...(payload.managed.perModel || {}) };
        library.managed = { ...library.managed, ...payload.managed, perModel };
        return { localEngines: normalizeLocalEngines({ openaiCompatible: { managed: library.managed } }) };
      },
    },
  };
  const controller = createModelLibraryFoldersController({
    windowRef: dom.window,
    documentRef: dom.window.document,
    getRoots: () => library.managed.libraryRoots,
    getLibrary: () => library,
    refresh: () => Promise.resolve(),
    hostId: 'folders',
  });
  controller.bind();
  controller.render();
  const document = dom.window.document;
  return {
    calls,
    document,
    controller,
    click(selector) {
      document.querySelector(selector).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    },
    note: () => document.querySelector('.model-library-add')?.textContent || '',
    status: () => document.querySelector('.model-library-folders-status')?.textContent || '',
    saved: () => calls.filter((call) => call[0] === 'update').map((call) => Object.values(call[1].managed.perModel || {})[0]?.modelPath),
  };
}

const ADD = '[data-model-library-folder-action="add-model"]';
const action = (name) => `[data-model-library-add-action="${name}"]`;

test('the first folder says new models go there', () => {
  const h = harness();
  assert.equal(h.document.querySelector('.model-library-folders-home-note').textContent, 'new models go here');
  h.controller.dispose();
});

test('a file already inside a GGUF folder is added at once, with no question', async () => {
  const h = harness({ plan: { ok: true, inside: true, architecture: 'lfm3', archSupport: 'yes' } });
  h.click(ADD);
  await flush();
  assert.equal(h.note(), '');
  assert.deepEqual(h.saved(), [PICKED]);
  assert.equal(h.status(), `Added ${TAG}.`);
  h.controller.dispose();
});

test('a Downloads file asks first; Move and add moves it and saves the new path', async () => {
  const h = harness();
  h.click(ADD);
  await flush();
  assert.match(h.note(), /LFM3-Omni-2B-F16\.gguf \(3\.2 GB\) is in Downloads\. Move it to G:\\llmmodels\\gguf\\LFM3-Omni-2B\?/);
  assert.match(h.note(), /Files in Downloads get cleaned up/);
  assert.deepEqual(h.saved(), [], 'nothing is saved before the click');

  h.click(action('move'));
  await flush();
  assert.deepEqual(h.calls.find((call) => call[0] === 'import'), ['import', { path: PICKED }]);
  assert.deepEqual(h.saved(), [MOVED]);
  assert.equal(h.note(), '');
  assert.equal(h.status(), `Added ${TAG} · moved to ${MOVED_DIR}`);
  h.controller.dispose();
});

test('companion files are named in the question', async () => {
  const h = harness({ plan: outsidePlan({ companions: ['mmproj-LFM3-Omni-2B-F16.gguf'] }) });
  h.click(ADD);
  await flush();
  assert.match(h.note(), /These move with it: mmproj-LFM3-Omni-2B-F16\.gguf\./);
  h.controller.dispose();
});

test('Add where it is saves the original path and says what that means', async () => {
  const h = harness();
  h.click(ADD);
  await flush();
  h.click(action('in-place'));
  await flush();
  assert.equal(h.calls.some((call) => call[0] === 'import'), false);
  assert.deepEqual(h.saved(), [PICKED]);
  assert.equal(h.status(), `Added ${TAG} from Downloads. If you move or delete the file, Jenny can't run it.`);
  h.controller.dispose();
});

test('Cancel writes nothing, and only one add runs at a time until it is answered', async () => {
  const h = harness();
  h.click(ADD);
  await flush();
  h.click(ADD);
  await flush();
  assert.equal(h.calls.filter((call) => call[0] === 'chooseGguf').length, 1, 'a second Add waits for the answer');
  h.click(action('cancel'));
  await flush();
  assert.equal(h.note(), '');
  assert.deepEqual(h.saved(), []);
  h.click(ADD);
  await flush();
  assert.equal(h.calls.filter((call) => call[0] === 'chooseGguf').length, 2);
  h.controller.dispose();
});

test('Cancel while moving asks main to stop and saves nothing', async () => {
  let finishImport;
  const h = harness({ importGguf: () => new Promise((resolve) => { finishImport = resolve; }) });
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  assert.match(h.note(), /Moving LFM3-Omni-2B-F16\.gguf to G:\\llmmodels\\gguf\\LFM3-Omni-2B/);
  assert.match(h.note(), /the original stays in Downloads until the copy is checked/);
  h.click(action('cancel'));
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'cancel'));
  finishImport({ ok: false, reason: 'cancelled' });
  await flush();
  assert.deepEqual(h.saved(), []);
  assert.equal(h.status(), 'Cancelled. Nothing was moved.');
  h.controller.dispose();
});

test('not enough space says so and still offers Add where it is', async () => {
  const h = harness({ importGguf: async () => ({ ok: false, reason: 'no_space', freeBytes: 1181116006, sizeBytes: 3466628608 }) });
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  assert.match(h.note(), /The destination has 1\.1 GB free, and LFM3-Omni-2B-F16\.gguf needs 3\.2 GB\. Nothing was moved\./);
  h.click(action('in-place'));
  await flush();
  assert.deepEqual(h.saved(), [PICKED]);
  h.controller.dispose();
});

test('Another folder… moves into the folder main picked', async () => {
  const h = harness({ importGguf: async (payload) => ({ ok: true, modelPath: payload.destRoot + '\\LFM3-Omni-2B\\LFM3-Omni-2B-F16.gguf', dir: payload.destRoot + '\\LFM3-Omni-2B' }) });
  h.click(ADD);
  await flush();
  h.click(action('another'));
  await flush();
  assert.deepEqual(h.calls.find((call) => call[0] === 'import'), ['import', { path: PICKED, destRoot: 'E:\\models' }]);
  assert.deepEqual(h.saved(), ['E:\\models\\LFM3-Omni-2B\\LFM3-Omni-2B-F16.gguf']);
  h.controller.dispose();
});

test('after the add, a build that can\'t read the architecture is named, and Dismiss clears it', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }) });
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  assert.match(h.note(), /The bundled llama-server can't run lfm3 models\./);
  assert.match(h.note(), new RegExp(`Choose a newer llama-server build for ${TAG} in Tune`));
  h.click(action('dismiss'));
  assert.equal(h.note(), '');
  h.controller.dispose();
});

test('a name another model already has is refused before anything is planned or moved', async () => {
  const h = harness();
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  h.click(ADD);
  await flush();
  assert.equal(h.status(), `Another model is already named ${TAG}. Rename the file, then add it.`);
  assert.equal(h.calls.filter((call) => call[0] === 'plan').length, 1);
  assert.equal(h.calls.filter((call) => call[0] === 'import').length, 1);
  assert.equal(h.note(), '');
  h.controller.dispose();
});

test('closing Settings mid-move cancels the move', async () => {
  const h = harness({ importGguf: () => new Promise(() => {}) });
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  h.controller.dispose();
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'cancel'));
});

test('a file that moved but could not be added says where it went', async () => {
  const h = harness();
  h.document.defaultView.jennyShell.engines.updateSettings = async (payload) => {
    h.calls.push(['update', payload]);
    throw new Error('write failed');
  };
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  assert.equal(h.status(), `Moved LFM3-Omni-2B-F16.gguf to ${MOVED_DIR}, but could not add it. Add it from there with Add GGUF model….`);
  h.click(ADD);
  await flush();
  assert.equal(h.calls.filter((call) => call[0] === 'chooseGguf').length, 2, 'the next add is not blocked');
  h.controller.dispose();
});

test('a file another program holds open is named, and nothing moved', async () => {
  const h = harness({ importGguf: async () => ({ ok: false, reason: 'in_use' }) });
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
  assert.match(h.note(), /LFM3-Omni-2B-F16\.gguf is open in another program\. Close it, then try again\. Nothing was moved\./);
  h.controller.dispose();
});

test('without the import bridge the file is added where it is, as before', async () => {
  const h = harness();
  delete h.document.defaultView.jennyShell.llamaServer.planGgufImport;
  h.click(ADD);
  await flush();
  assert.deepEqual(h.saved(), [PICKED]);
  h.controller.dispose();
});
