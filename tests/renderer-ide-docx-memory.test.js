'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { createDocxModel, W_NS } = require('../renderer/features/renderer-ide-docx-model');
const { createCompositeDocxModel } = require('../renderer/features/renderer-ide-docx-rich');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');
const zipUtils = require('../renderer/features/renderer-ide-docx-zip');

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const image = (base64 = 'AQ==') => ({ mime: 'image/png', base64, widthPx: 40, heightPx: 40 });

function options(t, extra = {}) {
  const dom = new JSDOM('');
  t.after(() => dom.window.close());
  return {
    documentXml: `<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}"><w:body><w:p/></w:body></w:document>`,
    DOMParser: dom.window.DOMParser, XMLSerializer: dom.window.XMLSerializer,
    ...extra,
  };
}

function composite(t, extra = {}) {
  return createCompositeDocxModel({ ...options(t, extra), createDocxModel });
}

function exhaustUndo(model) {
  let count = 0;
  while (model.canUndo()) {
    const before = model.getParagraphText('b1');
    assert.equal(model.undo(), true, 'every advertised Undo must restore a snapshot');
    assert.notEqual(model.getParagraphText('b1'), before, 'Undo must restore content');
    count += 1;
    assert.ok(count <= 250);
  }
  assert.equal(model.undo(), false);
  return count;
}

test('ten image insert/delete cycles export no new media or dangling relationships and reopen', async (t) => {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const pane = createIdeDocxPane({ getHost: () => dom.window.document.querySelector('#host') });
  t.after(() => pane.dispose());
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/documents/paragraphs.docx'));
  let model;
  const capturingPane = createIdeDocxPane({
    getHost: () => dom.window.document.querySelector('#host'),
    modelUtils: { createDocxModel(value) { model = createDocxModel(value); return model; } },
  });
  t.after(() => capturingPane.dispose());
  const source = { base64: bytes.toString('base64'), size: bytes.length, mtimeMs: 1 };
  assert.equal((await capturingPane.load('/cycles.docx', source)).ok, true);
  for (let cycle = 0; cycle < 10; cycle += 1) {
    assert.equal(model.insertImage('b1', 0, image()), true);
    assert.equal(model.deleteRange('b1', 0, 1), true);
  }
  const serialized = model.serialize();
  assert.doesNotMatch(serialized['word/document.xml'], /<w:drawing/);
  assert.equal(serialized.media.size, 0, 'deleted inserted images must not be exported');
  assert.doesNotMatch(serialized['word/_rels/document.xml.rels'] || '', /jenny-body-image-/);
  const exported = await capturingPane.exportBytes('/cycles.docx');
  const zip = await zipUtils.readZip(new Uint8Array(Buffer.from(exported, 'base64')));
  assert.equal(zip.order.filter((name) => name.startsWith('word/media/jenny-')).length, 0);
  const original = await zipUtils.readZip(new Uint8Array(bytes));
  for (const name of original.order.filter((name) => name !== 'word/document.xml')) {
    assert.deepEqual(await zipUtils.readEntryBytes(zip, name), await zipUtils.readEntryBytes(original, name));
  }
  assert.equal((await pane.load('/reopened.docx', { base64: exported, size: Buffer.from(exported, 'base64').length })).ok, true);
  assert.equal(dom.window.document.querySelectorAll('.ide-docx-img').length, 0);
});

test('deletion hides inserted media from export but undo and redo retain the payload', (t) => {
  const model = createDocxModel(options(t));
  assert.equal(model.insertImage('b1', 0, image()), true);
  model.markSaved();
  assert.equal(model.deleteRange('b1', 0, 1), true);
  assert.equal(model.serialize().media.size, 0, 'deleted media is export-ineligible');
  assert.equal(model.undo(), true);
  assert.equal(model.getBlocks()[0].runs[0].src, 'data:image/png;base64,AQ==');
  assert.equal(model.serialize().media.size, 1);
  assert.equal(model.isDirty(), false, 'undo to saved image state is clean');
  assert.equal(model.redo(), true);
  assert.equal(model.serialize().media.size, 0);
  assert.equal(model.undo(), true);
  assert.equal(model.serialize().media.size, 1);
});

