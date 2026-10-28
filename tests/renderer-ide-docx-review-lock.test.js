'use strict';

// A document under review (w:trackRevisions in settings.xml, or revisions in
// its content) opens read-only: edits made here would not be tracked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const modelUtils = require('../renderer/features/renderer-ide-docx-model');
const renderUtils = require('../renderer/features/renderer-ide-docx-render');
const { createIdeDocxPane } = require('../renderer/features/renderer-ide-docx-host');

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const FIXTURE = path.join(__dirname, 'fixtures', 'documents', 'paragraphs.docx');

async function packageWith(parts) {
  const zip = await zipUtils.readZip(new Uint8Array(fs.readFileSync(FIXTURE)));
  const bytes = await zipUtils.writeZip(zip, new Map(Object.entries(parts)));
  return { base64: Buffer.from(bytes).toString('base64'), size: bytes.length, mtimeMs: 1 };
}

const TRACKING = {
  'word/settings.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W_NS}"><w:trackRevisions/></w:settings>`,
};

function harness() {
  const dom = new JSDOM('<div id="host"></div>', { pretendToBeVisual: true });
  const host = dom.window.document.querySelector('#host');
  const edits = [];
  let saves = 0;
  const pane = createIdeDocxPane({
    getHost: () => host,
    onEdit: (filePath) => edits.push(filePath),
    onSaveRequest: () => { saves += 1; },
    zipUtils,
    modelUtils,
    renderUtils,
  });
  const doc = () => host.querySelector('.ide-docx-doc:not(.hidden)');
  const lockBar = () => host.querySelector('.ide-docx-review-lock');
  const button = (action) => host.querySelector(`[data-ide-docx-action="${action}"]`);
  const firstParagraph = () => doc().querySelector('.ide-docx-p');
  function type(text) {
    renderUtils.setCaret(dom.window.document, firstParagraph(), 0);
    const event = new dom.window.InputEvent('beforeinput', { inputType: 'insertText', data: text, bubbles: true, cancelable: true });
    doc().dispatchEvent(event);
    return event;
  }
  function key(value, options = {}) {
    const event = new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    doc().dispatchEvent(event);
    return event;
  }
  return { dom, host, pane, edits, saves: () => saves, doc, lockBar, button, firstParagraph, type, key };
}

async function open(h, source, filePath = 'C:/review.docx') {
  assert.deepEqual(await h.pane.load(filePath, source), { ok: true });
  assert.equal(h.pane.show(filePath), true);
  return filePath;
}

test('a document that tracks revisions opens read-only with the review notice', async () => {
  const h = harness();
  const filePath = await open(h, await packageWith(TRACKING));
  assert.equal(h.doc().getAttribute('contenteditable'), 'false');
  assert.equal(h.lockBar().classList.contains('hidden'), false);
  assert.match(h.lockBar().textContent, /tracks changes/);
  assert.equal(h.button('bold').disabled, true);
  assert.equal(h.button('undo').disabled, true);
  assert.equal(h.button('editAnyway').disabled, false);

  const typed = h.type('X');
  assert.equal(typed.defaultPrevented, true, 'the browser never mutates the locked DOM');
  assert.equal(h.firstParagraph().textContent, 'Quarterly summary');
  assert.equal(h.key('b', { ctrlKey: true }).defaultPrevented, false);
  h.button('bold').click();
  assert.equal(h.pane.isDirty(filePath), false);
  assert.deepEqual(h.edits, []);

  assert.equal(h.key('s', { ctrlKey: true }).defaultPrevented, true, 'Save still passes through');
  assert.equal(h.saves(), 1);
  h.pane.dispose();
});

test('Edit anyway unlocks for this open document, across reloads, but not after reopening', async () => {
  const h = harness();
  const source = await packageWith(TRACKING);
  const filePath = await open(h, source);
  h.button('editAnyway').click();
  assert.equal(h.doc().getAttribute('contenteditable'), 'true');
  assert.equal(h.lockBar().classList.contains('hidden'), true);
  assert.equal(h.button('bold').disabled, false);
  h.type('X');
  assert.equal(h.firstParagraph().textContent, 'XQuarterly summary');
  assert.equal(h.pane.isDirty(filePath), true);

  await open(h, source, filePath);
  assert.equal(h.doc().getAttribute('contenteditable'), 'true', 'a reload keeps the opt-in');
  h.pane.close(filePath);
  await open(h, source, filePath);
  assert.equal(h.doc().getAttribute('contenteditable'), 'false', 'a fresh open asks again');
  h.pane.dispose();
});

test('revisions in the content lock the document even without trackRevisions', async () => {
  const h = harness();
  await open(h, await packageWith({
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="${W_NS}"><w:body>`
      + '<w:p><w:r><w:t>Kept</w:t></w:r><w:ins w:id="1" w:author="Reviewer"><w:r><w:t> added</w:t></w:r></w:ins></w:p>'
      + '</w:body></w:document>',
  }));
  assert.equal(h.doc().getAttribute('contenteditable'), 'false');
  assert.equal(h.lockBar().classList.contains('hidden'), false);
  h.pane.dispose();
});

test('an ordinary document stays editable with no review notice', async () => {
  const h = harness();
  await open(h, await packageWith({}));
  assert.equal(h.doc().getAttribute('contenteditable'), 'true');
  assert.equal(h.lockBar().classList.contains('hidden'), true);
  h.type('X');
  assert.equal(h.firstParagraph().textContent, 'XQuarterly summary');
  h.pane.dispose();
});
