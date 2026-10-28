'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeChipPicker } = require('../renderer/features/renderer-ide-chip-picker');
const popover = require('../renderer/inventory/popover');
const actionButton = require('../renderer/inventory/action-button');
const { createHarness, settle } = require('./helpers/renderer-ide-harness');

function fakeEditorHost() {
  const state = { eol: 'lf', tabCalls: [], eolCalls: [] };
  return {
    state,
    getActivePath: () => 'a.js',
    getTabSize: () => 2,
    getEol: () => state.eol,
    setTabSize: (n) => { state.tabCalls.push(n); return true; },
    setEol: (p, e) => { state.eol = e; state.eolCalls.push([p, e]); return true; },
  };
}

function buildPicker(host) {
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  let renders = 0;
  const changes = [];
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
    onAfterChange: (change) => { renders += 1; changes.push(change); },
  });
  picker.initHandlers();
  return { picker, shell, anchor, getRenders: () => renders, changes };
}

test('chip-picker applies a tab-size pick and remembers it as the session default', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor, getRenders, changes } = buildPicker(host);

  picker.openTabSizePicker(anchor);
  const popEl = shell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the tab-size quick-pick opens');
  const options = [...popEl.querySelectorAll('[data-ide-chip-value]')];
  const sizes = options.map((b) => b.getAttribute('data-ide-chip-value'));
  assert.deepEqual(sizes, ['2', '4', '8']);

  // Single-select group: the host is a menu, options are menuitemradio, and
  // exactly the current value (2) is aria-checked - not aria-pressed toggles.
  assert.equal(popEl.getAttribute('role'), 'menu', 'popover host is a menu');
  assert.ok(options.every((b) => b.getAttribute('role') === 'menuitemradio'), 'options are menuitemradio');
  assert.ok(options.every((b) => !b.hasAttribute('aria-pressed')), 'no toggle-button semantics');
  assert.deepEqual(
    options.map((b) => b.getAttribute('aria-checked')),
    ['true', 'false', 'false'],
    'only the current tab size is checked',
  );

  popEl.querySelector('[data-ide-chip-value="4"]').click();
  assert.deepEqual(host.state.tabCalls, [4]);
  assert.deepEqual(changes.at(-1), { kind: 'tab-size', value: 4 });
  assert.equal(popEl.hidden, true, 'the popover closes after a pick');
  assert.ok(getRenders() >= 1, 'onAfterChange refreshes the statusbar');
});

test('chip-picker applies an EOL pick to the active file', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor, changes } = buildPicker(host);

  picker.openEolPicker(anchor);
  const popEl = shell.querySelector('.inv-popover');
  popEl.querySelector('[data-ide-chip-value="crlf"]').click();
  assert.deepEqual(host.state.eolCalls, [['a.js', 'crlf']]);
  assert.deepEqual(changes.at(-1), { kind: 'eol', value: 'crlf' });
});

test('chip-picker applies session defaults to newly opened files', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor } = buildPicker(host);

  picker.openTabSizePicker(anchor);
  shell.querySelector('[data-ide-chip-value="8"]').click();
  picker.openEolPicker(anchor);
  shell.querySelector('[data-ide-chip-value="crlf"]').click();

  host.state.tabCalls.length = 0;
  host.state.eolCalls.length = 0;
  picker.applyDefaults('b.js');
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['b.js', 'crlf']]);
});

test('chip-picker seedDefaults hydrates the session defaults from persisted prefs', () => {
  const host = fakeEditorHost();
  const { picker } = buildPicker(host);
  // Tier 2: persisted prefs seed the chip session defaults on activate/recreate.
  picker.seedDefaults({ tabSize: 8, eol: 'crlf' });
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['a.js', 'crlf']]);
  // null means "leave following the file" - no host calls, no session change.
  host.state.tabCalls.length = 0;
  host.state.eolCalls.length = 0;
  picker.seedDefaults({ tabSize: null, eol: null });
  assert.deepEqual(host.state.tabCalls, []);
  assert.deepEqual(host.state.eolCalls, []);
  picker.applyDefaults('b.js');
  assert.deepEqual(host.state.tabCalls, [8]);
  assert.deepEqual(host.state.eolCalls, [['b.js', 'crlf']]);
});

