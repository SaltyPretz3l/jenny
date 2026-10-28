'use strict';

/* Outline view (row 82 O1): the active file's symbols in the explorer's row grammar,
 * following the cursor, revealing on click, Collapse All and sort; plus the optional
 * `outline` view seam in the layout model, the config schema and the palette rows.
 * JSDOM, a fake editor host and model, manual timers; the real providers. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeOutlineView } = require('../renderer/features/renderer-ide-outline-view');
const { createFakeTimers } = require('./helpers/fake-timers');
const model = require('../renderer/shared/workbench-layout-model');
const ops = require('../renderer/shared/workbench-layout-ops');
const legacy = require('../renderer/shared/workbench-layout-legacy');
const { normalizeWorkspaceIde } = require('../services/workspace-ide-config-schema');
const { createIdeCommandRegistry } = require('../renderer/features/renderer-ide-command-registry');
const { registerIdePaletteCommands } = require('../renderer/features/renderer-ide-palette-commands');

const MD = ['# Guide', 'intro', '## Install', '### Windows', 'steps', '### Linux', '## Use', '# Appendix'].join('\n');

function fakeModel(text, languageId) {
  let value = text;
  let version = 1;
  const listeners = new Set();
  const lineStarts = () => {
    const starts = [0];
    for (let i = 0; i < value.length; i += 1) if (value[i] === '\n') starts.push(i + 1);
    return starts;
  };
  return {
    getValue: () => value,
    getValueLength: () => value.length,
    getVersionId: () => version,
    getLanguageId: () => languageId,
    getPositionAt(offset) {
      const starts = lineStarts();
      let line = 0;
      while (line + 1 < starts.length && starts[line + 1] <= offset) line += 1;
      return { lineNumber: line + 1, column: offset - starts[line] + 1 };
    },
    getValueInRange: (range) => value.split('\n').slice(0, range.endLineNumber - 1).join('\n'),
    onDidChangeContent(listener) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    get listenerCount() { return listeners.size; },
    edit(next) { value = next; version += 1; for (const listener of [...listeners]) listener({}); },
  };
}

function setup(t, opts = {}) {
  const dom = new JSDOM('<!doctype html><html><body><div id="host" tabindex="-1"></div><div id="editor" tabindex="-1"></div></body></html>');
  const { window } = dom;
  const host = window.document.getElementById('host');
  const docs = new Map();
  const state = { path: opts.path ?? 'docs/guide.md', cursor: opts.cursor || 1, visible: opts.visible !== false, reveals: [], focused: 0, large: false };
  if (state.path) docs.set(state.path, opts.model || fakeModel(opts.text ?? MD, opts.languageId || 'markdown'));
  const editorHost = {
    getFocusedPath: () => '',
    getActivePath: () => state.path,
    getModel: (path) => docs.get(path) || null,
    getDocumentKind: (path) => (docs.has(path) ? 'file' : ''),
    getActiveLanguageId: () => docs.get(state.path)?.getLanguageId() || '',
    getCursorInfo: () => ({ lineNumber: state.cursor, column: 1 }),
    isLargeFile: () => state.large,
    revealPosition: (path, line, column) => state.reveals.push([path, line, column]),
    focus: () => { state.focused += 1; window.document.getElementById('editor').focus(); },
  };
  const timers = createFakeTimers();
  const delays = []; // every requested debounce, reset by the test that reads it
  const view = createIdeOutlineView({
    getViewDeps: () => ({ getMountEl: () => host, isActivePanel: () => state.visible }),
    editorHost,
    getSymbolNav: () => opts.symbolNav || null,
    windowRef: window,
    setTimeoutFn: (fn, ms) => { delays.push(ms); return timers.setTimeout(fn, ms); },
    clearTimeoutFn: timers.clearTimeout,
    appendClientLog: () => {},
  });
  t.after(() => {
    view.dispose();
    window.close();
  });
  const flush = () => { while (timers.pending()) timers.runPending(); };
  const rows = () => [...host.querySelectorAll('[data-ide-outline-key]')];
  const names = () => rows().map((row) => `${'  '.repeat(Number(row.getAttribute('aria-level')) - 1)}${row.querySelector('.ide-tree-name').textContent}`);
  const row = (name) => rows().find((r) => r.querySelector('.ide-tree-name').textContent === name) || null;
  const status = () => [...host.querySelectorAll('.ide-tree-status')].map((el) => el.textContent);
  // Counts writes of host.innerHTML (O1: an active-row move must not rebuild the tree).
  const html = Object.getOwnPropertyDescriptor(window.Element.prototype, 'innerHTML');
  const writes = { count: 0 };
  Object.defineProperty(host, 'innerHTML', {
    configurable: true,
    get() { return html.get.call(this); },
    set(value) { writes.count += 1; html.set.call(this, value); },
  });
  return { window, host, view, state, docs, editorHost, flush, rows, names, row, status, writes, delays, timers };
}

test('a Markdown file renders the explorer header and a three-level tree in the explorer row grammar', (t) => {
  const h = setup(t);
  h.view.render();
  assert.equal(h.host.querySelector('.ide-tree-header .ide-tree-header-title').textContent, 'Outline');
  const tree = h.host.querySelector('.ide-tree.ide-tree--qol[role="tree"]');
  assert.ok(tree, 'the explorer tree container');
  assert.equal(tree.getAttribute('aria-label'), 'Outline of guide.md');
  assert.deepEqual(h.names(), ['Guide', '  Install', '    Windows', '    Linux', '  Use', 'Appendix']);
  const windows = h.row('Windows');
  assert.ok(windows.classList.contains('ide-tree-row'));
  assert.equal(windows.getAttribute('role'), 'treeitem');
  assert.equal(windows.style.getPropertyValue('--ide-tree-depth'), '2');
  assert.equal(windows.title, 'Windows (heading, line 4)');
  assert.equal(h.row('Guide').getAttribute('aria-expanded'), 'true');
  assert.equal(h.row('Guide').querySelector('.ide-tree-twisty').textContent, '▾');
  assert.equal(h.row('Windows').hasAttribute('aria-expanded'), false, 'a leaf has no expanded state');
  assert.equal(h.host.querySelectorAll('[data-ide-outline-action]').length, 2, 'Sort and Collapse All');
});

test('the active row follows the cursor and re-opens its ancestors', (t) => {
  const h = setup(t, { cursor: 5 });
  h.view.render();
  assert.equal(h.row('Windows').classList.contains('ide-tree-row--active'), true);
  assert.equal(h.row('Windows').getAttribute('aria-current'), 'true');
  assert.equal(h.host.querySelectorAll('.ide-tree-row--active').length, 1);
  h.view.collapseAll();
  assert.deepEqual(h.names(), ['Guide', 'Appendix']);
  h.state.cursor = 7;
  h.view.noteCursor();
  h.flush();
  assert.deepEqual(h.names(), ['Guide', '  Install', '  Use', 'Appendix'], 'the new active symbol opens its ancestors');
  assert.equal(h.row('Use').classList.contains('ide-tree-row--active'), true);
  h.state.cursor = 8;
  h.view.noteCursor();
  h.flush();
  assert.equal(h.row('Appendix').getAttribute('aria-current'), 'true');
});

test('O1: a cursor move inside the same tree writes no innerHTML', (t) => {
  const h = setup(t, { cursor: 5 });
  h.view.render();
  assert.equal(h.row('Windows').classList.contains('ide-tree-row--active'), true);
  const windowsRow = h.row('Windows');
  h.writes.count = 0;
  h.state.cursor = 6;
  h.view.noteCursor();
  h.flush();
  assert.equal(h.writes.count, 0, 'the active class moves in place');
  assert.equal(h.row('Windows'), windowsRow, 'the same row elements stay');
  assert.equal(h.row('Linux').classList.contains('ide-tree-row--active'), true);
  assert.equal(h.row('Linux').getAttribute('aria-current'), 'true');
  assert.equal(h.row('Windows').classList.contains('ide-tree-row--active'), false);
  assert.equal(h.row('Windows').hasAttribute('aria-current'), false);
  assert.equal(h.host.querySelectorAll('.ide-tree-row--active').length, 1);
  // A sort still rebuilds.
  h.view.setSortMode('name');
  assert.equal(h.writes.count, 1);
  assert.equal(h.row('Linux').classList.contains('ide-tree-row--active'), true, 'the rebuilt tree keeps the active row');
});

test('O3: typing below the cursor updates the tree after the debounce', (t) => {
  const h = setup(t, { cursor: 1 });
  h.view.render();
  const model = h.docs.get('docs/guide.md');
  assert.equal(model.listenerCount, 1, 'the visible view follows its model');
  h.delays.length = 0;
  model.edit(`${MD}\n## Added`); // no cursor move, no file switch
  assert.deepEqual(h.delays, [400]);
  h.flush();
  assert.ok(h.row('Added'), 'the edit shows up');
  // While hidden an edit only marks the view stale; showing it refreshes.
  h.state.visible = false;
  h.delays.length = 0;
  model.edit(`${MD}\n## Added\n## Later`);
  assert.deepEqual(h.delays, []);
  h.state.visible = true;
  h.view.render();
  assert.ok(h.row('Later'));
  h.view.dispose();
  assert.equal(model.listenerCount, 0, 'dispose lets go of the model');
});

test('typing re-scans the file after the longer debounce; an unchanged version is not re-scanned', (t) => {
  const h = setup(t);
  h.view.render();
  h.docs.get('docs/guide.md').edit(`${MD}\n## Added`);
  h.view.noteCursor();
  h.flush();
  assert.ok(h.row('Added'), 'the edit shows up');
  const before = h.host.innerHTML;
  h.view.noteCursor();
  h.flush();
  assert.equal(h.host.innerHTML, before);
});

test('click reveals the symbol in the editor; the twisty toggles; Collapse All and Sort act from the header', (t) => {
  const h = setup(t);
  h.view.render();
  h.row('Linux').querySelector('.ide-tree-name').click();
  assert.deepEqual(h.state.reveals, [['docs/guide.md', 6, 1]]);
  assert.equal(h.state.focused, 1, 'a click puts the caret there');
  h.row('Install').querySelector('.ide-tree-twisty').click();
  assert.deepEqual(h.names(), ['Guide', '  Install', '  Use', 'Appendix']);
  assert.equal(h.row('Install').getAttribute('aria-expanded'), 'false');
  assert.equal(h.state.reveals.length, 1, 'the twisty does not reveal');
  h.host.querySelector('[data-ide-outline-action="collapse-all"]').click();
  assert.deepEqual(h.names(), ['Guide', 'Appendix']);
  h.row('Guide').querySelector('.ide-tree-twisty').click();
  h.row('Install').querySelector('.ide-tree-twisty').click();
  const sort = h.host.querySelector('[data-ide-outline-action="sort"]');
  assert.equal(sort.getAttribute('aria-pressed'), 'false');
  assert.equal(sort.title, 'Sort by: Position');
  sort.click();
  assert.equal(h.view.getSortMode(), 'name');
  assert.deepEqual(h.names(), ['Appendix', 'Guide', '  Install', '    Linux', '    Windows', '  Use']);
  assert.equal(h.host.querySelector('[data-ide-outline-action="sort"]').getAttribute('aria-pressed'), 'true');
});

test('keyboard: arrows move and fold, Enter reveals and focuses the editor, Space reveals only', (t) => {
  const h = setup(t);
  h.view.render();
  assert.equal(h.view.focus(), true);
  const key = (k) => h.window.document.activeElement.dispatchEvent(new h.window.KeyboardEvent('keydown', { key: k, bubbles: true }));
  assert.equal(h.window.document.activeElement, h.row('Guide'));
  assert.equal(h.row('Guide').getAttribute('tabindex'), '0');
  key('ArrowDown');
  assert.equal(h.window.document.activeElement, h.row('Install'));
  key('ArrowLeft');
  assert.equal(h.row('Install').getAttribute('aria-expanded'), 'false');
  assert.equal(h.window.document.activeElement, h.row('Install'), 'focus survives the repaint');
  key('ArrowLeft');
  assert.equal(h.window.document.activeElement, h.row('Guide'), 'Left on a closed node goes to its parent');
  key('End');
  assert.equal(h.window.document.activeElement, h.row('Appendix'));
  key(' ');
  assert.deepEqual(h.state.reveals.at(-1), ['docs/guide.md', 8, 1]);
  assert.equal(h.state.focused, 0);
  key('Enter');
  assert.equal(h.state.focused, 1);
});

test('a hidden view does no work; showing it refreshes', (t) => {
  const h = setup(t, { visible: false });
  h.view.render();
  h.view.noteCursor();
  h.flush();
  assert.equal(h.host.innerHTML, '', 'nothing painted while hidden');
  h.state.visible = true;
  h.view.render();
  assert.equal(h.rows().length, 6);
});

test('status rows: no file, an unsupported type, a too-large TS file, and the symbol cap note', async (t) => {
  const none = setup(t, { path: '' });
  none.view.render();
  assert.deepEqual(none.status(), ['No file is open. Open one to see its outline.']);
  assert.equal(none.host.querySelectorAll('[data-ide-outline-action]').length, 0);

  const rust = setup(t, { path: 'src/main.rs', text: 'fn main() {}', languageId: 'rust' });
  rust.view.render();
  assert.deepEqual(rust.status(), ['No outline for this file type.']);

  const ts = setup(t, { path: 'src/a.ts', text: 'const a = 1;', languageId: 'typescript', symbolNav: { getNavigationTree: async () => null } });
  ts.state.large = true;
  ts.view.render();
  assert.deepEqual(ts.status(), ['This file is too large for an outline.']);

  const yaml = Array.from({ length: 2005 }, (_, i) => `k${i}: 1`).join('\n');
  const big = setup(t, { path: 'big.yml', text: yaml, languageId: 'yaml' });
  big.view.render();
  assert.equal(big.rows().length, 2000);
  assert.deepEqual(big.status(), ['Showing the first 2,000 symbols.']);
  assert.equal(big.view.getSnapshot().truncated, 'symbols');
});

test('TS/JS use the symbol-nav navigation tree (no re-parse) and drop a stale answer', async (t) => {
  const src = 'class Greeter {\n  greet() {}\n}\n';
  const calls = [];
  const tree = {
    text: '"a"', kind: 'module', spans: [{ start: 0, length: src.length }],
    childItems: [{ text: 'Greeter', kind: 'class', spans: [{ start: 0, length: 28 }], nameSpan: { start: 6, length: 7 },
      childItems: [{ text: 'greet', kind: 'method', spans: [{ start: 18, length: 10 }] }] }],
  };
  const symbolNav = { getNavigationTree: async (path) => { calls.push(path); return tree; } };
  const h = setup(t, { path: 'src/a.ts', text: src, languageId: 'typescript', symbolNav, cursor: 2 });
  h.view.render();
  assert.deepEqual(h.status(), ['Loading symbols…']);
  h.view.noteCursor();
  h.flush();
  assert.deepEqual(calls, ['src/a.ts'], 'a cursor move while the request is in flight does not restart it');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.names(), ['Greeter', '  greet']);
  assert.equal(h.row('greet').classList.contains('ide-tree-row--active'), true);
  assert.equal(h.row('Greeter').title, 'Greeter (class, line 1)');
  h.view.noteCursor();
  h.flush();
  assert.deepEqual(calls, ['src/a.ts'], 'an unchanged model version asks the worker once');
  h.row('Greeter').click();
  assert.deepEqual(h.state.reveals.at(-1), ['src/a.ts', 1, 7], 'the name position');
});

test('switching files and committing a new root reset the view', (t) => {
  const h = setup(t);
  h.view.render();
  h.docs.set('tool.py', fakeModel('class A:\n    def run(self):\n        pass\n', 'python'));
  h.state.path = 'tool.py';
  h.window.dispatchEvent(new h.window.CustomEvent('ide:active-file-changed', { detail: { path: 'tool.py' } }));
  h.flush();
  assert.deepEqual(h.names(), ['A', '  run']);
  h.window.dispatchEvent(new h.window.CustomEvent('ide:workspace-root-committed'));
  h.state.path = '';
  h.view.render();
  assert.deepEqual(h.status(), ['No file is open. Open one to see its outline.']);
});

/* ---------------------------------------------------------------- layout, config, palette seams */

