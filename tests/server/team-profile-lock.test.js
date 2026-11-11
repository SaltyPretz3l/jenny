'use strict';

// Team slice 1e: the hosted application host takes its profile lock on Windows
// through a process-lifetime exclusive named pipe (the same kernel mechanism the
// CLI uses), keeps the owner marker and the `.host.lock` evidence file, and
// refuses a profile that is a junction.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { HOST_ERROR_CODES } = require('../../services/backend/error-codes');
const { IS_WINDOWS, linkDirectory, linuxOnly, windowsOnly } = require('../helpers/platform-skips');
const {
  acquireProfile, acquireProfileAsync, assertDesktopProfile, claimDesktopProfile,
} = require('../../services/host/profile-ownership');
const { pipeLockName } = require('../../services/host/profile-pipe-lock');
const { cliLockName } = require('../../services/cli-host/profile-lock');

const HOLDER = path.resolve(__dirname, 'helpers', 'profile-lock-holder.js');
const LOCKED_MESSAGE = 'Profile is locked or locking is unavailable.';

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-lock-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function readLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(buffer.slice(0, newline));
    });
    child.once('exit', (code) => reject(new Error(`child exited ${code} before answering: ${buffer}`)));
  });
}

function spawnHolder(t, directory) {
  const child = spawn(process.execPath, [HOLDER, directory], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const pid = child.pid;
  t.after(() => { if (child.exitCode === null && child.signalCode === null) process.kill(pid); });
  return child;
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', resolve);
  });
}

const isConflict = (error) => error.code === HOST_ERROR_CODES.CONFLICT && error.message === LOCKED_MESSAGE;

