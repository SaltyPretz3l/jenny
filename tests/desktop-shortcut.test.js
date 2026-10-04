const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const {
  APP_USER_MODEL_ID,
  DEV_APP_USER_MODEL_ID,
  DEV_LAUNCHER_NAME,
  DEV_START_MENU_SHORTCUT_NAME,
  DEV_TOAST_ACTIVATOR_CLSID,
  buildDesktopShortcutOptions,
  buildDevStartMenuShortcutDetails,
  ensureDesktopShortcut,
  ensureDevStartMenuShortcut,
  getDevLauncherPath,
  resolveAppUserModelId,
  LEGACY_WINDOWS_SHORTCUT_NAME,
  WINDOWS_SHORTCUT_NAME,
} = require('../services/desktop-shortcut');

test('desktop shortcut options target the Windows launcher wrapper in development', () => {
  const appRoot = 'C:\\dev\\jenny-test-builds';
  const execPath = 'C:\\dev\\jenny-test-builds\\node_modules\\electron\\dist\\electron.exe';
  const { details } = buildDesktopShortcutOptions({
    appRoot,
    execPath,
    isPackaged: false,
  });

  assert.equal(details.target, getDevLauncherPath(appRoot));
  assert.equal(details.target, path.join(appRoot, DEV_LAUNCHER_NAME));
  assert.equal(details.args, '');
  assert.equal(details.cwd, appRoot);
  assert.equal(details.icon, path.join(appRoot, 'build', 'icon.ico'));
  assert.equal(details.appUserModelId, DEV_APP_USER_MODEL_ID);
});

test('unpackaged runs use a separate app identity from the installed app', () => {
  assert.equal(resolveAppUserModelId({ isPackaged: true }), APP_USER_MODEL_ID);
  assert.equal(resolveAppUserModelId({ isPackaged: false }), DEV_APP_USER_MODEL_ID);
  assert.notEqual(DEV_APP_USER_MODEL_ID, APP_USER_MODEL_ID);
});

test('desktop shortcut options omit dot-args for packaged app launches', () => {
  const execPath = 'C:\\Program Files\\Jenny\\Jenny.exe';
  const { details } = buildDesktopShortcutOptions({
    appRoot: 'C:\\ignored',
    execPath,
    isPackaged: true,
  });

  assert.equal(details.target, execPath);
  assert.equal(details.args, '');
  assert.equal(details.cwd, path.dirname(execPath));
  assert.equal(details.icon, execPath);
});

test('development desktop launcher enables the bounded subagent batch gate', () => {
  const launcher = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'dev', 'launch-jenny-dev.ps1'),
    'utf8'
  );

  assert.match(launcher, /\$env:JENNY_ENABLE_SUBAGENT_BATCH\s*=\s*'1'/);
});

test('desktop shortcut repair creates or overwrites the Windows desktop shortcut', () => {
  const calls = [];
  const entries = [];
  const result = ensureDesktopShortcut({
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'desktop');
      return 'C:\\Users\\example\\Desktop';
      },
      getAppUserModelId() {
        return '';
      },
    },
    shell: {
      writeShortcutLink(shortcutPath, operation, details) {
        calls.push({ shortcutPath, operation, details });
        return true;
      },
    },
    logger(level, event, details) {
      entries.push({ level, event, details });
    },
    platform: 'win32',
    execPath: 'C:\\dev\\jenny-test-builds\\node_modules\\electron\\dist\\electron.exe',
    appRoot: 'C:\\dev\\jenny-test-builds',
  });

  assert.deepEqual(result, {
    ok: true,
    shortcutPath: 'C:\\Users\\example\\Desktop\\Jenny (Dev).lnk',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shortcutPath, 'C:\\Users\\example\\Desktop\\Jenny (Dev).lnk');
  assert.equal(calls[0].operation, 'create');
  assert.equal(calls[0].details.target.endsWith(DEV_LAUNCHER_NAME), true);
  assert.equal(calls[0].details.args, '');
  assert.equal(entries[0].event, 'shortcut.desktop_ready');
});

