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
