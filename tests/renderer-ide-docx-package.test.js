'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const zipUtils = require('../renderer/features/renderer-ide-docx-zip');
const { patchPackageParts, tracksRevisions } = require('../renderer/features/renderer-ide-docx-package');

const { DOMParser, XMLSerializer } = new JSDOM('').window;
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function settings(inner) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:settings xmlns:w="${W_NS}">${inner}</w:settings>`;
}

test('trackRevisions is on when present and not switched off', () => {
  assert.equal(tracksRevisions(settings('<w:zoom w:percent="100"/><w:trackRevisions/>'), DOMParser), true);
  assert.equal(tracksRevisions(settings('<w:trackRevisions w:val="true"/>'), DOMParser), true);
  assert.equal(tracksRevisions(settings('<w:trackRevisions w:val="false"/>'), DOMParser), false);
  assert.equal(tracksRevisions(settings('<w:trackRevisions w:val="0"/>'), DOMParser), false);
  assert.equal(tracksRevisions(settings('<w:zoom w:percent="100"/>'), DOMParser), false);
  assert.equal(tracksRevisions(null, DOMParser), false);
  assert.equal(tracksRevisions('<w:settings', DOMParser), false, 'unreadable settings never lock');
  assert.equal(tracksRevisions(`<!DOCTYPE x>${settings('<w:trackRevisions/>')}`, DOMParser), false);
});

test('patchPackageParts registers a new numbering part and inserted media types once', async () => {
  const relsName = 'word/_rels/document.xml.rels';
  const source = await zipUtils.readZip(await zipUtils.writeZip(
    { entries: new Map(), order: [], comment: new Uint8Array() },
    new Map([
      ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="PNG" ContentType="image/png"/></Types>'],
      [relsName, '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="x" Target="styles.xml"/></Relationships>'],
    ]),
  ));
  const replacements = new Map();
  const media = new Map([
    ['word/media/a.png', { mime: 'image/png' }],
    ['word/media/b.gif', { mime: 'image/gif' }],
    ['word/media/c.gif', { mime: 'image/gif' }],
  ]);
  await patchPackageParts({
    zip: source, zipUtils, replacements, Parser: DOMParser, Serializer: XMLSerializer, numbering: true, media,
  });
  const types = replacements.get('[Content_Types].xml');
  assert.match(types, /^<\?xml version="1\.0"\?>/);
  assert.equal(types.split('Extension="gif"').length - 1, 1);
  assert.doesNotMatch(types, /Extension="png"/, 'an existing Default matches case-insensitively');
  assert.match(types, /PartName="\/word\/numbering\.xml"/);
  assert.match(replacements.get(relsName), /Id="rId2"[^>]*Target="numbering\.xml"/);
});
