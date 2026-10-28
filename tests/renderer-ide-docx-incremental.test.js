'use strict';

// Enter and paragraph merges patch the DOM in place (positional ids shift
// for later blocks), and package images render from per-document object
// URLs that close revokes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const modelUtils = require('../renderer/features/renderer-ide-docx-model');
const renderUtils = require('../renderer/features/renderer-ide-docx-render');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');

const FIXTURES = path.join(__dirname, 'fixtures', 'documents');

function source(name) {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 };
}

function harness(setup = () => {}) {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  setup(dom.window);
  const host = dom.window.document.querySelector('#host');
  const pane = createIdeDocxPane({ getHost: () => host, zipUtils, modelUtils, renderUtils });
  const doc = () => host.querySelector('.ide-docx-doc:not(.hidden)');
  const block = (id) => doc().querySelector(`.ide-docx-p[data-block="${id}"]`);
  function input(id, offset, inputType) {
    renderUtils.setCaret(dom.window.document, block(id), offset);
    doc().dispatchEvent(new dom.window.InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true }));
  }
  return { dom, host, pane, doc, block, input };
}

async function open(h, payload, filePath = 'C:/doc.docx') {
  assert.deepEqual(await h.pane.load(filePath, payload), { ok: true });
  assert.equal(h.pane.show(filePath), true);
  return filePath;
}

// Every id-carrying element in document order, with its text and list label.
function layout(container) {
  return Array.from(container.querySelectorAll('[data-block], [data-cell]'), (element) => (
    `${element.dataset.block ?? `cell:${element.dataset.cell}`}|${element.dataset.listLabel || ''}|${element.textContent}`
  ));
}

// The patched DOM must match what a full render of the same model gives:
// export it and open the bytes in a fresh pane.
async function assertMatchesFullRender(h, filePath) {
  const fresh = harness();
  await open(fresh, { base64: await h.pane.exportBytes(filePath) });
  assert.deepEqual(layout(h.doc()), layout(fresh.doc()));
  fresh.pane.dispose();
}

test('Enter and Backspace in a plain paragraph patch in place and renumber later blocks', async () => {
  const h = harness();
  const filePath = await open(h, source('lists-tables.docx'));
  const table = h.doc().querySelector('.ide-docx-table');
  h.input('b1', 'Shopping'.length, 'insertParagraph');
  assert.equal(h.doc().querySelector('.ide-docx-table'), table, 'blocks after the split keep their elements');
  assert.equal(h.block('b2').textContent, ' list');
  assert.equal(table.querySelector('.ide-docx-cell').dataset.cell, 'b8.row1.c1');
  await assertMatchesFullRender(h, filePath);

  h.input('b2', 0, 'deleteContentBackward');
  assert.equal(h.doc().querySelector('.ide-docx-table'), table);
  assert.equal(h.block('b1').textContent, 'Shopping list');
  await assertMatchesFullRender(h, filePath);

  h.input('b1', 'Shopping'.length, 'insertParagraph');
  h.input('b1', 'Shopping'.length, 'deleteContentForward');
  assert.equal(h.doc().querySelector('.ide-docx-table'), table);
  await assertMatchesFullRender(h, filePath);
  h.pane.dispose();
});

test('a split inside a table cell or a header renumbers only that container', async () => {
  const h = harness();
  const filePath = await open(h, source('lists-tables.docx'));
  h.input('b7.row1.c1.b1', 'Acc'.length, 'insertParagraph');
  assert.equal(h.block('b7.row1.c1.b2').textContent, 'ount');
  await assertMatchesFullRender(h, filePath);
  h.pane.dispose();

  const withHeader = harness();
  const headerPath = await open(withHeader, source('images-headers.docx'));
  withHeader.input('header1::b1', 'Confidential'.length, 'insertParagraph');
  assert.equal(withHeader.block('header1::b2').textContent, ' header');
  await assertMatchesFullRender(withHeader, headerPath);
  withHeader.pane.dispose();
});

test('Enter in a list paragraph renders everything so numbering stays right', async () => {
  const h = harness();
  const filePath = await open(h, source('lists-tables.docx'));
  const table = h.doc().querySelector('.ide-docx-table');
  h.input('b5', 'First'.length, 'insertParagraph');
  assert.notEqual(h.doc().querySelector('.ide-docx-table'), table, 'a list split falls back to a full render');
  assert.equal(h.block('b7').dataset.listLabel, '3.');
  await assertMatchesFullRender(h, filePath);
  h.pane.dispose();
});

test('typing in a list paragraph re-renders only that paragraph and keeps its label', async () => {
  const h = harness();
  const filePath = await open(h, source('lists-tables.docx'));
  const table = h.doc().querySelector('.ide-docx-table');
  const label = h.block('b6').dataset.listLabel;
  const neighbour = h.block('b5');
  h.input('b6', 'Second'.length, 'deleteContentBackward');
  h.doc().dispatchEvent(new h.dom.window.InputEvent('beforeinput', {
    inputType: 'insertText', data: 'd', bubbles: true, cancelable: true,
  }));
  assert.equal(h.doc().querySelector('.ide-docx-table'), table, 'no full render for a text edit');
  assert.equal(h.block('b5'), neighbour);
  assert.equal(h.block('b6').dataset.listLabel, label);
  assert.equal(h.block('b6').textContent, 'Second step');
  await assertMatchesFullRender(h, filePath);
  h.pane.dispose();
});

test('package images render from object URLs that reload, close and dispose revoke', async () => {
  const created = [];
  const revoked = [];
  const h = harness((window) => {
    window.URL.createObjectURL = (blob) => {
      assert.equal(blob.type, 'image/png');
      created.push(`blob:test/${created.length}`);
      return created.at(-1);
    };
    window.URL.revokeObjectURL = (url) => revoked.push(url);
  });
  const filePath = await open(h, source('images-headers.docx'));
  const image = h.doc().querySelector('.ide-docx-img');
  assert.equal(image.getAttribute('src'), 'blob:test/0');
  assert.equal(image.decoding, 'async');
  h.input('b2', 0, 'insertParagraph');
  assert.equal(created.length, 1, 'one URL per media payload, reused across renders');

  await open(h, source('images-headers.docx'), filePath);
  assert.deepEqual(revoked, ['blob:test/0'], 'a reload revokes the replaced record');
  h.pane.close(filePath);
  assert.deepEqual(revoked, ['blob:test/0', 'blob:test/1']);

  await open(h, source('images-headers.docx'), filePath);
  h.pane.dispose();
  assert.deepEqual(revoked, ['blob:test/0', 'blob:test/1', 'blob:test/2']);
});

test('without createObjectURL images fall back to data URIs', async () => {
  const h = harness();
  await open(h, source('images-headers.docx'));
  assert.match(h.doc().querySelector('.ide-docx-img').getAttribute('src'), /^data:image\/png;base64,/);
  h.pane.dispose();
});
