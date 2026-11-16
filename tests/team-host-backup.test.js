'use strict';

// The password-locked team backup file (slice 5-6, E63): services/team/host/host-backup.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BackupError, HEADER_BYTES, isBackupPassword, peekBackup, readBackup, writeBackup,
} = require('../services/team/host/host-backup');

const PASSWORD = 'correct horse battery';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-backup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedFiles(dir) {
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'empty'), { recursive: true });
  fs.writeFileSync(path.join(src, 'small.json'), '{"a":1}');
  // Three chunks and a bit: crosses the 64 KiB chunk boundary.
  fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(200_000, 7));
  fs.writeFileSync(path.join(src, 'zero.txt'), '');
  return [
    { rel: 'empty', dir: true },
    { rel: 'small.json', abs: path.join(src, 'small.json') },
    { rel: 'big.bin', abs: path.join(src, 'big.bin') },
    { rel: 'zero.txt', abs: path.join(src, 'zero.txt') },
  ];
}

async function readAll(file, password) {
  const out = { manifest: null, dirs: [], files: {} };
  let current = null;
  await readBackup({ file, password, handlers: {
    onManifest: (manifest) => { out.manifest = manifest; },
    onDir: (rel) => { out.dirs.push(rel); },
    onFileStart: (rel) => { current = rel; out.files[rel] = []; },
    onFileData: (data) => { out.files[current].push(Buffer.from(data)); },
    onFileEnd: () => { out.files[current] = Buffer.concat(out.files[current]); current = null; },
  } });
  return out;
}

async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (error) => error instanceof BackupError && error.reason === reason);
}

test('a backup round trip gives back the manifest and every file byte for byte', async (t) => {
  const dir = tempDir(t);
  const entries = seedFiles(dir);
  const target = path.join(dir, 'team.jennyteam');
  const written = await writeBackup({ target, password: PASSWORD, manifest: { schema: 1, key: 'k' }, entries });
  assert.equal(written.bytes, fs.statSync(target).size);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['src', 'team.jennyteam'], 'no temporary file is left');
  const back = await readAll(target, PASSWORD);
  assert.deepEqual(back.manifest, { schema: 1, key: 'k' });
  assert.deepEqual(back.dirs, ['empty']);
  for (const entry of entries.filter((e) => !e.dir)) assert.ok(back.files[entry.rel].equals(fs.readFileSync(entry.abs)), entry.rel);
  // The plaintext appears nowhere in the file.
  assert.equal(fs.readFileSync(target).includes(Buffer.from('{"a":1}')), false);
  assert.equal(fs.readFileSync(target).includes(Buffer.from(PASSWORD)), false);
});

test('two exports of the same team differ (fresh salt and nonce), and both open', async (t) => {
  const dir = tempDir(t);
  const entries = seedFiles(dir);
  const a = path.join(dir, 'a.jennyteam');
  const b = path.join(dir, 'b.jennyteam');
  await writeBackup({ target: a, password: PASSWORD, manifest: { schema: 1 }, entries });
  await writeBackup({ target: b, password: PASSWORD, manifest: { schema: 1 }, entries });
  const bytesA = fs.readFileSync(a);
  const bytesB = fs.readFileSync(b);
  assert.notDeepEqual(bytesA.subarray(18, 42), bytesB.subarray(18, 42));
  assert.equal(bytesA.equals(bytesB), false);
  assert.ok((await readAll(b, PASSWORD)).manifest);
});

