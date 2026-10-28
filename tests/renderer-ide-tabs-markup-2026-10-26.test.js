'use strict';

/* Editor tab strip overhaul (row 81, slice T): markup contract, disambiguation,
 * the scroll-snap fix (finding 1), the "+N" count chip and the copy fixes.
 * jsdom has no layout, so rects are stubbed per element where a test needs them. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const ideTabs = require('../renderer/features/renderer-ide-tabs');
const { escapeHtml } = require('../renderer/shared/string-utils');

const JENNY_LABEL = "a.js (Jenny's change)";

function makeStrip({ getGitDecoration, ariaControls } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="ide-tabbar"><div id="strip" class="ide-tabstrip" role="tablist"></div></div></body>');
  const strip = dom.window.document.getElementById('strip');
  const calls = [];
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
    calls.push({ el: this, options });
  };
  const tabStrip = ideTabs.createIdeTabStrip({
    getDom: () => ({ ideTabStrip: strip }),
    escapeHtml,
    ariaControls,
    getGitDecoration,
  });
  return { dom, strip, calls, render: (args) => tabStrip.renderTabs(args) };
}

const FILE_TABS = [
  { path: 'a.js', kind: 'file' },
  { path: 'b.js', kind: 'file' },
  { path: 'c.js', kind: 'file' },
];

test('the active tab is scrolled into view only when the active path or tab count changes', () => {
  const { strip, calls, render } = makeStrip();
  render({ openTabs: FILE_TABS, activeTabPath: 'a.js' });
  assert.equal(calls.length, 1, 'first render scrolls the active tab into view');
  assert.deepEqual(calls[0].options, { inline: 'nearest', block: 'nearest' });
  assert.equal(calls[0].el, strip.querySelector('.ide-tab--active'));

  // A dirty flip re-renders with the same active path and count: no scroll.
  render({ openTabs: FILE_TABS, activeTabPath: 'a.js', dirtyByPath: { 'b.js': true } });
  render({ openTabs: FILE_TABS, activeTabPath: 'a.js', dirtyByPath: { 'b.js': true }, staleByPath: { 'c.js': true } });
  assert.equal(calls.length, 1, 'same active path and count never re-scrolls (the strip no longer snaps back)');

  render({ openTabs: FILE_TABS, activeTabPath: 'c.js' });
  assert.equal(calls.length, 2, 'a new active path scrolls');
  assert.equal(calls[1].el.getAttribute('data-ide-tab'), 'c.js');

  render({ openTabs: FILE_TABS.concat({ path: 'd.js', kind: 'file' }), activeTabPath: 'c.js' });
  assert.equal(calls.length, 3, 'a new tab count scrolls');
});

// ── disambiguateTabs ─────────────────────────────────────────────────────────

test('disambiguateTabs leaves unique basenames alone and suffixes duplicates with the shortest unique folder', () => {
  const result = ideTabs.disambiguateTabs([
    { path: 'src/index.js', kind: 'file' },
    { path: 'lib/index.js', kind: 'file' },
    { path: 'README.md', kind: 'file' },
  ]);
  assert.deepEqual([...result], [['src/index.js', 'src'], ['lib/index.js', 'lib']]);
});

test('disambiguateTabs walks up nested folders only as far as needed', () => {
  const result = ideTabs.disambiguateTabs([
    { path: 'a/x/index.js', kind: 'file' },
    { path: 'b/x/index.js', kind: 'file' },
    { path: 'c/index.js', kind: 'file' },
  ]);
  assert.equal(result.get('a/x/index.js'), 'a/x');
  assert.equal(result.get('b/x/index.js'), 'b/x');
  assert.equal(result.get('c/index.js'), 'c');

  // A shorter folder that is a tail of a longer one still disambiguates.
  const nested = ideTabs.disambiguateTabs([
    { path: 'a/x.js', kind: 'file' },
    { path: 'b/a/x.js', kind: 'file' },
  ]);
  assert.equal(nested.get('a/x.js'), 'a');
  assert.equal(nested.get('b/a/x.js'), 'b/a');
});

test('disambiguateTabs names a root-level file with the workspace label', () => {
  const result = ideTabs.disambiguateTabs([
    { path: 'index.js', kind: 'file' },
    { path: 'src/index.js', kind: 'file' },
  ]);
  assert.equal(result.get('index.js'), 'root');
  assert.equal(result.get('src/index.js'), 'src');
});

test('disambiguateTabs ignores diff and preview tabs', () => {
  const result = ideTabs.disambiguateTabs([
    { path: 'src/a.js', kind: 'file' },
    { path: 'diff://change/1', kind: 'diff', label: JENNY_LABEL },
    { path: 'preview://a.js', kind: 'preview', label: 'a.js' },
    { path: 'lib/a.js', kind: 'file' },
  ]);
  assert.deepEqual([...result.keys()].sort(), ['lib/a.js', 'src/a.js']);
});

// ── markup contract ──────────────────────────────────────────────────────────

test('a tab renders icon, name and one slot with a close button', () => {
  const { strip, render } = makeStrip();
  render({ openTabs: [{ path: 'src/a.js', kind: 'file' }], activeTabPath: 'src/a.js' });
  const tab = strip.querySelector('.ide-tab');
  assert.equal(tab.getAttribute('draggable'), 'true');
  assert.equal(tab.dataset.ideTab, 'src/a.js');
  const label = tab.querySelector('button.ide-tab-label');
  assert.equal(label.getAttribute('role'), 'tab');
  assert.equal(label.dataset.ideTabPath, 'src/a.js');
  assert.equal(label.getAttribute('aria-selected'), 'true');
  assert.equal(label.getAttribute('tabindex'), '0');
  assert.ok(label.querySelector('.ide-tree-icon svg'), 'file icon resolved lazily from rendererIdeIcons');
  assert.equal(label.querySelector('.ide-tab-name').textContent, 'a.js');
  assert.equal(label.querySelector('.ide-tab-dir'), null, 'no suffix for a unique basename');
  const slot = tab.querySelector('span.ide-tab-slot');
  assert.ok(slot);
  assert.equal(slot.querySelector('.ide-tab-mark'), null);
  assert.equal(slot.querySelector('.ide-tab-pin'), null);
  const close = slot.querySelector('button.ide-tab-close');
  assert.equal(close.dataset.ideTabClose, 'src/a.js');
  assert.equal(close.getAttribute('tabindex'), '-1');
  assert.ok(close.querySelector('svg'), 'the close glyph is an SVG cross');
});

test('the slot holds the mark for dirty and stale tabs and the pin glyph for pinned ones', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [
      { path: 'clean.js', kind: 'file' },
      { path: 'dirty.js', kind: 'file' },
      { path: 'stale.js', kind: 'file' },
      { path: 'pinned.js', kind: 'file', pinned: true },
    ],
    activeTabPath: 'clean.js',
    dirtyByPath: { 'dirty.js': true, 'stale.js': true },
    staleByPath: { 'stale.js': true },
  });
  const slotOf = (path) => strip.querySelector(`[data-ide-tab="${path}"] .ide-tab-slot`);
  const tabOf = (path) => strip.querySelector(`[data-ide-tab="${path}"]`);
  assert.equal(slotOf('clean.js').querySelector('.ide-tab-mark'), null);
  assert.ok(slotOf('dirty.js').querySelector('.ide-tab-mark'));
  assert.ok(tabOf('dirty.js').classList.contains('ide-tab--dirty'));
  assert.ok(slotOf('stale.js').querySelector('.ide-tab-mark'));
  assert.ok(tabOf('stale.js').classList.contains('ide-tab--stale'));
  assert.ok(slotOf('pinned.js').querySelector('.ide-tab-pin svg'));
  assert.ok(tabOf('pinned.js').classList.contains('ide-tab--pinned'));
  assert.equal(slotOf('pinned.js').querySelector('.ide-tab-mark'), null);
  for (const path of ['clean.js', 'dirty.js', 'stale.js', 'pinned.js']) {
    assert.ok(slotOf(path).querySelector('.ide-tab-close'), `${path} keeps its close button in the slot`);
  }
});

test('duplicate basenames render a folder suffix and the has-dir modifier', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [{ path: 'src/index.js', kind: 'file' }, { path: 'lib/index.js', kind: 'file' }, { path: 'main.js', kind: 'file' }],
    activeTabPath: 'main.js',
  });
  const dirOf = (path) => strip.querySelector(`[data-ide-tab="${path}"] .ide-tab-dir`);
  assert.equal(dirOf('src/index.js').textContent, 'src');
  assert.equal(dirOf('lib/index.js').textContent, 'lib');
  assert.equal(dirOf('main.js'), null);
  assert.ok(strip.querySelector('[data-ide-tab="src/index.js"]').classList.contains('ide-tab--has-dir'));
  assert.ok(!strip.querySelector('[data-ide-tab="main.js"]').classList.contains('ide-tab--has-dir'));
});

test('the folder suffix is part of the accessible name, before the state words', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [{ path: 'src/index.js', kind: 'file' }, { path: 'lib/index.js', kind: 'file' }],
    activeTabPath: 'src/index.js',
    dirtyByPath: { 'lib/index.js': true },
  });
  const labelOf = (path) => strip.querySelector(`[data-ide-tab-path="${path}"]`).getAttribute('aria-label');
  assert.equal(labelOf('src/index.js'), 'index.js (src)');
  assert.equal(labelOf('lib/index.js'), 'index.js (lib, unsaved changes)');
});

test('syncTabOverflow leaves the chip alone when the counts did not change', () => {
  const { strip, render } = makeStrip();
  render({ openTabs: FILE_TABS, activeTabPath: 'a.js' });
  const chip = strip.nextElementSibling;
  ideTabs.syncTabOverflow(strip);
  chip.title = 'untouched';
  ideTabs.syncTabOverflow(strip);
  assert.equal(chip.title, 'untouched');
});

test('diff tabs show the file name, a diff glyph and the Jenny change suffix', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [
      { path: 'diff://change/7', kind: 'diff', label: JENNY_LABEL },
      { path: 'diff://unsaved/a.js', kind: 'diff', label: 'a.js (unsaved vs saved)' },
    ],
    activeTabPath: 'diff://change/7',
    dirtyByPath: { 'diff://change/7': true },
  });
  const change = strip.querySelector('[data-ide-tab="diff://change/7"]');
  assert.ok(change.classList.contains('ide-tab--diff'));
  assert.ok(change.classList.contains('ide-tab--has-dir'));
  assert.ok(change.querySelector('.ide-tab-glyph svg'), 'diff glyph replaces the file icon');
  assert.equal(change.querySelector('.ide-tree-icon'), null);
  assert.equal(change.querySelector('.ide-tab-name').textContent, 'a.js');
  assert.equal(change.querySelector('.ide-tab-dir').textContent, "Jenny's change");
  assert.equal(change.querySelector('.ide-tab-mark'), null, 'review tabs never show the dirty mark');
  assert.equal(change.querySelector('.ide-tab-label').getAttribute('aria-label'), `${JENNY_LABEL} (diff view)`);
  assert.equal(strip.querySelector('[data-ide-tab="diff://unsaved/a.js"] .ide-tab-dir').textContent, 'unsaved vs saved');
  assert.equal(ideTabs.tabDisplayName({ path: 'diff://change/7', kind: 'diff', label: JENNY_LABEL }), JENNY_LABEL);
});

test('a git decoration class lands only on file tabs that are not dirty', () => {
  const status = { 'm.js': 'modified', 'u.js': 'untracked', 'd.js': 'modified', 's.js': 'modified', 'x.js': 'bogus' };
  const { strip, render } = makeStrip({ getGitDecoration: (path) => status[path] || null });
  render({
    openTabs: ['m.js', 'u.js', 'd.js', 's.js', 'x.js', 'plain.js'].map((path) => ({ path, kind: 'file' })),
    activeTabPath: 'plain.js',
    dirtyByPath: { 'd.js': true },
    staleByPath: { 's.js': true },
  });
  const cls = (path) => strip.querySelector(`[data-ide-tab="${path}"]`).className;
  assert.match(cls('m.js'), /ide-tab--git-modified/);
  assert.match(cls('u.js'), /ide-tab--git-untracked/);
  assert.doesNotMatch(cls('d.js'), /ide-tab--git-/, 'dirty wins over the git tint');
  assert.doesNotMatch(cls('s.js'), /ide-tab--git-/);
  assert.doesNotMatch(cls('x.js'), /ide-tab--git-/, 'unknown statuses are ignored');
  assert.doesNotMatch(cls('plain.js'), /ide-tab--git-/);
});

test('the transient preview modifier and the aria state words go through the catalog fallbacks', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [
      { path: 'p.js', kind: 'file', pinned: true },
      { path: 'v.js', kind: 'file', transientPreview: true },
    ],
    activeTabPath: 'v.js',
    dirtyByPath: { 'p.js': true },
  });
  const aria = (path) => strip.querySelector(`[data-ide-tab-path="${path}"]`).getAttribute('aria-label');
  assert.equal(aria('p.js'), 'p.js (unsaved changes, pinned)');
  assert.equal(aria('v.js'), 'v.js (preview)');
  assert.ok(strip.querySelector('[data-ide-tab="v.js"]').classList.contains('ide-tab--preview'));
});

test('every tab shares one close title with no "discards" wording', () => {
  const { strip, render } = makeStrip();
  render({
    openTabs: [{ path: 'a.js', kind: 'file' }, { path: 'b.js', kind: 'file' }, { path: 'diff://change/1', kind: 'diff', label: 'c.js (unsaved vs saved)' }],
    activeTabPath: 'a.js',
    dirtyByPath: { 'b.js': true },
  });
  const titles = [...strip.querySelectorAll('.ide-tab-close')].map((button) => button.title);
  assert.deepEqual(titles, ['Close a.js (Ctrl+F4)', 'Close b.js (Ctrl+F4)', 'Close c.js (Ctrl+F4)']);
});

// ── surface tab ──────────────────────────────────────────────────────────────

test('a stage surface renders as the last real tab and every file tab reads inactive', () => {
  const { strip, render } = makeStrip();
  const openTabs = [{ path: 'src/README.md', kind: 'file' }, { path: 'b.js', kind: 'file' }];
  render({
    openTabs,
    activeTabPath: 'src/README.md',
    surfaceTab: { surface: 'preview', label: 'Preview', subject: 'src/README.md' },
  });
  const tabs = [...strip.querySelectorAll('.ide-tab')];
  assert.equal(tabs.length, 3);
  const surface = tabs[2];
  assert.ok(surface.classList.contains('ide-tab--surface'));
  assert.ok(surface.classList.contains('ide-tab--active'));
  assert.equal(surface.dataset.ideSurfaceTab, 'preview');
  const label = surface.querySelector('button.ide-tab-label');
  assert.equal(label.getAttribute('role'), 'tab');
  assert.equal(label.getAttribute('aria-selected'), 'true');
  assert.equal(label.getAttribute('tabindex'), '0');
  assert.equal(label.dataset.ideSurfaceLabel, 'preview');
  assert.ok(label.querySelector('.ide-tab-glyph svg'));
  assert.equal(label.querySelector('.ide-tab-name').textContent, 'Preview');
  assert.equal(label.querySelector('.ide-tab-dir').textContent, 'README.md');
  const close = surface.querySelector('.ide-tab-slot button.ide-tab-close');
  assert.equal(close.dataset.ideSurfaceClose, 'preview');
  assert.equal(close.getAttribute('tabindex'), '-1');
  for (const fileTab of tabs.slice(0, 2)) {
    assert.ok(!fileTab.classList.contains('ide-tab--active'));
    assert.equal(fileTab.querySelector('.ide-tab-label').getAttribute('aria-selected'), 'false');
    assert.equal(fileTab.querySelector('.ide-tab-label').getAttribute('tabindex'), '-1');
  }
  assert.equal(strip.querySelectorAll('[aria-selected="true"]').length, 1);

  // Closing the surface returns the selection to the active file tab.
  render({ openTabs, activeTabPath: 'src/README.md' });
  assert.equal(strip.querySelector('.ide-tab--surface'), null);
  assert.ok(strip.querySelector('[data-ide-tab="src/README.md"]').classList.contains('ide-tab--active'));
});

test('a surface that appears, or changes, scrolls into view like a new active tab', () => {
  const { calls, render } = makeStrip();
  const openTabs = [{ path: 'a.js', kind: 'file' }];
  render({ openTabs, activeTabPath: 'a.js' });
  render({ openTabs, activeTabPath: 'a.js', surfaceTab: { surface: 'preview', label: 'Preview', subject: 'a.js' } });
  assert.equal(calls.length, 2);
  render({ openTabs, activeTabPath: 'a.js', surfaceTab: { surface: 'preview', label: 'Preview', subject: 'a.js' } });
  assert.equal(calls.length, 2);
  render({ openTabs, activeTabPath: 'a.js', surfaceTab: { surface: 'file_map', label: 'File Map', subject: '' } });
  assert.equal(calls.length, 3);
});

// ── count chip ───────────────────────────────────────────────────────────────

test("the count chip is the strip's next sibling, hidden, and is created once", () => {
  const { strip, render } = makeStrip();
  assert.equal(strip.nextElementSibling, null, 'no chip while the strip has never held a tab');
  render({ openTabs: FILE_TABS, activeTabPath: 'a.js' });
  const chip = strip.nextElementSibling;
  assert.ok(chip.classList.contains('ide-tabstrip-count'));
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.hasAttribute('data-ide-tab-overflow'), true);
  assert.equal(chip.getAttribute('aria-haspopup'), 'menu');
  assert.equal(chip.hidden, true);
  render({ openTabs: FILE_TABS, activeTabPath: 'b.js' });
  assert.equal(strip.parentElement.querySelectorAll('.ide-tabstrip-count').length, 1);
  assert.equal(strip.querySelector('[data-ide-tab-overflow]'), null, 'no in-strip chevron');
});

test('syncTabOverflow counts tabs that are not fully inside the strip and labels the chip', () => {
  const { strip, render } = makeStrip();
  render({ openTabs: [...FILE_TABS, { path: 'd.js', kind: 'file' }], activeTabPath: 'a.js' });
  const chip = strip.nextElementSibling;
  const rect = (left, width) => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32 });

  // jsdom's all-zero layout: nothing counts as hidden.
  assert.equal(ideTabs.syncTabOverflow(strip), 0);
  assert.equal(chip.hidden, true);

  strip.getBoundingClientRect = () => rect(100, 250);
  [...strip.querySelectorAll('.ide-tab')].forEach((tab, index) => {
    // a.js starts 20 px left of the strip, b.js fits, c.js and d.js run past the right edge.
    tab.getBoundingClientRect = () => rect(80 + index * 120, 120);
  });
  assert.equal(ideTabs.syncTabOverflow(strip), 3);
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, '+3');
  assert.equal(chip.title, 'Show all 4 open tabs');
  assert.equal(chip.getAttribute('aria-label'), 'Show all 4 open tabs');

  strip.getBoundingClientRect = () => rect(0, 1000);
  assert.equal(ideTabs.syncTabOverflow(strip), 0);
  assert.equal(chip.hidden, true);
});

test('syncTabOverflow is a no-op for a strip without a chip', () => {
  const dom = new JSDOM('<!doctype html><body><div id="s"></div></body>');
  assert.equal(ideTabs.syncTabOverflow(dom.window.document.getElementById('s')), 0);
});
