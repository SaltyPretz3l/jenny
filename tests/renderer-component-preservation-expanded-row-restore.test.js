'use strict';

// timeline-perf 2026-10-04: the expanded-row restore runs for every tool row
// of the active turn root on every streamed event. It walks the row once for
// its toggles and bodies instead of running two queries, one of them the
// `[aria-expanded]:not(.tool-call-row-body *)` selector. The writes must stay
// exactly those of the two-query version (the oracle below).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createComponentPreservationRegistry } = require('../renderer/chat/renderer-component-preservation-registry');

function toolRow(id, expanded) {
  const flag = expanded ? 'true' : 'false';
  return `<div class="chat-row" data-row-id="${id}">`
    + `<div class="tool-call-row tool-call-row--minimal" data-tool-call-id="${id}" data-expanded="${flag}" data-tool-details-materialized="true">`
    + `<div class="tool-call-row-header"><div class="tool-call-row-toggle" role="button" aria-expanded="${flag}">read</div>`
    + '<button class="code-toggle" aria-expanded="false">code</button></div>'
    + `<div class="tool-call-row-body" aria-expanded="false"${expanded ? '' : ' inert'}>`
    + '<button class="inner" aria-expanded="false">inner</button>'
    + '<div class="tool-call-row-body nested" inert><span aria-expanded="true">deep</span></div>'
    + '</div></div></div>';
}

// The two-query restore this change replaced, kept as the oracle.
function oracleRestore(node, expanded) {
  if (expanded && node.getAttribute('data-tool-details-materialized') === 'false') return;
  node.setAttribute('data-expanded', expanded ? 'true' : 'false');
  for (const toggle of node.querySelectorAll('[aria-expanded]:not(.tool-call-row-body *)')) {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  }
  for (const body of node.querySelectorAll('.tool-call-row-body')) {
    if (expanded) body.removeAttribute('inert');
    else body.setAttribute('inert', '');
  }
}

function collapseLikeAMorph(root) {
  for (const row of root.querySelectorAll('.tool-call-row')) {
    row.setAttribute('data-expanded', 'false');
    for (const element of row.querySelectorAll('[aria-expanded]')) element.setAttribute('aria-expanded', 'false');
    for (const body of row.querySelectorAll('.tool-call-row-body')) body.setAttribute('inert', '');
  }
}

test('the expanded-row restore writes exactly what the two-query restore wrote', (t) => {
  const dom = new JSDOM(`<!doctype html><body><div id="actual">${toolRow('a', true)}${toolRow('b', false)}</div><div id="expected"></div></body>`);
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const actual = document.getElementById('actual');
  const expected = document.getElementById('expected');
  expected.innerHTML = actual.innerHTML;
  const registry = createComponentPreservationRegistry();
  const snapshot = registry.capture(actual);
  const saved = Array.from(expected.querySelectorAll('.tool-call-row')).map((row) => row.getAttribute('data-expanded') === 'true');

  collapseLikeAMorph(actual);
  collapseLikeAMorph(expected);
  registry.restore(actual, snapshot);
  Array.from(expected.querySelectorAll('.tool-call-row')).forEach((row, index) => oracleRestore(row, saved[index]));

  assert.equal(actual.innerHTML, expected.innerHTML);
  const a = actual.querySelector('[data-tool-call-id="a"]');
  assert.equal(a.getAttribute('data-expanded'), 'true');
  assert.equal(a.querySelector('.code-toggle').getAttribute('aria-expanded'), 'true', 'a header control outside the body follows the row');
  assert.equal(a.querySelector('.tool-call-row-body').getAttribute('aria-expanded'), 'true', 'the body itself is not inside a body');
  assert.equal(a.querySelector('.inner').getAttribute('aria-expanded'), 'false', 'controls inside the body are left alone');
  assert.equal(a.querySelector('.nested').hasAttribute('inert'), false, 'every body, nested ones too, follows the row');
});

test('the expanded-row restore reads each tool row with one query', (t) => {
  const dom = new JSDOM(`<!doctype html><body><div id="root">${toolRow('a', true)}</div></body>`);
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');
  const registry = createComponentPreservationRegistry();
  const snapshot = registry.capture(root);
  collapseLikeAMorph(root);
  const toolRowNode = root.querySelector('.tool-call-row');
  const proto = dom.window.Element.prototype;
  const original = proto.querySelectorAll;
  let rowQueries = 0;
  proto.querySelectorAll = function countingQuerySelectorAll(selector) {
    if (this === toolRowNode) rowQueries += 1;
    return original.call(this, selector);
  };
  t.after(() => { proto.querySelectorAll = original; });
  registry.restore(root, snapshot);
  assert.equal(toolRowNode.getAttribute('data-expanded'), 'true');
  assert.equal(rowQueries, 1);
});
