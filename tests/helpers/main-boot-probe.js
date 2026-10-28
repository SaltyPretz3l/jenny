'use strict';

// Child-process probe for tests/main-boot-order.test.js: evaluates the real
// main.js as Electron would (process.versions.electron set, autostart on) with
// a recording Electron stub, then prints one JSON line and exits.
//   node main-boot-probe.js <primary|second|preload-fail> <userDataDir>
// primary:      reports the event order up to the 'main-sync-init-end' mark,
//               before systemStats or the backend start anything.
// second:       requestSingleInstanceLock() refuses; reports the exit.
// preload-fail: the dev preload check fails; reports the error box and exit.

const Module = require('module');
const path = require('path');

const [mode, userDataDir] = process.argv.slice(2);
const ROOT = path.resolve(__dirname, '..', '..');
const moduleCountAtStart = Object.keys(require.cache).length;
const events = [];
let windowTickEnded = false;

function finish(extra) {
  const line = JSON.stringify({
    events,
    modulesLoaded: Object.keys(require.cache).length - moduleCountAtStart,
    ...extra,
  });
  process.stdout.write(`${line}\n`);
  // Skip main.js's emergency exit handlers: nothing was spawned.
  process.removeAllListeners('exit');
  process.exit(0);
}

function stub() {
  const fn = function () { return stub(); };
  return new Proxy(fn, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === 'then') return undefined;
      if (key === 'isSupported' || key === 'isEncryptionAvailable' || key === 'isDestroyed') return () => false;
      if (key === 'getAllDisplays' || key === 'getAllWindows') return () => [];
      if (key === 'getPrimaryDisplay') {
        return () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } });
      }
      return stub();
    },
    apply: () => stub(),
  });
}

const app = new Proxy({}, {
  get: (_target, key) => {
    if (key === 'isPackaged') return false;
    if (key === 'getPath') return () => userDataDir;
    if (key === 'getAppPath') return () => ROOT;
    if (key === 'getVersion') return () => '0.0.0-probe';
    if (key === 'getLocale') return () => 'en-US';
    if (key === 'requestSingleInstanceLock') {
      return () => { events.push('lock'); return mode !== 'second'; };
    }
    if (key === 'quit') return () => events.push('quit');
    if (key === 'exit') return (code) => finish({ exitCode: code });
    if (key === 'whenReady') return () => { events.push('when-ready'); return Promise.resolve(); };
    return stub();
  },
});

const ipcMain = {
  handle: () => events.push(windowTickEnded ? 'handle-after-yield' : 'handle'),
  on: () => {},
  once: () => {},
  off: () => {},
  removeHandler: () => {},
  removeListener: () => {},
  removeAllListeners: () => {},
};

function BrowserWindow() {
  events.push('window');
  queueMicrotask(() => { windowTickEnded = true; });
  return stub();
}
BrowserWindow.getAllWindows = () => [];

const dialog = new Proxy({}, {
  get: (_target, key) => (key === 'showErrorBox'
    ? (title, message) => events.push(`error-box:${title}:${message}`)
    : stub()),
});

const electron = new Proxy({}, {
  get: (_target, key) => ({ app, ipcMain, BrowserWindow, dialog })[key] || stub(),
});

const originalLoad = Module._load;
Module._load = function probeLoad(request) {
  if (request === 'electron') return electron;
  if (/desktop-shortcut$/.test(request)) {
    return { ensureDesktopShortcut() {}, ensureDevStartMenuShortcut() {}, resolveAppUserModelId: () => 'probe' };
  }
  if (mode === 'preload-fail' && /dev-preload-bundle$/.test(request)) {
    return { ensureDevPreloadBundle: () => ({ status: 'failed', detail: 'probe build failed' }) };
  }
  const loaded = originalLoad.apply(this, arguments);
  if (/window-exit-guard$/.test(request) && loaded.createWindowExitGuard) {
    return {
      ...loaded,
      createWindowExitGuard: (options) => {
        const guard = loaded.createWindowExitGuard(options);
        const attach = guard.attach;
        guard.attach = (windowRef) => { events.push('exit-guard-attached'); return attach(windowRef); };
        return guard;
      },
    };
  }
  if (/startup-audit$/.test(request) && loaded.createStartupAudit) {
    return {
      ...loaded,
      createStartupAudit: (options) => {
        const audit = loaded.createStartupAudit(options);
        const emit = audit.emitStartupAuditMark;
        audit.emitStartupAuditMark = (name, details) => {
          if (name === 'main-sync-init-end') finish({ syncEndReached: true });
          return emit(name, details);
        };
        return audit;
      },
    };
  }
  return loaded;
};

Object.defineProperty(process.versions, 'electron', { value: '0.0.0-probe' });
process.env.JENNY_USER_DATA_DIR = userDataDir;
if (mode !== 'preload-fail') process.env.JENNY_PRELOAD_BUNDLE_CHECKED = '1';
delete process.env.JENNY_SKIP_MAIN_AUTOSTART;
delete process.env.JENNY_COLD_START_AUDIT;

require(path.join(ROOT, 'main.js'));
// Reached only when main.js neither exited nor scheduled anything that finishes.
if (mode === 'primary') setTimeout(() => finish({ fellThrough: true }), 30_000);
else setImmediate(() => finish({ fellThrough: true }));