test('chip-picker passes the change payload to onAfterChange for persistence', () => {
  const host = fakeEditorHost();
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  const changes = [];
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
    onAfterChange: (change) => changes.push(change),
  });
  picker.initHandlers();
  picker.openTabSizePicker(anchor);
  shell.querySelector('[data-ide-chip-value="4"]').click();
  assert.deepEqual(changes.at(-1), { kind: 'tab-size', value: 4 });
});

test('chip-picker toggles the popover closed when the same chip is re-clicked', () => {
  const host = fakeEditorHost();
  const { picker, shell, anchor } = buildPicker(host);
  picker.openTabSizePicker(anchor);
  assert.equal(shell.querySelector('.inv-popover').hidden, false);
  picker.openTabSizePicker(anchor);
  assert.equal(shell.querySelector('.inv-popover').hidden, true);
});

// ── Integration through the controller + real statusbar/popover ──────────────

test('statusbar renders interactive indentation and EOL chips', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'x' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  const statusBar = harness.getDom().ideStatusBar;
  assert.ok(statusBar.querySelector('[data-ide-status-action="indentation"]'), 'indentation chip is a button');
  assert.ok(statusBar.querySelector('[data-ide-status-action="eol"]'), 'EOL chip is a button');
  assert.match(statusBar.textContent, /Spaces: 2/);
  assert.match(statusBar.textContent, /LF/);
});

test('clicking the EOL chip opens a quick-pick; choosing CRLF updates the chip', async (t) => {
  const harness = createHarness({
    bridgeOptions: { rootPath: 'G:/fake-root', files: { 'a.js': 'x' } },
  });
  t.after(() => harness.dispose());
  await harness.controller.activateIde();
  await harness.controller.openFile('a.js');
  await settle();

  harness.getDom().ideStatusBar.querySelector('[data-ide-status-action="eol"]').click();
  await settle();
  const popEl = harness.getDom().ideShell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the EOL quick-pick opens in the shell');

  popEl.querySelector('[data-ide-chip-value="crlf"]').click();
  await settle();
  assert.match(harness.getDom().ideStatusBar.textContent, /CRLF/, 'the chip reflects the new EOL');
});

// ── Row 82 slice S: language / indentation / encoding pickers + palette rows ──

const LANGUAGES = [
  { id: 'typescript', aliases: ['TypeScript', 'ts'] },
  { id: 'plaintext', aliases: ['Plain Text', 'text'] },
  { id: 'hidden-no-alias', aliases: [] },
  { id: 'no-aliases-field' },
  { id: 'javascript', aliases: ['JavaScript', 'js'] },
];

function openPopover(shell) {
  const popEl = shell.querySelector('.inv-popover');
  assert.ok(popEl && !popEl.hidden, 'the popover is open');
  return popEl;
}

function typeInto(input, value) {
  input.value = value;
  input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }));
}

test('openLanguagePicker lists Auto Detect first, then alias-bearing languages by label, current marked', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  const picks = [];
  picker.openLanguagePicker(anchor, { current: 'javascript', languages: LANGUAGES, onPick: (id) => picks.push(id) });
  const popEl = openPopover(shell);
  const rows = [...popEl.querySelectorAll('[data-ide-chip-kind="language"]')];
  assert.deepEqual(
    rows.map((row) => row.querySelector('.ide-chip-option-label').textContent),
    ['Auto Detect', 'JavaScript', 'Plain Text', 'TypeScript'],
    'no-alias entries are dropped, the rest sort by label',
  );
  assert.equal(rows[1].querySelector('.ide-chip-option-desc').textContent, 'javascript', 'description is the id');
  assert.equal(rows[0].getAttribute('data-ide-chip-value'), '');
  assert.deepEqual(rows.map((row) => row.getAttribute('aria-selected')), ['false', 'true', 'false', 'false']);
  assert.ok(rows[1].classList.contains('ide-chip-option--active'), 'the current language uses the selected styling');
  assert.ok(popEl.querySelector('[data-ide-chip-search]'), 'a search field is present');

  rows[3].click();
  assert.deepEqual(picks, ['typescript']);
  assert.equal(popEl.hidden, true, 'the popover closes after a pick');
});