test('a wrong password, a one-byte change anywhere and a truncated file fail alike, before any record is handed on', async (t) => {
  const dir = tempDir(t);
  const entries = seedFiles(dir);
  const target = path.join(dir, 'team.jennyteam');
  await writeBackup({ target, password: PASSWORD, manifest: { schema: 1 }, entries });
  const original = fs.readFileSync(target);
  let handed = 0;
  const count = () => { handed += 1; };
  const handlers = { onManifest: count, onDir: count, onFileStart: count, onFileData: count, onFileEnd: count };
  await rejectsWith(readBackup({ file: target, password: 'not the password', handlers }), 'team_backup_password_wrong');
  assert.equal(handed, 0, 'a wrong password hands nothing on');
  // A change in the header (salt), in the first chunk, in a middle chunk and in the last byte (the last chunk's tag):
  // the header and the first chunk fail before anything is handed on; a later chunk fails before its own records.
  const middle = HEADER_BYTES + 2 * (65_536 + 16) + 40;
  for (const [at, before] of [[20, 0], [HEADER_BYTES + 3, 0], [middle, null], [original.length - 1, null]]) {
    const changed = Buffer.from(original);
    changed[at] ^= 0x01;
    fs.writeFileSync(target, changed);
    handed = 0;
    const seen = [];
    const watching = { ...handlers, onFileData: (data) => { handed += 1; seen.push(Buffer.from(data)); } };
    await rejectsWith(readBackup({ file: target, password: PASSWORD, handlers: watching }), 'team_backup_password_wrong');
    if (before === 0) assert.equal(handed, 0, `a change at byte ${at} hands nothing on`);
    // Nothing of the changed chunk is handed on: every byte handed over is a byte of the files as written.
    const plain = Buffer.concat(seen);
    const written = Buffer.concat([Buffer.from('{"a":1}'), Buffer.alloc(200_000, 7)]);
    assert.ok(plain.length < written.length && written.subarray(0, plain.length).equals(plain), `byte ${at}: only an intact prefix`);
  }
  // Cut at a chunk boundary and cut short of it.
  for (const length of [HEADER_BYTES + 65_536 + 16, original.length - 5, HEADER_BYTES + 4]) {
    fs.writeFileSync(target, original.subarray(0, length));
    await rejectsWith(readBackup({ file: target, password: PASSWORD, handlers }), 'team_backup_password_wrong');
  }
});

test('a file from a newer Jenny is refused with its own reason before any password work', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'team.jennyteam');
  await writeBackup({ target, password: PASSWORD, manifest: { schema: 1 }, entries: [] });
  const bytes = fs.readFileSync(target);
  bytes.writeUInt16BE(2, 12);
  fs.writeFileSync(target, bytes);
  const derive = t.mock.method(crypto, 'scrypt');
  await rejectsWith(readBackup({ file: target, password: 'anything at all', handlers: {} }), 'team_backup_too_new');
  await rejectsWith(peekBackup(target), 'team_backup_too_new');
  assert.equal(derive.mock.callCount(), 0, 'no key was derived');
});

test('the reader enforces its key-derivation floor', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'weak.jennyteam');
  await writeBackup({ target, password: PASSWORD, manifest: { schema: 1 }, entries: [] });
  const bytes = fs.readFileSync(target);
  bytes.writeUInt8(10, 15); // log2(N) 10: below the floor
  fs.writeFileSync(target, bytes);
  await rejectsWith(readBackup({ file: target, password: PASSWORD, handlers: {} }), 'team_backup_password_wrong');
});

test('the password needs at least ten characters and nothing else', async (t) => {
  assert.equal(isBackupPassword('123456789'), false);
  assert.equal(isBackupPassword('1234567890'), true);
  assert.equal(isBackupPassword('          '), true);
  const dir = tempDir(t);
  await rejectsWith(writeBackup({ target: path.join(dir, 'x.jennyteam'), password: 'short', manifest: {}, entries: [] }), 'team_backup_password_short');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a write that fails part way leaves no file and no temporary file', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'team.jennyteam');
  await rejectsWith(writeBackup({ target, password: PASSWORD, manifest: {}, entries: [{ rel: 'gone', abs: path.join(dir, 'missing') }] }),
    'team_backup_write_failed');
  assert.deepEqual(fs.readdirSync(dir), []);
});
