'use strict';

/* Workspace-panel bug pass (S3): #10 re-theme + mono font, #11 size-change-only
 * fit/resize, #14 focus after Start, #16 clean slate on a workspace-root switch. */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, settle } = require('./helpers/renderer-ide-harness');
const { fakeTerminal, buildPanel } = require('./helpers/pty-terminal-panel-fixture');

function stubComputedStyle(win, tokens) {
  win.getComputedStyle = () => ({ getPropertyValue: (name) => tokens[name] || '' });
}

test('#11: repeated renders at an unchanged host size neither re-fit nor send a PTY resize', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, fit, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  panel.renderTerminalPanel(); // first render after Start measures the host once
  const fitsBefore = fit.fits;
  for (let i = 0; i < 5; i += 1) panel.renderTerminalPanel();
  assert.equal(fit.fits, fitsBefore, 'no fit per render when the host size is unchanged');
  assert.deepEqual(api.calls.resize, [], 'no resize IPC: the PTY already has the spawn size');

  // A real host size change re-fits once; unchanged cols/rows still send nothing.
  const xtermHost = mount.querySelector('[data-ide-pty-mount]');
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 640 });
  panel.renderTerminalPanel();
  panel.renderTerminalPanel();
  assert.equal(fit.fits, fitsBefore + 1, 'exactly one fit for one host size change');
  assert.deepEqual(api.calls.resize, [], 'same cols/rows after the fit: no resize IPC');
});

test('#11: a fit that changes cols/rows sends exactly one resize for the new size', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, fit, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  fit.fit = () => { fit.fits += 1; term.cols = 120; term.rows = 30; };
  const xtermHost = mount.querySelector('[data-ide-pty-mount]');
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 900 });
  panel.renderTerminalPanel();
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 901 });
  panel.renderTerminalPanel();
  assert.deepEqual(api.calls.resize, [{ sessionId: 'pty-1', cols: 120, rows: 30 }]);
});

test('#10: Start applies the palette theme and the app mono font; a palette switch re-themes the live terminal', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const tokens = {
    '--bg-base': '#111111', '--text-secondary': '#cccccc', '--accent': '#ff8800',
    '--font-family-mono': '"Cascadia Code", monospace',
  };
  stubComputedStyle(win, tokens);
  const term = fakeTerminal();
  term.options = {};
  const { panel } = buildPanel(harness, { term });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.deepEqual(term.options.theme, { background: '#111111', foreground: '#cccccc', cursor: '#ff8800' });
  assert.equal(term.options.fontFamily, '"Cascadia Code", monospace', 'xterm uses --font-family-mono');
  assert.equal(term.options.fontSize, 13, 'xterm uses the code role size (13px at Text size Default)');

  tokens['--bg-base'] = '#fafafa';
  tokens['--text-secondary'] = '#222222';
  win.document.documentElement.setAttribute('data-palette', 'paper');
  await settle();
  assert.deepEqual(term.options.theme, { background: '#fafafa', foreground: '#222222', cursor: '#ff8800' },
    'the palette switch re-themed xterm without a Restart');

  tokens['--font-family-mono'] = '"JetBrains Mono", monospace';
  win.document.documentElement.setAttribute('data-typography', 'alt');
  await settle();
  assert.equal(term.options.fontFamily, '"JetBrains Mono", monospace', 'a typography switch re-fonts xterm');

  panel.dispose();
  tokens['--bg-base'] = '#000000';
  win.document.documentElement.setAttribute('data-palette', 'after-dispose');
  await settle();
  assert.equal(term.options.theme.background, '#fafafa', 'the palette observer is disconnected on dispose');
});

test('#14: pressing Start focuses the terminal once the session is ready', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const term = fakeTerminal();
  term.focused = 0;
  term.focus = function focus() { this.focused += 1; };
  const { panel, mount, api } = buildPanel(harness, { term });
  panel.renderTerminalPanel();
  panel.bindEvents();
  mount.querySelector('[data-ide-terminal-action="start"]').click();
  await settle();
  assert.equal(api.calls.spawn.length, 1);
  assert.equal(term.focused, 1, 'xterm focused after the spawn resolved');
});

test('#14: focusTerminal falls back to the Start button before any session exists', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount } = buildPanel(harness);
  panel.renderTerminalPanel();
  assert.equal(panel.focusTerminal(), true);
  assert.equal(harness.dom.window.document.activeElement, mount.querySelector('[data-ide-terminal-action="start"]'));
});

