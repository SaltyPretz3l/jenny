'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createArchive,
  extractArchive,
  readManifest,
  verifyArchive,
} = require('../services/data-lifecycle/archive-service');
const {
  decryptFileToPath,
  decryptFileToSink,
  resolveArchiveChild,
  validateKdfProfile,
  validateLogicalPath,
  validateManifest,
} = require('../services/data-lifecycle/archive-format');

const roots = [];

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-archive-test-'));
  roots.push(root);
  return root;
}

test.afterEach(() => {
  while (roots.length) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

test('encrypted archive round-trips buffers and files and verifies before returning', async () => {
  const root = tempRoot();
  const sourcePath = path.join(root, 'source.txt');
  fs.writeFileSync(sourcePath, 'portable file data', 'utf8');
  const progress = [];

  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Encrypted.jenny-archive',
    appVersion: '0.9.1',
    encrypted: true,
    passphrase: 'a correct horse battery staple',
    entries: [
      { logicalPath: 'sessions/session-one.json', category: 'chats', data: '{"ok":true}' },
      { logicalPath: 'personality/AGENTS.md', category: 'personality', sourcePath },
    ],
    onProgress(payload) { progress.push(payload); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'complete');
  assert.equal(fs.existsSync(path.join(result.archivePath, 'COMPLETE')), true);
  const envelope = JSON.parse(fs.readFileSync(path.join(result.archivePath, 'archive.json'), 'utf8'));
  assert.equal(envelope.encrypted, true);
  assert.equal(JSON.stringify(envelope).includes('session-one'), false);
  assert.equal(fs.existsSync(path.join(result.archivePath, 'manifest.enc')), true);
  assert.equal(fs.existsSync(path.join(result.archivePath, 'manifest.json')), false);
  assert.equal(progress.at(-1).phase, 'complete');

  const verified = await verifyArchive(result.archivePath, {
    passphrase: 'a correct horse battery staple',
  });
  assert.equal(verified.status, 'verified');
  const extracted = path.join(root, 'restored');
  await extractArchive(result.archivePath, extracted, {
    passphrase: 'a correct horse battery staple',
  });
  assert.equal(fs.readFileSync(path.join(extracted, 'sessions', 'session-one.json'), 'utf8'), '{"ok":true}');
  assert.equal(fs.readFileSync(path.join(extracted, 'personality', 'AGENTS.md'), 'utf8'), 'portable file data');
});

test('encrypted archive rejects a wrong passphrase and tampered ciphertext', async () => {
  const root = tempRoot();
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Protected.jenny-archive',
    encrypted: true,
    passphrase: 'correct-password-123',
    entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{}' }],
  });

  await assert.rejects(
    verifyArchive(result.archivePath, { passphrase: 'incorrect-password' }),
    (error) => error.code === 'CMP-DATA-0006' && error.reason === 'archive_authentication_failed'
  );

  const state = await readManifest(result.archivePath, { passphrase: 'correct-password-123' });
  const payloadPath = resolveArchiveChild(result.archivePath, state.manifest.entries[0].stored_path);
  const bytes = fs.readFileSync(payloadPath);
  bytes[0] ^= 0xff;
  fs.writeFileSync(payloadPath, bytes);
  await assert.rejects(
    verifyArchive(result.archivePath, { passphrase: 'correct-password-123' }),
    (error) => error.code === 'CMP-DATA-0006'
  );
});

