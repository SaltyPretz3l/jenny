'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const textField = require('../renderer/inventory/text-field');

test('text-field renders a number input with min, max and step (Runtime limits form)', () => {
  const dom = new JSDOM(`<div>${textField({ id: 'limit', label: 'Programs at once', type: 'number', min: 0, max: 64, step: 1, value: 2 })}</div>`);
  const input = dom.window.document.querySelector('input');
  assert.equal(input.type, 'number');
  assert.equal(input.getAttribute('min'), '0');
  assert.equal(input.getAttribute('max'), '64');
  assert.equal(input.getAttribute('step'), '1');
  assert.equal(input.getAttribute('inputmode'), 'numeric');
  assert.equal(input.value, '2');
  assert.equal(input.hasAttribute('dir'), false, 'numbers are not bidi text');
  dom.window.close();
});

test('number bounds are ignored for text fields and unknown types still fall back to text', () => {
  const dom = new JSDOM(`<div>${textField({ id: 'a', label: 'A', min: 1, step: 1 })}${textField({ id: 'b', label: 'B', type: 'date' })}</div>`);
  const [a, b] = dom.window.document.querySelectorAll('input');
  assert.equal(a.type, 'text');
  assert.equal(a.hasAttribute('min'), false);
  assert.equal(a.hasAttribute('inputmode'), false);
  assert.equal(b.type, 'text');
  dom.window.close();
});