test('openLanguagePicker Auto Detect picks null and the search filters by label, id and alias', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  const picks = [];
  picker.openLanguagePicker(anchor, { current: 'plaintext', languages: LANGUAGES, onPick: (id) => picks.push(id) });
  const popEl = openPopover(shell);
  const search = popEl.querySelector('[data-ide-chip-search]');
  const labels = () => [...popEl.querySelectorAll('[data-ide-chip-kind="language"] .ide-chip-option-label')].map((n) => n.textContent);

  typeInto(search, 'ts');
  assert.deepEqual(labels(), ['TypeScript'], 'matches the alias "ts"');
  typeInto(search, 'plain');
  assert.deepEqual(labels(), ['Plain Text']);
  typeInto(search, 'zzz');
  assert.deepEqual(labels(), []);
  assert.match(popEl.textContent, /No languages found/);
  typeInto(search, 'auto');
  popEl.querySelector('[data-ide-chip-kind="language"]').click();
  assert.deepEqual(picks, [null], 'Auto Detect reports null');
});

test('openLanguagePicker Enter in the search commits the first match', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  const picks = [];
  picker.openLanguagePicker(anchor, { current: '', languages: LANGUAGES, onPick: (id) => picks.push(id) });
  const popEl = openPopover(shell);
  const search = popEl.querySelector('[data-ide-chip-search]');
  typeInto(search, 'java');
  search.dispatchEvent(new search.ownerDocument.defaultView.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(picks, ['javascript']);
});

test('openIndentationPicker shows the source note and routes each row to one onPick payload', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  const picks = [];
  const open = () => picker.openIndentationPicker(anchor, {
    insertSpaces: true, tabSize: 4, source: 'editorconfig', onPick: (pick) => picks.push(pick),
  });
  open();
  let popEl = openPopover(shell);
  assert.match(popEl.querySelector('.ide-chip-note').textContent, /\.editorconfig/);
  const labels = [...popEl.querySelectorAll('[data-ide-chip-kind="indent"]')].map((b) => b.textContent);
  assert.deepEqual(labels, [
    'Indent Using Spaces', 'Indent Using Tabs', 'Change Tab Display Size',
    'Detect Indentation from Content', 'Convert Indentation to Spaces', 'Convert Indentation to Tabs',
  ]);
  const radios = [...popEl.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(radios.map((b) => b.getAttribute('aria-checked')), ['true', 'false'], 'spaces is current');

  const click = (value) => {
    popEl = shell.querySelector('.inv-popover');
    if (popEl.hidden) open();
    popEl.querySelector(`[data-ide-chip-kind="indent"][data-ide-chip-value="${value}"]`).click();
  };
  ['spaces', 'tabs', 'detect', 'convert-spaces', 'convert-tabs'].forEach(click);
  assert.deepEqual(picks, [
    { kind: 'spaces' }, { kind: 'tabs' }, { kind: 'detect' },
    { kind: 'convert', to: 'spaces' }, { kind: 'convert', to: 'tabs' },
  ]);
});

test('openIndentationPicker "Change Tab Display Size" opens the 1,2,3,4,6,8 list and picks a size', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  const picks = [];
  picker.openIndentationPicker(anchor, { insertSpaces: false, tabSize: 4, source: 'file', onPick: (pick) => picks.push(pick) });
  const popEl = openPopover(shell);
  assert.deepEqual(
    [...popEl.querySelectorAll('[role="menuitemradio"]')].map((b) => b.getAttribute('aria-checked')),
    ['false', 'true'],
    'tabs is current',
  );
  popEl.querySelector('[data-ide-chip-value="size"]').click();
  assert.equal(popEl.hidden, false, 'the size list replaces the menu inside the same popover');
  const sizes = [...popEl.querySelectorAll('[data-ide-chip-kind="indent-size"]')];
  assert.deepEqual(sizes.map((b) => b.getAttribute('data-ide-chip-value')), ['1', '2', '3', '4', '6', '8']);
  assert.deepEqual(sizes.map((b) => b.getAttribute('aria-checked')), ['false', 'false', 'false', 'true', 'false', 'false']);
  sizes[4].click();
  assert.deepEqual(picks, [{ kind: 'size', value: 6 }]);
  assert.equal(popEl.hidden, true);
});

