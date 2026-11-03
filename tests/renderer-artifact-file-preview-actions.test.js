'use strict';

// Coverage for renderer/features/renderer-artifact-file-preview-actions.js: the text actions the
// file preview controller attaches to its rendered body (shared panel code actions, find, header
// Copy). JSDOM with the real shared modules; clipboard, toast, composer and menu are stubbed.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createFilePreviewActions } = require('../renderer/features/renderer-artifact-file-preview-actions');

const CODE_HTML = '<div class="artifact-file-preview-bar">bar</div>'
  + '<ol class="artifact-file-preview-code" start="1">'
  + '<li class="artifact-file-preview-row" data-preview-line="1"><span class="artifact-file-preview-gutter">1</span><code data-language-id="javascript">const a = 1;</code></li>'
  + '<li class="artifact-file-preview-row" data-preview-line="2"><span class="artifact-file-preview-gutter">2</span><code data-language-id="javascript">const b = 2;</code></li>'
  + '</ol>';

function readySlot(overrides) {
  return Object.assign({
    path: 'src/app.js', status: 'ready',
    payload: { kind: 'code', text: 'const a = 1;\nconst b = 2;', totalLines: 2, byteTruncated: false },
  }, overrides || {});
}

function makeHarness(t, bodyHtml) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host">' + (bodyHtml || CODE_HTML) + '</div></body></html>', {
    url: 'https://jenny.local/chat',
  });
  const doc = dom.window.document;
  const calls = { clipboard: [], toasts: [], composer: [], menus: [], ide: [], reloads: 0, logs: [] };
  const state = { clipboardError: null };
  const actions = createFilePreviewActions({
    windowRef: dom.window,
    jt: (key, fallback, params) => (params
      ? String(fallback).replace(/\{(\w+)\}/g, (m, name) => String(params[name]))
      : fallback),
    showToast: (message) => calls.toasts.push(message),
    appendClientLog: (level, event) => calls.logs.push(`${level}:${event}`),
    writeClipboard: (text) => {
      if (state.clipboardError) return Promise.reject(state.clipboardError);
      calls.clipboard.push(text);
      return Promise.resolve();
    },
    insertIntoComposer: (payload) => { calls.composer.push(payload.text); return true; },
    contextMenu: { show: (options) => calls.menus.push(options) },
    openInIde: (slot, line) => calls.ide.push({ path: slot.path, line }),
    reload: () => { calls.reloads += 1; },
  });
  t.after(() => actions.dispose());
  return { dom, doc, host: doc.getElementById('host'), actions, calls, state };
}

function openMenuOnRow(h, line) {
  const row = h.host.querySelector(`[data-preview-line="${line}"]`);
  row.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  return h.calls.menus[h.calls.menus.length - 1];
}

function findItem(menu, label) {
  return menu.items.find((item) => item.label === label);
}

function selectRow(h, line) {
  const code = h.host.querySelector(`[data-preview-line="${line}"] code`);
  h.doc.getSelection().selectAllChildren(code);
}

describe('hydrate — code list', () => {
  test('attaches the body menu with the file path, row line and Reload', (t) => {
    const h = makeHarness(t);
    const slot = readySlot();
    h.actions.hydrate(h.host, slot);

    assert.equal(h.host.querySelector('.artifact-file-preview-code').getAttribute('tabindex'), '0');
    const menu = openMenuOnRow(h, 2);
    findItem(menu, 'Open in IDE at line 2').action();
    assert.deepEqual(h.calls.ide, [{ path: 'src/app.js', line: 2 }]);
    assert.equal(findItem(menu, 'View file at line 2'), undefined, 'already viewing the file');
    findItem(menu, 'Reload file').action();
    assert.equal(h.calls.reloads, 1);
    findItem(menu, 'Copy path').action();
    return Promise.resolve().then(() => assert.deepEqual(h.calls.clipboard, ['src/app.js']));
  });

  test('Ask Jenny references the selection with the row language id', (t) => {
    const h = makeHarness(t);
    h.actions.hydrate(h.host, readySlot());
    selectRow(h, 2);
    const menu = openMenuOnRow(h, 2);
    findItem(menu, 'Ask Jenny').action();
    assert.equal(h.calls.composer.length, 1);
    assert.match(h.calls.composer[0], /^`src\/app\.js:2`\n```javascript\nconst b = 2;\n```/);
  });

  test('without a selection Ask Jenny inserts the backticked path', (t) => {
    const h = makeHarness(t);
    h.actions.hydrate(h.host, readySlot());
    findItem(openMenuOnRow(h, 1), 'Ask Jenny about this file').action();
    assert.deepEqual(h.calls.composer, ['`src/app.js` ']);
  });

  test('sets the find offset from the sticky bar and Ctrl+F opens the find field', (t) => {
    const h = makeHarness(t);
    const bar = h.host.querySelector('.artifact-file-preview-bar');
    Object.defineProperty(bar, 'offsetHeight', { value: 36 });
    h.actions.hydrate(h.host, readySlot());

    assert.equal(h.host.style.getPropertyValue('--panel-code-find-offset'), '36px');
    const list = h.host.querySelector('.artifact-file-preview-code');
    list.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.ok(h.host.querySelector('.panel-code-find'), 'find field inserted next to the code list');
  });
});

