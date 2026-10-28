'use strict';

/* In the renderer the global `require` is Monaco's AMD loader, which throws for the lazily
   loaded Settings modules. The module is run here the way the browser runs it: as a script
   with a throwing `require` and no `module`. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'features', 'renderer-offline-utils.js'), 'utf8');

function loadAsBrowserScript() {
  const dom = new JSDOM('<!doctype html><body><div id="offlineLocalOnlyList"></div><div id="offlineModelStatus"></div><div id="offlineSummary"></div></body>');
  const amdRequireCalls = [];
  const sandbox = {
    document: dom.window.document,
    console,
    require: (name) => { amdRequireCalls.push(name); throw new Error(`Check dependency list! Synchronous require cannot resolve module '${name}'.`); },
    stringUtils: require('../renderer/shared/string-utils'),
    rendererAsyncFence: require('../renderer/shared/async-fence'),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox, { filename: 'renderer-offline-utils.js' });
  return { dom, sandbox, amdRequireCalls };
}

test('loading and rendering never touch the browser-global require', () => {
  const { dom, sandbox, amdRequireCalls } = loadAsBrowserScript();
  const doc = dom.window.document;
  const utils = sandbox.rendererOfflineUtils;
  assert.equal(typeof utils?.createOfflineManager, 'function');

  const manager = utils.createOfflineManager({
    state: {},
    callbacks: { appendClientLog() {}, renderSettings() {} },
    dom: {
      offlineLocalOnlyList: doc.getElementById('offlineLocalOnlyList'),
      offlineModelStatus: doc.getElementById('offlineModelStatus'),
      offlineSummary: doc.getElementById('offlineSummary'),
    },
  });
  manager.applyOfflinePayload({ mode: 'disabled' });
  assert.doesNotThrow(() => manager.renderOfflineManager());

  assert.deepEqual(amdRequireCalls, [], 'no AMD require for the lazy Settings modules');
  assert.notEqual(doc.getElementById('offlineModelStatus').textContent.trim(), '', 'the render ran to its end');
  assert.notEqual(doc.getElementById('offlineSummary').innerHTML, '', 'the summary row rendered through its fallback');
});

test('the lazy toggle-list renderer is used when its global is present', () => {
  const { dom, sandbox } = loadAsBrowserScript();
  const doc = dom.window.document;
  const rendered = [];
  // Arrays built inside the vm realm are not reference-equal to this realm's Array; compare as JSON.
  sandbox.rendererSettingsLazyRenderers = { renderToggleListInto: (target, fields) => { rendered.push(JSON.stringify(fields.map((f) => f.id))); target.textContent = 'toggles'; } };
  const manager = sandbox.rendererOfflineUtils.createOfflineManager({
    state: {},
    callbacks: { appendClientLog() {}, renderSettings() {} },
    dom: { offlineLocalOnlyList: doc.getElementById('offlineLocalOnlyList') },
  });
  manager.applyOfflinePayload({ mode: 'local_only' });
  manager.renderOfflineManager();
  assert.deepEqual(rendered, ['["offlineLocalOnlyToggle"]']);
  assert.equal(doc.getElementById('offlineLocalOnlyList').textContent, 'toggles');
});
