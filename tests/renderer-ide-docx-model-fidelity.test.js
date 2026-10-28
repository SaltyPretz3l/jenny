'use strict';

// OOXML fidelity regressions for the DOCX model: inline documents only, so
// each case pins the exact markup Word would reject or misread.
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const { DOMParser, XMLSerializer } = new JSDOM('').window;
const { createDocxModel, W_NS } = require('../renderer/features/renderer-ide-docx-model');

function parseXml(xml) {
  return new DOMParser().parseFromString(xml, 'application/xml');
}

function elementNames(element) {
  return Array.from(element.children, (child) => child.localName);
}

const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const INLINE_NS = [
  `xmlns:w="${W_NS}"`,
  `xmlns:r="${R_NS}"`,
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  `xmlns:a="${A_NS}"`,
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');
const IMAGE_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + `<Relationship Id="rId9" Type="${R_NS}/image" Target="/word/media/image1.png"/></Relationships>`;
const DRAWING = '<w:drawing><wp:inline><wp:extent cx="952500" cy="952500"/><wp:docPr id="1" name="p"/>'
  + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
  + '<pic:blipFill><a:blip r:embed="rId9"><a:extLst><a:ext uri="{28A0092B-C50C-407E-A947-70E740481C1C}"/></a:extLst></a:blip></pic:blipFill>'
  + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></pic:spPr>'
  + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';

function inlineModel(body, options = {}) {
  return createDocxModel({
    documentXml: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${INLINE_NS}><w:body>${body}</w:body></w:document>`,
    numberingXml: null,
    relsXml: null,
    media: new Map([['word/media/image1.png', { mime: 'image/png', base64: 'AQ==' }]]),
    DOMParser,
    XMLSerializer,
    ...options,
  });
}

function hasParserErrorIn(xml) {
  return parseXml(xml).getElementsByTagName('parsererror').length > 0;
}

test('a run mixing text and a drawing keeps snapshot offsets equal to model offsets', () => {
  const model = inlineModel(`<w:p><w:r><w:t xml:space="preserve">Caption </w:t>${DRAWING}</w:r><w:r><w:t>tail</w:t></w:r></w:p>`,
    { relsXml: IMAGE_RELS });
  const [block] = model.getBlocks();
  assert.equal(block.text, 'Caption ￼tail');
  assert.equal(block.text, model.getParagraphText(block.id));
  assert.deepEqual(block.runs.map((run) => run.kind), ['text', 'image', 'text']);
  assert.equal(block.runs[1].src, 'data:image/png;base64,AQ==', 'an absolute /word/media target resolves');
  assert.deepEqual(model.getBlock(block.id), block);
});

test('resizing an image writes the xfrm extent, never an extension-list a:ext', () => {
  const model = inlineModel(`<w:p><w:r>${DRAWING}</w:r></w:p>`, { relsXml: IMAGE_RELS });
  assert.equal(model.resizeImage('b1', 0, 50, 40), true);
  const xml = parseXml(model.serialize()['word/document.xml']);
  const [extension, size] = Array.from(xml.getElementsByTagNameNS(A_NS, 'ext'));
  assert.equal(extension.hasAttribute('cx'), false);
  assert.equal(size.getAttribute('cx'), String(50 * 9525));
  assert.equal(size.getAttribute('cy'), String(40 * 9525));
});

test('insertText drops characters XML 1.0 cannot carry', () => {
  const model = inlineModel('<w:p><w:r><w:t>x</w:t></w:r></w:p>');
  assert.ok(model.insertText('b1', 1, 'a\u0007b\u000Cc\uD800d\r\ne'));
  assert.equal(model.getParagraphText('b1'), 'xabcd\ne');
  assert.equal(hasParserErrorIn(model.serialize()['word/document.xml']), false);
});

test('text typed at the end of a field result lands after the field', () => {
  const model = inlineModel('<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>');
  assert.ok(model.insertText('b1', 6, ' of X'));
  const xml = model.serialize()['word/document.xml'];
  assert.ok(xml.indexOf('fldCharType="end"') < xml.indexOf(' of X'), xml);
  assert.equal(model.getParagraphText('b1'), 'Page 1 of X');
});

test('a run created from the paragraph mark drops revision-only properties', () => {
  const model = inlineModel('<w:p><w:pPr><w:rPr><w:ins w:id="1" w:author="a"/><w:b/></w:rPr></w:pPr></w:p>');
  assert.ok(model.insertText('b1', 0, 'x'));
  const run = parseXml(model.serialize()['word/document.xml']).getElementsByTagNameNS(W_NS, 'r')[0];
  assert.deepEqual(elementNames(run.getElementsByTagNameNS(W_NS, 'rPr')[0]), ['b']);
});

test('new numbering starts at one and keeps numbering.xml schema order', () => {
  const fresh = inlineModel('<w:p><w:r><w:t>one</w:t></w:r></w:p>');
  assert.equal(fresh.setList('b1', 'number'), true);
  const level = parseXml(fresh.serialize()['word/numbering.xml']).getElementsByTagNameNS(W_NS, 'lvl')[0];
  assert.equal(elementNames(level)[0], 'start');
  assert.equal(fresh.getBlocks()[0].list.start, 1);

  const trailing = inlineModel('<w:p><w:r><w:t>one</w:t></w:r></w:p>', {
    numberingXml: `<w:numbering xmlns:w="${W_NS}"><w:numIdMacAtCleanup w:val="0"/></w:numbering>`,
  });
  assert.equal(trailing.setList('b1', 'bullet'), true);
  assert.deepEqual(elementNames(parseXml(trailing.serialize()['word/numbering.xml']).documentElement),
    ['abstractNum', 'num', 'numIdMacAtCleanup']);
});

test('splitting inside a tracked insertion gives the right half its own revision id', () => {
  const model = inlineModel('<w:p><w:ins w:id="5" w:author="a"><w:r><w:t>abcd</w:t></w:r></w:ins></w:p>');
  assert.ok(model.splitParagraph('b1', 2));
  const ids = Array.from(parseXml(model.serialize()['word/document.xml']).getElementsByTagNameNS(W_NS, 'ins'),
    (item) => item.getAttributeNS(W_NS, 'id'));
  assert.deepEqual(ids, ['5', '6']);
});

test('package XML with a DTD is refused', () => {
  assert.throws(() => createDocxModel({
    documentXml: `<!DOCTYPE x [<!ENTITY a "a">]><w:document xmlns:w="${W_NS}"><w:body/></w:document>`,
    DOMParser,
    XMLSerializer,
  }), (error) => error.code === 'docx_invalid');
});

test('an inserted image deleted but kept for undo is not referenced by the exported package', () => {
  const model = inlineModel('<w:p><w:r><w:t>x</w:t></w:r></w:p>', {
    relsXml: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  });
  assert.equal(model.insertImage('b1', 1, { mime: 'image/png', base64: 'AQ==', widthPx: 10, heightPx: 10 }), true);
  assert.equal(model.deleteRange('b1', 1, 2), true);
  const deleted = model.serialize();
  assert.doesNotMatch(deleted['word/_rels/document.xml.rels'] || '', /jenny-body-image/);
  assert.equal(deleted.media.size, 0);
  assert.equal(model.undo(), true);
  const restored = model.serialize();
  assert.match(restored['word/_rels/document.xml.rels'], /jenny-body-image-1\.png/);
  assert.equal(restored.media.size, 1);
});

test('block snapshots are reused until the next change and getBlock matches getBlocks', () => {
  const model = inlineModel('<w:p><w:r><w:t>one</w:t></w:r></w:p><w:p><w:r><w:t>two</w:t></w:r></w:p>');
  const first = model.getBlocks();
  assert.equal(model.getBlocks(), first);
  assert.deepEqual(model.getBlock('b2'), first[1]);
  model.insertText('b2', 3, '!');
  assert.notEqual(model.getBlocks(), first);
  assert.equal(model.getBlock('b2').text, 'two!');
  model.undo();
  assert.equal(model.getBlock('b2').text, 'two');
  assert.equal(model.isDirty(), false);
});

test('insertText returns the length it actually inserted after sanitizing', () => {
  const model = inlineModel('<w:p><w:r><w:t>x</w:t></w:r></w:p>');
  assert.equal(model.insertText('b1', 1, 'a\u0007b\r\nc'), 4);
  assert.equal(model.getParagraphText('b1'), 'xab\nc');
  assert.equal(model.insertText('b1', 0, '\u0007'), false);
});

test('bold lands before rPrChange and newly typed text does not inherit the revision', () => {
  const change = '<w:rPrChange w:id="3" w:author="a"><w:rPr/></w:rPrChange>';
  const model = inlineModel(`<w:p><w:r><w:rPr><w:i/>${change}</w:rPr><w:t>abcd</w:t></w:r></w:p>`);
  assert.equal(model.toggleRunProperty('b1', 0, 4, 'bold'), true);
  let rPr = parseXml(model.serialize()['word/document.xml']).getElementsByTagNameNS(W_NS, 'rPr')[0];
  assert.deepEqual(elementNames(rPr), ['b', 'i', 'rPrChange']);
  assert.ok(model.insertText('b1', 4, 'typed'));
  assert.ok(model.insertText('b1', 2, 'mid'));
  const runs = Array.from(parseXml(model.serialize()['word/document.xml']).getElementsByTagNameNS(W_NS, 'r'));
  const typed = runs.filter((run) => /typed|mid/.test(run.textContent));
  assert.equal(typed.length, 2);
  for (const run of typed) {
    rPr = run.getElementsByTagNameNS(W_NS, 'rPr')[0];
    assert.deepEqual(elementNames(rPr), ['b', 'i'], 'typed text keeps formatting but not the revision');
  }
  const split = runs.filter((run) => /^(ab|cd)$/.test(run.textContent));
  assert.equal(split.length, 2);
  for (const run of split) assert.ok(run.getElementsByTagNameNS(W_NS, 'rPrChange').length, 'split halves keep it');
});

test('an unparseable numbering part refuses list edits instead of replacing every definition', () => {
  const model = inlineModel('<w:p><w:r><w:t>one</w:t></w:r></w:p>', { numberingXml: `<w:numbering xmlns:w="${W_NS}"><w:num` });
  assert.equal(model.setList('b1', 'number'), false);
  assert.equal(model.isDirty(), false);
  const serialized = model.serialize();
  assert.equal(serialized['word/numbering.xml'], undefined);
  assert.equal(serialized.newNumberingPart, false);
});

test('resize finds a drawing that shares its run with text or another drawing', () => {
  const model = inlineModel(`<w:p><w:r><w:t xml:space="preserve">Caption </w:t>${DRAWING}${DRAWING}</w:r></w:p>`,
    { relsXml: IMAGE_RELS });
  assert.equal(model.resizeImage('b1', 8, 50, 40), true);
  assert.equal(model.resizeImage('b1', 9, 60, 30), true);
  assert.equal(model.resizeImage('b1', 3, 60, 30), false, 'a text offset is not an image');
  const extents = Array.from(parseXml(model.serialize()['word/document.xml'])
    .getElementsByTagNameNS('http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'extent'));
  assert.deepEqual(extents.map((item) => item.getAttribute('cx')), [String(50 * 9525), String(60 * 9525)]);
});

test('deleting plain text never rescans media; deleting a drawing does', () => {
  const resources = { stacks: [], sequence: 0, mediaStores: [] };
  const model = inlineModel('<w:p><w:r><w:t>abcdef</w:t></w:r></w:p>', {
    resources, relsXml: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  });
  assert.equal(model.insertImage('b1', 6, { mime: 'image/png', base64: 'AQ==', widthPx: 10, heightPx: 10 }), true);
  const store = resources.mediaStores[0];
  const reclaim = store.reclaim;
  let calls = 0;
  store.reclaim = () => { calls += 1; reclaim(); };
  model.beginTransaction();
  assert.equal(model.deleteRange('b1', 5, 6), true);
  const afterFirst = calls;
  assert.equal(model.deleteRange('b1', 4, 5), true);
  assert.equal(model.deleteRange('b1', 3, 4), true);
  assert.equal(calls, afterFirst, 'text-only deletions inside one transaction do not reclaim');
  assert.equal(model.deleteRange('b1', 3, 4), true, 'the drawing');
  assert.equal(calls, afterFirst + 1);
  model.endTransaction();
  assert.equal(model.serialize().media.size, 0);
});