test('encrypted archive decryption preserves filesystem failure classifications', async () => {
  const root = tempRoot();
  const passphrase = 'correct-password-123';
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Filesystem-errors.jenny-archive',
    encrypted: true,
    passphrase,
    entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{}' }],
  });
  const state = await readManifest(result.archivePath, { passphrase });
  const entry = state.manifest.entries[0];
  const sourcePath = resolveArchiveChild(state.root, entry.stored_path);
  const originalCreateReadStream = fs.createReadStream;
  fs.createReadStream = function createFailingReadStream(filePath, options) {
    const stream = originalCreateReadStream.call(fs, filePath, options);
    if (path.resolve(String(filePath)) === path.resolve(sourcePath)) {
      process.nextTick(() => stream.destroy(Object.assign(new Error('private source path'), { code: 'EIO' })));
    }
    return stream;
  };
  try {
    await assert.rejects(decryptFileToSink({
      sourcePath,
      masterKey: state.masterKey,
      salt: state.salt,
      entryId: entry.entry_id,
      iv: entry.iv,
      tag: entry.tag,
    }), (error) => {
      assert.equal(error.code, 'CMP-DATA-0004');
      assert.equal(error.reason, 'archive_io_failed');
      assert.equal(error.message, 'Archive data could not be read or written.');
      return true;
    });
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }

  const destinationPath = path.join(root, 'restored', 'preferences.json');
  const originalCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function createFailingWriteStream(filePath, options) {
    const stream = originalCreateWriteStream.call(fs, filePath, options);
    if (path.resolve(String(filePath)) === path.resolve(destinationPath)) {
      process.nextTick(() => stream.destroy(Object.assign(new Error('private destination path'), { code: 'ENOSPC' })));
    }
    return stream;
  };
  try {
    await assert.rejects(decryptFileToPath({
      sourcePath,
      destinationPath,
      masterKey: state.masterKey,
      salt: state.salt,
      entryId: entry.entry_id,
      iv: entry.iv,
      tag: entry.tag,
    }), (error) => {
      assert.equal(error.code, 'CMP-DATA-0005');
      assert.equal(error.reason, 'archive_io_failed');
      assert.equal(error.message, 'Archive data could not be read or written because the destination has insufficient space.');
      return true;
    });
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
  }
});

test('plain archive remains readable and detects payload tampering', async () => {
  const root = tempRoot();
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Plain.jenny-archive',
    encrypted: false,
    entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{"theme":"paper"}' }],
  });

  assert.equal(fs.existsSync(path.join(result.archivePath, 'manifest.json')), true);
  assert.equal(
    fs.readFileSync(path.join(result.archivePath, 'data', 'settings', 'preferences.json'), 'utf8'),
    '{"theme":"paper"}'
  );
  fs.appendFileSync(path.join(result.archivePath, 'data', 'settings', 'preferences.json'), 'tampered');
  await assert.rejects(
    verifyArchive(result.archivePath),
    (error) => error.code === 'CMP-DATA-0007' && error.reason === 'archive_corrupt'
  );
});

test('archive retries one source change and records the stable size', async () => {
  const root = tempRoot();
  const sourcePath = path.join(root, 'changing.txt');
  fs.writeFileSync(sourcePath, 'first', 'utf8');
  const originalCreateReadStream = fs.createReadStream;
  let changed = false;
  fs.createReadStream = function createReadStreamWithOneChange(filePath, options) {
    const stream = originalCreateReadStream.call(fs, filePath, options);
    if (!changed && path.resolve(String(filePath)) === path.resolve(sourcePath)) {
      changed = true;
      stream.once('end', () => fs.appendFileSync(sourcePath, '-stable', 'utf8'));
    }
    return stream;
  };

  try {
    const result = await createArchive({
      destinationRoot: path.join(root, 'archives'),
      archiveName: 'Changed-once.jenny-archive',
      encrypted: false,
      entries: [{ logicalPath: 'memory/changing.txt', category: 'memory', sourcePath }],
    });
    const verified = await verifyArchive(result.archivePath);
    assert.equal(result.counts.bytes, Buffer.byteLength('first-stable'));
    assert.equal(verified.manifest.total_bytes, Buffer.byteLength('first-stable'));
  } finally {
    fs.createReadStream = originalCreateReadStream;
  }
});

test('review-bound source digest rejects changed content and removes partial output', async () => {
  const root = tempRoot();
  const sourcePath = path.join(root, 'reviewed.txt');
  fs.writeFileSync(sourcePath, 'changed', 'utf8');
  const destinationRoot = path.join(root, 'archives');

  await assert.rejects(createArchive({
    destinationRoot,
    archiveName: 'Reviewed.jenny-archive',
    encrypted: false,
    entries: [{
      logicalPath: 'workspace/reviewed.txt',
      category: 'workspace',
      sourcePath,
      expectedSha256: '0'.repeat(64),
    }],
  }), { reason: 'workspace_review_stale' });
  assert.equal(fs.existsSync(path.join(destinationRoot, 'Reviewed.jenny-archive')), false);
  assert.deepEqual(fs.existsSync(destinationRoot) ? fs.readdirSync(destinationRoot) : [], []);
});

