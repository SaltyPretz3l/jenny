'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const viewActions = require('../renderer/features/renderer-changes-view-actions');
const panelCodeActions = require('../renderer/features/renderer-panel-code-actions');
const panelCodeFind = require('../renderer/features/renderer-panel-code-find');
const { createChangesView } = require('../renderer/features/renderer-changes-view');
const fileDiffView = require('../renderer/chat/renderer-file-diff-view');
const { renderDiffHunks } = require('../renderer/chat/renderer-diff-hunks-render');
const actionButton = require('../renderer/inventory/action-button');
const { escapeHtml } = require('../renderer/shared/string-utils');

const HUNKS_A = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;'] }];
const HUNKS_B = [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old()', '+next()'] }];
const PATCH_A = [
  '--- a/src/a.js', '+++ b/src/a.js', '@@ -1,2 +1,3 @@',
  ' const a = 1;', '-const b = 2;', '+const b = 3;', '+const c = 4;', '',
].join('\n');

function change(path, extra = {}) {
  return {
    changeId: `c-${path}`, turnId: 't1', toolCallId: 'call_1', toolName: 'edit_file', path, fileKey: `ws:${path}`,
    status: 'modified', callOutcome: 'succeeded', scripted: false, sensitive: false, afterHash: 'sha256:aa',
    hashKind: 'diff_input_text', hunks: HUNKS_A, ...extra,
  };
}

function workingTreeFile(path, hunks) {
  return fileDiffView.buildFileDiffMarkup({
    path, diffId: `wt:${path}`, expandable: true, expanded: true, stacked: true, hunks, languageId: 'javascript', escapeHtml, actionButton,
  });
}

// A page with a Working tree half (two expanded files and a filter field) and a ledger half
// holding the real panel Changes view; the shared modules are the real ones.
function buildPage(options = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { url: 'http://localhost/' });
  const { document } = dom.window;
  const win = dom.window;
  const scrolled = [];
  win.Element.prototype.scrollIntoView = function scrollIntoView(arg) { scrolled.push({ el: this, arg }); };
  const pageEl = document.createElement('div');
  pageEl.className = 'changes-detail-page';
  pageEl.dataset.changesScope = options.scope || 'working_tree';
  const workingTreeEl = document.createElement('div');
  workingTreeEl.className = 'changes-wt';
  // Like the real page, the half that is not showing holds no rows.
  workingTreeEl.innerHTML = options.scope === 'this_chat' ? '' : '<input id="filter" type="text"><div class="file-diff-list">'
    + workingTreeFile('src/a.js', HUNKS_A) + workingTreeFile('src/b.js', HUNKS_B) + '</div>';
  const hostEl = document.createElement('div');
  hostEl.className = 'changes-view-host';
  pageEl.append(workingTreeEl, hostEl);
  document.getElementById('host').appendChild(pageEl);

  const ledger = { changes: [change('a.js'), change('b.js', { hunks: HUNKS_B }), change('c.js', { turnId: 't2' })], notices: [] };
  const view = createChangesView({
    host: 'panel',
    getSessionId: () => 's1',
    getTurnViewModels: () => [{ turnId: 't1', user: { content: 'First' }, toolCalls: [] }, { turnId: 't2', user: { content: 'Second' }, toolCalls: [] }],
    buildLedger: () => ledger,
    renderDiffBody: (item) => renderDiffHunks(item.hunks, escapeHtml, { path: item.path }),
    openInWorkspace: () => {},
  });
  if (options.scope === 'this_chat') view.mount(hostEl);

  const menus = [];
  const clipboard = [];
  const composer = [];
  const toasts = [];
  const opened = { workingTree: [], ledger: [] };
  const created = { actions: 0 };
  const hunksByPath = { 'src/a.js': HUNKS_A, 'src/b.js': HUNKS_B };
  const pageActions = viewActions.createChangesPageActions({
    getLedgerDetail: () => view.getDetail(),
    getWorkingTreeHunks: (path) => hunksByPath[path] || null,
    openWorkingTreeFile: (path) => opened.workingTree.push(path),
    openLedgerChange: (changeId) => opened.ledger.push(changeId),
    panelCodeActions: { createPanelCodeActions: (deps) => { created.actions += 1; return panelCodeActions.createPanelCodeActions(deps); } },
    panelCodeFind,
    contextMenu: { show: (menu) => menus.push(menu) },
    writeClipboard: (text) => clipboard.push(text),
    insertIntoComposer: (payload) => { composer.push(payload.text); return options.composerOpen !== false; },
    showToast: (message) => toasts.push(message),
  });
  pageActions.attach(pageEl);
  return { dom, win, document, pageEl, workingTreeEl, hostEl, view, pageActions, menus, clipboard, composer, toasts, opened, created, scrolled };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function rightClick(h, el) {
  const event = new h.win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 4, clientY: 5 });
  el.dispatchEvent(event);
  return event;
}