test('250 committed edits exhaust composite routes exactly with the 200 real snapshots', (t) => {
  const model = composite(t);
  for (let edit = 0; edit < 250; edit += 1) {
    model.beginTransaction();
    assert.equal(model.insertText('b1', edit, 'x'), true);
    model.endTransaction();
  }
  assert.equal(exhaustUndo(model), 200);
  assert.equal(model.getParagraphText('b1'), 'x'.repeat(50));
  for (let edit = 0; edit < 200; edit += 1) {
    assert.equal(model.canRedo(), true);
    assert.equal(model.redo(), true);
  }
  assert.equal(model.canRedo(), false);
  assert.equal(model.getParagraphText('b1'), 'x'.repeat(250));
});

test('32 MiB history budget evicts oldest snapshots across body and header', (t) => {
  const padding = 'p'.repeat(1024 * 1024);
  const model = composite(t, {
    documentXml: `<w:document xmlns:w="${W_NS}"><!--${padding}--><w:body><w:p/></w:body></w:document>`,
    relatedParts: [{
      key: 'header1', type: 'header', path: 'word/header1.xml',
      xml: `<w:hdr xmlns:w="${W_NS}"><!--${padding}--><w:p/></w:hdr>`,
    }],
  });
  for (let edit = 0; edit < 40; edit += 1) {
    const id = edit % 2 ? 'header1::b1' : 'b1';
    assert.equal(model.insertText(id, model.getParagraphText(id).length, 'x'), true);
  }
  let count = 0;
  while (model.canUndo()) {
    const before = [model.getParagraphText('b1'), model.getParagraphText('header1::b1')];
    assert.equal(model.undo(), true);
    assert.notDeepEqual([model.getParagraphText('b1'), model.getParagraphText('header1::b1')], before);
    count += 1;
  }
  assert.equal(count, 31, 'only the newest 31 snapshots fit below 32 MiB');
  assert.equal(model.getParagraphText('b1'), 'x'.repeat(5));
  assert.equal(model.getParagraphText('header1::b1'), 'x'.repeat(4));
  let redos = 0;
  while (model.canRedo()) { assert.equal(model.redo(), true); redos += 1; }
  assert.equal(redos, 31);
});

test('aggregate inserted-media budget rejects overflow and reclaims after history eviction', (t) => {
  const model = createDocxModel(options(t));
  const chunk = 'A'.repeat(8 * 1024 * 1024);
  for (let inserted = 0; inserted < 8; inserted += 1) {
    assert.equal(model.insertImage('b1', inserted, image(chunk)), true);
  }
  const before = model.serialize()['word/document.xml'];
  assert.equal(model.insertImage('b1', 8, image('AQ==')), false, '64 MiB aggregate overflow must be rejected');
  assert.equal(model.serialize()['word/document.xml'], before);
  assert.equal(model.deleteRange('b1', 0, 8), true);
  assert.equal(model.insertImage('b1', 0, image('AQ==')), false, 'undo-reachable payloads still consume the budget');
  for (let edit = 0; edit < 200; edit += 1) assert.equal(model.insertText('b1', edit, 'x'), true);
  assert.equal(model.insertImage('b1', 0, image(chunk)), true, 'evicted media must free the insertion budget');
  assert.equal(model.serialize().media.size, 1);
});

test('aggregate media budget is shared across body and header', (t) => {
  const model = composite(t, {
    relatedParts: [{ key: 'header1', type: 'header', path: 'word/header1.xml', xml: `<w:hdr xmlns:w="${W_NS}"><w:p/></w:hdr>` }],
  });
  const chunk = 'A'.repeat(8 * 1024 * 1024);
  for (let inserted = 0; inserted < 8; inserted += 1) {
    const id = inserted % 2 ? 'header1::b1' : 'b1';
    assert.equal(model.insertImage(id, model.getParagraphText(id).length, image(chunk)), true);
  }
  assert.equal(model.insertImage('header1::b1', 4, image()), false, 'budget covers the whole document');
});