test('a second acquisition from another process is refused with CONFLICT', { timeout: 30_000, skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const holder = spawnHolder(t, profile);
  assert.equal(await readLine(holder), 'held');

  await assert.rejects(acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' }), isConflict);
  const second = spawnHolder(t, profile);
  assert.equal(await readLine(second), `refused:${HOST_ERROR_CODES.CONFLICT}`);
  await exited(second);

  holder.stdin.end();
  await exited(holder);
});

test('the lock is released when the holding process is killed', { timeout: 30_000, skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const holder = spawnHolder(t, profile);
  const pid = holder.pid;
  assert.equal(await readLine(holder), 'held');

  process.kill(pid);
  await exited(holder);
  const held = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  try {
    assert.equal(held.directory, fs.realpathSync(profile));
  } finally {
    await held.release();
  }
});

test('release frees the profile for the next acquisition and is safe to call twice', { skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const first = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  await assert.rejects(acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' }), isConflict);
  await first.release();
  await first.release();
  const second = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  await assert.rejects(acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' }), isConflict);
  await second.release();
  await second.release();
});

test('two spellings of one profile path share one lock', { skip: windowsOnly('case-insensitive paths and named-pipe lock') }, async (t) => {
  const profile = fixture(t);
  const held = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  try {
    await assert.rejects(acquireProfileAsync({ userDataPath: profile.toUpperCase(), pythonExecutable: '' }), isConflict);
    await assert.rejects(acquireProfileAsync({ userDataPath: profile.toLowerCase(), pythonExecutable: '' }), isConflict);
    await assert.rejects(acquireProfileAsync({ userDataPath: `${profile}${path.sep}`, pythonExecutable: '' }), isConflict);
    await assert.rejects(acquireProfileAsync({ userDataPath: `${profile.toUpperCase()}${path.sep}`, pythonExecutable: '' }), isConflict);
  } finally {
    await held.release();
  }
});

test('the profile carries the server marker and .host.lock, so the desktop refuses it', { skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const held = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  try {
    assert.equal(fs.statSync(path.join(held.directory, '.host.lock')).isFile(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(held.directory, 'profile-owner.json'), 'utf8')),
      { schema_version: 1, host_mode: 'server' });
    assert.throws(() => claimDesktopProfile(profile), (error) => error.code === HOST_ERROR_CODES.CONFLICT);
    assert.throws(() => assertDesktopProfile(profile), (error) => error.code === HOST_ERROR_CODES.CONFLICT);
  } finally {
    await held.release();
  }
  // The evidence file outlives the lock: a released profile is still refused.
  assert.equal(fs.existsSync(path.join(profile, '.host.lock')), true);
  assert.throws(() => assertDesktopProfile(profile), (error) => error.code === HOST_ERROR_CODES.CONFLICT);
  const again = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  await again.release();
});

test('a junction as the profile directory is refused before anything is written', { skip: windowsOnly('junctions') }, async (t) => {
  const root = fixture(t);
  const target = path.join(root, 'real-profile');
  fs.mkdirSync(target);
  const link = path.join(root, 'profile-link');
  linkDirectory(target, link);
  await assert.rejects(acquireProfileAsync({ userDataPath: link, pythonExecutable: '' }),
    (error) => error.code === HOST_ERROR_CODES.CONFLICT && error.reason === 'unsafe_path');
  assert.deepEqual(fs.readdirSync(target), [], 'nothing was written through the junction');
});

test('a .host.lock that is a hard link to another file is refused and the pipe is freed', { skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const outside = path.join(fixture(t), 'other.txt');
  fs.writeFileSync(outside, 'x');
  fs.linkSync(outside, path.join(profile, '.host.lock'));
  await assert.rejects(acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' }),
    (error) => error.code === HOST_ERROR_CODES.CONFLICT && error.reason === 'unsafe_path');
  fs.rmSync(path.join(profile, '.host.lock'));
  const held = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  await held.release();
});

test('a file system without hard links fails closed with UNAVAILABLE', { skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const original = fs.linkSync;
  fs.linkSync = (from, to) => { throw Object.assign(new Error(`EPERM: operation not permitted, link '${from}' -> '${to}'`), { code: 'EPERM', syscall: 'link' }); };
  try {
    await assert.rejects(acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' }),
      (error) => error.code === HOST_ERROR_CODES.UNAVAILABLE && /hard links/u.test(error.message) && !error.message.includes(profile));
  } finally {
    fs.linkSync = original;
  }
  // The refusal left no lock behind: the pipe was never taken.
  const held = await acquireProfileAsync({ userDataPath: profile, pythonExecutable: '' });
  await held.release();
});

test('the CLI pipe name is unchanged by the shared module, and the server pipe is a different one', { skip: windowsOnly('Windows path case-folding') }, () => {
  const original = os.userInfo;
  os.userInfo = () => ({ username: 'pin-user' });
  try {
    // Pinned from the pre-extraction implementation.
    assert.equal(cliLockName('C:\\Jenny\\Profile'), '\\\\.\\pipe\\jenny-cli-06aabe2c4d5c165ee6eb56e48cd52386');
    assert.equal(cliLockName('c:\\jenny\\profile'), '\\\\.\\pipe\\jenny-cli-06aabe2c4d5c165ee6eb56e48cd52386');
    const server = pipeLockName('\\\\.\\pipe\\jenny-host-', 'C:\\Jenny\\Profile');
    assert.equal(server, '\\\\.\\pipe\\jenny-host-06aabe2c4d5c165ee6eb56e48cd52386');
    assert.notEqual(server, cliLockName('C:\\Jenny\\Profile'));
  } finally {
    os.userInfo = original;
  }
});

test('on Linux the synchronous and asynchronous paths return the same shape', { skip: linuxOnly('flock helper'), timeout: 30_000 }, async (t) => {
  const python = path.resolve(__dirname, '../..', '.venv', 'bin', 'python');
  if (!fs.existsSync(python)) { t.skip('needs the sidecar venv'); return; }
  const syncProfile = fixture(t);
  const asyncProfile = fixture(t);
  const sync = acquireProfile({ userDataPath: syncProfile, pythonExecutable: python });
  const asynchronous = await acquireProfileAsync({ userDataPath: asyncProfile, pythonExecutable: python });
  try {
    assert.deepEqual(Object.keys(asynchronous).sort(), Object.keys(sync).sort());
    assert.equal(typeof asynchronous.release, 'function');
  } finally {
    sync.release();
    asynchronous.release();
  }
});

test('profile locking stays unsupported off Linux and Windows', { skip: IS_WINDOWS || process.platform === 'linux' ? 'only on other platforms' : false }, async (t) => {
  await assert.rejects(acquireProfileAsync({ userDataPath: fixture(t), pythonExecutable: '' }),
    (error) => error.code === HOST_ERROR_CODES.UNAVAILABLE);
});
