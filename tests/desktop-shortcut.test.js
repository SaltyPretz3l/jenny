const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('path');

const {
  APP_USER_MODEL_ID,
  DEV_LAUNCHER_NAME,
  buildDesktopShortcutOptions,
  ensureDesktopShortcut,
  getDevLauncherPath,
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
  assert.equal(details.appUserModelId, APP_USER_MODEL_ID);
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
    shortcutPath: 'C:\\Users\\example\\Desktop\\Jenny.lnk',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].shortcutPath, 'C:\\Users\\example\\Desktop\\Jenny.lnk');
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