function press(h, el, key, init = {}) {
  const event = new h.win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(event);
  return event;
}

const lastMenu = (h) => h.menus[h.menus.length - 1];
const item = (h, label) => lastMenu(h).items.find((entry) => entry.label === label || String(entry.label).startsWith(label));
const wtRow = (h, path, newLine) => h.workingTreeEl.querySelector(`.file-diff[data-diff-id="wt:${path}"] .diff-line[data-new-line="${newLine}"]`);

function openLedgerDetail(h, index) {
  h.hostEl.querySelectorAll('[data-changes-item]')[index].dispatchEvent(new h.win.MouseEvent('click', { bubbles: true }));
}

test('buildUnifiedPatch writes the file headers, hunk headers and the lines as they are', () => {
  assert.equal(viewActions.buildUnifiedPatch('src/a.js', HUNKS_A), PATCH_A);
  assert.equal(viewActions.buildUnifiedPatch('src/a.js', []), '');
  assert.equal(viewActions.buildUnifiedPatch('src/a.js', null), '');
});

test('nextItemKey clamps arrows and jumps with Home and End', () => {
  const keys = ['a', 'b', 'c'];
  assert.equal(viewActions.nextItemKey(keys, 1, 'ArrowDown'), 'c');
  assert.equal(viewActions.nextItemKey(keys, 2, 'ArrowDown'), 'c');
  assert.equal(viewActions.nextItemKey(keys, 0, 'ArrowUp'), 'a');
  assert.equal(viewActions.nextItemKey(keys, 1, 'Home'), 'a');
  assert.equal(viewActions.nextItemKey(keys, 1, 'End'), 'c');
  assert.equal(viewActions.nextItemKey(keys, 1, 'x'), '');
});

test('page actions attach once per page element and dispose with it', () => {
  const h = buildPage();
  h.pageActions.attach(h.pageEl);
  assert.equal(h.created.actions, 1, 'a second attach to the same element is a no-op');
  rightClick(h, wtRow(h, 'src/a.js', 2));
  assert.equal(h.menus.length, 1, 'one menu, not one per attach');

  const otherPage = h.pageEl.cloneNode(true);
  h.document.body.appendChild(otherPage);
  h.pageActions.attach(otherPage);
  rightClick(h, wtRow(h, 'src/a.js', 2));
  assert.equal(h.menus.length, 1, 'the replaced element is detached');
  rightClick(h, otherPage.querySelector('.diff-line[data-new-line="2"]'));
  assert.equal(h.menus.length, 2);
  h.pageActions.dispose();
  rightClick(h, otherPage.querySelector('.diff-line[data-new-line="2"]'));
  assert.equal(h.menus.length, 2, 'dispose removes every listener');
});

test('a Working tree row resolves its own file for path, diff and opening', async () => {
  const h = buildPage();
  const row = wtRow(h, 'src/b.js', 10);
  assert.equal(rightClick(h, row).defaultPrevented, true);
  assert.equal(item(h, 'Open in IDE at line').label, 'Open in IDE at line 10');
  item(h, 'Copy path').action();
  item(h, 'Copy diff').action();
  item(h, 'Open in IDE').action();
  await settle();
  assert.deepEqual(h.clipboard, ['src/b.js', viewActions.buildUnifiedPatch('src/b.js', HUNKS_B)]);
  assert.deepEqual(h.opened.workingTree, ['src/b.js']);
  item(h, 'Ask Jenny').action();
  assert.deepEqual(h.composer, ['`src/b.js` '], 'without a selection the whole file is asked about');
});

test('Ask Jenny on a selected Working tree row sends that row as a diff', () => {
  const h = buildPage();
  const row = wtRow(h, 'src/a.js', 1);
  const range = h.document.createRange();
  range.selectNodeContents(row.querySelector('.diff-content'));
  h.win.getSelection().removeAllRanges();
  h.win.getSelection().addRange(range);
  rightClick(h, row);
  item(h, 'Ask Jenny').action();
  assert.match(h.composer[0], /^`src\/a\.js:1`\n```diff\n const a = 1;\n```\n$/);
});

