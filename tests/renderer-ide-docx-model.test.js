const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const { JSDOM } = require('jsdom');
const yauzl = require('yauzl');

const { DOMParser, XMLSerializer } = new JSDOM('').window;
const { createDocxModel, W_NS } = require('../renderer/features/renderer-ide-docx-model');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'documents');

function readZipParts(filename, wantedParts) {
  return fs.readFile(path.join(FIXTURE_DIR, filename)).then((buffer) => new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) {
        reject(openError);
        return;
      }
      const parts = new Map();
      zipfile.on('error', reject);
      zipfile.on('end', () => resolve(parts));
      zipfile.on('entry', (entry) => {
        if (!wantedParts.has(entry.fileName)) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('error', reject);
          stream.on('end', () => {
            parts.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });
      zipfile.readEntry();
    });
  }));
}

async function loadFixture(filename) {
  const wanted = new Set([
    'word/document.xml',
    'word/numbering.xml',
    'word/_rels/document.xml.rels',
    'word/media/image1.png',
  ]);
  const parts = await readZipParts(filename, wanted);
  const media = new Map();
  const image = parts.get('word/media/image1.png');
  if (image) {
    media.set('word/media/image1.png', { mime: 'image/png', base64: image.toString('base64') });
  }
  return {
    documentXml: parts.get('word/document.xml').toString('utf8'),
    numberingXml: parts.get('word/numbering.xml')?.toString('utf8') || null,
    relsXml: parts.get('word/_rels/document.xml.rels')?.toString('utf8') || null,
    media,
    DOMParser,
    XMLSerializer,
  };
}

function paragraph(blocks, text) {
  const result = blocks.find((block) => block.type === 'paragraph' && block.text === text);
  assert.ok(result, `paragraph not found: ${text}`);
  return result;
}

function parseXml(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function count(xml, token) {
  return xml.split(token).length - 1;
}

function elementNames(element) {
  return Array.from(element.children, (child) => child.localName);
}

test('reads paragraphs, styles, formatting, tabs, and line breaks', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const blocks = model.getBlocks();

  assert.equal(blocks.length, 3);
  assert.deepEqual(blocks.map((block) => block.id), ['b1', 'b2', 'b3']);
  assert.equal(blocks[0].styleId, 'Heading1');
  assert.equal(blocks[0].text, 'Quarterly summary');
  assert.equal(blocks[1].runs.find((run) => run.text === 'bold').bold, true);
  assert.equal(blocks[1].runs.find((run) => run.text === 'italic').italic, true);
  assert.equal(blocks[1].runs.find((run) => run.text === 'underlined').underline, true);
  assert.equal(blocks[2].text, 'Tab\tafter tab, then\na manual line break.');
});

test('insertText inherits run properties and preserves significant spaces', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  let target = model.getBlocks()[1];
  const boldOffset = target.text.indexOf('bold') + 2;
  assert.equal(model.insertText(target.id, boldOffset, 'X'), true);
  target = model.getBlocks()[1];
  assert.equal(target.runs.find((run) => run.text === 'X').bold, true);

  const boundary = 'Plain '.length;
  assert.equal(model.insertText(target.id, boundary, ' Y '), true);
  target = model.getBlocks()[1];
  const inserted = target.runs.find((run) => run.text === ' Y ');
  assert.ok(inserted);
  assert.equal(inserted.bold, false);

  const xml = model.serialize()['word/document.xml'];
  const insertedText = Array.from(parseXml(xml).getElementsByTagNameNS(W_NS, 't'))
    .find((node) => node.textContent === ' Y ');
  assert.equal(insertedText.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'space'), 'preserve');
});

test('deleteRange spans runs, retains surrounding formatting, and keeps the paragraph', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const target = model.getBlocks()[1];
  const start = target.text.indexOf('n ');
  const end = target.text.indexOf('italic') + 2;
  const expected = target.text.slice(0, start) + target.text.slice(end);

  assert.equal(model.deleteRange(target.id, start, end), true);
  const changed = model.getBlocks()[1];
  assert.equal(changed.text, expected);
  assert.equal(changed.runs.some((run) => run.italic && run.text === 'alic'), true);
  assert.equal(model.getBlocks().length, 3);

  const wholeRunModel = createDocxModel(await loadFixture('paragraphs.docx'));
  const wholeTarget = wholeRunModel.getBlocks()[1];
  const boldStart = wholeTarget.text.indexOf('bold');
  const beforeCount = parseXml(wholeRunModel.serialize()['word/document.xml'])
    .getElementsByTagNameNS(W_NS, 'r').length;
  wholeRunModel.deleteRange(wholeTarget.id, boldStart, boldStart + 4);
  const afterCount = parseXml(wholeRunModel.serialize()['word/document.xml'])
    .getElementsByTagNameNS(W_NS, 'r').length;
  assert.equal(afterCount, beforeCount - 1);
});

