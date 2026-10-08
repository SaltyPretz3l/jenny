'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { buildSelectorProbeScript } = require('../services/browser-interaction-utils');

function probe(html, selector, options) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom has no layout: give every element a box and a no-op scroll.
  window.Element.prototype.scrollIntoView = () => {};
  window.Element.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 40, height: 20, right: 40, bottom: 20,
  });
  const result = window.eval(buildSelectorProbeScript(selector, options));
  const active = window.document.activeElement;
  window.close();
  return { result, active };
}

describe('buildSelectorProbeScript / focusAny', () => {
  test('focuses a pointer-events:none button without requiring pointer interactivity', () => {
    const { result, active } = probe(
      '<button id="go" style="pointer-events:none">Go</button>', '#go', { focusAny: true }
    );
    assert.equal(result.status, 'ready');
    assert.equal(active.id, 'go');
  });

  test('reports selector_not_focusable for an element that cannot take focus', () => {
    const { result } = probe('<div id="plain">text</div>', '#plain', { focusAny: true });
    assert.equal(result.status, 'selector_not_focusable');
  });

  test('reports selector_not_focusable for a disabled button', () => {
    const { result } = probe('<button id="off" disabled>Off</button>', '#off', { focusAny: true });
    assert.equal(result.status, 'selector_not_focusable');
  });

  test('a missing selector still reports selector_not_found', () => {
    const { result } = probe('<p></p>', '#nope', { focusAny: true });
    assert.equal(result.status, 'selector_miss');
    assert.equal(result.reason, 'selector_not_found');
  });

  test('click/type probes still treat pointer-events:none as hidden', () => {
    const { result } = probe('<button id="go" style="pointer-events:none">Go</button>', '#go');
    assert.equal(result.status, 'selector_hidden');
  });
});