test('View file at line dispatches the cancelable open-file event with the path and line', () => {
  const h = buildPage();
  const seen = [];
  h.win.addEventListener('ide:open-file-at-line', (event) => { seen.push(event); event.preventDefault(); });
  rightClick(h, wtRow(h, 'src/a.js', 2));
  item(h, 'View file at line').action();
  assert.equal(seen.length, 1);
  assert.deepEqual({ ...seen[0].detail }, { path: 'src/a.js', line: 2 });
  assert.equal(seen[0].bubbles, true);
  assert.equal(seen[0].cancelable, true);
});

test('a ledger row resolves the detail page change for path, diff and opening', async () => {
  const h = buildPage({ scope: 'this_chat' });
  openLedgerDetail(h, 1);
  const detail = h.view.getDetail();
  assert.equal(h.view.getMode(), 'detail');
  const row = h.hostEl.querySelector('.changes-detail-diff .diff-line[data-new-line="2"], .changes-detail-diff .diff-line[data-new-line="10"]');
  rightClick(h, row);
  item(h, 'Copy path').action();
  item(h, 'Copy diff').action();
  item(h, 'Open in IDE').action();
  await settle();
  assert.deepEqual(h.clipboard, [detail.path, viewActions.buildUnifiedPatch(detail.path, detail.change.hunks)]);
  assert.deepEqual(h.opened.ledger, [detail.changeId]);
});

test('with no row under the pointer the focused Working tree file, else the first, is used', async () => {
  const h = buildPage();
  h.workingTreeEl.querySelectorAll('[data-file-diff-toggle]')[1].focus();
  const event = press(h, h.workingTreeEl.querySelectorAll('[data-file-diff-toggle]')[1], 'ContextMenu');
  assert.equal(event.defaultPrevented, true);
  item(h, 'Copy path').action();
  h.document.activeElement.blur();
  press(h, h.workingTreeEl.querySelector('.file-diff-list'), 'F10', { shiftKey: true });
  item(h, 'Copy path').action();
  await settle();
  assert.deepEqual(h.clipboard, ['src/b.js', 'src/a.js']);
});

test('[ and ] move focus between Working tree files, stop at the ends and scroll into view', () => {
  const h = buildPage();
  const toggles = Array.from(h.workingTreeEl.querySelectorAll('[data-file-diff-toggle]'));
  toggles[0].focus();
  const event = press(h, toggles[0], ']');
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.document.activeElement, toggles[1]);
  assert.deepEqual(h.scrolled.pop().arg, { block: 'nearest' });
  press(h, toggles[1], ']');
  assert.equal(h.document.activeElement, toggles[1], 'no wrap past the last file');
  press(h, toggles[1], '[');
  assert.equal(h.document.activeElement, toggles[0]);
  // From inside a diff the file's own header is the starting point.
  wtRow(h, 'src/b.js', 10).querySelector('.diff-content').setAttribute('tabindex', '0');
  wtRow(h, 'src/b.js', 10).querySelector('.diff-content').focus();
  press(h, h.document.activeElement, '[');
  assert.equal(h.document.activeElement, toggles[0]);
});