test('openEncodingInfo is read-only: the encoding row plus one explanatory row', () => {
  const { picker, shell, anchor } = buildPicker(fakeEditorHost());
  picker.openEncodingInfo(anchor, { encoding: 'utf-8', bom: false });
  let popEl = openPopover(shell);
  const notes = [...popEl.querySelectorAll('.ide-chip-note')].map((n) => n.textContent);
  assert.deepEqual(notes, ['UTF-8', 'Jenny reads and saves files as UTF-8; re-encoding is not available.']);
  assert.equal(popEl.querySelectorAll('[data-ide-chip-value]').length, 0, 'nothing to pick');
  popEl.querySelector('.ide-chip-note').click();
  assert.equal(popEl.hidden, false, 'clicking a note does not close or act');

  picker.openEncodingInfo(anchor, { encoding: 'utf-8', bom: true }); // same chip: toggles closed
  assert.equal(popEl.hidden, true);
  picker.openEncodingInfo(anchor, { encoding: 'utf-8', bom: true });
  popEl = openPopover(shell);
  assert.equal(popEl.querySelector('.ide-chip-note').textContent, 'UTF-8 with BOM');
});

test('default pickers act on the editor host and refresh the status bar', async () => {
  const calls = [];
  const host = {
    ...fakeEditorHost(),
    getMonaco: () => ({ languages: { getLanguages: () => LANGUAGES } }),
    getFocusedLanguageId: () => 'javascript',
    getIndentInfo: () => ({ insertSpaces: true, tabSize: 4, source: 'default' }),
    getEncodingInfo: () => ({ encoding: 'utf-8', bom: true }),
    setLanguage: (...args) => calls.push(['setLanguage', ...args]),
    setIndent: (...args) => calls.push(['setIndent', ...args]),
    detectIndentation: (...args) => calls.push(['detect', ...args]),
    convertIndentation: (...args) => { calls.push(['convert', ...args]); return Promise.resolve(true); },
  };
  const dom = new JSDOM('<div id="ideShell"></div>');
  const shell = dom.window.document.getElementById('ideShell');
  const anchor = dom.window.document.createElement('button');
  shell.appendChild(anchor);
  let renders = 0;
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
    getIndentDefaults: () => ({ insertSpaces: false, tabSize: 8 }),
    requestStatusRender: () => { renders += 1; },
  });
  picker.initHandlers();

  picker.openLanguagePicker(anchor);
  assert.equal(shell.querySelectorAll('[data-ide-chip-kind="language"]').length, 4, 'Monaco languages read from the host');
  shell.querySelector('[data-ide-chip-value="typescript"]').click();
  picker.openLanguagePicker(anchor);
  shell.querySelector('[data-ide-chip-value=""]').click();
  assert.deepEqual(calls.slice(0, 2), [['setLanguage', 'a.js', 'typescript'], ['setLanguage', 'a.js', null]]);

  picker.openIndentationPicker(anchor);
  shell.querySelector('[data-ide-chip-value="tabs"]').click();
  picker.openIndentationPicker(anchor);
  shell.querySelector('[data-ide-chip-value="detect"]').click();
  picker.openIndentationPicker(anchor);
  shell.querySelector('[data-ide-chip-value="convert-tabs"]').click();
  await settle();
  assert.deepEqual(calls.slice(2), [
    ['setIndent', 'a.js', { insertSpaces: false, tabSize: 4, source: 'file' }],
    ['detect', 'a.js', { insertSpaces: false, tabSize: 8 }],
    ['convert', 'a.js', 'tabs'],
  ]);
  assert.ok(renders >= 5, 'each pick re-renders the status bar');
});

