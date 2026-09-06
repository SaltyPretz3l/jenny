'use strict';

/* W9 terminal rail panel: 4th activity-bar panel, explicit start (never
 * auto-spawn), Enter submits + echoes, onData appends ANSI-stripped output
 * via textContent, onExit reports, toolbar clear/signal/restart, and
 * scrollback survives panel switches. Shared jsdom harness. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createHarness,
  dispatchInput,
  settle,
} = require('./helpers/renderer-ide-harness');
const {
  createIdeTerminalPanel,
} = require('../renderer/features/renderer-ide-terminal-panel');

// Direct injected-fake panel (no markup): exercises startSession() session-state
// guards via call counters + isRunning(), independent of the jsdom controller.
function fakeTerminalApi(overrides = {}) {
  return {
    calls: { start: 0 },
    async start() {
      this.calls.start += 1;
      return overrides.startResult !== undefined
        ? overrides.startResult
        : { sessionId: 'term-1', shell: 'pwsh', cwd: 'C:/ws' };
    },
    async write() {},
    async signal() {},
    async kill() {},
    onData() { return () => {}; },
    onExit() { return () => {}; },
  };
}

function makeDirectPanel(opts = {}) {
  const errors = [];
  const logs = [];
  const api = opts.api || fakeTerminalApi(opts.apiOverrides);
  const panel = createIdeTerminalPanel({
    getDom: () => ({}),
    getIde: () => ({}),
    getMountEl: () => null,
    isActivePanel: () => false,
    getWorkspaceTerminalApi: () => api,
    showError: (message, meta) => errors.push({ message, meta }),
    appendClientLog: (level, code, data) => logs.push({ level, code, data }),
  });
  return { panel, api, errors, logs };
}

function makePaintFixture() {
  const frames = [];
  let dataListener = null;
  const nodes = [];
  const metrics = { fullReplacements: 0, appends: 0 };
  const pre = {
    dataset: {},
    scrollTop: 0,
    clientHeight: 20,
    get scrollHeight() { return this.textContent.length; },
    get firstChild() { return nodes[0] || null; },
    get textContent() { return nodes.map((node) => node.data).join(''); },
    set textContent(value) {
      metrics.fullReplacements += 1;
      nodes.length = 0;
      const text = String(value || '');
      if (text) nodes.push({ data: text, nodeValue: text });
    },
    appendChild(node) {
      metrics.appends += 1;
      nodes.push(node);
      return node;
    },
    removeChild(node) {
      const index = nodes.indexOf(node);
      if (index >= 0) nodes.splice(index, 1);
      return node;
    },
    querySelector() { return null; },
  };
  pre.ownerDocument = {
    createTextNode(value) {
      let data = String(value || '');
      return {
        get data() { return data; },
        set data(value) { data = String(value || ''); },
        get nodeValue() { return data; },
        set nodeValue(value) { data = String(value || ''); },
      };
    },
  };
  const status = { textContent: '', classList: { toggle() {} } };
  const mount = {
    querySelector(selector) {
      if (selector === '[data-ide-terminal-scrollback]') return pre;
      if (selector === '[data-ide-terminal-status]') return status;
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const api = {
    async start() { return { sessionId: 'term-paint', shell: 'pwsh', cwd: 'C:/ws' }; },
    onData(callback) { dataListener = callback; return () => {}; },
    onExit() { return () => {}; },
  };
  const panel = createIdeTerminalPanel({
    getMountEl: () => mount,
    isActivePanel: () => true,
    getWorkspaceTerminalApi: () => api,
    requestAnimationFrameImpl: (callback) => { frames.push(callback); return callback; },
    cancelAnimationFrameImpl: (callback) => {
      const index = frames.indexOf(callback);
      if (index >= 0) frames.splice(index, 1);
    },
  });
  return {
    panel,
    pre,
    metrics,
    emitData: (chunk, droppedBytes = 0) => dataListener?.({
      sessionId: 'term-paint', chunk, droppedBytes,
    }),
    flushFrame() {
      const callback = frames.shift();
      assert.equal(typeof callback, 'function', 'a paint frame is scheduled');
      callback(0);
    },
    pendingFrames: () => frames.length,
  };
}

// The terminal was re-homed from the rail into the bottom panel: open it on the
// Terminal tab and return the shared bottom-panel content host.
async function openTerminalPanel(harness) {
  await harness.controller.activateIde();
  await settle();
  harness.state.ui.ide.bottomPanelOpen = true;
  harness.state.ui.ide.bottomPanelActiveView = 'terminal';
  harness.controller.renderIde();
  await settle();
  return harness.getDom().ideBottomPanelContent;
}

function press(harness, element, key, init = {}) {
  element.dispatchEvent(new harness.dom.window.KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  }));
}

test('terminal panel renders stopped and never auto-spawns', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  assert.ok(panel.querySelector('.ide-terminal-panel'), 'panel structure rendered');
  const scrollback = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.equal(scrollback.getAttribute('role'), 'log');
  assert.equal(scrollback.getAttribute('aria-live'), 'polite');
  assert.equal(panel.querySelector('[data-ide-terminal-status]').textContent, 'stopped');
  assert.equal(harness.bridge.calls.terminalStart.length, 0, 'no auto-spawn');
});

test('wide-055: sustained terminal output coalesces and incrementally appends without full replacement', async () => {
  const fixture = makePaintFixture();
  fixture.panel.bindEvents();
  await fixture.panel.startSession();
  fixture.flushFrame();
  fixture.metrics.fullReplacements = 0;
  fixture.metrics.appends = 0;

  for (let index = 0; index < 200; index += 1) {
    fixture.emitData(`row-${index}\n`);
  }
  assert.equal(fixture.pendingFrames(), 1, 'one animation frame owns the producer burst');
  assert.equal(fixture.metrics.fullReplacements, 0, 'producer callbacks never replace the full pre');
  fixture.flushFrame();
  assert.equal(fixture.metrics.fullReplacements, 0, 'incremental paint preserves existing DOM/selection');
  assert.equal(fixture.metrics.appends, 1, 'the burst is appended once');
  assert.match(fixture.pre.textContent, /row-199/);

  fixture.metrics.appends = 0;
  for (let index = 0; index < 40; index += 1) fixture.emitData('x'.repeat(20 * 1024), 3);
  assert.equal(fixture.pendingFrames(), 1);
  fixture.flushFrame();
  assert.ok(fixture.pre.textContent.length <= 400 * 1024, 'rendered scrollback remains bounded');
  assert.ok(Number(fixture.pre.dataset.droppedChars) > 0, 'local ring eviction is explicit');
  assert.equal(Number(fixture.pre.dataset.droppedBytes), 120, 'service drop metadata is accumulated');
  assert.equal(fixture.metrics.fullReplacements, 0, 'cap enforcement trims the DOM head incrementally');
  assert.equal(fixture.metrics.appends, 1);
});

test('Enter starts the session, echoes the command, and writes CRLF', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'git status');
  press(harness, input, 'Enter');
  await settle();

  assert.equal(harness.bridge.calls.terminalStart.length, 1);
  assert.deepEqual(harness.bridge.calls.terminalWrite, [
    { sessionId: harness.bridge.terminalSessionId, data: 'git status\r\n' },
  ]);
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /> git status/);
  assert.equal(input.value, '', 'input cleared after submit');
  assert.equal(panel.querySelector('[data-ide-terminal-status]').textContent, 'running');
});

test('commands submitted while terminal startup is pending are queued and retain the newer input', async (t) => {
  let resolveStart;
  let startCalls = 0;
  const writes = [];
  const dom = new JSDOM('<div id="panel"></div>');
  t.after(() => dom.window.close());
  const mount = dom.window.document.getElementById('panel');
  const api = {
    start() {
      startCalls += 1;
      return new Promise((resolve) => { resolveStart = resolve; });
    },
    async write(payload) { writes.push(payload); },
    onData() { return () => {}; },
    onExit() { return () => {}; },
  };
  const terminal = createIdeTerminalPanel({
    getMountEl: () => mount,
    isActivePanel: () => true,
    getWorkspaceTerminalApi: () => api,
  });
  t.after(() => terminal.dispose());
  terminal.renderTerminalPanel();
  terminal.bindEvents();
  const input = mount.querySelector('[data-ide-terminal-input]');

  input.value = 'first';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.value = 'second';
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(startCalls, 1, 'concurrent submissions share one startup');
  assert.equal(input.value, 'second', 'the first pending submission cannot erase newer typing');

  resolveStart({ sessionId: 'term-queued', shell: 'pwsh', cwd: 'G:/ws' });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.deepEqual(writes.map((entry) => entry.data), ['first\r\n', 'second\r\n']);
  assert.equal(input.value, '', 'the submitted second command clears after it is written');
});

test('onData appends ANSI-stripped output as text; onExit reports the end', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'dir');
  press(harness, input, 'Enter');
  await settle();
  const sessionId = harness.bridge.terminalSessionId;

  const ESC = String.fromCharCode(27);
  harness.bridge.emitTerminalData({
    sessionId,
    stream: 'stdout',
    chunk: `${ESC}[32mREADME.md${ESC}[0m <b>not markup</b>\n`,
  });
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /README\.md <b>not markup<\/b>/, 'ANSI stripped, text kept verbatim');
  assert.equal(pre.querySelector('b'), null, 'output is textContent, never markup');

  harness.bridge.emitTerminalExit({ sessionId, code: 0, signal: '' });
  assert.match(pre.textContent, /session ended \(code 0\)/);
  assert.equal(panel.querySelector('[data-ide-terminal-status]').textContent, 'stopped');
});

test('UIUX-035: a BEL-terminated OSC does not swallow the real output that follows it', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'dir');
  press(harness, input, 'Enter');
  await settle();
  const sessionId = harness.bridge.terminalSessionId;

  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // ESC ] ... BEL is a complete OSC sequence (a window-title set, e.g.) — the
  // legacy per-chunk regex `ESC\][^ESC]*` has no BEL/ST awareness and keeps
  // consuming everything up to the NEXT escape byte, so at HEAD it swallows
  // "REAL OUTPUT" along with the OSC payload (RED at HEAD).
  harness.bridge.emitTerminalData({
    sessionId,
    stream: 'stdout',
    chunk: `${ESC}]0;window-title${BEL}REAL OUTPUT${ESC}[0m\n`,
  });
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /REAL OUTPUT/, 'content after a BEL-terminated OSC must survive, not be swallowed');
  assert.doesNotMatch(pre.textContent, /window-title/, 'the OSC payload itself is still stripped');
});

test('UIUX-035: a CSI sequence split across two chunks is still stripped, never leaked as literal escape/param text', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'dir');
  press(harness, input, 'Enter');
  await settle();
  const sessionId = harness.bridge.terminalSessionId;

  const ESC = String.fromCharCode(27);
  // The PTY write boundary has no relationship to escape-sequence boundaries:
  // split a CSI SGR sequence (ESC [ 3 2 m) across two separate chunks. A
  // stateless per-chunk regex cannot recognize either half (RED at HEAD:
  // chunk 1 leaks a raw ESC[ and chunk 2 leaks "32mBOLD" as literal text).
  harness.bridge.emitTerminalData({ sessionId, stream: 'stdout', chunk: `abc${ESC}[` });
  harness.bridge.emitTerminalData({ sessionId, stream: 'stdout', chunk: `32mBOLD${ESC}[0mEND\n` });
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /abcBOLDEND/, 'a CSI split across chunks is still recognized and stripped');
  assert.doesNotMatch(pre.textContent, /\[32m/, 'no raw CSI parameter text leaks through');
});

test('UIUX-035: an OSC terminator (BEL) split across two chunks is still recognized', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'dir');
  press(harness, input, 'Enter');
  await settle();
  const sessionId = harness.bridge.terminalSessionId;

  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  harness.bridge.emitTerminalData({ sessionId, stream: 'stdout', chunk: `${ESC}]0;title` });
  harness.bridge.emitTerminalData({ sessionId, stream: 'stdout', chunk: `${BEL}AFTER\n` });
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /AFTER/, 'output after a cross-chunk BEL terminator survives');
  assert.doesNotMatch(pre.textContent, /title/, 'the split OSC payload is still fully stripped');
  // RED at HEAD: chunk 1's greedy stateless match consumes to end-of-string
  // (no ESC left to stop at), so the BEL terminator that actually arrives at
  // the START of chunk 2 is never recognized as a terminator at all — it
  // leaks through as a raw, invisible control byte ahead of "AFTER".
  assert.ok(!pre.textContent.includes(BEL), 'no raw BEL control byte leaks into the rendered scrollback');
});

test('restart clears any mid-escape-sequence parser state (no leaked bytes from the prior session)', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'sleep 100');
  press(harness, input, 'Enter');
  await settle();
  const sessionId = harness.bridge.terminalSessionId;

  const ESC = String.fromCharCode(27);
  // Leave the parser mid-CSI (unterminated) right before Restart clears state.
  harness.bridge.emitTerminalData({ sessionId, stream: 'stdout', chunk: `pending${ESC}[` });

  panel.querySelector('[data-ide-terminal-action="restart"]').click();
  await settle();
  const newSessionId = harness.bridge.terminalSessionId;
  harness.bridge.emitTerminalData({ sessionId: newSessionId, stream: 'stdout', chunk: 'fresh\n' });
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /fresh/, 'the new session writes normally after a mid-escape restart');
  assert.doesNotMatch(pre.textContent, /pending/, 'restart clears scrollback, no leaked prior-session text');
});

test('toolbar clear empties scrollback; signal interrupts; restart respawns', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'sleep 100');
  press(harness, input, 'Enter');
  await settle();

  panel.querySelector('[data-ide-terminal-action="signal"]').click();
  await settle();
  assert.equal(harness.bridge.calls.terminalSignal.length, 1);
  assert.match(panel.querySelector('[data-ide-terminal-scrollback]').textContent, /\^C/);

  panel.querySelector('[data-ide-terminal-action="clear"]').click();
  assert.equal(panel.querySelector('[data-ide-terminal-scrollback]').textContent, '');

  panel.querySelector('[data-ide-terminal-action="restart"]').click();
  await settle();
  assert.equal(harness.bridge.calls.terminalKill.length, 1);
  assert.equal(harness.bridge.calls.terminalStart.length, 2);
});

test('startSession rejects an empty session id and stays stopped', async () => {
  const { panel, errors, logs } = makeDirectPanel({
    apiOverrides: { startResult: { sessionId: '', shell: 'pwsh', cwd: 'C:/ws' } },
  });
  const ok = await panel.startSession();
  assert.equal(ok, false, 'an empty session id is treated as a failed start');
  assert.equal(panel.isRunning(), false, 'running stays false (no phantom session)');
  assert.equal(errors.length, 1, 'the failure is surfaced once');
  assert.equal(errors[0].meta?.dedupeKey, 'ide:terminal:start');
  assert.ok(
    logs.some((l) => l.code === 'ide.terminal_start_no_session'),
    'a WARN diagnostic is logged'
  );
});

test('startSession with a valid session id reports running', async () => {
  const { panel } = makeDirectPanel();
  const ok = await panel.startSession();
  assert.equal(ok, true);
  assert.equal(panel.isRunning(), true, 'a real session id arms the running flag');
});

test('scrollback survives switching bottom-panel views and back', async (t) => {
  const harness = createHarness({ bridgeOptions: { files: { 'a.txt': '1' } } });
  t.after(() => harness.dispose());
  const panel = await openTerminalPanel(harness);
  const input = panel.querySelector('[data-ide-terminal-input]');
  dispatchInput(harness, input, 'echo hi');
  press(harness, input, 'Enter');
  await settle();
  harness.bridge.emitTerminalData({
    sessionId: harness.bridge.terminalSessionId,
    stream: 'stdout',
    chunk: 'hi\n',
  });

  // Switch the bottom panel to the Problems view, then back to Terminal: the
  // Terminal markup is replaced while away and its scrollback is restored on return.
  harness.state.ui.ide.bottomPanelActiveView = 'problems';
  harness.controller.renderIde();
  await settle();
  assert.equal(panel.querySelector('[data-ide-terminal-scrollback]'), null, 'problems view took the host');

  harness.state.ui.ide.bottomPanelActiveView = 'terminal';
  harness.controller.renderIde();
  await settle();
  const pre = panel.querySelector('[data-ide-terminal-scrollback]');
  assert.match(pre.textContent, /> echo hi/);
  assert.match(pre.textContent, /\bhi\n/);
});