function cancelAfterFirstEntry() {
  let checks = 0;
  return () => { checks += 1; return checks > 1; };
}

const CANCELED_ARCHIVE_ENTRIES = [
  { logicalPath: 'sessions/private.json', category: 'chats', data: 'private chat text' },
  { logicalPath: 'sessions/second.json', category: 'chats', data: '{}' },
];

test('a canceled archive whose partial cannot be removed reports the retained partial', async (t) => {
  const root = tempRoot();
  const destinationRoot = path.join(root, 'archives');
  const originalRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = originalRm; });
  fs.promises.rm = async function rmDenyingPartials(target, options) {
    if (String(target).endsWith('.partial')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return originalRm.call(fs.promises, target, options);
  };

  await assert.rejects(createArchive({
    destinationRoot,
    archiveName: 'Canceled.jenny-archive',
    encrypted: false,
    entries: CANCELED_ARCHIVE_ENTRIES,
    shouldCancel: cancelAfterFirstEntry(),
  }), (error) => {
    assert.equal(error.code, 'CMP-DATA-0001');
    assert.equal(error.reason, 'operation_cancelled');
    assert.equal(error.partialRetained, true);
    assert.equal(fs.existsSync(error.partialPath), true);
    assert.equal(path.dirname(error.partialPath), destinationRoot);
    return true;
  });
});

test('a canceled archive removes its partial and leaves no retained-partial marker', async () => {
  const root = tempRoot();
  const destinationRoot = path.join(root, 'archives');

  await assert.rejects(createArchive({
    destinationRoot,
    archiveName: 'Canceled.jenny-archive',
    encrypted: false,
    entries: CANCELED_ARCHIVE_ENTRIES,
    shouldCancel: cancelAfterFirstEntry(),
  }), (error) => {
    assert.equal(error.reason, 'operation_cancelled');
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'partialRetained'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(error, 'partialPath'), false);
    return true;
  });
  assert.deepEqual(fs.readdirSync(destinationRoot), []);
});

test('a new archive sweeps stale owned partials and leaves everything else alone', async () => {
  const root = tempRoot();
  const destinationRoot = path.join(root, 'archives');
  fs.mkdirSync(destinationRoot, { recursive: true });
  const makePartial = (name, ageMs) => {
    const target = path.join(destinationRoot, name);
    fs.mkdirSync(path.join(target, 'data'), { recursive: true });
    fs.writeFileSync(path.join(target, 'data', 'old.json'), 'old', 'utf8');
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(target, when, when);
    return target;
  };
  const day = 24 * 60 * 60 * 1000;
  const stale = makePartial('Old.jenny-archive.0123456789ab.partial', 2 * day);
  const fresh = makePartial('Fresh.jenny-archive.ba9876543210.partial', 0);
  const unrelated = makePartial('notes.partial', 2 * day);
  const wrongSuffix = makePartial('Old.jenny-archive.XYZ.partial', 2 * day);
  const staleFile = path.join(destinationRoot, 'File.jenny-archive.0123456789ab.partial');
  fs.writeFileSync(staleFile, 'not a directory', 'utf8');
  const when = new Date(Date.now() - 2 * day);
  fs.utimesSync(staleFile, when, when);

  const result = await createArchive({
    destinationRoot,
    archiveName: 'Next.jenny-archive',
    encrypted: false,
    entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{}' }],
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(stale), false);
  for (const kept of [fresh, unrelated, wrongSuffix, staleFile]) {
    assert.equal(fs.existsSync(kept), true, `${path.basename(kept)} must be left alone`);
  }
  assert.equal(fs.existsSync(result.archivePath), true);
});

test('a failing stale-partial removal does not fail the new archive', async (t) => {
  const root = tempRoot();
  const destinationRoot = path.join(root, 'archives');
  const stale = path.join(destinationRoot, 'Old.jenny-archive.0123456789ab.partial');
  fs.mkdirSync(stale, { recursive: true });
  const when = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, when, when);
  const originalRm = fs.promises.rm;
  t.after(() => { fs.promises.rm = originalRm; });
  fs.promises.rm = async function rmDenyingPartials(target, options) {
    if (String(target).endsWith('.partial')) throw Object.assign(new Error('denied'), { code: 'EPERM' });
    return originalRm.call(fs.promises, target, options);
  };

  const result = await createArchive({
    destinationRoot,
    archiveName: 'Next.jenny-archive',
    encrypted: false,
    entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{}' }],
  });

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(stale), true);
});