test('#16: a workspace-root commit clears the old scrollback and returns to the pre-Start state', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const term = fakeTerminal();
  term.resets = 0;
  term.reset = function reset() { this.resets += 1; };
  const { panel, mount, api, pendingFrames } = buildPanel(harness, { term, deferFrames: true });
  panel.renderTerminalPanel();
  await panel.startSession();
  api.emitData({ sessionId: 'pty-1', data: 'old workspace output' });
  assert.equal(pendingFrames(), 1, 'old-root output is queued for the next frame');
  assert.equal(panel.isRunning(), true);

  win.dispatchEvent(new win.CustomEvent('ide:workspace-root-committed', { detail: { context: { rootPath: 'D:/other' } } }));
  assert.equal(term.resets, 1, 'the xterm buffer is reset');
  assert.equal(panel.isRunning(), false);
  assert.deepEqual(api.calls.kill, [{ sessionId: 'pty-1' }], 'the renderer never loses track of a live session');
  assert.equal(mount.querySelector('[data-ide-terminal-status]').textContent, 'stopped', 'status back to the pre-Start state');

  // Main's exit for the killed session arrives late: no "session ended" banner lands in the new root.
  api.emitExit({ sessionId: 'pty-1', exitCode: 1 });
  assert.deepEqual(term.writtenLines, [], 'no stale session-ended line after the reset');
  assert.equal(pendingFrames(), 0, 'the pending flush frame was cancelled');
  assert.equal(term.written.join(''), '', 'queued old-root output never flushes after the reset');

  // The new root starts clean with an explicit Start.
  assert.equal(await panel.startSession(), true);
  assert.equal(api.calls.spawn.length, 2);
});

test('#16: dispose stops listening for root commits', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const term = fakeTerminal();
  term.resets = 0;
  term.reset = function reset() { this.resets += 1; };
  const { panel } = buildPanel(harness, { term });
  panel.renderTerminalPanel();
  await panel.startSession();
  panel.dispose();
  win.dispatchEvent(new win.CustomEvent('ide:workspace-root-committed', { detail: {} }));
  assert.equal(term.resets, 0);
});

test('#11 (Astra review): a failed or refused resize is retried on the next size notification', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const { panel, mount, term, fit, api } = buildPanel(harness);
  panel.renderTerminalPanel();
  await panel.startSession();
  let refuse = true;
  const record = api.resize.bind(api);
  api.resize = async (payload) => { await record(payload); return refuse ? { ok: false, code: 'resize_failed' } : { ok: true }; };
  fit.fit = () => { fit.fits += 1; term.cols = 120; term.rows = 30; };
  const xtermHost = mount.querySelector('[data-ide-pty-mount]');
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 900 });
  panel.renderTerminalPanel();
  await settle(5);
  refuse = false;
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 901 });
  panel.renderTerminalPanel(); // same 120x30 cells: only a forgotten cache sends it again
  await settle(5);
  assert.deepEqual(api.calls.resize, [
    { sessionId: 'pty-1', cols: 120, rows: 30 },
    { sessionId: 'pty-1', cols: 120, rows: 30 },
  ], 'the refused size is re-sent once');
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 902 });
  panel.renderTerminalPanel();
  await settle(5);
  assert.equal(api.calls.resize.length, 2, 'an applied size is not re-sent');
});

test('#11 (Astra review): attaching to an already-running PTY sends the corrective resize', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const term = fakeTerminal();
  term.cols = 120;
  term.rows = 30;
  const { panel, api } = buildPanel(harness, {
    term,
    spawnResult: { ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws', alreadyRunning: true },
  });
  panel.renderTerminalPanel();
  await panel.startSession();
  assert.deepEqual(api.calls.resize, [{ sessionId: 'pty-1', cols: 120, rows: 30 }],
    'the existing PTY (not resized by spawn) receives the renderer size');
});

test('NF1 (live re-check): a palette switch while the Workspace is hidden defers the refit to the next visible render', async (t) => {
  const harness = createHarness();
  t.after(() => harness.dispose());
  const win = harness.dom.window;
  const tokens = { '--bg-base': '#111111', '--text-secondary': '#cccccc', '--accent': '#ff8800', '--font-family-mono': 'monospace' };
  stubComputedStyle(win, tokens);
  const term = fakeTerminal();
  term.options = {};
  const { panel, mount, fit } = buildPanel(harness, { term });
  panel.renderTerminalPanel();
  await panel.startSession();
  const xtermHost = mount.querySelector('[data-ide-pty-mount]');
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(xtermHost, 'clientHeight', { configurable: true, value: 300 });
  panel.renderTerminalPanel();
  const fitsShown = fit.fits;
  // The Workspace is hidden (display:none): the host measures 0x0.
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 0 });
  Object.defineProperty(xtermHost, 'clientHeight', { configurable: true, value: 0 });
  tokens['--bg-base'] = '#fafafa';
  win.document.documentElement.setAttribute('data-palette', 'paper');
  await settle();
  assert.equal(term.options.theme.background, '#fafafa', 'the theme still applies while hidden');
  assert.equal(fit.fits, fitsShown, 'no fit against a 0x0 host (it collapsed xterm to two columns)');
  // Back in the Workspace: the next render re-fits once at the real size.
  Object.defineProperty(xtermHost, 'clientWidth', { configurable: true, value: 640 });
  Object.defineProperty(xtermHost, 'clientHeight', { configurable: true, value: 300 });
  panel.renderTerminalPanel();
  assert.equal(fit.fits, fitsShown + 1, 'the deferred refit runs on the first visible render');
  panel.renderTerminalPanel();
  assert.equal(fit.fits, fitsShown + 1, 'and only once');
});
