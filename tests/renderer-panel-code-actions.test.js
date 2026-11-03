'use strict';

// Coverage for renderer/features/renderer-panel-code-actions.js - clean copy,
// Ctrl+A scoping, the "Ask Jenny" chip and the body menu shared by the chat
// side panel's file preview and Changes diffs. JSDOM only; the diff and file
// row markup is built here to the row contract in the plan.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const panelCode = require('../renderer/features/renderer-panel-code-actions');
const actionButton = require('../renderer/inventory/action-button');

const FILE_HTML = '<ol id="body" class="artifact-file-preview-code">'
  + '<li class="artifact-file-preview-row" data-preview-line="10"><span class="artifact-file-preview-gutter">10</span><code>alpha beta</code></li>'
  + '<li class="artifact-file-preview-row" data-preview-line="11"><span class="artifact-file-preview-gutter">11</span><code><span class="tok">gamma</span> one</code></li>'
  + '<li class="artifact-file-preview-row" data-preview-line="12"><span class="artifact-file-preview-gutter">12</span><code>delta epsilon</code></li>'
  + '</ol>';

function diffRow(cls, oldLine, newLine, marker, text) {
  const attrs = (oldLine ? ` data-old-line="${oldLine}"` : '') + (newLine ? ` data-new-line="${newLine}"` : '');
  const gutters = `<span class="diff-gutter">${oldLine || ''}</span><span class="diff-gutter">${newLine || ''}</span>`;
  return `<div class="diff-line ${cls}"${attrs}>${gutters}<span class="diff-marker">${marker}</span><span class="diff-content">${text}</span></div>`;
}

const DIFF_HTML = '<div id="body" class="diff-body">'
  + '<div class="diff-line diff-line-meta"><span class="diff-content">@@ -4,3 +4,3 @@</span></div>'
  + diffRow('diff-line-context', 4, 4, ' ', 'keep it')
  + diffRow('diff-line-remove', 5, 0, '−', 'old value')
  + diffRow('diff-line-add', 0, 5, '+', 'new value')
  + '</div>';

function makeHarness(kind, overrides) {
  const dom = new JSDOM('<!doctype html><body><div id="host">' + (kind === 'diff' ? DIFF_HTML : FILE_HTML)
    + '</div><p id="outside">outside text</p><textarea id="chatInput"></textarea></body>', { url: 'https://jenny.local/chat' });
  const doc = dom.window.document;
  const calls = { clipboard: [], composer: [], toasts: [], logs: [], menus: [] };
  const opts = Object.assign({
    insertResult: true,
    clipboard: (text) => { calls.clipboard.push(text); return Promise.resolve(); },
  }, overrides || {});
  const actions = panelCode.createPanelCodeActions({
    documentRef: doc,
    jt: (key, fallback, params) => (params ? String(fallback).replace(/\{(\w+)\}/g, (m, n) => (n in params ? params[n] : m)) : fallback),
    log: (...args) => calls.logs.push(args),
    contextMenu: { show: (menu) => calls.menus.push(menu) },
    actionButton,
    writeClipboard: opts.clipboard,
    insertIntoComposer: (payload) => { calls.composer.push(payload); return opts.insertResult; },
    showToast: (message) => calls.toasts.push(message),
  });
  return { dom, doc, win: dom.window, body: doc.getElementById('body'), host: doc.getElementById('host'), actions, calls };
}