test('splitParagraph splits formatted runs and clones list paragraph properties', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const target = model.getBlocks()[1];
  const splitAt = target.text.indexOf('italic') + 3;
  const newId = model.splitParagraph(target.id, splitAt);
  assert.ok(newId);
  const blocks = model.getBlocks();
  assert.equal(blocks[1].text.endsWith('ita'), true);
  assert.equal(blocks[2].text.startsWith('lic'), true);
  assert.equal(blocks[1].runs.at(-1).italic, true);
  assert.equal(blocks[2].runs[0].italic, true);

  const listModel = createDocxModel(await loadFixture('lists-tables.docx'));
  const apples = paragraph(listModel.getBlocks(), 'Apples');
  const listNewId = listModel.splitParagraph(apples.id, 3);
  assert.deepEqual(listModel.getListInfo(listNewId), { kind: 'bullet', numId: '1', level: 0 });
});

test('mergeWithPrevious reverses a split and rejects invalid siblings', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const original = model.getBlocks()[1];
  assert.equal(model.mergeWithPrevious(model.getBlocks()[0].id), null);
  const splitId = model.splitParagraph(original.id, 10);
  assert.equal(model.mergeWithPrevious(splitId), original.id);
  assert.equal(model.getParagraphText(original.id), original.text);

  const tableModel = createDocxModel(await loadFixture('lists-tables.docx'));
  const afterTable = paragraph(tableModel.getBlocks(), 'After the table.');
  assert.equal(tableModel.mergeWithPrevious(afterTable.id), null);
});

test('split and merge keep a mid-document section break on its section\'s last paragraph', () => {
  const sectPr = '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>';
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<w:document xmlns:w="${W_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>`
    + '<w:p><w:r><w:t>Intro</w:t></w:r></w:p>'
    + `<w:p><w:pPr>${sectPr}</w:pPr><w:r><w:t>Section one end</w:t></w:r></w:p>`
    + '<w:p><w:r><w:t>Section two</w:t></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>';
  const load = () => createDocxModel({ documentXml, numberingXml: null, relsXml: null, media: new Map(), DOMParser, XMLSerializer });
  const sectionOwners = (model) => Array.from(parseXml(model.serialize()['word/document.xml'])
    .getElementsByTagNameNS(W_NS, 'p'))
    .filter((p) => p.getElementsByTagNameNS(W_NS, 'sectPr').length)
    .map((p) => p.textContent);

  // Enter inside the section's last paragraph: only the right half still ends the section.
  const split = load();
  split.splitParagraph(paragraph(split.getBlocks(), 'Section one end').id, 7);
  assert.deepEqual(sectionOwners(split), [' one end']);

  // Backspace at the start of the next section would fold two sections into one: refused.
  const across = load();
  assert.equal(across.mergeWithPrevious(paragraph(across.getBlocks(), 'Section two').id), null);
  assert.deepEqual(sectionOwners(across), ['Section one end']);

  // Backspace at the start of the section's last paragraph: the merged paragraph keeps the break.
  const within = load();
  assert.ok(within.mergeWithPrevious(paragraph(within.getBlocks(), 'Section one end').id));
  assert.deepEqual(sectionOwners(within), ['IntroSection one end']);
  assert.match(within.serialize()['word/document.xml'], /headerReference/);
});

test('toggleRunProperty isolates a partial range and maintains rPr schema order', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const target = model.getBlocks()[1];
  const start = target.text.indexOf('italic') + 1;
  const end = start + 4;
  const originalRunCount = target.runs.length;

  assert.equal(model.toggleRunProperty(target.id, start, end, 'bold'), true);
  assert.equal(model.getBlocks()[1].runs.length, originalRunCount + 2);
  assert.equal(model.toggleRunProperty(target.id, start, end, 'underline'), true);

  const xml = parseXml(model.serialize()['word/document.xml']);
  const formattedRun = Array.from(xml.getElementsByTagNameNS(W_NS, 'r'))
    .find((run) => run.textContent === 'tali');
  assert.deepEqual(elementNames(formattedRun.getElementsByTagNameNS(W_NS, 'rPr')[0]), ['b', 'i', 'u']);

  assert.equal(model.toggleRunProperty(target.id, start, end, 'underline'), false);
  assert.equal(model.toggleRunProperty(target.id, start, end, 'bold'), false);
  const restored = model.getBlocks()[1].runs.find((run) => run.text === 'tali');
  assert.equal(restored.bold, false);
  assert.equal(restored.italic, true);
  assert.equal(restored.underline, false);
});

