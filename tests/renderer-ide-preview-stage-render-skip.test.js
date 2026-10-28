'use strict';

/* Preview stage perf pins: a debounced buffer change whose text is unchanged is
 * not re-rendered, and the UTF-8 size bound only encodes text that could be
 * near the limit (a 200 ms pause no longer encodes the whole buffer). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ideState = require('../renderer/features/renderer-ide-state');
const { createIdePreviewStage } = require('../renderer/features/renderer-ide-preview-stage');

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function makeStage(buffers, t) {
  const dom = new JSDOM('<div id="idePreviewHost" class="hidden"></div>');
  const hostEl = dom.window.document.getElementById('idePreviewHost');
  const ide = ideState.createIdeUiState();
  const renders = [];
  globalThis.markdownUtils = {
    renderMarkdown: (source) => { renders.push(source); return `<p>${source.replace(/[<>&]/g, '')}</p>`; },
    renderInlineMermaidBlocks: () => {},
  };
  const versions = {};
  const stage = createIdePreviewStage({
    getDom: () => ({ idePreviewHost: hostEl }),
    getIde: () => ide,
    ideStateUtils: ideState,
    editorHost: {
      hasDocument: (path) => path in buffers,
      getValue: (path) => buffers[path] || '',
      getAltVersionId: (path) => versions[path] || 1,
    },
    windowRef: dom.window,
  });
  t.after(() => { stage.dispose(); delete globalThis.markdownUtils; });
  return { stage, ide, hostEl, renders, versions };
}

test('a debounced model change with unchanged text skips the re-render', async (t) => {
  const buffers = { 'a.md': 'SAME' };
  const h = makeStage(buffers, t);
  ideState.openTab(h.ide, 'a.md');
  ideState.setPreviewPath(h.ide, 'a.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.equal(h.renders.length, 1);

  h.versions['a.md'] = 2; // an edit that was undone: new version, same text
  h.stage.handleModelChange('a.md');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(h.renders.length, 1, 'identical text is not re-rendered');

  buffers['a.md'] = 'CHANGED';
  h.versions['a.md'] = 3;
  h.stage.handleModelChange('a.md');
  await new Promise((resolve) => setTimeout(resolve, 260));
  assert.equal(h.renders.length, 2);
  assert.match(h.hostEl.querySelector('.ide-preview-content').textContent, /CHANGED/);
});

test('the preview size bound UTF-8-encodes only text that could be near the limit', async (t) => {
  const encode = TextEncoder.prototype.encode;
  let encodes = 0;
  TextEncoder.prototype.encode = function countedEncode(...args) {
    if (args[0] === '# small') encodes += 1;
    return encode.apply(this, args);
  };
  t.after(() => { TextEncoder.prototype.encode = encode; });
  const h = makeStage({ 'small.md': '# small' }, t);
  ideState.setPreviewPath(h.ide, 'small.md');
  ideState.setStageSurface(h.ide, 'preview');
  h.stage.sync(true);
  await settle();
  assert.equal(h.renders.length, 1);
  assert.equal(encodes, 0, 'a small buffer is never encoded just to measure it');
});