function select(win, startNode, startOffset, endNode, endOffset) {
  const range = win.document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = win.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

const textOf = (el) => el.firstChild;
const rowCode = (body, i) => body.querySelectorAll('code')[i];
const fireSelectionChange = (h) => h.doc.dispatchEvent(new h.win.Event('selectionchange'));

function copyEvent(h) {
  const data = {};
  const event = new h.win.Event('copy', { bubbles: true, cancelable: true });
  event.clipboardData = { setData: (type, value) => { data[type] = value; } };
  return { event, data };
}

describe('readSelection (file rows)', () => {
  test('partial first and last rows give exact text; rows are whole', () => {
    const h = makeHarness('file');
    const selection = select(h.win, textOf(rowCode(h.body, 0)), 6, textOf(rowCode(h.body, 2)), 5);
    const result = panelCode.readSelection(selection, h.body, 'file');
    assert.equal(result.text, 'beta\ngamma one\ndelta');
    assert.equal(result.startLine, 10);
    assert.equal(result.endLine, 12);
    assert.deepEqual(result.rows, [
      { line: 10, marker: '', text: 'alpha beta' },
      { line: 11, marker: '', text: 'gamma one' },
      { line: 12, marker: '', text: 'delta epsilon' },
    ]);
  });

  test('a selection inside one row (across a highlight span) is a single row', () => {
    const h = makeHarness('file');
    const code = rowCode(h.body, 1);
    const selection = select(h.win, code.firstChild.firstChild, 2, code.lastChild, 3);
    const result = panelCode.readSelection(selection, h.body, 'file');
    assert.equal(result.text, 'mma on');
    assert.equal(result.startLine, 11);
    assert.equal(result.endLine, 11);
    assert.equal(result.rows.length, 1);
  });

  test('gutter numbers never reach the text; a range starting in the gutter keeps the row', () => {
    const h = makeHarness('file');
    const gutter = h.body.querySelector('.artifact-file-preview-gutter');
    const selection = select(h.win, textOf(gutter), 0, textOf(rowCode(h.body, 1)), 0);
    const result = panelCode.readSelection(selection, h.body, 'file');
    assert.equal(result.text, 'alpha beta');
    assert.deepEqual(result.rows.map((r) => r.line), [10]);
  });

  test('returns null for no selection, a collapsed one, or one outside the body', () => {
    const h = makeHarness('file');
    const selection = h.win.getSelection();
    selection.removeAllRanges();
    assert.equal(panelCode.readSelection(selection, h.body, 'file'), null);
    select(h.win, textOf(rowCode(h.body, 0)), 2, textOf(rowCode(h.body, 0)), 2);
    assert.equal(panelCode.readSelection(selection, h.body, 'file'), null);
    const outside = h.doc.getElementById('outside');
    select(h.win, textOf(outside), 0, textOf(outside), 4);
    assert.equal(panelCode.readSelection(selection, h.body, 'file'), null);
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(outside), 4);
    assert.equal(panelCode.readSelection(selection, h.body, 'file'), null);
  });
});

describe('readSelection (diff rows)', () => {
  test('line is the new line, or the old line for a removal; marker comes from the row class', () => {
    const h = makeHarness('diff');
    const contents = h.body.querySelectorAll('.diff-content');
    const selection = select(h.win, textOf(contents[1]), 0, textOf(contents[3]), 9);
    const result = panelCode.readSelection(selection, h.body, 'diff');
    assert.deepEqual(result.rows, [
      { line: 4, marker: ' ', text: 'keep it' },
      { line: 5, marker: '-', text: 'old value' },
      { line: 5, marker: '+', text: 'new value' },
    ]);
    assert.equal(result.text, 'keep it\nold value\nnew value');
    assert.equal(result.startLine, 4);
    assert.equal(result.endLine, 5);
  });

  test('the meta row is skipped and markers never enter the clean text', () => {
    const h = makeHarness('diff');
    const contents = h.body.querySelectorAll('.diff-content');
    const selection = select(h.win, textOf(contents[0]), 0, textOf(contents[2]), 3);
    const result = panelCode.readSelection(selection, h.body, 'diff');
    assert.equal(result.rows.length, 2);
    assert.equal(result.text, 'keep it\nold');
    assert.ok(!result.text.includes('−'));
    assert.ok(!result.text.includes('@@'));
  });

  test('a range that only names removals counts the old side', () => {
    const h = makeHarness('diff');
    const removed = h.body.querySelectorAll('.diff-content')[2];
    const selection = select(h.win, textOf(removed), 0, textOf(removed), 3);
    const result = panelCode.readSelection(selection, h.body, 'diff');
    assert.equal(result.startLine, 5);
    assert.equal(result.endLine, 5);
    assert.equal(result.rows[0].marker, '-');
  });

  test('a selection across two files of a page keeps the file it starts in', () => {
    const h = makeHarness('diff');
    const second = h.doc.createElement('div');
    second.className = 'file-diff';
    second.innerHTML = '<div class="diff-line diff-line-context" data-old-line="250" data-new-line="250"><span class="diff-content">far away</span></div>';
    const first = h.doc.createElement('div');
    first.className = 'file-diff';
    first.append(...h.body.childNodes);
    h.body.append(first, second);
    const contents = h.body.querySelectorAll('.diff-content');
    const selection = select(h.win, textOf(contents[1]), 0, textOf(contents[4]), 3);
    const result = panelCode.readSelection(selection, h.body, 'diff');
    assert.deepEqual(result.rows.map((row) => row.line), [4, 5, 5]);
    assert.equal(result.endLine, 5);
    assert.ok(!result.text.includes('far'));
  });
});