test('[ and ] ignore modifiers and text fields', () => {
  const h = buildPage();
  const toggles = Array.from(h.workingTreeEl.querySelectorAll('[data-file-diff-toggle]'));
  toggles[0].focus();
  assert.equal(press(h, toggles[0], ']', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(press(h, toggles[0], ']', { altKey: true }).defaultPrevented, false);
  const input = h.document.getElementById('filter');
  input.focus();
  assert.equal(press(h, input, ']').defaultPrevented, false);
  assert.equal(h.document.activeElement, input);
});

test('[ and ] move between the ledger history files', () => {
  const h = buildPage({ scope: 'this_chat' });
  const files = Array.from(h.hostEl.querySelectorAll('.changes-history-file'));
  files[0].focus();
  press(h, files[0], ']');
  assert.equal(h.document.activeElement, files[1]);
});

test('[ and ] step the ledger detail page to the adjacent change', () => {
  const h = buildPage({ scope: 'this_chat' });
  openLedgerDetail(h, 0);
  const position = () => h.hostEl.querySelector('.changes-detail-position').textContent;
  assert.match(position(), /Change 1 of 3/);
  press(h, h.hostEl.querySelector('[data-changes-back]'), ']');
  assert.match(position(), /Change 2 of 3/);
  press(h, h.hostEl.querySelector('[data-changes-back]'), '[');
  assert.match(position(), /Change 1 of 3/);
  press(h, h.hostEl.querySelector('[data-changes-back]'), '[');
  assert.match(position(), /Change 1 of 3/, 'the Previous button is disabled on the first change');
});

test('a text field keeps its own Ctrl+A and Ctrl+F, and the menu keys', () => {
  const h = buildPage();
  const input = h.document.getElementById('filter');
  input.focus();
  assert.equal(press(h, input, 'a', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(press(h, input, 'f', { ctrlKey: true }).defaultPrevented, false);
  assert.equal(h.pageEl.querySelector('.panel-code-find') || h.document.querySelector('.panel-code-find'), null);
  assert.equal(press(h, input, 'F10', { shiftKey: true }).defaultPrevented, false);
  assert.equal(h.menus.length, 0);
  // Ctrl+A on a file header still selects the page's code.
  const toggle = h.workingTreeEl.querySelector('[data-file-diff-toggle]');
  assert.equal(press(h, toggle, 'a', { ctrlKey: true }).defaultPrevented, true);
});

test('the code menu leaves other targets and menus already shown to their owners', () => {
  const h = buildPage();
  assert.equal(rightClick(h, h.document.getElementById('filter')).defaultPrevented, false);
  assert.equal(rightClick(h, h.workingTreeEl.querySelector('[data-file-diff-toggle]')).defaultPrevented, false);
  assert.equal(h.menus.length, 0);
  h.workingTreeEl.addEventListener('contextmenu', (event) => event.preventDefault());
  rightClick(h, wtRow(h, 'src/a.js', 2));
  assert.equal(h.menus.length, 0, 'a menu a child already opened is not opened twice');
});

test('the menu key opens nothing on the ledger list, where there is no file', () => {
  const h = buildPage({ scope: 'this_chat' });
  const files = h.hostEl.querySelectorAll('.changes-history-file');
  const event = press(h, h.hostEl.querySelector('.changes-view'), 'ContextMenu');
  assert.equal(event.defaultPrevented, false);
  assert.equal(h.menus.length, 0);
  assert.equal(files.length, 3);
});

test('a hidden ledger detail is not the file of the Working tree page', async () => {
  const h = buildPage({ scope: 'this_chat' });
  openLedgerDetail(h, 0);
  h.pageEl.dataset.changesScope = 'working_tree';
  h.workingTreeEl.innerHTML = workingTreeFile('src/a.js', HUNKS_A);
  h.document.activeElement.blur();
  press(h, h.pageEl, 'ContextMenu');
  item(h, 'Copy path').action();
  await settle();
  assert.deepEqual(h.clipboard, ['src/a.js']);
});

test('find on the page counts the diff rows of the page', () => {
  const h = buildPage();
  const toggle = h.workingTreeEl.querySelector('[data-file-diff-toggle]');
  toggle.focus();
  assert.equal(press(h, toggle, 'f', { ctrlKey: true }).defaultPrevented, true);
  const field = h.document.querySelector('.panel-code-find');
  assert.ok(field);
  assert.equal(field.nextSibling, h.pageEl);
});

test('file menu items: a failed Copy diff toasts instead of rejecting', async () => {
  const toasts = [];
  const [, copy] = viewActions.buildFileMenuItems({
    path: 'src/a.js', hunks: HUNKS_A, windowRef: {}, panelCodeActions,
    writeClipboard: () => Promise.reject(new Error('denied')), showToast: (message) => toasts.push(message),
  });
  await copy.action();
  assert.deepEqual(toasts, ['Couldn’t copy']);
});

test('file menu items: Copy diff is disabled without hunks and Ask Jenny toasts without a composer', async () => {
  const writes = [];
  const toasts = [];
  const inserted = [];
  const base = {
    path: 'src/a.js', windowRef: {}, panelCodeActions, writeClipboard: (text) => writes.push(text), showToast: (message) => toasts.push(message),
    insertIntoComposer: (payload) => { inserted.push(payload.text); return false; },
  };
  const [separator, copy, ask] = viewActions.buildFileMenuItems({ ...base, hunks: HUNKS_A });
  assert.equal(separator.separator, true);
  await copy.action();
  ask.action();
  assert.deepEqual(writes, [PATCH_A]);
  assert.deepEqual(inserted, ['`src/a.js` ']);
  assert.deepEqual(toasts, ['Open a chat to ask Jenny']);
  assert.equal(viewActions.buildFileMenuItems({ ...base, hunks: [] })[1].disabled, true);
});
