'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const ooxml = require('../renderer/features/renderer-ide-docx-ooxml');

const { DOMParser, XMLSerializer } = new JSDOM('').window;
const { W_NS } = ooxml;

function paragraphOf(body) {
  const doc = new DOMParser().parseFromString(
    `<w:document xmlns:w="${W_NS}"><w:body><w:p>${body}</w:p></w:body></w:document>`, 'application/xml');
  return doc.getElementsByTagNameNS(W_NS, 'p')[0];
}

test('run positions count text, tabs, breaks and drawings but not field codes', () => {
  const paragraph = paragraphOf('<w:r><w:t>ab</w:t><w:tab/></w:r>'
    + '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGE </w:instrText></w:r>'
    + '<w:hyperlink><w:r><w:t>cd</w:t><w:br/></w:r></w:hyperlink>');
  const positions = ooxml.runPositions(paragraph);
  assert.deepEqual(positions.map(({ text, start, end }) => [text, start, end]),
    [['ab\t', 0, 3], ['', 3, 3], ['', 3, 3], ['cd\n', 3, 6]]);
  assert.equal(ooxml.fieldCharType(positions[1].run), 'begin');
});

test('splitRun keeps run properties on both halves and marks edge spaces preserved', () => {
  const paragraph = paragraphOf('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">one two</w:t></w:r>');
  const [{ run }] = ooxml.runPositions(paragraph);
  const right = ooxml.splitRun(run, 4);
  assert.equal(ooxml.runText(run), 'one ');
  assert.equal(ooxml.runText(right), 'two');
  assert.ok(ooxml.directRunProperty(right, 'b'));
  const xml = new XMLSerializer().serializeToString(paragraph);
  assert.match(xml, /<w:t xml:space="preserve">one <\/w:t>/);
  assert.match(xml, /<w:t>two<\/w:t>/);
});

test('removeRunSlice drops an emptied run and DTD detection is case-insensitive', () => {
  const paragraph = paragraphOf('<w:r><w:t>ab</w:t></w:r><w:r><w:t>cd</w:t></w:r>');
  const [first, second] = ooxml.runPositions(paragraph).map((item) => item.run);
  ooxml.removeRunSlice(first, 0, 2);
  ooxml.removeRunSlice(second, 1, 2);
  assert.equal(paragraph.getElementsByTagNameNS(W_NS, 'r').length, 1);
  assert.equal(ooxml.runText(second), 'c');
  assert.equal(ooxml.hasDoctype('<!doctype x><x/>'), true);
  assert.equal(ooxml.hasDoctype('<x/>'), false);
});