describe('readSelection (blank rows)', () => {
  test('a triple-click range ending at the start of a blank row leaves that row out; a blank row inside stays', () => {
    const dom = new JSDOM('<!doctype html><body><ol id="body">'
      + '<li data-preview-line="1"><code>one</code></li>'
      + '<li data-preview-line="2"><code></code></li>'
      + '<li data-preview-line="3"><code>three</code></li>'
      + '<li data-preview-line="4"><code></code></li>'
      + '</ol></body>');
    const body = dom.window.document.getElementById('body');
    const codes = body.querySelectorAll('code');
    const lines = (endNode, endOffset) => {
      const selection = select(dom.window, codes[0].firstChild, 0, endNode, endOffset);
      return panelCode.readSelection(selection, body, 'file').rows.map((row) => row.line);
    };
    assert.deepEqual(lines(codes[1], 0), [1]);
    assert.deepEqual(lines(codes[3], 0), [1, 2, 3]);
  });
});

describe('formatAskReference', () => {
  test('single line, with the file language fence', () => {
    const text = panelCode.formatAskReference({
      path: 'src/app.js', startLine: 12, endLine: 12, kind: 'file', languageId: 'js',
      rows: [{ line: 12, marker: '', text: 'const a = 1;' }],
    });
    assert.equal(text, '`src/app.js:12`\n```js\nconst a = 1;\n```\n');
  });

  test('a range lists whole rows; unknown language gives a bare fence', () => {
    const text = panelCode.formatAskReference({
      path: 'notes.txt', startLine: 3, endLine: 4, kind: 'file',
      rows: [{ line: 3, marker: '', text: 'one' }, { line: 4, marker: '', text: 'two' }],
    });
    assert.equal(text, '`notes.txt:3-4`\n```\none\ntwo\n```\n');
  });

  test('a fence longer than any backtick run in the body', () => {
    const text = panelCode.formatAskReference({
      path: 'a.md', startLine: 1, endLine: 1, kind: 'file', languageId: 'markdown',
      rows: [{ line: 1, marker: '', text: '```js' }],
    });
    assert.equal(text, '`a.md:1`\n````markdown\n```js\n````\n');
  });

  test('diff uses a diff fence with each row prefixed by its marker', () => {
    const text = panelCode.formatAskReference({
      path: 'src/app.js', startLine: 4, endLine: 5, kind: 'diff', languageId: 'js',
      rows: [{ line: 4, marker: ' ', text: 'keep' }, { line: 5, marker: '-', text: 'old' }, { line: 5, marker: '+', text: 'new' }],
    });
    assert.equal(text, '`src/app.js:4-5`\n```diff\n keep\n-old\n+new\n```\n');
  });

  test('derives the range from the rows when none is given: new side, old side for all removals', () => {
    const mixed = panelCode.formatAskReference({
      path: 'f.js', kind: 'diff',
      rows: [{ line: 7, marker: '-', text: 'a' }, { line: 9, marker: '+', text: 'b' }],
    });
    assert.ok(mixed.startsWith('`f.js:9`\n'));
    const removed = panelCode.formatAskReference({
      path: 'f.js', kind: 'diff',
      rows: [{ line: 7, marker: '-', text: 'a' }, { line: 8, marker: '-', text: 'b' }],
    });
    assert.ok(removed.startsWith('`f.js:7-8`\n'));
  });

  test('a file-level ask is the backticked path and a trailing space', () => {
    assert.equal(panelCode.formatAskReference({ path: 'src/app.js', kind: 'file', rows: [] }), '`src/app.js` ');
    assert.equal(panelCode.formatAskReference({ path: 'src/app.js', kind: 'file' }), '`src/app.js` ');
  });
});

describe('formatCopyText', () => {
  const rows = [{ line: 9, marker: '', text: 'one' }, { line: 10, marker: '', text: 'two' }];

  test('plain rows are joined with newlines', () => {
    assert.equal(panelCode.formatCopyText(rows, { withLineNumbers: false }), 'one\ntwo');
    assert.equal(panelCode.formatCopyText(rows), 'one\ntwo');
  });

  test('line numbers prefix each row', () => {
    assert.equal(panelCode.formatCopyText(rows, { withLineNumbers: true }), '9  one\n10  two');
  });
});

