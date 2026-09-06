'use strict';

/* Editor-host external-reload EOL tracking (WIDE-047): openDocument re-running
 * on an already-open path (external reload / refresh) must re-derive doc.eol
 * from the incoming disk version on every accepted reload, not ratchet only
 * toward CRLF. Driven with a minimal fake Monaco (mirrors
 * renderer-ide-editor-host-markers.test.js). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeEditorHost } = require('../renderer/features/renderer-ide-editor-host');

function makeFakeMonaco() {
  const model = {
    value: '',
    getValue() { return this.value; },
    setValue(v) { this.value = v; },
    getAlternativeVersionId: () => 1,
    getLanguageId: () => 'javascript',
    dispose() {},
  };
  const api = {
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49 },
    Uri: { parse: (value) => ({ toString: () => String(value) }) },
    editor: {
      create: () => ({ addCommand() {}, onDidChangeModelContent() {}, dispose() {} }),
      getModel: () => null,
      createModel: (text) => { model.value = text; return model; },
      onDidChangeMarkers: () => ({ dispose() {} }),
    },
  };
  return { api, model };
}

function makeHost() {
  const dom = new JSDOM('<!doctype html><body><div id="ideEditorHost"></div></body>');
  const fake = makeFakeMonaco();
  const host = createIdeEditorHost({
    getDom: () => ({ ideEditorHost: dom.window.document.getElementById('ideEditorHost') }),
    monacoUtils: {
      ...require('../renderer/features/renderer-monaco-editor-utils'),
      ensureMonacoEditorApi: async () => fake.api,
      normalizeEditorLanguage: () => 'javascript',
    },
    imageHostUtils: {},
    previewHostUtils: {},
  });
  return { host, fake, dom };
}

test('external reload CRLF -> LF clears the stale CRLF indicator', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDocument({ path: 'a.txt', content: 'a\r\nb', eol: 'crlf' });
  assert.equal(host.getEol('a.txt'), 'crlf', 'initial open tracks crlf');

  // External normalization to LF lands as a second openDocument on the same
  // path (refresh/external-reload path), content now LF-only.
  await host.openDocument({ path: 'a.txt', content: 'a\nb', eol: 'lf' });
  assert.equal(host.getEol('a.txt'), 'lf', 'reload must clear the stale crlf flag, not retain it');

  // A save writes whatever the model actually holds - the reloaded LF content -
  // regardless of the (now-correct) doc.eol metadata.
  assert.equal(host.getValue('a.txt'), 'a\nb', 'save target reflects the reloaded LF content');
  assert.equal(fake.model.getValue(), 'a\nb');
});

test('external reload LF -> CRLF updates the indicator to crlf', async (t) => {
  const { host, fake } = makeHost();
  t.after(() => host.dispose());

  await host.openDocument({ path: 'b.txt', content: 'a\nb', eol: 'lf' });
  assert.equal(host.getEol('b.txt'), 'lf', 'initial open tracks lf');

  await host.openDocument({ path: 'b.txt', content: 'a\r\nb', eol: 'crlf' });
  assert.equal(host.getEol('b.txt'), 'crlf', 'reload must adopt the newly-detected crlf');
  assert.equal(host.getValue('b.txt'), 'a\r\nb', 'save target reflects the reloaded CRLF content');
  assert.equal(fake.model.getValue(), 'a\r\nb');
});

test('repeated reloads with unchanged eol keep the indicator stable', async (t) => {
  const { host } = makeHost();
  t.after(() => host.dispose());

  await host.openDocument({ path: 'c.txt', content: 'a\nb', eol: 'lf' });
  await host.openDocument({ path: 'c.txt', content: 'a\nb\nc', eol: 'lf' });
  assert.equal(host.getEol('c.txt'), 'lf');
});
