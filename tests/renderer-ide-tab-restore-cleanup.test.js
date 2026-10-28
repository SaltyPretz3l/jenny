'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createIdeTabRestore } = require('../renderer/features/renderer-ide-tab-restore');
const { normalizePdfView } = require('../renderer/features/renderer-ide-closed-tabs');

test('teardown removes the restore strip element and a later render builds a fresh one', (t) => {
  const dom = new JSDOM('<div><div class="ide-tabbar"><div id="tabs"></div></div></div>');
  t.after(() => dom.window.close());
  const tabs = dom.window.document.getElementById('tabs');
  const cleanups = [];
  const restore = createIdeTabRestore({
    getDom: () => ({ ideTabStrip: tabs }),
    registerCleanup: (fn) => cleanups.push(fn),
  });
  restore.hydrate({ openTabs: [] }, ['gone.js']);
  restore.render();
  assert.equal(dom.window.document.querySelectorAll('.ide-restore-strip').length, 1);
  cleanups.forEach((fn) => fn());
  assert.equal(dom.window.document.querySelectorAll('.ide-restore-strip').length, 0, 'strip removed on cleanup');
  restore.recordMissing('again.js');
  restore.render();
  assert.equal(dom.window.document.querySelectorAll('.ide-restore-strip').length, 1, 'no duplicate strip after re-render');
});

test('capture keeps only valid PDF page/zoom (shared closed-tabs validator)', () => {
  assert.equal(typeof normalizePdfView, 'function');
  const restore = createIdeTabRestore({
    editorHost: { getPdfViewPosition: (path) => (path === 'a.pdf' ? { page: 3, zoom: 99 } : { page: 0, zoom: 'page-fit' }) },
  });
  const snapshot = restore.capture({ openTabs: [{ path: 'a.pdf' }, { path: 'b.pdf' }], activeTabPath: 'a.pdf' }, null);
  assert.deepEqual(snapshot.openTabs, [{ path: 'a.pdf', page: 3 }, { path: 'b.pdf', zoom: 'page-fit' }]);
});
