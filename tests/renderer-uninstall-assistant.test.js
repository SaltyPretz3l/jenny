'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// The assistant is a self-initializing IIFE reading its deps from globals, so
// the harness stages the globals, requires the file fresh, and restores after.
async function bootAssistant({ previewWorkspaceArchive, i18n = null }) {
  const dom = new JSDOM('<!doctype html><body><div id="dataLifecycleAssistant"></div></body>');
  const previous = {};
  const globals = {
    document: dom.window.document,
    inventoryActionButton: require('../renderer/inventory/action-button'),
    inventoryTextField: require('../renderer/inventory/text-field'),
    inventoryToggleSwitch: require('../renderer/inventory/toggle-switch'),
    inventoryProgressBar: require('../renderer/inventory/progress-bar'),
    dataLifecycleUtils: require('../renderer/features/renderer-data-lifecycle-utils'),
    rendererAsyncFence: require('../renderer/shared/async-fence'),
    jennyI18n: i18n,
    jennyUninstall: {
      getOverview: async () => ({ ok: true }),
      onProgress: () => () => {},
      previewWorkspaceArchive,
    },
  };
  for (const key of Object.keys(globals)) {
    previous[key] = globalThis[key];
    globalThis[key] = globals[key];
  }
  const modulePath = require.resolve('../renderer/uninstall/renderer-uninstall-assistant');
  delete require.cache[modulePath];
  require(modulePath);
  await settle();
  const host = dom.window.document.getElementById('dataLifecycleAssistant');
  const restore = () => {
    delete require.cache[modulePath];
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete globalThis[key];
      else globalThis[key] = previous[key];
    }
  };
  return { dom, host, restore };
}

function click(host, dom, action) {
  const target = host.querySelector(`[data-action="${action}"]`);
  assert.ok(target, `control [data-action="${action}"] renders`);
  target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('a double-clicked workspace review runs once and a stale rejection cannot replace the successful review (hyg-W4-60-F05)', async (t) => {
  let previewCalls = 0;
  let resolveFirst = null;
  let rejectSecond = null;
  const preview = () => {
    previewCalls += 1;
    if (previewCalls === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return new Promise((_resolve, reject) => { rejectSecond = reject; });
  };
  const { dom, host, restore } = await bootAssistant({ previewWorkspaceArchive: preview });
  t.after(restore);

  click(host, dom, 'review-archive');
  host.dispatchEvent(new dom.window.CustomEvent('inv-toggle-change', {
    detail: { id: 'include-workspace', checked: true },
  }));

  click(host, dom, 'archive-remove');
  click(host, dom, 'archive-remove');
  await settle();
  assert.equal(previewCalls, 1, 'the in-flight guard must swallow the second click');

  resolveFirst({ ok: true, reviewId: 'review-1', workspace: { fileCount: 1, totalBytes: 10, topFolders: [] } });
  await settle();
  if (rejectSecond) rejectSecond(new Error('stale rejection'));
  await settle();

  assert.ok(
    host.querySelector('[data-action="archive-remove"]'),
    'the archive review view survives — no stale continuation flipped it to the error view'
  );
});

test('translated uninstall copy is escaped and the permanent confirmation token stays English', async (t) => {
  const calls = [];
  const interpolate = (value, params) => String(value).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params || {}, name) ? String(params[name]) : match
  ));
  const i18n = {
    tag: () => 'qps-ploc',
    t(key, englishDefault, params) {
      calls.push({ key, params });
      if (key === 'uninstall.landing.archiveTitle') return '<b>Localized archive</b>';
      return interpolate(englishDefault, params);
    },
    tn(key, count, params, one, other) {
      calls.push({ key, count, params });
      return interpolate(count === 1 ? one : other, params);
    },
  };
  const { dom, host, restore } = await bootAssistant({ previewWorkspaceArchive: async () => ({ ok: true }), i18n });
  t.after(restore);

  assert.match(host.textContent, /<b>Localized archive<\/b>/);
  assert.equal(host.querySelector('h2 b'), null, 'translated HTML is rendered as text');
  click(host, dom, 'review-permanent');
  const confirmation = host.querySelector('#permanentConfirmation');
  assert.equal(confirmation.placeholder, 'REMOVE JENNY');
  assert.match(host.textContent, /Type REMOVE JENNY to continue/);
  assert.equal(calls.find((call) => call.key === 'uninstall.permanent.confirmationInstruction').params.phrase, 'REMOVE JENNY');
});