test('desktop shortcut reports a bounded failure when read-back verification mismatches', () => {
  const events = [];
  const result = ensureDesktopShortcut({
    app: {
      isPackaged: true,
    getPath: () => 'C:\\Users\\example\\Desktop',
      getAppUserModelId: () => APP_USER_MODEL_ID,
    },
    shell: {
      writeShortcutLink: () => true,
      readShortcutLink: () => ({
        target: 'C:\\wrong.exe',
        icon: 'C:\\wrong.exe',
        appUserModelId: APP_USER_MODEL_ID,
      }),
    },
    logger(_level, event) { events.push(event); },
    platform: 'win32',
    execPath: 'C:\\Program Files\\Jenny\\Jenny.exe',
  });
  assert.deepEqual(result, {
    ok: false,
    shortcutPath: 'C:\\Users\\example\\Desktop\\Jenny.lnk',
    reason: 'verify-failed',
  });
  assert.equal(events.includes('shortcut.desktop_verify_failed'), true);
});

test('development shortcut maintenance never reads or overwrites the public shortcut', () => {
  const desktop = path.join(os.tmpdir(), 'jenny-desktop-isolation');
  const touched = [];
  let saved;
  const result = ensureDesktopShortcut({
    app: { isPackaged: false, getPath: () => desktop },
    platform: 'win32',
    shell: {
      readShortcutLink(file) { touched.push(file); return saved; },
      writeShortcutLink(file, _operation, details) {
        touched.push(file);
        saved = details;
        return true;
      },
    },
  });
  assert.equal(result.ok, true);
  assert.ok(touched.length > 0);
  assert.ok(touched.every((file) => file === path.join(desktop, 'Jenny (Dev).lnk')));
});

test('desktop shortcut read-back verification checks args, cwd, and iconIndex', () => {
  let reads = 0;
  const execPath = 'C:\\Program Files\\Jenny\\Jenny.exe';
  const result = ensureDesktopShortcut({
    app: {
      isPackaged: true,
      getPath: () => 'C:\\Users\\example\\Desktop',
      getAppUserModelId: () => APP_USER_MODEL_ID,
    },
    shell: {
      writeShortcutLink: () => true,
      readShortcutLink() {
        reads += 1;
        if (reads === 1) {
          throw new Error('missing');
        }
        return {
          target: execPath,
          args: '--wrong',
          cwd: 'C:\\wrong',
          icon: execPath,
          iconIndex: 99,
          appUserModelId: APP_USER_MODEL_ID,
        };
      },
    },
    platform: 'win32',
    execPath,
  });

  assert.equal(reads, 2);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'verify-failed');
});

test('desktop shortcut skips the rewrite when an existing shortcut already matches', () => {
  const writes = [];
  let builtDetails = null;
  const app = {
    isPackaged: false,
    getPath() { return 'C:\\Users\\example\\Desktop'; },
    getAppUserModelId() { return ''; },
  };
  const shellThatWrites = {
    writeShortcutLink(shortcutPath, operation, details) {
      builtDetails = details;
      writes.push({ shortcutPath, operation });
      return true;
    },
  };
  const opts = {
    app,
    logger() {},
    platform: 'win32',
    execPath: 'C:\\dev\\jenny-test-builds\\node_modules\\electron\\dist\\electron.exe',
    appRoot: 'C:\\dev\\jenny-test-builds',
  };

  // First run writes the shortcut and captures the exact details it produced.
  ensureDesktopShortcut({ ...opts, shell: shellThatWrites });
  assert.equal(writes.length, 1);
  assert.ok(builtDetails);

  // Second run with a readShortcutLink that returns the identical details must
  // skip the write entirely.
  const events = [];
  const idempotentResult = ensureDesktopShortcut({
    ...opts,
    shell: {
      readShortcutLink() { return { ...builtDetails }; },
      writeShortcutLink() { throw new Error('should not rewrite an unchanged shortcut'); },
    },
    logger(level, event) { events.push(event); },
  });
  assert.equal(idempotentResult.ok, true);
  assert.equal(idempotentResult.unchanged, true);
  assert.equal(events.includes('shortcut.desktop_unchanged'), true);
});