describe('attach: copy, select all, tabindex', () => {
  test('copy writes the clean selected text and prevents the default', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    select(h.win, textOf(rowCode(h.body, 0)), 6, rowCode(h.body, 1).lastChild, 3);
    const { event, data } = copyEvent(h);
    rowCode(h.body, 0).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(data['text/plain'], 'beta\ngamma on');
  });

  test('copy is left alone when the selection is outside the body', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    const outside = h.doc.getElementById('outside');
    select(h.win, textOf(outside), 0, textOf(outside), 4);
    const { event, data } = copyEvent(h);
    h.body.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.deepEqual(data, {});
  });

  test('Ctrl+A selects only the code text of the body and is prevented', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    const event = new h.win.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true });
    rowCode(h.body, 1).dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    const selection = h.win.getSelection();
    const range = selection.getRangeAt(0);
    assert.ok(h.body.contains(range.commonAncestorContainer));
    assert.equal(range.startContainer.tagName, 'CODE');
    assert.equal(range.endContainer.tagName, 'CODE');
    assert.equal(panelCode.readSelection(selection, h.body, 'file').text, 'alpha beta\ngamma one\ndelta epsilon');
  });

  test('Cmd+A works, Ctrl+Shift+A and plain A do not', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'p' });
    const send = (init) => {
      const event = new h.win.KeyboardEvent('keydown', Object.assign({ bubbles: true, cancelable: true }, init));
      h.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    assert.equal(send({ key: 'a', metaKey: true }), true);
    assert.equal(send({ key: 'a', ctrlKey: true, shiftKey: true }), false);
    assert.equal(send({ key: 'a' }), false);
  });

  test('Ctrl+A in a diff body selects the diff contents', () => {
    const h = makeHarness('diff');
    h.actions.attach(h.body, { kind: 'diff', getPath: () => 'p' });
    h.body.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'A', ctrlKey: true, bubbles: true, cancelable: true }));
    const result = panelCode.readSelection(h.win.getSelection(), h.body, 'diff');
    assert.equal(result.text, 'keep it\nold value\nnew value');
  });

  test('tabindex is added when missing and restored on detach; an existing one is kept', () => {
    const h = makeHarness('file');
    const detach = h.actions.attach(h.body, { kind: 'file', getPath: () => 'p' });
    assert.equal(h.body.getAttribute('tabindex'), '0');
    detach();
    assert.equal(h.body.hasAttribute('tabindex'), false);

    h.body.setAttribute('tabindex', '-1');
    const again = h.actions.attach(h.body, { kind: 'file', getPath: () => 'p' });
    assert.equal(h.body.getAttribute('tabindex'), '-1');
    again();
    assert.equal(h.body.getAttribute('tabindex'), '-1');
  });
});

