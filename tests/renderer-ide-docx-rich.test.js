'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const { createDocxModel } = require('../renderer/features/renderer-ide-docx-model');
const { createCompositeDocxModel, discoverRelatedParts } = require('../renderer/features/renderer-ide-docx-rich');

const fixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'documents', name)));

test('composes editable header/body/footer regions and retains changed parts across saves', async () => {
  const windowRef = new JSDOM('').window;
  const zip = await zipUtils.readZip(fixture('images-headers.docx'));
  const optional = async (name) => zip.entries.has(name) ? zipUtils.readEntryText(zip, name) : null;
  const documentXml = await zipUtils.readEntryText(zip, 'word/document.xml');
  const relsXml = await optional('word/_rels/document.xml.rels');
  const descriptors = discoverRelatedParts({ documentXml, relsXml, DOMParser: windowRef.DOMParser });
  const relatedParts = [];
  for (const descriptor of descriptors) {
    relatedParts.push({
      ...descriptor,
      xml: await zipUtils.readEntryText(zip, descriptor.path),
      relsXml: await optional(descriptor.relsPath),
    });
  }
  const model = createCompositeDocxModel({
    createDocxModel, documentXml, relsXml, relatedParts, media: new Map(),
    DOMParser: windowRef.DOMParser, XMLSerializer: windowRef.XMLSerializer,
  });
  const regions = model.getRegions();
  assert.deepEqual(regions.map((region) => region.type), ['header', 'body', 'footer']);
  const header = regions[0].blocks[0];
  const footer = regions[2].blocks[0];
  assert.equal(header.text, 'Confidential header');
  assert.equal(footer.text, 'Footer text');
  assert.equal(model.insertText(header.id, header.text.length, ' edited'), true);
  assert.equal(model.insertText(footer.id, 0, 'Edited '), true);
  let serialized = model.serialize();
  assert.match(serialized.replacements.get('word/header1.xml'), /Confidential header.* edited/);
  assert.match(serialized.replacements.get('word/footer1.xml'), /Edited .*Footer text/);
  assert.equal(serialized.replacements.has('word/footnotes.xml'), false);
  model.markSaved();
  assert.equal(model.insertText(regions[1].blocks[0].id, 0, 'Body edit. '), true);
  serialized = model.serialize();
  assert.match(serialized.replacements.get('word/header1.xml'), /Confidential header.* edited/);
  assert.match(serialized.replacements.get('word/footer1.xml'), /Edited .*Footer text/);
  assert.equal(model.undo(), true);
  assert.equal(model.undo(), true);
  assert.equal(model.getParagraphText(footer.id), 'Footer text');
  assert.equal(model.undo(), true);
  assert.equal(model.getParagraphText(header.id), 'Confidential header');
  serialized = model.serialize();
  assert.doesNotMatch(serialized.replacements.get('word/header1.xml'), /edited/);
  assert.doesNotMatch(serialized.replacements.get('word/footer1.xml'), /Edited/);
});

test('discovers distinct default, first, and even header/footer references', () => {
  const windowRef = new JSDOM('').window;
  const documentXml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:sectPr>'
    + '<w:headerReference w:type="default" r:id="rId1"/><w:headerReference w:type="first" r:id="rId2"/>'
    + '<w:footerReference w:type="even" r:id="rId3"/></w:sectPr></w:body></w:document>';
  const relsXml = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Target="header1.xml"/><Relationship Id="rId2" Target="header2.xml"/>'
    + '<Relationship Id="rId3" Target="footer1.xml"/></Relationships>';
  assert.deepEqual(
    discoverRelatedParts({ documentXml, relsXml, DOMParser: windowRef.DOMParser })
      .map(({ type, variant, path }) => ({ type, variant, path })),
    [
      { type: 'header', variant: 'default', path: 'word/header1.xml' },
      { type: 'header', variant: 'first', path: 'word/header2.xml' },
      { type: 'footer', variant: 'even', path: 'word/footer1.xml' },
    ],
  );
});