test('dirty checks use identities without JSON-serializing base64 and undo returns to saved state', (t) => {
  let jsonReads = 0;
  const original = { ...image(), toJSON() { jsonReads += 1; return { mime: this.mime, base64: this.base64 }; } };
  const model = createDocxModel(options(t, { media: new Map([['word/media/original.png', original]]) }));
  assert.equal(model.isDirty(), false);
  model.markSaved();
  assert.equal(model.insertImage('b1', 0, image('AQ==')), true);
  model.markSaved();
  assert.equal(model.insertText('b1', 1, 'changed'), true);
  assert.equal(model.isDirty(), true);
  assert.equal(model.undo(), true);
  assert.equal(model.isDirty(), false);
  assert.equal(jsonReads, 0, 'media payloads must never pass through JSON serialization');
  assert.equal(model.undo(), true);
  assert.equal(model.insertImage('b1', 0, image('Ag==')), true);
  assert.equal(model.isDirty(), true, 'same-size replacement media must be dirty');
});

test('original unreferenced relationships and package media survive deletion', (t) => {
  const relsXml = `<Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="${R_NS}/image" Target="media/original.png"/></Relationships>`;
  const original = { mime: 'image/png', base64: 'Ag==' };
  const model = createDocxModel(options(t, { relsXml, media: new Map([['word/media/original.png', original]]) }));
  assert.equal(model.insertImage('b1', 0, image()), true);
  assert.equal(model.deleteRange('b1', 0, 1), true);
  assert.equal(model.serialize().media.size, 0);
  assert.equal(model.serialize()['word/_rels/document.xml.rels'] || relsXml, relsXml);
});

test('a new edit clears redo before byte eviction so remaining undo snapshots survive', (t) => {
  const padding = 'p'.repeat(1024 * 1024);
  const model = composite(t, {
    documentXml: `<w:document xmlns:w="${W_NS}"><!--${padding}--><w:body><w:p/></w:body></w:document>`,
    relatedParts: [{
      key: 'header1', type: 'header', path: 'word/header1.xml',
      xml: `<w:hdr xmlns:w="${W_NS}"><!--${padding}${padding}--><w:p/></w:hdr>`,
    }],
  });
  for (let edit = 0; edit < 31; edit += 1) assert.equal(model.insertText('b1', edit, 'x'), true);
  for (let undo = 0; undo < 20; undo += 1) assert.equal(model.undo(), true);
  assert.equal(model.insertText('header1::b1', 0, 'header'), true);
  assert.equal(model.canRedo(), false);
  assert.equal(model.undo(), true);
  assert.equal(model.getParagraphText('header1::b1'), '');
  assert.equal(exhaustUndo(model), 11, 'discarded redo must not force eviction of valid undo');
});

test('a document larger than the history budget keeps one undo and its redo', (t) => {
  const padding = 'p'.repeat(33 * 1024 * 1024);
  const model = createDocxModel(options(t, {
    documentXml: `<w:document xmlns:w="${W_NS}"><!--${padding}--><w:body><w:p/></w:body></w:document>`,
  }));
  assert.equal(model.insertText('b1', 0, 'x'), true);
  assert.equal(model.canUndo(), true, 'the just-recorded snapshot must survive the budget');
  assert.equal(model.undo(), true);
  assert.equal(model.getParagraphText('b1'), '');
  assert.equal(model.canRedo(), true, 'undo must not evict its own redo snapshot');
  assert.equal(model.redo(), true);
  assert.equal(model.getParagraphText('b1'), 'x');
});

test('redo-only media does not count against a new insert', (t) => {
  const model = createDocxModel(options(t));
  const chunk = 'A'.repeat(8 * 1024 * 1024);
  for (let inserted = 0; inserted < 8; inserted += 1) {
    assert.equal(model.insertImage('b1', inserted, image(chunk)), true);
  }
  for (let undone = 0; undone < 8; undone += 1) assert.equal(model.undo(), true);
  assert.equal(model.insertImage('b1', 0, image('AQ==')), true, 'the insert discards redo, so its payloads are free');
  assert.equal(model.canRedo(), false);
});