describe('Ask Jenny chip', () => {
  const adapter = { kind: 'file', getPath: () => 'src/app.js', getLanguageId: () => 'js' };

  test('is hidden until a selection lands in the body, then hides again when collapsed', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, adapter);
    const chip = h.host.querySelector('.panel-code-ask');
    assert.ok(chip);
    assert.equal(chip.hidden, true);
    assert.ok(chip.querySelector('button.panel-code-ask-button'));

    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    assert.equal(chip.hidden, false);

    h.win.getSelection().removeAllRanges();
    fireSelectionChange(h);
    assert.equal(chip.hidden, true);
  });

  test('stays hidden for a selection outside the body', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, adapter);
    const outside = h.doc.getElementById('outside');
    select(h.win, textOf(outside), 0, textOf(outside), 4);
    fireSelectionChange(h);
    assert.equal(h.host.querySelector('.panel-code-ask').hidden, true);
  });

  test('follows scrolls of the body or its ancestors only, and none while hidden', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, adapter);
    let measured = 0;
    h.win.Range.prototype.getClientRects = function getClientRects() { measured += 1; return []; };
    const scroll = (target) => target.dispatchEvent(new h.win.Event('scroll'));
    scroll(h.host);
    assert.equal(measured, 0, 'hidden chip');

    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    measured = 0;
    scroll(h.doc.getElementById('outside'));
    assert.equal(measured, 0, 'a scroll elsewhere in the app');
    scroll(h.host);
    assert.ok(measured > 0, 'an ancestor of the body');
  });

  test('mousedown on the chip does not clear the selection', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, adapter);
    const button = h.host.querySelector('.panel-code-ask-button');
    const event = new h.win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    button.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  });

  test('clicking inserts the whole-row reference, then clears the selection and hides', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, adapter);
    select(h.win, textOf(rowCode(h.body, 0)), 6, rowCode(h.body, 1).lastChild, 3);
    fireSelectionChange(h);
    h.host.querySelector('.panel-code-ask-button').click();
    assert.deepEqual(h.calls.composer, [{ text: '`src/app.js:10-11`\n```js\nalpha beta\ngamma one\n```\n' }]);
    assert.deepEqual(h.calls.toasts, []);
    assert.equal(h.host.querySelector('.panel-code-ask').hidden, true);
    assert.equal(h.win.getSelection().isCollapsed, true);
  });

  test('the body selection is cleared before the composer insert, so the composer keeps its caret', () => {
    const h = makeHarness('file');
    const seen = [];
    const actions = panelCode.createPanelCodeActions({
      documentRef: h.doc,
      actionButton,
      writeClipboard: () => Promise.resolve(),
      insertIntoComposer: () => { seen.push(h.win.getSelection().rangeCount); return true; },
    });
    actions.attach(h.body, adapter);
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    h.host.querySelectorAll('.panel-code-ask-button')[0].click();
    assert.deepEqual(seen, [0]);
  });

  test('toasts when there is no composer to insert into', () => {
    const h = makeHarness('file', { insertResult: false });
    h.actions.attach(h.body, adapter);
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    h.host.querySelector('.panel-code-ask-button').click();
    assert.deepEqual(h.calls.toasts, ['Open a chat to ask Jenny']);
  });

  test('a diff selection inserts a diff fence', () => {
    const h = makeHarness('diff');
    h.actions.attach(h.body, { kind: 'diff', getPath: () => 'src/app.js', getLanguageId: () => 'js' });
    const contents = h.body.querySelectorAll('.diff-content');
    select(h.win, textOf(contents[2]), 0, textOf(contents[3]), 3);
    fireSelectionChange(h);
    h.host.querySelector('.panel-code-ask-button').click();
    assert.equal(h.calls.composer[0].text, '`src/app.js:5`\n```diff\n-old value\n+new value\n```\n');
  });

  test('detach removes the chip and stops reacting to selection changes', () => {
    const h = makeHarness('file');
    const detach = h.actions.attach(h.body, adapter);
    detach();
    assert.equal(h.host.querySelector('.panel-code-ask'), null);
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    fireSelectionChange(h);
    assert.equal(h.host.querySelector('.panel-code-ask'), null);
  });
});