function withOutline(layout) {
  return ops.addView(layout, 'outline', 'explorer');
}

test('outline is an optional view: the default tree and fromLegacy/toLegacy are unchanged', () => {
  const fresh = model.createDefaultLayout();
  assert.equal(model.listViews(fresh).includes('outline'), false, 'not in the default tree');
  assert.equal(model.listViews(model.normalizeLayout(fresh)).includes('outline'), false, 'never re-homed');
  assert.equal(model.listViews(legacy.fromLegacy({})).includes('outline'), false);
  assert.deepEqual(model.OPTIONAL_VIEW_IDS, ['outline']);
  assert.equal(model.isCatalogView('outline'), true);

  const added = withOutline(fresh);
  const rail = model.findStack(added, model.findView(added, 'explorer').stackId);
  assert.deepEqual(rail.views, ['explorer', 'outline', 'search', 'source-control'], 'joins the Files stack, beside Files');
  assert.equal(rail.active, 'outline');
  assert.deepEqual(model.normalizeLayout(added), added, 'a persisted outline survives normalize as is');
  assert.equal(legacy.toLegacy(added).railPanel, 'explorer', 'the legacy mirror never names it');
  assert.deepEqual(legacy.toLegacy(added).panelLocations, legacy.toLegacy(fresh).panelLocations);
  assert.equal(withOutline(added), added, 'adding twice is a no-op');
});

