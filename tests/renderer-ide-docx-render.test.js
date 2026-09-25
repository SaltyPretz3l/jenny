'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const { createDocxModel } = require('../renderer/features/renderer-ide-docx-model');
const renderUtils = require('../renderer/features/renderer-ide-docx-render');

const FIXTURES = path.join(__dirname, 'fixtures', 'documents');
const MIMES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };

function packageTarget(target) {
  const parts = `word/${target}`.split('/');
  const result = [];
  for (const part of parts) {
    if (part === '..') result.pop();
    else if (part && part !== '.') result.push(part);
  }
  return result.join('/');
}

async function fixtureModel(name) {
  const dom = new JSDOM('<main></main>');
  const bytes = new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
  const zip = await zipUtils.readZip(bytes);
  const optional = async (entry) => zip.entries.has(entry) ? zipUtils.readEntryText(zip, entry) : null;
  const relsXml = await optional('word/_rels/document.xml.rels');
  const media = new Map();
  if (relsXml) {
    const rels = new dom.window.DOMParser().parseFromString(relsXml, 'application/xml');
    for (const relationship of rels.getElementsByTagNameNS('*', 'Relationship')) {
      if (!relationship.getAttribute('Type').endsWith('/image')) continue;
      const target = packageTarget(relationship.getAttribute('Target'));
      const extension = target.split('.').pop().toLowerCase();
      const image = await zipUtils.readEntryBytes(zip, target);
      media.set(target, { mime: MIMES[extension], base64: Buffer.from(image).toString('base64') });
    }
  }
  const model = createDocxModel({
    documentXml: await zipUtils.readEntryText(zip, 'word/document.xml'),
    numberingXml: await optional('word/numbering.xml'),
    relsXml,
    media,
    DOMParser: dom.window.DOMParser,
    XMLSerializer: dom.window.XMLSerializer,
  });
  return { dom, model };
}

function mount(dom, blocks) {
  const host = dom.window.document.querySelector('main');
  host.replaceChildren(renderUtils.renderBlocks(dom.window.document, blocks));
  return host;
}

test('renders real paragraph formatting, tabs, lists, tables, and image blocks', async () => {
  const paragraphs = await fixtureModel('paragraphs.docx');
  let host = mount(paragraphs.dom, paragraphs.model.getBlocks());
  assert.equal(host.querySelectorAll('.ide-docx-p').length, 3);
  assert.equal(host.querySelector('[data-style="Heading1"]').textContent, 'Quarterly summary');
  assert.equal(host.querySelector('.ide-docx-run.is-bold').textContent, 'bold');
  assert.equal(host.querySelectorAll('.ide-docx-p')[2].textContent, 'Tab\tafter tab, then\na manual line break.');

  const lists = await fixtureModel('lists-tables.docx');
  host = mount(lists.dom, lists.model.getBlocks());
  assert.deepEqual(
    Array.from(host.querySelectorAll('[data-list="number"]'), (item) => item.dataset.listLabel),
    ['1.', '2.'],
  );
  assert.equal(host.querySelectorAll('.ide-docx-table').length, 1);
  assert.equal(host.querySelectorAll('.ide-docx-cell').length, 4);
  assert.equal(host.querySelector('[data-cell="b7.row2.c1"]').textContent, 'Cash');

  const images = await fixtureModel('images-headers.docx');
  host = mount(images.dom, images.model.getBlocks());
  const image = host.querySelector('.ide-docx-img');
  assert.match(image.src, /^data:image\/png;base64,/);
  assert.equal(image.width, 96);
  assert.equal(image.getAttribute('contenteditable'), 'false');
});

test('number labels restart after an interrupting paragraph and inside a new container', async () => {
  const { dom, model } = await fixtureModel('lists-tables.docx');
  const blocks = model.getBlocks();
  const first = blocks.find((block) => block.text === 'First step');
  const second = blocks.find((block) => block.text === 'Second step');
  const interrupt = blocks.find((block) => block.text === 'Steps');
  const host = mount(dom, [first, second, interrupt, first]);
  assert.deepEqual(
    Array.from(host.querySelectorAll('[data-list="number"]'), (item) => item.dataset.listLabel),
    ['1.', '2.', '1.'],
  );
});

test('resolvePoint and setCaret round trip run boundaries and a tab', async () => {
  const { dom, model } = await fixtureModel('paragraphs.docx');
  const host = mount(dom, model.getBlocks());
  const formatted = host.querySelector('[data-block="b2"]');
  const plainText = formatted.querySelector('.ide-docx-run').firstChild;
  assert.deepEqual(renderUtils.resolvePoint(plainText, 3), { blockId: 'b2', offset: 3 });
  assert.equal(renderUtils.setCaret(dom.window.document, formatted, 6), true);
  assert.deepEqual(renderUtils.resolveSelection(dom.window.getSelection()).anchor, { blockId: 'b2', offset: 6 });

  const tabParagraph = host.querySelector('[data-block="b3"]');
  renderUtils.setCaret(dom.window.document, tabParagraph, 4);
  assert.deepEqual(renderUtils.resolveSelection(dom.window.getSelection()).anchor, { blockId: 'b3', offset: 4 });
  const secondRun = tabParagraph.children[1];
  assert.deepEqual(renderUtils.resolvePoint(tabParagraph, 2), { blockId: 'b3', offset: 4 });
  assert.equal(secondRun.textContent, '\t');
});

test('selection mapping counts images as one and works in table cells', async () => {
  const images = await fixtureModel('images-headers.docx');
  let host = mount(images.dom, images.model.getBlocks());
  const paragraph = host.querySelector('[data-block="b1"]');
  const image = paragraph.querySelector('.ide-docx-img');
  const before = 'Before the picture '.length;
  assert.deepEqual(renderUtils.resolvePoint(image, 0), { blockId: 'b1', offset: before + 1 });
  renderUtils.setCaret(images.dom.window.document, paragraph, before + 1);
  assert.deepEqual(renderUtils.resolveSelection(images.dom.window.getSelection()).anchor, { blockId: 'b1', offset: before + 1 });

  const table = await fixtureModel('lists-tables.docx');
  host = mount(table.dom, table.model.getBlocks());
  const cash = host.querySelector('[data-block="b7.row2.c1.b1"]');
  renderUtils.setCaret(table.dom.window.document, cash, 2);
  assert.deepEqual(
    renderUtils.resolveSelection(table.dom.window.getSelection()).anchor,
    { blockId: 'b7.row2.c1.b1', offset: 2 },
  );
});

test('empty paragraphs and unsupported blocks retain visible non-editable placeholders', () => {
  const dom = new JSDOM('<main></main>');
  const host = mount(dom, [
    { id: 'b1', type: 'paragraph', styleId: '', align: '', list: null, runs: [], text: '' },
    { id: 'b2', type: 'other' },
    { id: 'b3', type: 'paragraph', styleId: '', align: '', list: null, runs: [{ id: 'r1', kind: 'image', src: '' }], text: '\uFFFC' },
  ]);
  assert.ok(host.querySelector('.ide-docx-empty'));
  assert.equal(host.querySelector('.ide-docx-other').getAttribute('contenteditable'), 'false');
  assert.equal(host.querySelector('.ide-docx-img-missing').textContent, '[image]');
});
