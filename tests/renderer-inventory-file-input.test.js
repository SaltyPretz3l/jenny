const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const fileInput = require('../renderer/inventory/file-input');

test('file chooser remains hidden and treats option values as attributes', () => {
  const dom = new JSDOM('<body></body>');
  const input = fileInput(dom.window.document, {
    className: 'image-picker',
    accept: 'image/png,image/jpeg',
  });
  dom.window.document.body.appendChild(input);
  assert.equal(input.type, 'file');
  assert.equal(input.hidden, true);
  assert.equal(input.accept, 'image/png,image/jpeg');
  assert.equal(input.multiple, false);
  const literal = fileInput(dom.window.document, { className: '"><script>bad()</script>', hidden: false });
  dom.window.document.body.appendChild(literal);
  assert.equal(literal.hidden, false);
  assert.equal(dom.window.document.querySelector('script'), null);
  dom.window.close();
});