test('registerCommands registers the eight status-bar rows with ctx guards and the Ctrl+K M chord', () => {
  const { createIdeCommandRegistry } = require('../renderer/features/renderer-ide-command-registry');
  const { picker } = buildPicker(fakeEditorHost());
  const registry = createIdeCommandRegistry();
  const dispose = picker.registerCommands(registry);
  const ids = [
    'ide:change-language-mode', 'ide:change-eol', 'ide:indent-using-spaces', 'ide:indent-using-tabs',
    'ide:change-tab-display-size', 'ide:detect-indentation', 'ide:convert-indentation-to-spaces', 'ide:convert-indentation-to-tabs',
  ];
  const ctx = { activeView: 'ide', hasActiveFile: true, activeKind: 'file', isRepo: false, groupCount: 1, focused: 'editor' };
  const listed = registry.list({ ctx });
  assert.deepEqual(ids.filter((id) => !listed.some((row) => row.id === id)), [], 'all rows are listed for an active file');
  const labelOf = (id) => listed.find((row) => row.id === id).label;
  assert.equal(labelOf('ide:change-language-mode'), 'Change Language Mode');
  assert.equal(labelOf('ide:change-eol'), 'Change End of Line Sequence');
  assert.equal(labelOf('ide:detect-indentation'), 'Detect Indentation from Content');
  assert.equal(labelOf('ide:convert-indentation-to-tabs'), 'Convert Indentation to Tabs');
  assert.deepEqual(registry.bindings().filter((b) => ids.includes(b.id)), [{ chord: 'ctrl+k m', id: 'ide:change-language-mode' }]);

  const idsFor = (c) => registry.list({ ctx: c }).map((row) => row.id).filter((id) => ids.includes(id));
  assert.deepEqual(idsFor({ ...ctx, hasActiveFile: false }), [], 'hidden without a real file tab');
  assert.deepEqual(idsFor({ ...ctx, activeView: 'chat' }), [], 'hidden outside the IDE view');

  dispose();
  assert.deepEqual(idsFor(ctx), [], 'dispose unregisters every row');
});

test('palette rows open the pickers anchored on the status-bar chips and apply indentation directly', () => {
  const { createIdeCommandRegistry } = require('../renderer/features/renderer-ide-command-registry');
  const calls = [];
  const host = {
    ...fakeEditorHost(),
    getMonaco: () => ({ languages: { getLanguages: () => LANGUAGES } }),
    getIndentInfo: () => ({ insertSpaces: true, tabSize: 2, source: 'default' }),
    setIndent: (...args) => calls.push(['setIndent', ...args]),
    detectIndentation: (...args) => calls.push(['detect', ...args]),
  };
  const dom = new JSDOM('<div id="ideShell"><div id="ideStatusBar">'
    + '<button data-ide-status-action="language" aria-haspopup="dialog">js</button>'
    + '<button data-ide-status-action="indentation">Spaces: 2</button>'
    + '<button data-ide-status-action="eol">LF</button></div></div>');
  const doc = dom.window.document;
  const shell = doc.getElementById('ideShell');
  const picker = createIdeChipPicker({
    getDom: () => ({ ideShell: shell, ideStatusBar: doc.getElementById('ideStatusBar') }),
    editorHost: host,
    getActivePath: () => 'a.js',
    actionButton,
    popover,
  });
  picker.initHandlers();
  const registry = createIdeCommandRegistry();
  picker.registerCommands(registry);
  const ctx = { activeView: 'ide', hasActiveFile: true };

  registry.run('ide:change-language-mode', ctx);
  assert.ok(shell.querySelector('.inv-popover [data-ide-chip-kind="language"]'), 'the language picker opens');
  assert.equal(doc.querySelector('[data-ide-status-action="language"]').getAttribute('aria-expanded'), 'true', 'anchored on the language chip');

  registry.run('ide:indent-using-tabs', ctx);
  registry.run('ide:detect-indentation', ctx);
  assert.deepEqual(calls, [
    ['setIndent', 'a.js', { insertSpaces: false, tabSize: 2, source: 'file' }],
    ['detect', 'a.js', {}],
  ]);
  assert.equal(registry.run('ide:indent-using-tabs', { activeView: 'ide', hasActiveFile: false }), false, 'the guard blocks a run without a file');
});
