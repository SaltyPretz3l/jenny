'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const checkboxModule = require('../renderer/inventory/checkbox');

test('checkbox escapes values and drops unsafe ids and dataset keys', () => {
  const html = checkboxModule.checkbox({
    id: 'unsafe id',
    label: '<Task & "notes">',
    ariaLabel: 'Pick "task"',
    className: 'task-choice bad$class',
    dataset: { 'task-id': 'a&"b', 'Bad Key': 'ignored' },
  });
  const dom = new JSDOM(`<div>${html}</div>`);
  const label = dom.window.document.querySelector('.inv-checkbox');
  const input = label.querySelector('input');

  assert.equal(label.getAttribute('for'), null);
  assert.equal(input.getAttribute('id'), null);
  assert.equal(label.classList.contains('task-choice'), true);
  assert.equal(label.classList.contains('bad$class'), false);
  assert.equal(input.getAttribute('data-task-id'), 'a&"b');
  assert.equal(input.hasAttribute('data-Bad Key'), false);
  assert.equal(input.getAttribute('aria-label'), 'Pick "task"');
  assert.equal(label.querySelector('.inv-checkbox__label').textContent, '<Task & "notes">');
});

test('checkbox markup reflects checked and disabled options', () => {
  const html = checkboxModule.checkbox({ id: 'taskChoice', label: 'Task', checked: true, disabled: true });
  const dom = new JSDOM(`<div>${html}</div>`);
  const label = dom.window.document.querySelector('label.inv-checkbox');
  const inputs = label.querySelectorAll('input[type="checkbox"]');

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].hasAttribute('data-inv-checkbox'), true);
  assert.equal(inputs[0].checked, true);
  assert.equal(inputs[0].disabled, true);
  assert.equal(label.classList.contains('inv-checkbox--on'), true);
  assert.equal(label.getAttribute('for'), 'taskChoice');
  assert.equal(label.querySelector('.inv-checkbox__box').getAttribute('aria-hidden'), 'true');
});

test('checkbox omits the visible label when empty and keeps its aria label', () => {
  const dom = new JSDOM(`<div>${checkboxModule.checkbox({ ariaLabel: 'Select task' })}</div>`);
  const input = dom.window.document.querySelector('[data-inv-checkbox]');
  assert.equal(input.getAttribute('aria-label'), 'Select task');
  assert.equal(dom.window.document.querySelector('.inv-checkbox__label'), null);
});

test('setChecked updates native and inventory checked state', () => {
  const dom = new JSDOM(`<div>${checkboxModule.checkbox({ label: 'Task' })}</div>`);
  const input = dom.window.document.querySelector('[data-inv-checkbox]');
  const label = input.closest('.inv-checkbox');

  checkboxModule.setChecked(input, true);
  assert.equal(input.checked, true);
  assert.equal(label.classList.contains('inv-checkbox--on'), true);
  checkboxModule.setChecked(input, false);
  assert.equal(input.checked, false);
  assert.equal(label.classList.contains('inv-checkbox--on'), false);
});
