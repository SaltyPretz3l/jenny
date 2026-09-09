'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildDetailBodyMarkup, toggleDetailClamp } = require('../renderer/chat/renderer-tool-detail-body');
const { setChildrenHtmlPreservingKeyedNodes } = require('../renderer/chat/renderer-stream-dom-patch-utils');

function row(id, output, input = {}) {
  return `<div class="tool-call-row" data-row-id="${id}" data-expanded="true"><div class="tool-call-header" aria-expanded="true"></div><div class="tool-call-row-body">${buildDetailBodyMarkup({
    toolName: 'example', domToken: id, outputText: output, input,
  })}</div></div>`;
}

for (const output of [Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'), 'long output '.repeat(1500)]) {
  test(`full output survives appended rows (${output.length} chars) and explicit collapse`, (t) => {
    const markup = row('first', output);
    const dom = new JSDOM(`<div id="root">${markup}</div>`);
    t.after(() => dom.window.close());
    const root = dom.window.document.getElementById('root');
    const control = () => root.querySelector('[data-tool-detail-toggle]');
    const target = () => root.querySelector('[data-detail-clamped]');
    assert.equal(toggleDetailClamp(control()), true);
    for (let i = 1; i <= 3; i += 1) {
      setChildrenHtmlPreservingKeyedNodes(root, markup + row(`next-${i}`, output));
      assert.equal(target().getAttribute('data-detail-clamped'), 'false');
      assert.equal(target().textContent, output);
      assert.equal(control().getAttribute('aria-expanded'), 'true');
      assert.equal(control().textContent, 'Show less');
      assert.equal(control().getAttribute('title'), 'Collapse output');
      assert.equal(root.querySelector(`[data-row-id="next-${i}"] [data-detail-clamped]`).getAttribute('data-detail-clamped'), 'true');
    }
    toggleDetailClamp(control());
    setChildrenHtmlPreservingKeyedNodes(root, markup + row('final', 'short'));
    assert.equal(target().getAttribute('data-detail-clamped'), 'true');
    assert.equal(control().getAttribute('aria-expanded'), 'false');
    assert.equal(control().getAttribute('title'), 'Show full output');
  });
}

test('capped argument expansion is independent of output and restores current content', (t) => {
  const value = 'argument '.repeat(1500);
  const output = 'result\n'.repeat(20);
  const dom = new JSDOM(`<div id="root">${row('args', output, { value })}</div>`);
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');
  toggleDetailClamp(root.querySelector('[data-tool-detail-toggle]'));
  const updated = value + 'new value';
  setChildrenHtmlPreservingKeyedNodes(root, row('args', output, { value: updated }) + row('new', 'short'));
  const controls = root.querySelectorAll('[data-tool-detail-toggle]');
  assert.equal(controls[0].getAttribute('aria-expanded'), 'true');
  assert.equal(controls[1].getAttribute('aria-expanded'), 'false');
  assert.equal(root.querySelector('[data-detail-field-key="value"]').textContent, updated);
});