test('Windows launcher clears ELECTRON_RUN_AS_NODE before launching Electron', { skip: process.platform !== 'win32' }, () => {
  const cmdPath = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
  const result = spawnSync(cmdPath, ['/d', '/c', 'launch-jenny.cmd'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ComSpec: cmdPath,
      ELECTRON_RUN_AS_NODE: '1',
      JENNY_LAUNCHER_TEST_MODE: '1',
      PATH: '',
      PATHEXT: process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD',
      SystemRoot: process.env.SystemRoot || 'C:\\Windows',
      windir: process.env.windir || process.env.SystemRoot || 'C:\\Windows',
    },
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr);
  const repoRootLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('REPO_ROOT='));
  assert.ok(repoRootLine, `missing REPO_ROOT line in stdout: ${result.stdout}`);
  assert.equal(repoRootLine.slice('REPO_ROOT='.length).trim(), path.resolve(__dirname, '..'));
  assert.match(result.stdout, /ELECTRON_EXE=.*node_modules\\electron\\dist\\electron\.exe\s*$/m);
  assert.match(result.stdout, /^ELECTRON_RUN_AS_NODE=\s*$/m);
});

test('desktop shortcut repair removes the pre-rename "Jenny Shell" shortcut only when it is ours', () => {
  const desktop = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-desktop-'));
  const legacyPath = path.join(desktop, LEGACY_WINDOWS_SHORTCUT_NAME);
  const execPath = 'C:\\Program Files\\Jenny\\Jenny.exe';
  const { details: current } = buildDesktopShortcutOptions({ execPath, isPackaged: true });
  const events = [];
  const run = (legacyDetails) => {
    fs.writeFileSync(legacyPath, 'fixture');
    events.length = 0;
    return ensureDesktopShortcut({
      app: { isPackaged: true, getPath: () => desktop, getAppUserModelId: () => APP_USER_MODEL_ID },
      shell: {
        writeShortcutLink: () => true,
        readShortcutLink(shortcutPath) {
          if (shortcutPath === legacyPath) return legacyDetails;
          return current;
        },
      },
      logger(_level, event) { events.push(event); },
      platform: 'win32',
      execPath,
    });
  };
  try {
    const ours = run({ target: execPath, appUserModelId: APP_USER_MODEL_ID });
    assert.equal(ours.ok, true);
    assert.equal(ours.shortcutPath, path.join(desktop, WINDOWS_SHORTCUT_NAME));
    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(events.includes('shortcut.desktop_legacy_removed'), true);

    const foreign = run({ target: 'C:\\Other\\app.exe', appUserModelId: 'com.other.app' });
    assert.equal(foreign.ok, true);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(events.includes('shortcut.desktop_legacy_removed'), false);
  } finally {
    fs.rmSync(desktop, { recursive: true, force: true });
  }
});