test('resolves, reuses, removes, and creates numbering definitions', async () => {
  const model = createDocxModel(await loadFixture('lists-tables.docx'));
  const blocks = model.getBlocks();
  const apples = paragraph(blocks, 'Apples');
  const first = paragraph(blocks, 'First step');
  const shopping = paragraph(blocks, 'Shopping list');
  assert.deepEqual(model.getListInfo(apples.id), { kind: 'bullet', numId: '1', level: 0 });
  assert.deepEqual(model.getListInfo(first.id), { kind: 'number', numId: '2', level: 0, start: 1 });
  assert.equal(model.setList(shopping.id, 'bullet'), true);
  assert.deepEqual(model.getListInfo(shopping.id), { kind: 'bullet', numId: '1', level: 0 });
  assert.equal(model.setList(shopping.id, null), true);
  assert.equal(model.getListInfo(shopping.id), null);

  const newModel = createDocxModel(await loadFixture('paragraphs.docx'));
  assert.equal(newModel.setList(newModel.getBlocks()[0].id, 'number'), true);
  const serialized = newModel.serialize();
  assert.equal(serialized.newNumberingPart, true);
  assert.match(serialized['word/numbering.xml'], /w:numFmt w:val="decimal"/);
});

test('tables expose nested paragraph ids and preserve table structure during edits', async () => {
  const model = createDocxModel(await loadFixture('lists-tables.docx'));
  const table = model.getBlocks().find((block) => block.type === 'table');
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0].cells.length, 2);
  assert.equal(table.rows[1].cells[0].blocks[0].text, 'Cash');
  assert.equal(table.rows[1].cells[1].blocks[0].text, '1,250.00');

  const cash = table.rows[1].cells[0].blocks[0];
  assert.equal(model.insertText(cash.id, cash.text.length, ' account'), true);
  assert.equal(model.getParagraphText(cash.id), 'Cash account');
  const xml = model.serialize()['word/document.xml'];
  assert.equal(count(xml, '<w:tblPr'), 1);
  assert.equal(count(xml, '<w:tblGrid'), 1);
});

test('images and unsupported content are represented without disturbing wrappers', async () => {
  const options = await loadFixture('images-headers.docx');
  const originalXml = options.documentXml;
  const noEditModel = createDocxModel(options);
  const noEditXml = noEditModel.serialize()['word/document.xml'];
  assert.equal(noEditXml.startsWith(originalXml.match(/^<\?xml[^\r\n]*\?>\r?\n/)[0]), true);
  const originalNormalized = new XMLSerializer().serializeToString(parseXml(originalXml));
  const roundTripNormalized = new XMLSerializer().serializeToString(parseXml(noEditXml));
  assert.equal(roundTripNormalized, originalNormalized);
  for (const name of ['bookmarkStart', 'fldSimple', 'footnoteReference', 'hyperlink', 'drawing', 'sectPr']) {
    assert.equal(count(noEditXml, `<w:${name}`), count(originalXml, `<w:${name}`));
  }

  const model = createDocxModel(await loadFixture('images-headers.docx'));
  let blocks = model.getBlocks();
  const imageRun = blocks[0].runs.find((run) => run.kind === 'image');
  assert.match(imageRun.src, /^data:image\/png;base64,/);
  assert.equal(imageRun.widthPx, 96);
  assert.equal(blocks[1].text, 'Bookmarked paragraph with a link and page 1 with a footnote');
  assert.equal(model.getUnsupportedNotes().includes('fields'), true);
  assert.equal(model.getUnsupportedNotes().includes('footnotes'), true);

  const linkEnd = blocks[1].text.indexOf('link') + 4;
  assert.equal(model.insertText(blocks[1].id, linkEnd, '!'), true);
  const serialized = parseXml(model.serialize()['word/document.xml']);
  const insertedText = Array.from(serialized.getElementsByTagNameNS(W_NS, 't'))
    .find((node) => node.textContent === '!');
  assert.equal(insertedText.closest('w\\:hyperlink'), null);
  assert.equal(serialized.getElementsByTagNameNS(W_NS, 'hyperlink').length, 1);

  blocks = model.getBlocks();
  const imageOffset = blocks[0].text.indexOf('\uFFFC');
  assert.equal(model.deleteRange(blocks[0].id, imageOffset, imageOffset + 1), true);
  assert.equal(model.getBlocks()[0].runs.some((run) => run.kind === 'image'), false);
});

