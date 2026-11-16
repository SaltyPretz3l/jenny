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
  // Timers are driven by hand: every poll the flow asks for is one entry here.
  const timers = [];
  dom.window.setInterval = (fn) => { timers.push(fn); return timers.length; };
  dom.window.clearInterval = (id) => { timers[id - 1] = null; };
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
      ...(options.runtime ? {
        async runtimeOptions(payload) { calls.push(['runtimeOptions', payload]); return options.runtime.options(); },
        async chooseRuntimeFolder() { calls.push(['chooseRuntimeFolder']); return { ok: true, picked: true, path: 'D:\\builds' }; },
        async runtimeDownloadStart(payload) { calls.push(['downloadStart', payload]); return options.runtime.start ? options.runtime.start() : { ok: true, build: 12098 }; },
        async runtimeDownloadStatus() { return options.runtime.status(); },
        async runtimeDownloadCancel() { calls.push(['downloadCancel']); return { ok: true }; },
      } : {}),
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
    liveTimers: () => timers.filter(Boolean).length,
    tick: () => timers.filter(Boolean).forEach((fn) => fn()),
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

// ---- Row 142: what runs the model after an add ----

const NONE_READS = { ok: true, current: { source: 'bundled', build: 11513, label: 'bundled' }, candidates: [], download: { build: 12098, sizeBytes: 140e6 } };
const AUTO_RUNS = { ok: true, current: { source: 'auto', build: 12098, label: 'llama-b12098-cuda13.4' }, candidates: [], download: null };

async function addAndMove(h) {
  h.click(ADD);
  await flush();
  h.click(action('move'));
  await flush();
}

test('a build Jenny picks on its own is named, and Change in Tune opens Tune for that model', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no', autoBuild: { build: 12098, label: 'llama-b12098-cuda13.4' } }) });
  h.document.body.insertAdjacentHTML('beforeend', `<button data-model-card-action="tune" data-model-tag="${TAG}">Tune</button>`);
  let tuned = 0;
  h.document.querySelector('[data-model-card-action="tune"]').addEventListener('click', () => { tuned += 1; });
  await addAndMove(h);
  assert.match(h.note(), /Added\. It runs on llama\.cpp build 12098\./);
  assert.match(h.note(), /The bundled build can't read lfm3 models, so Jenny picks build 12098 each time it starts this model\./);
  assert.equal(h.document.querySelector('.model-library-add').getAttribute('role'), 'status');
  assert.equal(h.calls.some((call) => call[0] === 'runtimeOptions'), false, 'the plan already said it');
  h.click(action('open-tune'));
  assert.equal(tuned, 1);
  assert.equal(h.note(), '');
  h.controller.dispose();
});

test('Dismiss clears the build line', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no', autoBuild: { build: 12098, label: 'x' } }) });
  await addAndMove(h);
  h.click(action('dismiss'));
  assert.equal(h.note(), '');
  h.controller.dispose();
});

test('when no build reads it, the way out is Add runtime folder or Get build', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS } });
  await addAndMove(h);
  assert.deepEqual(h.calls.find((call) => call[0] === 'runtimeOptions'), ['runtimeOptions', { modelTag: TAG }]);
  assert.match(h.note(), /Added, but no llama-server build Jenny knows can read lfm3 models\./);
  assert.match(h.note(), /Add a folder of newer llama\.cpp builds, or get build 12098\./);
  assert.deepEqual([...h.document.querySelectorAll('.model-library-add-actions .btn')].map((node) => node.textContent), ['Add runtime folder…', 'Get build 12098', 'Dismiss']);
  h.controller.dispose();
});

test('with nothing to download, the line sends the user to Tune', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => ({ ...NONE_READS, download: null }) } });
  await addAndMove(h);
  assert.match(h.note(), /Add a folder of newer llama\.cpp builds, or choose a build in Tune\./);
  assert.deepEqual([...h.document.querySelectorAll('.model-library-add-actions .btn')].map((node) => node.textContent), ['Add runtime folder…', 'Dismiss']);
  h.controller.dispose();
});

test('Add runtime folder saves the picked folder, then asks again and shows the build that now reads it', async () => {
  let answer = NONE_READS;
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => answer } });
  h.document.defaultView.jennyShell.engines.getSettings = async () => ({ localEngines: { openaiCompatible: { managed: { runtimeRoots: [] } } } });
  await addAndMove(h);
  answer = AUTO_RUNS;
  h.click(action('add-runtime-folder'));
  await flush();
  const saved = h.calls.filter((call) => call[0] === 'update').map((call) => call[1].managed.runtimeRoots).filter(Boolean);
  assert.deepEqual(saved, [['D:\\builds']]);
  assert.equal(h.calls.filter((call) => call[0] === 'runtimeOptions').length, 2);
  assert.match(h.note(), /Added\. It runs on llama\.cpp build 12098\./);
  h.controller.dispose();
});

test('a folder that still leaves no reader keeps the no-reader line', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS } });
  await addAndMove(h);
  h.click(action('add-runtime-folder'));
  await flush();
  assert.match(h.note(), /no llama-server build Jenny knows can read lfm3 models/);
  h.controller.dispose();
});

test('when main will not say (flag off, no answer), today\'s warning shows unchanged', async () => {
  for (const answer of [{ ok: false, reason: 'flag_off' }, null]) {
    const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => answer } });
    await addAndMove(h);
    assert.match(h.note(), /The bundled llama-server can't run lfm3 models\./);
    assert.match(h.note(), new RegExp(`Choose a newer llama-server build for ${TAG} in Tune, or update Jenny when a newer bundled build ships\\.`));
    assert.deepEqual([...h.document.querySelectorAll('.model-library-add-actions .btn')].map((node) => node.textContent), ['Open Tune', 'Dismiss']);
    h.controller.dispose();
  }
});