const DEV_EXEC = 'C:\\dev\\jenny\\node_modules\\electron\\dist\\electron.exe';
const DEV_ROOT = 'C:\\dev\\jenny';
const APP_DATA = 'C:\\Users\\example\\AppData\\Roaming';
const START_MENU = path.join(APP_DATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs');

function devStartMenuApp(overrides = {}) {
  const calls = [];
  return {
    calls,
    app: {
      isPackaged: false,
      getPath(name) {
        assert.equal(name, 'appData');
        return APP_DATA;
      },
      getAppUserModelId: () => DEV_APP_USER_MODEL_ID,
      setToastActivatorCLSID(id) { calls.push(['setToastActivatorCLSID', id]); },
      ...overrides,
    },
  };
}

test('dev Start Menu link carries the fields Electron validates plus the Jenny icon', () => {
  const details = buildDevStartMenuShortcutDetails({ appRoot: DEV_ROOT, execPath: DEV_EXEC });
  assert.equal(details.target, DEV_EXEC);
  assert.equal(details.cwd, path.dirname(DEV_EXEC));
  assert.equal(details.appUserModelId, DEV_APP_USER_MODEL_ID);
  assert.equal(details.toastActivatorClsid, DEV_TOAST_ACTIVATOR_CLSID);
  assert.equal(details.icon, path.join(DEV_ROOT, 'build', 'icon.ico'));
  assert.equal(details.iconIndex, 0);
});

test('dev Start Menu link pins the toast CLSID before writing the Electron shortcut slot', () => {
  const { app, calls } = devStartMenuApp();
  let saved;
  const result = ensureDevStartMenuShortcut({
    app,
    shell: {
      readShortcutLink(file) {
        calls.push(['read', file]);
        if (!saved) throw new Error('missing');
        return saved;
      },
      writeShortcutLink(file, operation, details) {
        calls.push(['write', file, operation]);
        saved = details;
        return true;
      },
    },
    platform: 'win32',
    execPath: DEV_EXEC,
    appRoot: DEV_ROOT,
  });
  const shortcutPath = path.join(START_MENU, DEV_START_MENU_SHORTCUT_NAME);
  assert.deepEqual(result, { ok: true, shortcutPath });
  assert.deepEqual(calls[0], ['setToastActivatorCLSID', DEV_TOAST_ACTIVATOR_CLSID]);
  assert.deepEqual(calls.find((call) => call[0] === 'write'), ['write', shortcutPath, 'create']);
  assert.equal(saved.icon, path.join(DEV_ROOT, 'build', 'icon.ico'));
});

test('dev Start Menu link is left alone when it already matches (CLSID case-insensitive)', () => {
  const { app } = devStartMenuApp();
  const events = [];
  const existing = {
    ...buildDevStartMenuShortcutDetails({ appRoot: DEV_ROOT, execPath: DEV_EXEC }),
    toastActivatorClsid: DEV_TOAST_ACTIVATOR_CLSID.toLowerCase(),
  };
  const result = ensureDevStartMenuShortcut({
    app,
    shell: {
      readShortcutLink: () => existing,
      writeShortcutLink() { throw new Error('should not rewrite an unchanged shortcut'); },
    },
    logger(_level, event) { events.push(event); },
    platform: 'win32',
    execPath: DEV_EXEC,
    appRoot: DEV_ROOT,
  });
  assert.equal(result.unchanged, true);
  assert.deepEqual(events, ['shortcut.start_menu_unchanged']);
});

test('dev Start Menu link rewrites a link Electron left with its own CLSID and icon', () => {
  const { app } = devStartMenuApp();
  const writes = [];
  let saved = {
    ...buildDevStartMenuShortcutDetails({ appRoot: DEV_ROOT, execPath: DEV_EXEC }),
    icon: '',
    toastActivatorClsid: '{32149F81-EE05-48C5-86EC-F225E89933BB}',
  };
  const result = ensureDevStartMenuShortcut({
    app,
    shell: {
      readShortcutLink: () => saved,
      writeShortcutLink(_file, _operation, details) { writes.push(details); saved = details; return true; },
    },
    platform: 'win32',
    execPath: DEV_EXEC,
    appRoot: DEV_ROOT,
  });
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].toastActivatorClsid, DEV_TOAST_ACTIVATOR_CLSID);
});

test('dev Start Menu link is skipped for packaged builds and non-Windows hosts', () => {
  const shell = { writeShortcutLink() { throw new Error('must not write'); } };
  const packaged = devStartMenuApp({ isPackaged: true });
  assert.deepEqual(
    ensureDevStartMenuShortcut({ app: packaged.app, shell, platform: 'win32' }),
    { skipped: true, reason: 'packaged' }
  );
  assert.equal(packaged.calls.length, 0);
  assert.deepEqual(
    ensureDevStartMenuShortcut({ app: devStartMenuApp().app, shell, platform: 'linux' }),
    { skipped: true, reason: 'unsupported-platform' }
  );
});

test('dev Start Menu link failures are logged, never thrown', () => {
  const events = [];
  const { app } = devStartMenuApp();
  const failedWrite = ensureDevStartMenuShortcut({
    app,
    shell: { writeShortcutLink: () => false },
    logger(_level, event) { events.push(event); },
    platform: 'win32',
    execPath: DEV_EXEC,
    appRoot: DEV_ROOT,
  });
  assert.equal(failedWrite.ok, false);
  assert.equal(failedWrite.reason, 'write-failed');

  const threw = ensureDevStartMenuShortcut({
    app: { ...app, getPath() { throw new Error('no appData'); } },
    shell: { writeShortcutLink: () => true },
    logger(_level, event) { events.push(event); },
    platform: 'win32',
  });
  assert.equal(threw.ok, false);
  assert.deepEqual(events, ['shortcut.start_menu_create_failed', 'shortcut.start_menu_create_failed']);
});
