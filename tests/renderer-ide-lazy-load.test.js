'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const manifest = require('../renderer/shell/renderer-ide-script-manifest');
const { createIdeRootService } = require('../renderer/shell/renderer-shell-ide-root-service');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function fakeGroup({ fail = '', hold = false } = {}) {
  const requests = [];
  const cleanups = [];
  const logs = [];
  let builds = 0;
  let release;
  let failure = fail;
  const gate = hold ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  const windowRef = {
    rendererIdeScriptManifest: manifest,
    scriptLoaderUtils: {
      ensureScript({ src, isReady }) {
        requests.push(src);
        return gate.then(() => {
          if (src === failure) return false;
          const name = manifest.find(([entry]) => entry === src)[1];
          windowRef[name] = {};
          return isReady();
        });
      },
    },
  };
  const service = createIdeRootService({
    windowRef,
    state: { ui: { activeView: 'ide', ide: { openTabs: [] } } },
    registerCleanup: (fn) => cleanups.push(fn),
    getIdeControllerUtils: () => ({ createIdeController() { builds += 1; return {}; } }),
    callbacks: { appendClientLog: (...args) => logs.push(args) },
  });
  return { service, requests, cleanups, logs, release, get builds() { return builds; }, retry() { failure = ''; } };
}

test('chat boot evaluates no lazy IDE module and requests none', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  for (const [src, name] of manifest) {
    assert.equal(window[name], undefined, `chat boot evaluated ${src}`);
  }
  assert.deepEqual(window.scriptLoaderUtils.requests.filter((src) => manifest.some(([entry]) => entry === src)), []);
});

test('opening Workspace loads one ordered group and renders the IDE', async (t) => {
  const { window, dispose } = await loadRendererApp();
  t.after(dispose);
  const requests = [];
  const load = window.scriptLoaderUtils.ensureScript;
  window.scriptLoaderUtils.ensureScript = (options) => { requests.push(options.src); return load.call(window.scriptLoaderUtils, options); };
  window.document.querySelector('[data-tab-id="ide"]').click();
  window.document.querySelector('[data-tab-id="ide"]').click();
  await waitForUi(window, 100);
  assert.deepEqual(requests.filter((src) => manifest.some(([entry]) => entry === src)), manifest.map(([src]) => src));
  assert.ok(window.document.querySelector('#ideWorkbench [data-wb-tab="explorer"]'), 'IDE rendered after loading');
});

test('concurrent triggers share one flight and inject the entire group before awaiting', async () => {
  const h = fakeGroup({ hold: true });
  const first = h.service.ensureIdeLoaded();
  const second = h.service.ensureIdeLoaded();
  assert.equal(first, second);
  assert.deepEqual(h.requests, manifest.map(([src]) => src));
  const controller = h.service.ensureIdeController();
  assert.equal(h.builds, 0);
  h.release();
  assert.equal(await first, true);
  assert.ok(await controller);
  assert.ok(h.service.ensureIdeController());
  assert.equal(h.builds, 1);
});

test('a failed script logs its src, builds nothing, and the next trigger retries', async () => {
  const src = manifest[0][0];
  const h = fakeGroup({ fail: src });
  assert.equal(await h.service.ensureIdeLoaded(), false);
  assert.equal(h.builds, 0);
  assert.ok(h.logs.some(([level, event, details]) => level === 'WARN' && event === 'workspace.ide_load_failed' && details.src === src));
  h.retry();
  assert.equal(await h.service.ensureIdeLoaded(), true);
  assert.ok(h.service.ensureIdeController());
  assert.equal(h.builds, 1);
});

test('disposal during loading settles false and constructs no controller', async () => {
  const h = fakeGroup({ hold: true });
  const loaded = h.service.ensureIdeLoaded();
  h.cleanups.forEach((fn) => fn());
  h.release();
  assert.equal(await loaded, false);
  assert.equal(h.service.ensureIdeController(), null);
  assert.equal(h.builds, 0);
});

test('persisted Workspace launch renders before notifyBootViewReady', async (t) => {
  let ready = false;
  const { window, dispose } = await loadRendererApp({
    persistedActiveView: 'ide',
    beforeRendererBoot(win) {
      const create = win.rendererLifecycleUtils.createLifecycleController;
      win.rendererLifecycleUtils.createLifecycleController = (deps) => {
        const notify = deps.callbacks.notifyBootViewReady;
        deps.callbacks.notifyBootViewReady = (...args) => {
          assert.ok(win.document.querySelector('#ideWorkbench [data-wb-tab="explorer"]'), 'IDE painted before ready');
          ready = true;
          return notify(...args);
        };
        return create(deps);
      };
    },
  });
  t.after(dispose);
  assert.equal(ready, true);
  assert.equal(window.__rendererState.ui.activeView, 'ide');
});