describe('hydrate — markdown Read body', () => {
  const DOC_HTML = '<div class="artifact-file-preview-bar">bar</div><div class="artifact-file-preview-doc"><p>hello</p></div>';

  test('attaches the body menu without find', (t) => {
    const h = makeHarness(t, DOC_HTML);
    h.actions.hydrate(h.host, readySlot({ path: 'docs/readme.md', payload: { kind: 'markdown', text: '# hello', totalLines: 1 } }));

    const doc = h.host.querySelector('.artifact-file-preview-doc');
    doc.dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const menu = h.calls.menus[0];
    findItem(menu, 'Ask Jenny about this file').action();
    assert.deepEqual(h.calls.composer, ['`docs/readme.md` ']);

    doc.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(h.host.querySelector('.panel-code-find'), null, 'no find on the rendered doc');
    assert.equal(h.host.style.getPropertyValue('--panel-code-find-offset'), '');
  });
});

describe('hydrate — re-render and teardown', () => {
  test('re-hydrating the same body does not stack chips or listeners', (t) => {
    const h = makeHarness(t);
    h.actions.hydrate(h.host, readySlot());
    h.actions.hydrate(h.host, readySlot());

    assert.equal(h.host.querySelectorAll('.panel-code-ask').length, 1);
    openMenuOnRow(h, 1);
    assert.equal(h.calls.menus.length, 1, 'one contextmenu listener');
  });

  test('a body with nothing to act on (loading, image) releases the previous attachments', (t) => {
    const h = makeHarness(t);
    h.actions.hydrate(h.host, readySlot());
    h.actions.hydrate(h.host, readySlot({ status: 'loading', payload: null }));

    assert.equal(h.host.querySelectorAll('.panel-code-ask').length, 0);
    assert.equal(h.host.style.getPropertyValue('--panel-code-find-offset'), '');
    h.host.querySelector('[data-preview-line="1"]').dispatchEvent(new h.dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    assert.equal(h.calls.menus.length, 0);

    h.host.innerHTML = '<div class="artifact-file-preview-image"><img alt="x"></div>';
    h.actions.hydrate(h.host, readySlot({ payload: { kind: 'image', mime: 'image/png', base64: 'AA' } }));
    assert.equal(h.host.querySelectorAll('.panel-code-ask').length, 0);
  });

  test('dispose detaches the actions', (t) => {
    const h = makeHarness(t);
    h.actions.hydrate(h.host, readySlot());
    h.actions.dispose();

    assert.equal(h.host.querySelectorAll('.panel-code-ask').length, 0);
    assert.equal(h.host.querySelector('.artifact-file-preview-code').hasAttribute('tabindex'), false);
    openMenuOnRow(h, 1);
    assert.equal(h.calls.menus.length, 0);
  });
});

describe('copyContents', () => {
  test('copies the full loaded text, not the rendered window, and toasts', async (t) => {
    const h = makeHarness(t);
    const full = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join('\n');
    const copied = await h.actions.copyContents(readySlot({ payload: { kind: 'code', text: full, totalLines: 5000, truncated: true, byteTruncated: false } }));

    assert.equal(copied, true);
    assert.deepEqual(h.calls.clipboard, [full]);
    assert.deepEqual(h.calls.toasts, ['Copied']);
  });

  test('a byte-capped read says how many lines were copied', async (t) => {
    const h = makeHarness(t);
    await h.actions.copyContents(readySlot({ payload: { kind: 'code', text: 'a\nb\nc', totalLines: 3, truncated: true, byteTruncated: true } }));

    assert.deepEqual(h.calls.clipboard, ['a\nb\nc']);
    assert.deepEqual(h.calls.toasts, ['Copied the first 3 lines']);
  });

  test('a clipboard failure toasts and logs, and reports false', async (t) => {
    const h = makeHarness(t);
    h.state.clipboardError = new Error('denied');
    const copied = await h.actions.copyContents(readySlot());

    assert.equal(copied, false);
    assert.deepEqual(h.calls.toasts, ['Couldn’t copy']);
    assert.deepEqual(h.calls.logs, ['WARN:artifact_file_preview.copy_failed']);
  });

  test('images and unloaded slots copy nothing', async (t) => {
    const h = makeHarness(t);
    assert.equal(await h.actions.copyContents(readySlot({ payload: { kind: 'image', mime: 'image/png', base64: 'AA' } })), false);
    assert.equal(await h.actions.copyContents(readySlot({ status: 'loading', payload: null })), false);
    assert.deepEqual(h.calls.clipboard, []);
    assert.deepEqual(h.calls.toasts, []);
  });
});
