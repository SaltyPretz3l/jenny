'use strict';

/* Row 82 T1: the panel's terminal ergonomics wired through the xterm host
 * (file links, find bar, clipboard chords, scrollback, addons). xterm cannot
 * run under jsdom, so the term is the shared fake extended with the few APIs
 * the new modules call. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-ide-harness');
const { fakeTerminal, fakeFit, fakePtyApi, buildPanel } = require('./helpers/pty-terminal-panel-fixture');
const { createIdePtyTerminalPanel } = require('../renderer/features/renderer-ide-pty-terminal-panel');

function bufferTerminal() {
  const term = fakeTerminal();
  const lines = [];
  term.linkProviders = [];
  term.keyHandlers = [];
  term.selection = '';
  term.pasted = [];
  term.options = {};
  term.buffer = {
    active: {
      getLine(index) {
        const line = lines[index];
        return line ? { translateToString: () => line.text, isWrapped: line.wrapped === true } : undefined;
      },
    },
  };
  term.write = function write(data) {
    this.written.push(data);
    for (const part of String(data).split('\r\n')) {
      if (part) lines.push({ text: part });
    }
  };
  term.registerLinkProvider = function registerLinkProvider(provider) {
    this.linkProviders.push(provider);
    return { dispose() {} };
  };
  term.attachCustomKeyEventHandler = function attach(handler) { this.keyHandlers.push(handler); };
  term.hasSelection = function hasSelection() { return this.selection !== ''; };
  term.getSelection = function getSelection() { return this.selection; };
  term.clearSelection = function clearSelection() { this.selection = ''; };
  term.selectAll = function selectAll() { this.selectedAll = true; };
  term.paste = function paste(text) { this.pasted.push(text); };
  return term;
}

function provideLinks(provider, y) {
  let result;
  provider.provideLinks(y, (links) => { result = links; });
  return result;
}

test('T1: a file:line:col in PTY output becomes a link that opens the IDE editor on Ctrl+click', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const opened = [];
  win.addEventListener('ide:open-file-at-line', (event) => { opened.push(event.detail); event.preventDefault(); });
  const term = bufferTerminal();
  const { panel, api, flushFrame } = buildPanel(harness, {
    term,
    deferFrames: true,
    spawnResult: { ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws', alreadyRunning: false },
  });
  panel.renderTerminalPanel();
  await panel.startSession();

  api.emitData({ sessionId: 'pty-1', data: 'src/app.js:12:3\r\n' });
  flushFrame();

  assert.equal(term.linkProviders.length, 1, 'one file-link provider is registered per terminal');
  const links = provideLinks(term.linkProviders[0], 1);
  assert.equal(links.length, 1, 'exactly one link on the output line');
  assert.deepEqual(links[0].range, { start: { x: 1, y: 1 }, end: { x: 15, y: 1 } });

  links[0].activate({ ctrlKey: false, metaKey: false });
  assert.equal(opened.length, 0, 'a plain click keeps selecting text');
  links[0].activate({ ctrlKey: true });
  assert.deepEqual(opened, [{ path: 'src/app.js', line: 12, column: 3, preferIde: true }]);
});

// A panel with its own getIde / extra deps (the shared fixture pins getIde to {}).
function buildT1Panel(harness, { term = bufferTerminal(), ide = {}, extraDeps = {}, spawnResult } = {}) {
  const win = harness.dom.window;
  const mount = win.document.createElement('div');
  win.document.body.appendChild(mount);
  const api = fakePtyApi(spawnResult);
  const logs = [];
  const panel = createIdePtyTerminalPanel({
    getIde: () => ide,
    getMountEl: () => mount,
    isActivePanel: () => true,
    appendClientLog: (level, code, data) => logs.push({ level, code, data }),
    getWorkspacePtyApi: () => api,
    createTerminal: (options) => { term.createOptions = options; return term; },
    createFitAddon: () => fakeFit(),
    windowRef: win,
    ...extraDeps,
  });
  return { panel, mount, term, api, logs, win, ide };
}

test('T1: a file link resolves against the session cwd; a path outside it does not link', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const term = bufferTerminal();
  const { panel, api } = buildT1Panel(harness, { term });
  panel.renderTerminalPanel();
  await panel.startSession();
  api.emitData({ sessionId: 'pty-1', data: 'C:/ws/lib/x.js:5\r\nC:/other/y.js:6\r\n' });
  const provider = term.linkProviders[0];
  assert.equal(provideLinks(provider, 1).length, 1, 'under the spawn cwd (C:/ws)');
  assert.equal(provideLinks(provider, 2), undefined, 'outside the spawn cwd');
});

// Real-app gate finding (2026-10-26): the xterm host never handed the session cwd to the
// link provider, so a terminal opened on a sub-folder linked `./app.ts:10:5` against the root.
test('T1: a sub-folder session (Open in Terminal) links paths relative to its cwd, not the root', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const opened = [];
  win.addEventListener('ide:open-file-at-line', (event) => { opened.push(event.detail); event.preventDefault(); });
  const term = bufferTerminal();
  const { panel, api } = buildT1Panel(harness, {
    term,
    extraDeps: { getWorkspaceRootPath: () => 'C:/ws' },
    spawnResult: { ok: true, sessionId: 'pty-1', shell: 'bash', cwd: 'C:/ws/src', alreadyRunning: false },
  });
  panel.renderTerminalPanel();
  await panel.startSession({ cwd: 'src' });
  api.emitData({ sessionId: 'pty-1', data: './app.ts:10:5 farewell\r\n' });
  const links = provideLinks(term.linkProviders[0], 1);
  assert.equal(links?.length, 1, 'the relative path links');
  links[0].activate({ ctrlKey: true });
  assert.deepEqual(opened, [{ path: 'src/app.ts', line: 10, column: 5, preferIde: true }]);
});

test('T1: scrollback comes from the editor preference at creation and follows later changes', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const ide = { terminalScrollback: 5000 };
  const { panel, term } = buildT1Panel(harness, { ide });
  term.options = { scrollback: 5000 };
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(term.createOptions.scrollback, 5000);
  assert.equal(term.createOptions.allowProposedApi, true, 'search decorations need the proposed API');
  assert.equal(term.createOptions.minimumContrastRatio, 4.5);

  ide.terminalScrollback = 20000;
  panel.renderTerminalPanel();
  assert.equal(term.options.scrollback, 20000, 'a changed preference is applied to the live terminal');
  ide.terminalScrollback = 'garbage';
  panel.renderTerminalPanel();
  assert.equal(term.options.scrollback, 1000, 'a non-numeric value falls back to the default');
  ide.terminalScrollback = 5;
  panel.renderTerminalPanel();
  assert.equal(term.options.scrollback, 500, 'and a tiny one clamps up');
  ide.terminalScrollback = 100000; // D1: a stored pre-cleanup value clamps to the 25,000 ceiling
  panel.renderTerminalPanel();
  assert.equal(term.options.scrollback, 25000, 'a huge one clamps down to 25,000');
});

test('T1: the default scrollback is 1000 when no preference exists', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, term } = buildT1Panel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(term.createOptions.scrollback, 1000);
});

test('T1: the search and web-links addons load next to the fit addon; a missing or throwing one only degrades', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const handlers = [];
  class SearchStub {}
  class LinksStub { constructor(handler) { handlers.push(handler); } }
  const first = buildT1Panel(harness, { extraDeps: { createSearchAddon: () => new SearchStub(), createWebLinksAddon: (handler) => new LinksStub(handler) } });
  first.panel.renderTerminalPanel();
  await first.panel.startSession();
  assert.equal(first.term.addons.length, 3, 'fit + search + web links');
  assert.ok(first.term.addons[1] instanceof SearchStub);
  assert.ok(first.term.addons[2] instanceof LinksStub);
  assert.equal(typeof handlers[0], 'function', 'the web-links addon got an activation handler');

  const opened = [];
  first.win.open = (...args) => opened.push(args);
  handlers[0]({ ctrlKey: false }, 'https://example.com');
  handlers[0]({ ctrlKey: true }, 'https://example.com');
  handlers[0]({ ctrlKey: true }, 'javascript:alert(1)');
  assert.deepEqual(opened, [['https://example.com', '_blank', 'noopener,noreferrer']]);

  const throwing = buildT1Panel(harness, { extraDeps: { createSearchAddon: () => { throw new Error('no search'); } } });
  throwing.panel.renderTerminalPanel();
  await throwing.panel.startSession();
  assert.equal(throwing.panel.isRunning(), true, 'the terminal still starts');
  assert.ok(throwing.logs.some((entry) => entry.code === 'ide.pty_ignored_error' && entry.data.site === 'load_search_addon'));

  const bare = buildT1Panel(harness);
  bare.panel.renderTerminalPanel();
  await bare.panel.startSession();
  assert.equal(bare.term.addons.length, 1, 'no addon globals under jsdom -> only fit');
  assert.equal(bare.logs.filter((entry) => entry.code === 'ide.pty_ignored_error').length, 0, 'a missing addon global is silent');
});

test('T1: the panel markup carries a hidden find host between the toolbar and the xterm mount', (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount } = buildT1Panel(harness);
  panel.renderTerminalPanel();
  const children = [...mount.querySelector('.ide-terminal-panel').children].map((el) => el.className);
  assert.deepEqual(children, ['ide-terminal-toolbar', 'ide-terminal-find', 'ide-terminal-xterm']);
  assert.equal(mount.querySelector('[data-ide-terminal-find]').hidden, true);
});

test('T1: the custom key handler routes find and clipboard chords and leaves other keys to xterm', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const written = [];
  const { panel, mount, term, win } = buildT1Panel(harness, {
    extraDeps: { createSearchAddon: () => ({ findNext: () => true, findPrevious: () => true, clearDecorations() {} }) },
  });
  win.jennyShell = { clipboard: { writeText: (text) => { written.push(text); return Promise.resolve(); }, readText: () => Promise.resolve('clip') } };
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.equal(term.keyHandlers.length, 1);
  const handler = term.keyHandlers[0];
  const key = (init) => ({ type: 'keydown', preventDefault() {}, ...init });

  assert.equal(handler(key({ key: 'a' })), true, 'an ordinary key stays with xterm');
  assert.equal(handler(key({ key: 'f', ctrlKey: true })), false, 'Ctrl+F is the find bar');
  assert.equal(mount.querySelector('[data-ide-terminal-find]').hidden, false, 'the bar is open');
  assert.equal(win.document.activeElement, mount.querySelector('[data-ide-terminal-find-input]'));
  assert.equal(handler(key({ key: 'Escape' })), false, 'Esc closes the open bar');
  assert.equal(mount.querySelector('[data-ide-terminal-find]').hidden, true);
  assert.equal(handler(key({ key: 'Escape' })), true, 'and belongs to the shell when the bar is closed');

  term.selection = 'sel';
  assert.equal(handler(key({ key: 'C', ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+C copies');
  assert.deepEqual(written, ['sel']);
  assert.equal(handler(key({ key: 'c', ctrlKey: true })), false, 'Ctrl+C with a selection copies and clears');
  assert.equal(term.selection, '');
  assert.equal(handler(key({ key: 'c', ctrlKey: true })), true, 'Ctrl+C with no selection is ^C');
  assert.equal(handler(key({ key: 'v', ctrlKey: true })), false, 'Ctrl+V pastes');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(term.pasted, ['clip']);
});

test('T1: the context menu Clear runs the panel clearTerminal; Select All selects', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, win } = buildT1Panel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  const xtermMount = mount.querySelector('[data-ide-pty-mount]');
  const open = () => xtermMount.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const item = (label) => [...win.document.querySelectorAll('.inv-context-menu-item')].find((el) => el.textContent.startsWith(label));
  open();
  assert.equal(item('Copy').disabled, true, 'no selection yet');
  item('Clear').click();
  assert.equal(term.cleared, 1);
  open();
  item('Select All').click();
  assert.equal(term.selectedAll, true);
});

test('T1: the theme maps the ANSI palette and selection tokens only when they resolve', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const tokens = {
    '--bg-base': '#101010',
    '--ide-terminal-ansi-red': '#aa0000',
    '--ide-terminal-ansi-bright-cyan': '#00ffff',
    '--ide-terminal-selection': '#334455',
  };
  const { panel, term, win } = buildT1Panel(harness);
  win.getComputedStyle = () => ({ getPropertyValue: (name) => tokens[name] || '' });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.deepEqual(term.options.theme, {
    background: '#101010',
    selectionBackground: '#334455',
    red: '#aa0000',
    brightCyan: '#00ffff',
  });
  assert.equal(term.createOptions.minimumContrastRatio, 4.5, 'the contrast floor stays');
});

test('T1: terminalScrollback is an integer clamped to 500..25000 in the renderer state (D1)', () => {
  const state = require('../renderer/features/renderer-ide-state');
  const scrollbackOf = (value) => state.applyPersistedState(state.createIdeUiState(), { terminalScrollback: value }).terminalScrollback;
  assert.equal(scrollbackOf(undefined), 1000);
  assert.equal(scrollbackOf(2500.7), 2500);
  assert.equal(scrollbackOf('4000'), 4000);
  assert.equal(scrollbackOf(1), 500);
  assert.equal(scrollbackOf(100000), 25000, 'a stored pre-D1 value clamps on load');
  assert.equal(scrollbackOf(9e9), 25000);
  for (const bad of ['abc', '', null, NaN, true, {}, []]) {
    assert.equal(scrollbackOf(bad), 1000, `non-numeric ${JSON.stringify(bad)} -> 1000`);
  }
});

test('T1: openFind and clear (palette rows) are no-ops before Start and act on a live terminal', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount } = buildT1Panel(harness, { extraDeps: { createSearchAddon: () => ({ findNext: () => true, findPrevious: () => true, clearDecorations() {}, activate() {}, dispose() {} }) } });
  panel.renderTerminalPanel();
  assert.equal(panel.openFind(), false, 'no terminal yet: nothing to search');
  await panel.startSession();
  assert.equal(panel.openFind(), true);
  assert.equal(mount.querySelector('[data-ide-terminal-find]').hidden, false, 'the find bar opened');
  assert.doesNotThrow(() => panel.clear());
});
