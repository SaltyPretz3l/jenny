const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const inlineTitleEditor = require('../renderer/inventory/inline-title-editor');

function buildRow() {
  const dom = new JSDOM('<!doctype html><html><body><article class="row"><div class="title">Original Title</div></article></body></html>');
  const { window } = dom;
  const titleEl = window.document.querySelector('.title');
  const rowEl = window.document.querySelector('.row');
  return { window, titleEl, rowEl };
}

function startEdit(titleEl, overrides = {}) {
  const calls = { commits: [], cancels: 0 };
  const editor = inlineTitleEditor.startInlineTitleEdit({
    titleEl,
    initialValue: 'Original Title',
    onCommit: (value) => calls.commits.push(value),
    onCancel: () => { calls.cancels += 1; },
    ...overrides,
  });
  return { editor, calls };
}

function pressKey(window, input, key) {
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

test('Enter commits the trimmed value and restores the title element', () => {
  const { window, titleEl, rowEl } = buildRow();
  const { editor, calls } = startEdit(titleEl);
  assert.ok(editor, 'editor starts');
  const input = rowEl.querySelector('.inv-inline-title-editor');
  assert.ok(input, 'input is inserted into the row');
  assert.equal(input.value, 'Original Title');
  assert.equal(titleEl.style.display, 'none', 'title hides while editing');

  input.value = '  Renamed Title  ';
  pressKey(window, input, 'Enter');

  assert.deepEqual(calls.commits, ['Renamed Title']);
  assert.equal(calls.cancels, 0);
  assert.equal(rowEl.querySelector('.inv-inline-title-editor'), null, 'input is removed');
  assert.notEqual(titleEl.style.display, 'none', 'title element is visible again');
});

test('Escape cancels without committing', () => {
  const { window, titleEl, rowEl } = buildRow();
  const { calls } = startEdit(titleEl);
  const input = rowEl.querySelector('.inv-inline-title-editor');
  input.value = 'Discarded Text';
  pressKey(window, input, 'Escape');

  assert.deepEqual(calls.commits, []);
  assert.equal(calls.cancels, 1);
  assert.equal(rowEl.querySelector('.inv-inline-title-editor'), null);
});

test('blur commits a changed value, and empty or unchanged values cancel', () => {
  const blurred = buildRow();
  const blurredEdit = startEdit(blurred.titleEl);
  const blurredInput = blurred.rowEl.querySelector('.inv-inline-title-editor');
  blurredInput.value = 'Blurred Commit';
  blurredInput.dispatchEvent(new blurred.window.Event('blur'));
  assert.deepEqual(blurredEdit.calls.commits, ['Blurred Commit']);

  const unchanged = buildRow();
  const unchangedEdit = startEdit(unchanged.titleEl);
  const unchangedInput = unchanged.rowEl.querySelector('.inv-inline-title-editor');
  pressKey(unchanged.window, unchangedInput, 'Enter');
  assert.deepEqual(unchangedEdit.calls.commits, []);
  assert.equal(unchangedEdit.calls.cancels, 1, 'unchanged value cancels');

  const emptied = buildRow();
  const emptiedEdit = startEdit(emptied.titleEl);
  const emptiedInput = emptied.rowEl.querySelector('.inv-inline-title-editor');
  emptiedInput.value = '   ';
  pressKey(emptied.window, emptiedInput, 'Enter');
  assert.deepEqual(emptiedEdit.calls.commits, []);
  assert.equal(emptiedEdit.calls.cancels, 1, 'whitespace-only value cancels');
});

test('editor keystrokes and clicks never reach row-level delegated handlers', () => {
  const { window, titleEl, rowEl } = buildRow();
  const rowEvents = [];
  rowEl.addEventListener('keydown', (event) => rowEvents.push(`key:${event.key}`));
  rowEl.addEventListener('click', () => rowEvents.push('click'));

  startEdit(titleEl);
  const input = rowEl.querySelector('.inv-inline-title-editor');
  pressKey(window, input, 'ArrowDown');
  pressKey(window, input, 'a');
  input.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  input.value = 'Quiet Edit';
  pressKey(window, input, 'Enter');

  assert.deepEqual(rowEvents, [], 'no editor event bubbled to the row');
});

test('a second editor cannot start while one is active, and settle fires only once', () => {
  const { window, titleEl, rowEl } = buildRow();
  const { calls } = startEdit(titleEl);
  const second = inlineTitleEditor.startInlineTitleEdit({ titleEl });
  assert.equal(second, null, 'second concurrent editor is refused');

  const input = rowEl.querySelector('.inv-inline-title-editor');
  input.value = 'Once Only';
  pressKey(window, input, 'Enter');
  // The Enter handler removes the input, which can fire a trailing blur in
  // real browsers — simulate it and assert the commit does not double-fire.
  input.dispatchEvent(new window.Event('blur'));
  assert.deepEqual(calls.commits, ['Once Only']);
  assert.equal(calls.cancels, 0);
});
