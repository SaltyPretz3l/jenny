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
  const calls = [];
  const chooseLibraryFolder = options.chooseLibraryFolder
    || (async () => ({ ok: true, picked: false, path: '' }));
  dom.window.jennyShell = {
    llamaServer: { chooseLibraryFolder },
    engines: {
      async updateSettings(payload) {
        calls.push(['update', payload]);
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