test('the config schema keeps a persisted outline view (main-process normalize)', () => {
  const added = withOutline(model.createDefaultLayout());
  const out = normalizeWorkspaceIde({ workbenchLayout: added }).workbenchLayout;
  assert.equal(model.findView(out, 'outline').active, true);
});

test('palette: "Explorer: Focus on Outline View" adds the view, reveals it and focuses the list; "Outline: Collapse All"', () => {
  let layout = model.createDefaultLayout();
  const calls = [];
  const outline = { focus: () => calls.push('focus'), collapseAll: () => calls.push('collapse') };
  const registry = createIdeCommandRegistry();
  registerIdePaletteCommands(registry, {
    getOutlineView: () => outline,
    workbenchWiring: {
      listViews: () => model.listViews(layout),
      addView: (id, near) => { layout = ops.addView(layout, id, near); return true; },
    },
    showPanel: (id, options) => calls.push(`show:${id}:${options.focus}`),
  });
  const ctx = { activeView: 'ide' };
  const rows = registry.list({ ctx }).map((row) => row.label);
  assert.ok(rows.includes('Explorer: Focus on Outline View'));
  assert.ok(rows.includes('Outline: Collapse All'));
  registry.run('ide:focus-outline', ctx);
  assert.equal(model.findView(layout, 'outline').stackId, model.findView(layout, 'explorer').stackId);
  registry.run('ide:outline-collapse-all', ctx);
  assert.deepEqual(calls, ['show:outline:true', 'focus', 'show:outline:false', 'collapse']);
  assert.equal(model.listViews(layout).filter((id) => id === 'outline').length, 1);

  const bare = createIdeCommandRegistry();
  registerIdePaletteCommands(bare, {});
  assert.equal(bare.list({ ctx }).some((row) => row.id === 'ide:focus-outline'), false, 'no outline seam, no row');
});
