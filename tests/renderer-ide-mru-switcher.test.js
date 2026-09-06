'use strict';

/* Ctrl+Tab MRU tab switcher (renderer-ide-mru-switcher.js): the pure buildMruPaths
 * union/order, plus the focus-less overlay's keyup-commit state machine driven
 * standalone against a jsdom window (open/preselect/cycle/wrap, Ctrl-release
 * commit, Esc + blur cancel, click-to-commit, the <2-tab no-op, and dispose). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createIdeMruSwitcher,
  buildMruPaths,
} = require('../renderer/features/renderer-ide-mru-switcher');

function fileTabs(...paths) {
  return paths.map((path) => ({ path, kind: 'file' }));
}

function buildSwitcher(recentFiles, openTabs, view = { current: 'ide' }) {
  const dom = new JSDOM('<!doctype html><body><div id="stage"></div></body>');
  const stage = dom.window.document.getElementById('stage');
  const calls = { activateTab: [], log: [] };
  const switcher = createIdeMruSwitcher({
    getDom: () => ({ ideEditorStage: stage }),
    windowRef: dom.window,
    escapeHtml: (v) => String(v == null ? '' : v),
    appendClientLog: (...args) => calls.log.push(args),
    getRecentFiles: () => recentFiles.slice(),
    getOpenTabs: () => openTabs.slice(),
    activateTab: (path) => calls.activateTab.push(path),
    getActiveView: () => view.current,
  });
  switcher.bindEvents();
  return { dom, stage, switcher, calls, view };
}

const overlayEl = (stage) => stage.querySelector('.ide-mru-switcher');
const isOpen = (stage) => {
  const el = overlayEl(stage);
  return !!el && !el.classList.contains('hidden');
};
const rowPaths = (stage) => [...stage.querySelectorAll('[data-ide-mru-path]')].map((r) => r.dataset.ideMruPath);
const selectedPath = (stage) => {
  const row = stage.querySelector('.ide-picker-row--selected');
  return row ? row.dataset.ideMruPath : null;
};
const winKeyup = (dom, key) => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key, bubbles: true }));
const winKeydown = (dom, key, mods = {}) =>
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, shiftKey: !!mods.shift, bubbles: true, cancelable: true }));

test('buildMruPaths unions recent + open file tabs MRU-first, files only, deduped', () => {
  const open = [
    { path: 'a.js', kind: 'file' },
    { path: 'b.js', kind: 'file' },
    { path: 'c.js', kind: 'file' },                 // open but never activated -> tail
    { path: 'diff://x', kind: 'diff', label: 'Diff' }, // review surface -> excluded
  ];
  assert.deepEqual(buildMruPaths(() => ['a.js', 'b.js'], () => open), ['a.js', 'b.js', 'c.js']);
  // A recent path that is no longer open is dropped; the tab order fills the tail.
  assert.deepEqual(buildMruPaths(() => ['gone.js', 'b.js'], () => open), ['b.js', 'a.js', 'c.js']);
});

test('Ctrl+Tab opens, preselects the previous tab, and cycles forward with wrap', () => {
  const { stage, switcher } = buildSwitcher(['a.js', 'b.js', 'c.js'], fileTabs('a.js', 'b.js', 'c.js'));
  switcher.handleTabKey(true);
  assert.equal(isOpen(stage), true);
  assert.deepEqual(rowPaths(stage), ['a.js', 'b.js', 'c.js']);
  assert.equal(selectedPath(stage), 'b.js', 'index 1 (the previous tab) is preselected');
  switcher.handleTabKey(true);
  assert.equal(selectedPath(stage), 'c.js');
  switcher.handleTabKey(true);
  assert.equal(selectedPath(stage), 'a.js', 'wraps to the top');
  switcher.dispose();
});

test('Ctrl+Shift+Tab (backward) preselects the last tab', () => {
  const { stage, switcher } = buildSwitcher(['a.js', 'b.js', 'c.js'], fileTabs('a.js', 'b.js', 'c.js'));
  switcher.handleTabKey(false);
  assert.equal(selectedPath(stage), 'c.js');
  switcher.dispose();
});

test('releasing Ctrl commits to the highlighted tab and closes the overlay', () => {
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js'], fileTabs('a.js', 'b.js'));
  switcher.handleTabKey(true); // selects 'b.js'
  winKeyup(dom, 'Control');
  assert.deepEqual(calls.activateTab, ['b.js']);
  assert.equal(isOpen(stage), false);
  switcher.dispose();
});

test('Escape cancels without switching tabs', () => {
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js'], fileTabs('a.js', 'b.js'));
  switcher.handleTabKey(true);
  winKeydown(dom, 'Escape');
  assert.deepEqual(calls.activateTab, []);
  assert.equal(isOpen(stage), false);
  switcher.dispose();
});

test('once open, a window Tab keydown advances (forward) / Shift+Tab retreats', () => {
  const { dom, stage, switcher } = buildSwitcher(['a.js', 'b.js', 'c.js'], fileTabs('a.js', 'b.js', 'c.js'));
  switcher.handleTabKey(true); // open, index 1 = 'b.js'
  winKeydown(dom, 'Tab');
  assert.equal(selectedPath(stage), 'c.js');
  winKeydown(dom, 'Tab', { shift: true });
  assert.equal(selectedPath(stage), 'b.js');
  switcher.dispose();
});

test('clicking a row commits to that tab', () => {
  const { stage, switcher, calls } = buildSwitcher(['a.js', 'b.js', 'c.js'], fileTabs('a.js', 'b.js', 'c.js'));
  switcher.handleTabKey(true);
  const row = [...stage.querySelectorAll('[data-ide-mru-path]')].find((r) => r.dataset.ideMruPath === 'c.js');
  row.click();
  assert.deepEqual(calls.activateTab, ['c.js']);
  assert.equal(isOpen(stage), false);
  switcher.dispose();
});

test('clicking a row whose tab was closed mid-overlay does not reopen it', () => {
  const open = fileTabs('a.js', 'b.js', 'c.js');
  const { stage, switcher, calls } = buildSwitcher(['a.js', 'b.js', 'c.js'], open);
  switcher.handleTabKey(true);  // open; rows snapshot [a.js, b.js, c.js]
  open.splice(2, 1);            // 'c.js' closed elsewhere (Ctrl+F4); openTabs now [a.js, b.js]
  const row = [...stage.querySelectorAll('[data-ide-mru-path]')].find((r) => r.dataset.ideMruPath === 'c.js');
  row.click();
  assert.deepEqual(calls.activateTab, [], 'a closed tab is not re-activated on click (mirrors commit())');
  assert.equal(isOpen(stage), false);
  switcher.dispose();
});

test('losing window focus cancels the overlay (a missed Ctrl-release cannot strand it)', () => {
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js'], fileTabs('a.js', 'b.js'));
  switcher.handleTabKey(true);
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  assert.equal(isOpen(stage), false);
  assert.deepEqual(calls.activateTab, []);
  switcher.dispose();
});

test('fewer than two tabs is a no-op (the overlay never mounts)', () => {
  const { stage, switcher } = buildSwitcher(['a.js'], fileTabs('a.js'));
  switcher.handleTabKey(true);
  assert.equal(overlayEl(stage), null);
  switcher.dispose();
});

test('switching away from the IDE view cancels on the next key (no stale commit)', () => {
  const view = { current: 'ide' };
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js'], fileTabs('a.js', 'b.js'), view);
  switcher.handleTabKey(true); // open on the IDE, selects 'b.js'
  view.current = 'chat';        // navigate away while holding Ctrl (no window blur)
  winKeyup(dom, 'Control');     // releasing Ctrl on a non-IDE surface must NOT switch tabs
  assert.deepEqual(calls.activateTab, [], 'no commit off the IDE view');
  assert.equal(isOpen(stage), false, 'the overlay stood down');
  switcher.dispose();
});

test('committing to a tab closed mid-overlay does not resurrect it', () => {
  const open = fileTabs('a.js', 'b.js', 'c.js');
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js', 'c.js'], open);
  switcher.handleTabKey(true);  // open, selects 'b.js'
  // 'b.js' is closed elsewhere (e.g. Ctrl+F4) while the overlay is held.
  open.splice(1, 1);            // openTabs is now [a.js, c.js]
  winKeyup(dom, 'Control');     // commit to the now-stale 'b.js'
  assert.deepEqual(calls.activateTab, [], 'a closed tab is not re-activated');
  assert.equal(isOpen(stage), false);
  switcher.dispose();
});

test('a stray Ctrl-release after dispose does not commit (listeners + overlay torn down)', () => {
  const { dom, stage, switcher, calls } = buildSwitcher(['a.js', 'b.js'], fileTabs('a.js', 'b.js'));
  switcher.handleTabKey(true);
  switcher.dispose();
  assert.equal(stage.querySelector('.ide-mru-switcher'), null, 'overlay removed on dispose');
  winKeyup(dom, 'Control');
  assert.deepEqual(calls.activateTab, [], 'no commit after teardown');
});