test('the archive README says knowledge folders are not included', async () => {
  const root = tempRoot();
  for (const encrypted of [true, false]) {
    const result = await createArchive({
      destinationRoot: path.join(root, 'archives'),
      archiveName: `Readme-${encrypted ? 'enc' : 'plain'}.jenny-archive`,
      encrypted,
      passphrase: encrypted ? 'correct-password-123' : '',
      entries: [{ logicalPath: 'settings/preferences.json', category: 'preferences', data: '{}' }],
    });
    const readme = fs.readFileSync(path.join(result.archivePath, 'README.txt'), 'utf8');
    assert.match(readme, /knowledge folder/i);
    assert.match(readme, /not (part of|included in) this archive/i);
  }
});

test('archive path and manifest validation rejects traversal, reserved names, and case collisions', () => {
  for (const unsafePath of ['../escape', '/absolute', 'C:/absolute', 'safe/../escape', 'safe/CON.txt', 'safe/name:stream']) {
    assert.throws(() => validateLogicalPath(unsafePath), { code: 'CMP-DATA-0003' });
  }
  assert.equal(validateLogicalPath('safe/Unicode-資料.json'), 'safe/Unicode-資料.json');

  const baseManifest = {
    format: 'jenny-data-archive',
    format_version: 1,
    entries: [
      {
        entry_id: '00000000-0000-4000-8000-000000000001',
        logical_path: 'Sessions/one.json',
        stored_path: 'data/Sessions/one.json',
        category: 'chats',
        size: 1,
        sha256: 'a'.repeat(64),
      },
      {
        entry_id: '00000000-0000-4000-8000-000000000002',
        logical_path: 'sessions/ONE.json',
        stored_path: 'data/sessions/ONE.json',
        category: 'chats',
        size: 1,
        sha256: 'b'.repeat(64),
      },
    ],
    category_counts: { chats: 2 },
  };
  assert.throws(() => validateManifest(baseManifest), {
    code: 'CMP-DATA-0007',
    reason: 'archive_path_collision',
  });
});

test('archive reader bounds metadata and binds payload paths and sizes to the manifest', async () => {
  const root = tempRoot();
  const result = await createArchive({
    destinationRoot: path.join(root, 'archives'),
    archiveName: 'Bounded.jenny-archive',
    encrypted: false,
    entries: [{ logicalPath: 'preferences/preferences.json', category: 'preferences', data: '{}' }],
  });
  const manifestPath = path.join(result.archivePath, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.entries[0].stored_path = 'data/preferences/other.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(readManifest(result.archivePath), {
    code: 'CMP-DATA-0007',
    reason: 'archive_corrupt',
  });

  manifest.entries[0].stored_path = 'data/preferences/preferences.json';
  manifest.category_counts.preferences = 2;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(readManifest(result.archivePath), {
    code: 'CMP-DATA-0007',
    reason: 'archive_corrupt',
  });

  manifest.category_counts.preferences = 1;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  fs.appendFileSync(path.join(result.archivePath, manifest.entries[0].stored_path), 'extra');
  await assert.rejects(verifyArchive(result.archivePath), {
    code: 'CMP-DATA-0007',
    reason: 'archive_corrupt',
  });

  fs.writeFileSync(path.join(result.archivePath, 'archive.json'), ' '.repeat((64 * 1024) + 1));
  await assert.rejects(readManifest(result.archivePath), {
    code: 'CMP-DATA-0007',
    reason: 'archive_corrupt',
  });
});

test('restore rejects archive-controlled KDF work factors', () => {
  assert.throws(() => validateKdfProfile({
    name: 'scrypt-v1',
    algorithm: 'scrypt',
    N: 1073741824,
    r: 8,
    p: 1,
    keyLength: 32,
  }), {
    code: 'CMP-DATA-0008',
    reason: 'unsupported_kdf_profile',
  });
});
