'use strict';

// Jenny CLI S2: a profile belongs to one host mode (the `cli` marker fences the desktop and the
// server, and vice versa) and to one live process at a time (the Windows named pipe, or the POSIX
// flock through the existing helper). Liveness comes from the kernel: a dead holder releases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { windowsOnly } = require('../helpers/platform-skips');
const { readJson } = require('../../services/host/durable-json');
const {
  assertDesktopProfile, claimCliProfile, claimDesktopProfile, claimProfileOwner,
} = require('../../services/host/profile-ownership');
const { CLI_PROFILE_ERROR_CODES, acquireCliProfile, acquireFlockLock, cliLockName } = require('../../services/cli-host/profile-lock');

const ROOT = path.resolve(__dirname, '../..');
const PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CHILD = path.join(ROOT, 'tests/helpers/cli-profile-lock-child.js');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-cli-profile-'));
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

function spawnHolder(directory) {
  return spawn(process.execPath, [CHILD, directory, PYTHON], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
}

test('the cli marker fences the desktop and the server, and they fence the cli', (t) => {
  const cli = fixture(t);
  const directory = claimCliProfile(cli);
  assert.deepEqual(readJson(path.join(directory, 'profile-owner.json')), { schema_version: 1, host_mode: 'cli' });
  assert.equal(claimCliProfile(cli), directory, 'a second cli claim of its own profile is fine');
  assert.throws(() => claimDesktopProfile(cli), (error) => error.code === 'CMP-HOST-0004');
  assert.throws(() => assertDesktopProfile(cli), (error) => error.code === 'CMP-HOST-0004');
  assert.throws(() => claimProfileOwner(cli, 'server'), (error) => error.code === 'CMP-HOST-0004');

  const desktop = fixture(t);
  claimDesktopProfile(desktop);
  assert.throws(() => claimCliProfile(desktop), (error) => error.code === 'CMP-HOST-0004');

  const server = fixture(t);
  claimProfileOwner(server, 'server');
  assert.throws(() => claimCliProfile(server), (error) => error.code === 'CMP-HOST-0004');
});

test('the cli never adopts an unmarked profile that already holds data', (t) => {
  const residue = fixture(t);
  fs.writeFileSync(path.join(residue, 'sessions.json'), '{}');
  assert.throws(() => claimCliProfile(residue), (error) => error.code === 'CMP-HOST-0004' && /requires_import/.test(error.message));
  assert.equal(fs.existsSync(path.join(residue, 'profile-owner.json')), false, 'nothing was written');
  assert.throws(() => claimCliProfile('relative/profile'), /invalid_profile_owner/);
  // The CLI's own configuration file is not someone else's data.
  const configured = fixture(t);
  fs.writeFileSync(path.join(configured, 'cli.json'), '{"engine":"ollama"}');
  assert.equal(claimCliProfile(configured), fs.realpathSync.native(configured));
  assert.equal(readJson(path.join(configured, 'profile-owner.json')).host_mode, 'cli');
});

test('the profile identity is the kernel real path, so two spellings of one directory share one lock', (t) => {
  const directory = fixture(t);
  const native = fs.realpathSync.native(directory);
  assert.equal(claimCliProfile(directory), native);
  if (process.platform !== 'win32') return;
  const shouted = directory.toUpperCase();
  assert.equal(claimCliProfile(shouted), native, 'the caller spelling never leaks into the identity');
  assert.equal(cliLockName(shouted), cliLockName(native));
  assert.equal(cliLockName(fs.realpathSync(shouted)), cliLockName(native), 'the non-native realpath keeps the caller case; the lock name folds it');
});

test('the lock name is stable per real path and user, and never carries the path', (t) => {
  const directory = fs.realpathSync(fixture(t));
  const name = cliLockName(directory);
  assert.match(name, /^\\\\\.\\pipe\\jenny-cli-[a-f0-9]{32}$/);
  assert.equal(cliLockName(directory), name);
  assert.notEqual(cliLockName(path.join(directory, 'other')), name);
  assert.equal(name.includes(path.basename(directory)), false);
});

test('a second process is refused while the first holds the profile, and admitted once it dies', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'win32' && !fs.existsSync(PYTHON)) {
    t.skip('POSIX flock path needs the sidecar venv');
    return;
  }
  const profile = fixture(t);
  const holder = spawnHolder(profile);
  t.after(() => { if (holder.exitCode === null) holder.kill(); });
  const first = await readLine(holder);
  assert.equal(first, process.platform === 'win32' ? 'held:pipe' : 'held:flock');

  await assert.rejects(acquireCliProfile({ userDataPath: profile, pythonExecutable: PYTHON }),
    (error) => error.code === CLI_PROFILE_ERROR_CODES.BUSY && error.reason === 'profile_busy');
  const second = spawnHolder(profile);
  assert.equal(await readLine(second), 'refused:profile_busy');

  holder.kill();
  await new Promise((resolve) => holder.once('exit', resolve));
  const held = await acquireCliProfile({ userDataPath: profile, pythonExecutable: PYTHON });
  assert.equal(held.directory, fs.realpathSync(profile));
  assert.deepEqual(readJson(path.join(held.directory, 'profile-owner.json')), { schema_version: 1, host_mode: 'cli' });
  const third = spawnHolder(profile);
  assert.equal(await readLine(third), 'refused:profile_busy');
  held.release();
  held.release();
  const fourth = spawnHolder(profile);
  t.after(() => { if (fourth.exitCode === null) fourth.kill(); });
  assert.match(await readLine(fourth), /^held:/, 'release hands the profile to the next process');
  fourth.stdin.end();
  await new Promise((resolve) => fourth.once('exit', resolve));
});

// S9: an installed copy reads the helper from app.asar.unpacked; a path an external interpreter
// cannot read is refused before any lock file or process exists.
test('the flock path refuses a missing helper or interpreter before it opens the lock file', (t) => {
  const directory = fixture(t);
  const missing = path.join(directory, 'app.asar.unpacked', 'services', 'host', 'profile_lock.py');
  assert.throws(() => acquireFlockLock(directory, PYTHON, missing), (error) => {
    assert.equal(error.code, CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE);
    assert.equal(error.reason, 'lock_unavailable');
    assert.ok(error.message.includes(missing), error.message);
    return true;
  });
  assert.throws(() => acquireFlockLock(directory, '', path.join(ROOT, 'services', 'host', 'profile_lock.py')),
    { code: CLI_PROFILE_ERROR_CODES.LOCK_UNAVAILABLE, reason: 'lock_unavailable', message: /needs the sidecar Python/u });
  assert.equal(fs.existsSync(path.join(directory, '.cli.lock')), false, 'nothing was opened');
});

test('the lock helper option is accepted and unused on the Windows named-pipe path', { skip: windowsOnly('named-pipe profile lock') }, async (t) => {
  const profile = fixture(t);
  const held = await acquireCliProfile({ userDataPath: profile, pythonExecutable: '', lockHelperPath: path.join(profile, 'no-such-helper.py') });
  try {
    assert.equal(held.kind, 'pipe');
  } finally {
    held.release();
  }
});

test('a lost lock is reported once so the host can fail closed', { timeout: 15_000, skip: windowsOnly('named-pipe listener loss') }, async (t) => {
  const profile = fixture(t);
  const lost = [];
  const held = await acquireCliProfile({ userDataPath: profile, onLost: (error) => lost.push(error) });
  // A release is the host's own choice, not a loss.
  held.release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(lost, []);
  const again = await acquireCliProfile({ userDataPath: profile, onLost: (error) => lost.push(error) });
  again.release();
  assert.deepEqual(lost, []);
});