test('Get build shows its progress, then the build that runs the model', async () => {
  const statuses = [
    { state: 'downloading', build: 12098, receivedBytes: 50 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 },
    { state: 'verifying', build: 12098, receivedBytes: 100 * 1024 * 1024, totalBytes: 100 * 1024 * 1024 },
    { state: 'ready', build: 12098 },
  ];
  let answer = NONE_READS;
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => answer, status: () => statuses.shift() } });
  await addAndMove(h);
  h.click(action('get-build'));
  await flush();
  assert.deepEqual(h.calls.find((call) => call[0] === 'downloadStart'), ['downloadStart', { architecture: 'lfm3' }]);
  assert.match(h.note(), /Getting build 12098/);
  assert.deepEqual([...h.document.querySelectorAll('.model-library-add-actions .btn')].map((node) => node.textContent), ['Cancel']);
  assert.equal(h.liveTimers(), 1);
  h.tick();
  await flush();
  assert.equal(h.document.querySelector('[data-model-library-add-progress-text]').textContent, '50 MB of 100 MB');
  assert.equal(h.document.querySelector('[data-model-library-add-bar]').style.width, '50%');
  h.tick();
  await flush();
  assert.equal(h.document.querySelector('[data-model-library-add-progress-text]').textContent, 'Checking build 12098…');
  answer = AUTO_RUNS;
  h.tick();
  await flush();
  assert.match(h.note(), /Added\. It runs on llama\.cpp build 12098\./);
  assert.equal(h.liveTimers(), 0, 'the poll stops once the build is ready');
  h.controller.dispose();
});

test('a ready build that main still does not pick says it is ready', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, status: () => ({ state: 'ready', build: 12098 }) } });
  await addAndMove(h);
  h.click(action('get-build'));
  await flush();
  h.tick();
  await flush();
  assert.match(h.note(), /Build 12098 is ready\./);
  h.click(action('dismiss'));
  assert.equal(h.note(), '');
  h.controller.dispose();
});

test('a download that failed its checksum says so and offers Try again', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, status: () => ({ state: 'failed', build: 12098, reason: 'sha_mismatch' }) } });
  await addAndMove(h);
  h.click(action('get-build'));
  await flush();
  h.tick();
  await flush();
  assert.match(h.note(), /Couldn't get build 12098\./);
  assert.match(h.note(), /The download didn't match its checksum, so Jenny deleted it\./);
  assert.deepEqual([...h.document.querySelectorAll('.model-library-add-actions .btn')].map((node) => node.textContent), ['Try again', 'Dismiss']);
  assert.equal(h.liveTimers(), 0);
  h.click(action('get-build'));
  await flush();
  assert.equal(h.calls.filter((call) => call[0] === 'downloadStart').length, 2);
  h.controller.dispose();
});

test('every failure reason has its own sentence', async () => {
  const wanted = {
    network: /The download stopped\. Try again\./,
    size_mismatch: /didn't match its checksum/,
    unsafe_entry: /The archive looked wrong, so Jenny deleted it\./,
    too_large: /The archive looked wrong/,
    probe_failed: /The downloaded build didn't start\./,
    local_only: /Local only is on, so Jenny downloads nothing\./,
  };
  for (const [reason, pattern] of Object.entries(wanted)) {
    const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, status: () => ({ state: 'failed', build: 12098, reason }) } });
    await addAndMove(h);
    h.click(action('get-build'));
    await flush();
    h.tick();
    await flush();
    assert.match(h.note(), pattern, reason);
    h.controller.dispose();
  }
});

test('a download main refuses to start says why, and the choices stay', async () => {
  const refusals = [
    [{ ok: false, reason: 'local_only' }, /Local only is on, so Jenny downloads nothing\./],
    [{ ok: false, reason: 'no_space', needBytes: 2254857830, freeBytes: 1181116006 }, /Needs 2\.1 GB free\. 1\.1 GB is free\./],
    [{ ok: false, reason: 'busy' }, /Another build is downloading\./],
    [{ ok: false, reason: 'flag_off' }, /Couldn't start the download\./],
  ];
  for (const [refusal, pattern] of refusals) {
    const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, start: () => refusal } });
    await addAndMove(h);
    h.click(action('get-build'));
    await flush();
    assert.match(h.note(), pattern);
    assert.equal(h.liveTimers(), 0, 'nothing to poll');
    assert.ok(h.document.querySelector(action('get-build')), 'Get build is still there');
    h.controller.dispose();
  }
});

test('Cancel asks main to stop, and a cancelled download goes back to the no-reader line', async () => {
  const statuses = [{ state: 'downloading', build: 12098, receivedBytes: 1, totalBytes: 100 }, { state: 'cancelled', build: 12098 }];
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, status: () => statuses.shift() } });
  await addAndMove(h);
  h.click(action('get-build'));
  await flush();
  h.click(action('download-cancel'));
  await flush();
  assert.ok(h.calls.some((call) => call[0] === 'downloadCancel'));
  h.tick();
  await flush();
  h.tick();
  await flush();
  assert.match(h.note(), /no llama-server build Jenny knows can read lfm3 models/);
  assert.equal(h.liveTimers(), 0);
  h.controller.dispose();
});

test('closing Settings during a download leaves no timer running', async () => {
  const h = harness({ plan: outsidePlan({ archSupport: 'no' }), runtime: { options: () => NONE_READS, status: () => ({ state: 'downloading', build: 12098, receivedBytes: 1, totalBytes: 100 }) } });
  await addAndMove(h);
  h.click(action('get-build'));
  await flush();
  assert.equal(h.liveTimers(), 1);
  h.controller.dispose();
  assert.equal(h.liveTimers(), 0);
});
