const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const {
  buildModel,
  findChangedStartIndex,
  fingerprintHtml,
} = require('../renderer/shared/markdown-stream-units');

test('unit fingerprints include length and remain stable', () => {
  assert.equal(fingerprintHtml('<p>a</p>'), fingerprintHtml('<p>a</p>'));
  assert.notEqual(fingerprintHtml('<p>a</p>'), fingerprintHtml('<p>aa</p>'));
});

test('exact HTML comparison rejects a synthetic fingerprint collision', () => {
  const previous = [{ fingerprint: 'unit_collision', html: '<p>old</p>' }];
  const next = [{ fingerprint: 'unit_collision', html: '<p>new</p>' }];
  assert.equal(findChangedStartIndex(previous, next), 0);
});

test('buildModel preserves top-level units and exact unchanged prefixes', () => {
  const dom = new JSDOM('<template id="t"><p>One</p><p>Two</p></template>');
  const nodes = dom.window.document.getElementById('t').content.childNodes;
  const first = buildModel(nodes, '<p>One</p><p>Two</p>', [], (value) => value);
  const second = buildModel(nodes, '<p>One</p><p>Two</p>', first.units, (value) => value);
  assert.equal(first.units.length, 2);
  assert.equal(second.changedStartIndex, -1);
  dom.window.close();
});
