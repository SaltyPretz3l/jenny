'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJson, readJson } = require('../../services/host/durable-json');
const { FileSecretStore } = require('../../server/file-secret-store');
const { acquireProfile, assertDesktopProfile, claimDesktopProfile, claimProfileOwner } = require('../../services/host/profile-ownership');
const { applySingleInstance } = require('../../services/apply-single-instance');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-storage-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('metadata replaces atomically and rejects corrupt or oversized reads', (t) => {
  const file = path.join(fixture(t), 'metadata.json');
  assert.equal(readJson(file), null);
  writeJson(file, { version: 1 });
  writeJson(file, { version: 2 });
  assert.deepEqual(readJson(file), { version: 2 });
  assert.throws(() => readJson(file, { maxBytes: 1 }));
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readJson(file));
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('mounted credentials never fall back to arbitrary keys or files', (t) => {
  const directory = fixture(t);
  const store = new FileSecretStore({ directory });
  assert.equal(store.get('openai_compatible_api_key'), null);
  fs.writeFileSync(path.join(directory, 'model-api-key'), 'test-only-value\n');
  assert.equal(store.get('openai_compatible_api_key'), 'test-only-value');
  assert.equal(store.get('../model-api-key'), null);
  fs.writeFileSync(path.join(directory, 'model-api-key'), 'line1\nline2');
  assert.throws(() => store.get('openai_compatible_api_key'), (error) => error.message === 'secret_unavailable');
  assert.equal(store.getStatus().readOnly, true);
});

test('desktop refuses a hosted profile before creating service stores', (t) => {
  const directory = fixture(t);
  assert.doesNotThrow(() => assertDesktopProfile(directory));
  writeJson(path.join(directory, 'host-profile.json'), { schema_version: 1, host_mode: 'server' });
  assert.throws(() => assertDesktopProfile(directory), (error) => error.code === 'CMP-HOST-0004');
});

test('host admission rejects a real split desktop profile without changing its files', (t) => {
  const { ElectronSessionStore } = require('../../services/backend/electron-session-store');
  const directory = fixture(t);
  const legacyPath = path.join(directory, 'sessions.json');
  const store = new ElectronSessionStore(legacyPath, { writeDebounceMs: 0 });
  const session = store.createSession({ title: 'Keep my desktop conversation' });
  store.appendMessage(session.id, { role: 'user', content: 'Preserve this message' });
  store.flush();
  store.dispose();
  assert.equal(fs.existsSync(legacyPath), false);
  const indexPath = path.join(directory, 'sessions', '_index.json');
  const original = fs.readFileSync(indexPath, 'utf8');
  assert.throws(() => acquireProfile({ userDataPath: directory, pythonExecutable: 'must-not-start' }),
    (error) => error.message === 'desktop_profile_requires_import');
  assert.equal(fs.readFileSync(indexPath, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(directory, 'host-profile.json')), false);
  assert.equal(fs.existsSync(path.join(directory, '.host.lock')), false);
  assert.doesNotThrow(() => assertDesktopProfile(directory));
});

test('host admission also preserves legacy and not-yet-chatting desktop profiles', (t) => {
  for (const name of ['sessions.json', 'shell-config.json']) {
    const directory = fixture(t);
    const file = path.join(directory, name);
    fs.writeFileSync(file, '{}');
    assert.throws(() => acquireProfile({ userDataPath: directory, pythonExecutable: 'must-not-start' }),
      (error) => error.message === 'desktop_profile_requires_import');
    assert.equal(fs.readFileSync(file, 'utf8'), '{}');
    assert.equal(fs.existsSync(path.join(directory, 'host-profile.json')), false);
  }
});

test('Linux profile lock survives helper exit and releases with its parent descriptor', {
  skip: process.platform !== 'linux' ? 'Linux container qualification gate' : false,
}, (t) => {
  const userDataPath = fixture(t);
  const options = { userDataPath, pythonExecutable: 'python3' };
  const first = acquireProfile(options);
  try { assert.throws(() => acquireProfile(options), (error) => error.code === 'CMP-HOST-0004'); }
  finally { first.release(); }
  const next = acquireProfile(options);
  next.release();
  assert.throws(() => acquireProfile({ ...options, pythonExecutable: '/bin/true' }),
    (error) => error.code === 'CMP-HOST-0005');
  acquireProfile(options).release();
});

test('persistent profile claims fence both host modes and preserve unknown residue', (t) => {
  const desktop = fixture(t);
  claimDesktopProfile(desktop);
  assert.throws(() => claimProfileOwner(desktop, 'server'), (error) => error.code === 'CMP-HOST-0004');
  const host = fixture(t);
  claimProfileOwner(host, 'server');
  assert.throws(() => claimDesktopProfile(host), (error) => error.code === 'CMP-HOST-0004');
  const unclaimed = fixture(t);
  fs.writeFileSync(path.join(unclaimed, 'unknown-state'), 'preserve');
  assert.throws(() => claimProfileOwner(unclaimed, 'server'));
  assert.equal(fs.existsSync(path.join(unclaimed, 'profile-owner.json')), false);
});

test('profile marker publication is fully written before exclusive visibility', (t) => {
  const directory = fixture(t);
  const link = fs.linkSync;
  let observed = false;
  fs.linkSync = (source, target) => {
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(readJson(source), { schema_version: 1, host_mode: 'desktop' });
    observed = true;
    return link(source, target);
  };
  try { claimDesktopProfile(directory); } finally { fs.linkSync = link; }
  assert.equal(observed, true);
  assert.deepEqual(readJson(path.join(directory, 'profile-owner.json')),
    { schema_version: 1, host_mode: 'desktop' });
});

test('desktop repairs torn owner metadata but never repairs hosted evidence', (t) => {
  for (const content of ['', '{torn']) {
    const desktop = fixture(t);
    const desktopMarker = path.join(desktop, 'profile-owner.json');
    fs.writeFileSync(desktopMarker, content);
    assert.doesNotThrow(() => claimDesktopProfile(desktop));
    assert.deepEqual(readJson(desktopMarker), { schema_version: 1, host_mode: 'desktop' });
  }

  for (const hostedEvidence of ['host-profile.json', '.host.lock']) {
    const hosted = fixture(t);
    const marker = path.join(hosted, 'profile-owner.json');
    fs.writeFileSync(marker, '{torn');
    fs.writeFileSync(path.join(hosted, hostedEvidence), '{}');
    assert.throws(() => claimDesktopProfile(hosted), (error) => error.code === 'CMP-HOST-0004');
    assert.equal(fs.readFileSync(marker, 'utf8'), '{torn');
  }
});

test('desktop never replaces an unreadable owner marker', (t) => {
  const unreadable = fixture(t);
  const unreadableMarker = path.join(unreadable, 'profile-owner.json');
  fs.writeFileSync(unreadableMarker, '{torn');
  const open = fs.openSync;
  let denied = false;
  fs.openSync = (target, flags, ...args) => {
    if (!denied && path.resolve(String(target)) === path.resolve(unreadableMarker)) {
      denied = true;
      throw Object.assign(new Error('simulated permission denial'), { code: 'EPERM' });
    }
    return open(target, flags, ...args);
  };
  try {
    assert.throws(() => claimDesktopProfile(unreadable), (error) => error.code === 'EPERM');
  } finally {
    fs.openSync = open;
  }
  assert.equal(fs.readFileSync(unreadableMarker, 'utf8'), '{torn');
});

test('desktop never replaces a symlinked owner marker', (t) => {
  const linked = fixture(t);
  const target = path.join(linked, 'marker-target');
  const marker = path.join(linked, 'profile-owner.json');
  fs.writeFileSync(target, '{torn');
  try {
    fs.symlinkSync(target, marker, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`symlink creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.throws(() => claimDesktopProfile(linked));
  assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '{torn');
});

test('desktop refuses a special-file owner marker without blocking or replacing it', {
  skip: process.platform !== 'linux' ? 'Linux special-file qualification' : false,
}, (t) => {
  const directory = fixture(t);
  const marker = path.join(directory, 'profile-owner.json');
  require('node:child_process').execFileSync('mkfifo', [marker]);
  assert.throws(() => claimDesktopProfile(directory));
  assert.equal(fs.lstatSync(marker).isFIFO(), true);
});

test('a linked atomic publish is recovered without desktop stealing server ownership', (t) => {
  const directory = fixture(t);
  const temp = path.join(directory, `.profile-owner-${'a'.repeat(32)}.tmp`);
  const marker = path.join(directory, 'profile-owner.json');
  fs.writeFileSync(temp, JSON.stringify({ schema_version: 1, host_mode: 'server' }));
  fs.linkSync(temp, marker);
  assert.equal(fs.lstatSync(marker).nlink, 2);
  assert.throws(() => claimDesktopProfile(directory), (error) => error.code === 'CMP-HOST-0004');
  assert.deepEqual(readJson(marker), { schema_version: 1, host_mode: 'server' });
  assert.equal(fs.existsSync(temp), false);
});

test('desktop owner failure shows a bounded startup error and exits before locking', () => {
  const calls = [];
  const app = {
    getPath: () => 'private-profile-path',
    requestSingleInstanceLock: () => { calls.push('lock'); return true; },
    quit: () => calls.push('quit'),
    on() {},
  };
  const acquired = applySingleInstance(app, null, {
    claimDesktopProfile: () => { throw Object.assign(new Error('private failure'), { code: 'EPERM' }); },
    showErrorBox: (title, message) => calls.push({ title, message }),
  });
  assert.equal(acquired, false);
  assert.deepEqual(calls.map((call) => typeof call === 'string' ? call : 'dialog'), ['dialog', 'quit']);
  assert.equal(calls[0].title, 'Jenny could not open this profile');
  assert.equal(calls[0].message.includes('private-profile-path'), false);
  assert.equal(calls[0].message.includes('private failure'), false);
});


test('mounted secret reads reject oversized, invalid UTF-8 and changing content', (t) => {
  const directory = fixture(t);
  const file = path.join(directory, 'model-api-key');
  const store = new FileSecretStore({ directory });
  for (const content of [Buffer.alloc(16_385, 65), Buffer.from([0xff])]) {
    fs.writeFileSync(file, content);
    assert.throws(() => store.get('openai_compatible_api_key'), /secret_unavailable/);
  }
  fs.writeFileSync(file, 'old-key');
  const read = fs.readSync;
  let changed = false;
  try {
    fs.readSync = (...args) => {
      if (!changed) {
        changed = true;
        fs.appendFileSync(file, 'additional-content');
      }
      return read(...args);
    };
    assert.throws(() => store.get('openai_compatible_api_key'), /secret_unavailable/);
    assert.equal(changed, true);
  } finally {
    fs.readSync = read;
  }
});

test('a FIFO secret fails promptly without a writer', {
  skip: process.platform !== 'linux' ? 'Linux mounted-file qualification' : false,
}, (t) => {
  const directory = fixture(t);
  require('node:child_process').execFileSync('mkfifo', [path.join(directory, 'model-api-key')]);
  assert.throws(() => new FileSecretStore({ directory }).get('openai_compatible_api_key'), /secret_unavailable/);
});