test('inserted images carry valid DrawingML relationships and undo restores all package state', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const block = model.getBlocks()[0];
  const image = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
  assert.equal(model.insertImage(block.id, 0, {
    mime: 'image/png', base64: image, widthPx: 200, heightPx: 100, name: 'chart.png',
  }), true);
  let serialized = model.serialize();
  assert.equal(serialized.media.size, 1);
  assert.match(serialized['word/_rels/document.xml.rels'], /relationships\/image/);
  let xml = parseXml(serialized['word/document.xml']);
  const graphicData = xml.getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/main', 'graphicData')[0];
  assert.equal(graphicData.getAttribute('uri'), 'http://schemas.openxmlformats.org/drawingml/2006/picture');
  assert.equal(model.resizeImage(block.id, 0, 300, 150), true);
  assert.equal(model.getBlocks()[0].runs[0].widthPx, 300);
  assert.equal(model.undo(), true);
  assert.equal(model.getBlocks()[0].runs[0].widthPx, 200);
  model.markSaved();
  assert.equal(model.insertText(block.id, 1, 'after image'), true);
  serialized = model.serialize();
  assert.match(serialized['word/_rels/document.xml.rels'], /relationships\/image/);
  assert.equal(serialized.media.size, 1);
  assert.equal(model.undo(), true);
  assert.equal(model.undo(), true);
  serialized = model.serialize();
  assert.equal(serialized.media.size, 0);
  xml = parseXml(serialized['word/document.xml']);
  assert.equal(xml.getElementsByTagNameNS(W_NS, 'drawing').length, 0);
  assert.equal(serialized['word/_rels/document.xml.rels'], undefined);
});

test('transactions coalesce undo, redo restores it, and dirty state follows saved bytes', async () => {
  const model = createDocxModel(await loadFixture('paragraphs.docx'));
  const originalIds = model.getBlocks().map((block) => block.id);
  const target = model.getBlocks()[0];
  const originalText = target.text;
  assert.equal(model.isDirty(), false);

  model.beginTransaction();
  for (let index = 0; index < 5; index += 1) {
    assert.equal(model.insertText(target.id, originalText.length + index, String(index)), true);
  }
  model.endTransaction();
  assert.equal(model.canUndo(), true);
  assert.equal(model.isDirty(), true);
  assert.equal(model.undo(), true);
  assert.equal(model.getParagraphText(target.id), originalText);
  assert.equal(model.isDirty(), false);
  assert.deepEqual(model.getBlocks().map((block) => block.id), originalIds);
  assert.equal(model.canUndo(), false);
  assert.equal(model.redo(), true);
  assert.equal(model.getParagraphText(target.id), `${originalText}01234`);
  model.markSaved();
  assert.equal(model.isDirty(), false);
});

test('invalid document XML throws docx_invalid', () => {
  assert.throws(
    () => createDocxModel({ documentXml: '<w:document>', DOMParser, XMLSerializer }),
    (error) => error?.code === 'docx_invalid',
  );
  assert.throws(
    () => createDocxModel({ documentXml: '<root/>', DOMParser, XMLSerializer }),
    (error) => error?.code === 'docx_invalid',
  );
});

test('new images reserve unloaded package names across undo and redo', async () => {
  const options = await loadFixture('images-headers.docx');
  const occupied = 'word/media/jenny-body-image-1.png';
  const model = createDocxModel({ ...options, media: new Map(), occupiedNames: new Set([occupied]) });
  const block = model.getBlocks()[0];
  assert.equal(model.insertImage(block.id, 0, { mime: 'image/png', base64: 'AQ==', widthPx: 40, heightPx: 40 }), true);
  assert.deepEqual([...model.serialize().media.keys()], ['word/media/jenny-body-image-2.png']);
  assert.equal(model.undo(), true);
  assert.equal(model.redo(), true);
  assert.deepEqual([...model.serialize().media.keys()], ['word/media/jenny-body-image-2.png']);
});

test('deleteRange never removes zero-length runs such as footnote references', async () => {
  const options = await loadFixture('images-headers.docx');
  const model = createDocxModel(options);
  const block = model.getBlocks()[1];
  assert.equal(count(model.serialize()['word/document.xml'], '<w:footnoteReference'), 1);
  // delete every visible character of the paragraph; the reference run sits inside the range
  assert.equal(model.deleteRange(block.id, 0, block.text.length), true);
  const xml = model.serialize()['word/document.xml'];
  assert.equal(count(xml, '<w:footnoteReference'), 1, 'reference preserved');
  assert.equal(count(xml, '<w:fldSimple'), count(options.documentXml, '<w:fldSimple'), 'fields preserved');
  assert.equal(model.getParagraphText(block.id), '');
});
