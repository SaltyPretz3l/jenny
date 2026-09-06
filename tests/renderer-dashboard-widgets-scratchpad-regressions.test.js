const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createScratchpadWidget } = require('../renderer/features/renderer-dashboard-widgets-scratchpad.js');
const textField = require('../renderer/inventory/text-field.js');
const actionButton = require('../renderer/inventory/action-button.js');
const { twoNotesActive, flagOnCtx } = require('./helpers/scratchpad-fixtures.js');

test('a throwing legacy clipboard copy always removes its temporary textarea', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const documentRef = dom.window.document;
  const body = documentRef.getElementById('body');
  let menu = null;
  documentRef.execCommand = () => { throw new Error('copy blocked'); };
  const widget = createScratchpadWidget({
    textField,
    actionButton,
    actions: {},
    contextMenu: { show: (options) => { menu = options; } },
    menuModule: {
      buildScratchpadMenu: (options) => [{ label: 'Copy', action: () => options.copyText('copy me') }],
    },
  });
  widget.render(body, flagOnCtx(twoNotesActive('note-1')));
  assert.equal(body.querySelector('[data-scratchpad-actions]').title, 'Note actions');
  body.querySelector('[data-scratchpad-actions]')
    .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.ok(menu);
  assert.equal(documentRef.body.querySelectorAll('textarea').length, 1);

  assert.equal(menu.items[0].action(), false);

  assert.equal(documentRef.body.querySelectorAll('textarea').length, 1);
});

test('a replacement scratchpad owns the reused body listeners and can tear them down', () => {
  const dom = new JSDOM('<section id="body"></section>');
  const body = dom.window.document.getElementById('body');
  let oldCalls = 0;
  let newCalls = 0;
  const oldWidget = createScratchpadWidget({
    textField,
    actionButton,
    actions: { queueSave: () => { oldCalls += 1; } },
  });
  const replacement = createScratchpadWidget({
    textField,
    actionButton,
    actions: { queueSave: () => { newCalls += 1; } },
  });
  const ctx = flagOnCtx(twoNotesActive('note-1'));
  oldWidget.render(body, ctx);
  replacement.render(body, ctx);

  const input = body.querySelector('#homeScratchpadInput');
  input.value = 'new owner';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
  replacement.dispose();
  assert.equal(body.hasAttribute('data-scratchpad-bound'), false);
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(newCalls, 1);
});
