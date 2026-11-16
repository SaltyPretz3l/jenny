'use strict';

// The Ask Jenny chip of renderer/features/renderer-panel-code-actions.js never covers the selected
// text: it waits for a mouse selection to finish and sits below the selection (or above its first row).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const panelCode = require('../renderer/features/renderer-panel-code-actions');
const actionButton = require('../renderer/inventory/action-button');

const FILE_HTML = '<ol id="body" class="artifact-file-preview-code">'
  + '<li class="artifact-file-preview-row" data-preview-line="10"><span class="artifact-file-preview-gutter">10</span><code>alpha beta</code></li>'
  + '<li class="artifact-file-preview-row" data-preview-line="11"><span class="artifact-file-preview-gutter">11</span><code>gamma one</code></li>'
  + '</ol>';

function makeHarness() {
  const dom = new JSDOM('<!doctype html><body><div id="host">' + FILE_HTML + '</div></body>', { url: 'https://jenny.local/chat' });
  const doc = dom.window.document;
  const actions = panelCode.createPanelCodeActions({
    documentRef: doc,
    jt: (_key, fallback) => fallback,
    log: () => {},
    contextMenu: { show: () => {} },
    actionButton,
    writeClipboard: () => Promise.resolve(),
    insertIntoComposer: () => true,
    showToast: () => {},
  });
  return { doc, win: dom.window, body: doc.getElementById('body'), host: doc.getElementById('host'), actions };
}

function select(win, startNode, startOffset, endNode, endOffset) {
  const range = win.document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  win.getSelection().removeAllRanges();
  win.getSelection().addRange(range);
}

const textOf = (el) => el.firstChild;
const rowCode = (body, i) => body.querySelectorAll('code')[i];
const fireSelectionChange = (h) => h.doc.dispatchEvent(new h.win.Event('selectionchange'));

describe('Ask Jenny chip placement', () => {
  const adapter = { kind: 'file', getPath: () => 'src/app.js', getLanguageId: () => 'js' };

  test('a mouse selection shows no chip until the button is released', () => {
    const h = makeHarness();
    h.actions.attach(h.body, adapter);
    const chip = h.host.querySelector('.panel-code-ask');
    h.body.dispatchEvent(new h.win.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    assert.equal(chip.hidden, true, 'hidden while dragging');
    h.doc.dispatchEvent(new h.win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
    assert.equal(chip.hidden, false, 'shown on release');
  });

  test('sits below the selection, or above its first row when there is no room below', () => {
    const h = makeHarness();
    h.actions.attach(h.body, adapter);
    const chip = h.host.querySelector('.panel-code-ask');
    Object.defineProperty(chip, 'offsetHeight', { configurable: true, value: 20 });
    h.win.Range.prototype.getClientRects = () => [
      { top: 100, bottom: 116, left: 0, right: 200 },
      { top: 120, bottom: 136, left: 0, right: 180 },
    ];
    let hostBottom = 600;
    chip.parentElement.getBoundingClientRect = () => ({ top: 50, bottom: hostBottom, left: 0, width: 400 });
    select(h.win, textOf(rowCode(h.body, 0)), 0, rowCode(h.body, 1).lastChild, 3);
    fireSelectionChange(h);
    assert.equal(chip.style.top, '92px', 'below the last selected row (136 + 6 - 50)');

    hostBottom = 150;
    fireSelectionChange(h);
    assert.equal(chip.style.top, '24px', 'above the first selected row (100 - 20 - 6 - 50)');
  });
});

// Pin to board (row 150 slice C5): the selection menu offers the selected text to the chat's pin entry, only for a selection.
describe('Pin selection to board', () => {
  const adapter = { kind: 'file', getPath: () => 'src/app.js', getLanguageId: () => 'js' };

  function menuFor(h, { entry, selected }) {
    h.win.rendererChatMessageActionBindings = entry;
    const menus = [];
    const actions = require('../renderer/features/renderer-panel-code-actions').createPanelCodeActions({
      documentRef: h.doc, jt: (_key, fallback) => fallback, log: () => {}, contextMenu: { show: (opts) => menus.push(opts) }, actionButton,
      writeClipboard: () => Promise.resolve(), insertIntoComposer: () => true, showToast: () => {},
    });
    actions.attach(h.body, adapter);
    if (selected) select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    else h.win.getSelection().removeAllRanges();
    h.body.dispatchEvent(new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    return { menus, labels: () => menus[0].items.map((item) => item.label) };
  }

  test('a selection adds one item that pins its text as a note under its own heading', () => {
    const h = makeHarness();
    const asked = [];
    const menu = menuFor(h, { selected: true, entry: { pinMenuItem: (args) => { asked.push(args); return { label: args.label, action() {} }; } } });
    const labels = menu.labels();
    assert.ok(labels.indexOf('Pin selection to board') > labels.indexOf('Ask Jenny'), labels.join(' | '));
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].item, { kind: 'note', text: 'alpha' });
    assert.equal(asked[0].heading, 'Pin selection to board');
    assert.equal(asked[0].windowRef, h.win);
  });

  test('with no selection, a declining entry or no entry the menu is as it was', () => {
    const entry = { pinMenuItem: () => ({ label: 'Pin selection to board', action() {} }) };
    assert.equal(menuFor(makeHarness(), { selected: false, entry }).labels().includes('Pin selection to board'), false);
    assert.equal(menuFor(makeHarness(), { selected: true, entry: { pinMenuItem: () => null } }).labels().includes('Pin selection to board'), false);
    assert.equal(menuFor(makeHarness(), { selected: true, entry: undefined }).labels().includes('Pin selection to board'), false);
  });
});
