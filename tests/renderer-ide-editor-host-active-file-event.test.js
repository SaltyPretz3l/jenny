'use strict';

/* JCA-005 event/read order: the editor host announces `ide:active-file-changed`
 * only AFTER activation has updated activePath, so a listener that reads the
 * live accessor (rendererIdeActiveEditorReader) at event time observes the NEW
 * document — never the outgoing one. showEmpty() (closing the last tab) must
 * announce too, with an empty path, instead of staying silent.
 *
 * The host dispatches on its module global (the window in production, the bare
 * Node global here, where dispatchEvent normally no-ops) — so the test installs
 * a capture-at-dispatch-time stub on globalThis to observe ordering exactly. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function bootHost(t) {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div>'
    + '<textarea id="ideEditorFallback" class="hidden"></textarea></body>');
  const doc = dom.window.document;
  const seen = [];
  const previousDispatch = globalThis.dispatchEvent;
  const previousCustomEvent = globalThis.CustomEvent;
  const previousReader = globalThis.rendererIdeActiveEditorReader;
  globalThis.CustomEvent = dom.window.CustomEvent;
  globalThis.dispatchEvent = (event) => {
    if (event && event.type === 'ide:active-file-changed') {
      const reader = globalThis.rendererIdeActiveEditorReader;
      seen.push({
        detailPath: event.detail ? event.detail.path : undefined,
        readerPath: reader ? reader.getActivePath() : undefined,
      });
    }
    return true;
  };
  const host = createIdeEditorHost({
    getDom: () => ({
      ideEditorHost: doc.getElementById('ideEditorHost'),
      ideEditorFallback: doc.getElementById('ideEditorFallback'),
    }),
    monacoUtils: {
      ensureMonacoEditorApi: async () => null, // fallback textarea path
      normalizeEditorLanguage: () => 'plaintext',
    },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  t.after(() => {
    host.dispose();
    globalThis.dispatchEvent = previousDispatch;
    globalThis.CustomEvent = previousCustomEvent;
    globalThis.rendererIdeActiveEditorReader = previousReader;
  });
  return { host, seen };
}

test('the change event fires after activePath reflects the newly activated document', async (t) => {
  const { host, seen } = bootHost(t);

  await host.openDocument({ path: 'src/first.js', content: 'one' });
  host.activateDocument('src/first.js');
  await host.openDocument({ path: 'src/second.js', content: 'two' });
  host.activateDocument('src/second.js');

  assert.ok(seen.length >= 2, 'each activation announces');
  for (const entry of seen) {
    assert.equal(entry.readerPath, entry.detailPath,
      'at event time the live reader already reports the announced document');
  }
  assert.equal(seen[seen.length - 1].detailPath, 'src/second.js');
});

test('showEmpty announces the cleared state instead of leaving listeners on the old reader', async (t) => {
  const { host, seen } = bootHost(t);

  await host.openDocument({ path: 'src/only.js', content: 'body' });
  host.activateDocument('src/only.js');
  host.showEmpty();

  const last = seen[seen.length - 1];
  assert.equal(last.detailPath, '', 'closing the last tab announces an empty path');
  assert.equal(last.readerPath, '', 'the live reader is already cleared at event time');
});