describe('body context menu', () => {
  function openMenu(h, target) {
    const event = new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 42, clientY: 77 });
    target.dispatchEvent(event);
    return event;
  }

  const labels = (menu) => menu.items.map((item) => item.label);

  test('file menu without a selection: order, line from the pointer row, Copy disabled', () => {
    const h = makeHarness('file');
    const opened = [];
    h.actions.attach(h.body, {
      kind: 'file',
      getPath: () => 'src/app.js',
      openInIde: (line) => opened.push(['ide', line]),
      openFileAtLine: (line) => opened.push(['view', line]),
      extraMenuItems: () => [{ label: 'Extra thing', action: () => {} }],
    });
    h.win.getSelection().removeAllRanges();
    const event = openMenu(h, rowCode(h.body, 1));
    assert.equal(event.defaultPrevented, true);
    const menu = h.calls.menus[0];
    assert.equal(menu.anchorX, 42);
    assert.equal(menu.anchorY, 77);
    assert.deepEqual(labels(menu), [
      'Copy', 'Copy with line numbers', 'Copy path', 'Ask Jenny about this file',
      'Open in IDE at line 11', 'View file at line 11', 'Extra thing',
    ]);
    assert.equal(menu.items[0].disabled, true);
    assert.equal(menu.items[1].disabled, true);
    menu.items[4].action();
    menu.items[5].action();
    assert.deepEqual(opened, [['ide', 11], ['view', 11]]);
  });

  test('adapter hooks get the anchoring row, so one attachment can serve several files', async () => {
    const h = makeHarness('diff');
    const anchors = [];
    const rowOf = (el) => el && el.closest('.diff-line');
    h.actions.attach(h.body, {
      kind: 'diff',
      getPath: (rowEl) => { anchors.push(['path', rowEl]); return 'src/app.js'; },
      copyDiff: (rowEl) => { anchors.push(['diff', rowEl]); return ''; },
      openInIde: (line, rowEl) => anchors.push(['ide', rowEl]),
    });
    h.win.getSelection().removeAllRanges();
    const target = h.body.querySelectorAll('.diff-content')[2];
    openMenu(h, target);
    const menu = h.calls.menus[0];
    await menu.items.find((item) => item.label === 'Copy diff').action();
    menu.items.find((item) => /^Open in IDE/.test(item.label)).action();
    assert.ok(anchors.length >= 3);
    for (const [, rowEl] of anchors) assert.equal(rowEl, rowOf(target));
  });

  test('hooks the adapter lacks are skipped', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    openMenu(h, rowCode(h.body, 0));
    assert.deepEqual(labels(h.calls.menus[0]), ['Copy', 'Copy with line numbers', 'Copy path', 'Ask Jenny about this file']);
  });

  test('diff menu with a selection: Copy diff is placed after Copy path, copy actions write clean text', async () => {
    const h = makeHarness('diff');
    h.actions.attach(h.body, {
      kind: 'diff',
      getPath: () => 'src/app.js',
      getLanguageId: () => 'js',
      copyDiff: () => '--- a\n+++ b\n',
      openInIde: () => {},
    });
    const contents = h.body.querySelectorAll('.diff-content');
    select(h.win, textOf(contents[1]), 0, textOf(contents[2]), 3);
    openMenu(h, contents[1]);
    const menu = h.calls.menus[0];
    assert.deepEqual(labels(menu), ['Copy', 'Copy with line numbers', 'Copy path', 'Copy diff', 'Ask Jenny', 'Open in IDE at line 4']);
    assert.equal(menu.items[0].disabled, false);
    await menu.items[0].action();
    await menu.items[1].action();
    await menu.items[2].action();
    await menu.items[3].action();
    assert.deepEqual(h.calls.clipboard, ['keep it\nold', '4  keep it\n5  old value', 'src/app.js', '--- a\n+++ b\n']);
    menu.items[4].action();
    assert.equal(h.calls.composer[0].text, '`src/app.js:4`\n```diff\n keep it\n-old value\n```\n');
  });

  test('Ask Jenny with no selection inserts the file-level reference', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    h.win.getSelection().removeAllRanges();
    openMenu(h, rowCode(h.body, 0));
    h.calls.menus[0].items[3].action();
    assert.deepEqual(h.calls.composer, [{ text: '`src/app.js` ' }]);
  });

  test('extraMenuItems receives the selection and line context', () => {
    const h = makeHarness('file');
    let seen = null;
    h.actions.attach(h.body, {
      kind: 'file', getPath: () => 'src/app.js',
      extraMenuItems: (ctx) => { seen = ctx; return []; },
    });
    select(h.win, textOf(rowCode(h.body, 2)), 0, textOf(rowCode(h.body, 2)), 5);
    openMenu(h, rowCode(h.body, 2));
    assert.equal(seen.line, 12);
    assert.equal(seen.path, 'src/app.js');
    assert.equal(seen.selection.text, 'delta');
  });

  test('Shift+F10 and the ContextMenu key open the menu from the keyboard', () => {
    const h = makeHarness('file');
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    select(h.win, textOf(rowCode(h.body, 0)), 0, textOf(rowCode(h.body, 0)), 5);
    const shiftF10 = new h.win.KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true });
    h.body.dispatchEvent(shiftF10);
    assert.equal(shiftF10.defaultPrevented, true);
    h.body.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    assert.equal(h.calls.menus.length, 2);
    assert.equal(h.calls.menus[0].items[0].disabled, false);
  });

  test('a clipboard failure is logged and toasted', async () => {
    const h = makeHarness('file', { clipboard: () => Promise.reject(new Error('denied')) });
    h.actions.attach(h.body, { kind: 'file', getPath: () => 'src/app.js' });
    openMenu(h, rowCode(h.body, 0));
    await h.calls.menus[0].items[2].action();
    assert.deepEqual(h.calls.toasts, ['Couldn’t copy']);
    assert.equal(h.calls.logs.length, 1);
  });

  test('detach removes the menu and key handlers; dispose detaches everything', () => {
    const h = makeHarness('file');
    const detach = h.actions.attach(h.body, { kind: 'file', getPath: () => 'p' });
    detach();
    openMenu(h, rowCode(h.body, 0));
    h.body.dispatchEvent(new h.win.KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
    assert.equal(h.calls.menus.length, 0);

    h.actions.attach(h.body, { kind: 'file', getPath: () => 'p' });
    h.actions.dispose();
    assert.equal(h.host.querySelector('.panel-code-ask'), null);
    assert.equal(h.body.hasAttribute('tabindex'), false);
    openMenu(h, rowCode(h.body, 0));
    assert.equal(h.calls.menus.length, 0);
  });
});
