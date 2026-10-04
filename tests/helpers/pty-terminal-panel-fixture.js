'use strict';

/* Shared fixture for the PTY-terminal (xterm) panel tests. xterm cannot run
 * under jsdom, so the panel injects createTerminal/createFitAddon fakes (plain
 * objects that record calls) and a fake workspacePty bridge with manual
 * onData/onExit emitters. buildPanel(harness) mounts a panel onto the shared
 * jsdom harness window (ResizeObserver shim, optional deferred frames). */

const assert = require('node:assert/strict');

const {
  createIdePtyTerminalPanel,
} = require('../../renderer/features/renderer-ide-pty-terminal-panel');

function fakeTerminal() {
  const term = {
    cols: 80,
    rows: 24,
    opened: null,
    written: [],
    writtenLines: [],
    cleared: 0,
    disposed: 0,
    addons: [],
    _dataCb: null,
    open(el) { this.opened = el; },
    write(data) { this.written.push(data); },
    writeln(line) { this.writtenLines.push(line); },
    clear() { this.cleared += 1; },
    dispose() { this.disposed += 1; },
    loadAddon(addon) { this.addons.push(addon); },
    onData(cb) { this._dataCb = cb; return { dispose() {} }; },
    // test helper: simulate a user keystroke
    _type(data) { if (this._dataCb) this._dataCb(data); },
  };
  return term;
}

function fakeFit() {
  return { fits: 0, fit() { this.fits += 1; } };
}

// A fake workspacePty bridge recording calls, with manual onData/onExit emitters.
function fakePtyApi(spawnResult) {
  const dataListeners = [];
  const exitListeners = [];
  return {
    calls: { spawn: [], write: [], resize: [], kill: [] },
    unsubData: 0,
    unsubExit: 0,
    async spawn(dims) {
      this.calls.spawn.push(dims);
      return spawnResult !== undefined
        ? spawnResult
        : { ok: true, sessionId: 'pty-1', shell: 'pwsh', cwd: 'C:/ws', alreadyRunning: false };
    },
    async write(payload) { this.calls.write.push(payload); },
    async resize(payload) { this.calls.resize.push(payload); },
    async kill(payload) { this.calls.kill.push(payload); },
    onData(cb) { dataListeners.push(cb); const self = this; return () => { self.unsubData += 1; }; },
    onExit(cb) { exitListeners.push(cb); const self = this; return () => { self.unsubExit += 1; }; },
    emitData(p) { for (const cb of [...dataListeners]) cb(p); },
    emitExit(p) { for (const cb of [...exitListeners]) cb(p); },
  };
}

function buildPanel(harness, opts = {}) {
  const win = harness.dom.window;
  const mount = win.document.createElement('div');
  win.document.body.appendChild(mount);
  const errors = [];
  const logs = [];
  const term = opts.term || fakeTerminal();
  const fit = opts.fit || fakeFit();
  const api = opts.api || fakePtyApi(opts.spawnResult);
  const observers = [];
  // Shim ResizeObserver so the panel's resize-observe path is exercised.
  win.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.observed = null; this.disconnected = 0; observers.push(this); }
    observe(el) { this.observed = el; }
    disconnect() { this.disconnected += 1; }
  };
  // UIUX-035: when opts.deferFrames is set, requestAnimationFrame is faked to
  // hold callbacks until the test manually flushes them (deterministic,
  // no wall-clock) — the same pattern the legacy line panel's wide-055 test
  // uses to prove frame-coalescing without relying on a real animation frame.
  const frames = [];
  const deps = {
    getDom: () => ({}),
    getIde: () => ({}),
    getMountEl: () => mount,
    isActivePanel: () => true,
    showError: (message, meta) => errors.push({ message, meta }),
    toErrorMessage: (error, fallback) => String(error?.message || error || fallback || ''),
    appendClientLog: (level, code, data) => logs.push({ level, code, data }),
    getWorkspacePtyApi: () => api,
    createTerminal: (options) => { term.createOptions = options; return term; },
    createFitAddon: () => fit,
    windowRef: win,
  };
  if (opts.deferFrames) {
    deps.requestAnimationFrameImpl = (callback) => { frames.push(callback); return callback; };
    deps.cancelAnimationFrameImpl = (callback) => {
      const index = frames.indexOf(callback);
      if (index >= 0) frames.splice(index, 1);
    };
  }
  const panel = createIdePtyTerminalPanel(deps);
  const flushFrame = () => {
    const callback = frames.shift();
    assert.equal(typeof callback, 'function', 'a write-coalescing frame is scheduled');
    callback(0);
  };
  return {
    panel, mount, term, fit, api, errors, logs, observers, frames, flushFrame,
    pendingFrames: () => frames.length,
  };
}

module.exports = { fakeTerminal, fakeFit, fakePtyApi, buildPanel };
