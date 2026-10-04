'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SecureStore } = require('../services/backend/secure-store');
const { CredentialFileStore } = require('../services/backend/secure-store-file-health');

const DAMAGED_BYTES = '{"web_search_provider_key:brave": {"encrypted": true, "value": "c3lu';

function createFixture(t, damagedBytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-secure-store-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'secure-state.json');
  if (damagedBytes !== undefined) {
    fs.writeFileSync(filePath, damagedBytes, 'utf8');
  }
  const store = new SecureStore({
    filePath,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(String(value), 'utf8'),
      decryptString: (value) => Buffer.from(value).toString('utf8'),
    },
    isSafeStorageReady: () => true,
  });
  return { dir, filePath, store };
}

function preservedCopies(dir) {
  return fs.readdirSync(dir).filter((name) => name.startsWith('secure-state.json.corrupt-'));
}

function blockCorruptRename(t) {
  const realRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (String(to).includes('.corrupt-')) {
      const error = new Error('EACCES: permission denied, rename');
      error.code = 'EACCES';
      throw error;
    }
    return realRename(from, to);
  };
  t.after(() => { fs.renameSync = realRename; });
}

for (const [label, bytes] of [
  ['unparseable JSON', DAMAGED_BYTES],
  ['a top-level array', '[]'],
]) {
  test(`a damaged credential file (${label}) is preserved before a save`, (t) => {
    const { dir, filePath, store } = createFixture(t, bytes);

    assert.equal(store.getWebSearchProviderKey('tavily'), '');
    store.setWebSearchProviderKey('tavily', 'synthetic-key');

    const copies = preservedCopies(dir);
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(dir, copies[0]), 'utf8'), bytes);
    const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.deepEqual(Object.keys(written), ['web_search_provider_key:tavily']);
    assert.equal(store.getWebSearchProviderKey('tavily'), 'synthetic-key');
    assert.equal(store.getStatus().ready, true);
  });
}

test('a damaged credential file that cannot be preserved is never overwritten', (t) => {
  const { dir, filePath, store } = createFixture(t, DAMAGED_BYTES);
  blockCorruptRename(t);

  const status = store.getStatus();
  assert.equal(status.ready, false);
  assert.equal(status.status, 'unavailable');
  assert.match(status.detail, /unreadable/i);
  assert.equal(store.getWebSearchProviderKey('brave'), '');
  assert.equal(store.hasMcpAuthToken('mcp:remote-tools'), false);
  assert.throws(() => store.setWebSearchProviderKey('brave', 'synthetic-key'), /damaged.*not overwritten/i);
  assert.throws(() => store.deleteWebSearchProviderKey('brave'), /damaged.*not overwritten/i);
  assert.deepEqual(store.purgeRetiredSecrets(), []);

  assert.equal(fs.readFileSync(filePath, 'utf8'), DAMAGED_BYTES);
  assert.deepEqual(preservedCopies(dir), []);
});

test('credential file damage logs one error without file contents', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-secure-store-corrupt-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'secure-state.json');
  fs.writeFileSync(filePath, DAMAGED_BYTES, 'utf8');
  const logs = [];
  const credentialFile = new CredentialFileStore(filePath, {
    logger: (level, event, data) => logs.push({ level, event, data }),
  });

  assert.deepEqual(credentialFile.read({}), {});
  assert.deepEqual(credentialFile.read({}), {});

  const detected = logs.filter((entry) => entry.event === 'secure_store.corrupt_file_detected');
  assert.equal(detected.length, 1);
  assert.equal(detected[0].level, 'ERROR');
  assert.equal(detected[0].data.fileName, 'secure-state.json');
  assert.equal(detected[0].data.preserved, true);
  assert.equal(JSON.stringify(detected[0].data).includes('c3lu'), false);
});

test('a healthy credential file still round trips and a missing one starts empty', (t) => {
  const { dir, filePath, store } = createFixture(t);

  assert.equal(store.getStatus().ready, true);
  assert.equal(store.getSentryDsn(), '');
  store.setSentryDsn('https://synthetic@example.invalid/1');
  assert.equal(store.getSentryDsn(), 'https://synthetic@example.invalid/1');
  store.deleteSentryDsn();
  assert.equal(store.getSentryDsn(), '');
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {});
  assert.deepEqual(preservedCopies(dir), []);
});

test('a credential file that cannot be read is left in place and never overwritten', (t) => {
  const healthy = JSON.stringify({ 'web_search_provider_key:brave': { encrypted: true, value: 'c3ludGhldGlj' } });
  const { dir, filePath, store } = createFixture(t, healthy);
  const realRead = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (String(target) === filePath) {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return realRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  assert.equal(store.getWebSearchProviderKey('tavily'), '');
  assert.throws(() => store.setWebSearchProviderKey('tavily', 'synthetic-key'), /damaged and was not overwritten/);
  assert.equal(store.getStatus().ready, false);
  fs.readFileSync = realRead;

  assert.deepEqual(preservedCopies(dir), []);
  assert.equal(fs.readFileSync(filePath, 'utf8'), healthy);
});

test('a credential file that was briefly unreadable is read again and writable once the read succeeds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-secure-store-unreadable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'secure-state.json');
  fs.writeFileSync(filePath, JSON.stringify({ kept: 'value' }), 'utf8');
  let nowMs = 1_000_000;
  const logged = [];
  const fileStore = new CredentialFileStore(filePath, {
    writeDebounceMs: 0,
    now: () => nowMs,
    logger: (level, event) => logged.push(event),
  });
  const realRead = fs.readFileSync;
  let busy = true;
  fs.readFileSync = (target, ...rest) => {
    if (busy && String(target) === filePath) {
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return realRead(target, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  assert.deepEqual(fileStore.read({}), {});
  assert.throws(() => fileStore.assertWritable(), /damaged and was not overwritten/);
  busy = false;
  assert.deepEqual(fileStore.read({}), {}, 'the recheck waits out its interval');
  nowMs += 1000;

  assert.deepEqual(fileStore.read({}), { kept: 'value' });
  assert.equal(fileStore.damagedDetail(), '');
  fileStore.writeImmediate({ kept: 'value', added: 'later' });
  assert.deepEqual(JSON.parse(realRead(filePath, 'utf8')), { kept: 'value', added: 'later' });
  assert.equal(logged.filter((event) => event === 'secure_store.corrupt_file_detected').length, 1);
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.corrupt-')), []);
});
