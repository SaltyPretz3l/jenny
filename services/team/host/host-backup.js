'use strict';

// The password-locked team backup file (slice 5-6, decision E63): one file, `.jennyteam`, that can bring a hosted
// team back. Node's built-in `crypto` only. No Electron.
//
// Layout (all integers big-endian):
//
//   0   12  magic "JENNYTEAMBAK"
//   12   2  format version (1)
//   14   1  key derivation (1 = scrypt)
//   15   1  scrypt log2(N)        written 17; the reader refuses below 17 or above 18
//   16   1  scrypt r              written 8;  the reader refuses anything but 8
//   17   1  scrypt p              written 1;  the reader refuses below 1 or above 2
//   18  16  salt (fresh per file)
//   34   8  nonce prefix (fresh per file)
//   42      chunks: AES-256-GCM over 64 KiB of plaintext each, then its 16-byte tag. Chunk i's nonce is the
//           prefix followed by i as 4 bytes; its additional data is the 42-byte header and one byte, 1 for the
//           last chunk and 0 for every other, so the header is authenticated with the body and a file cut at
//           a chunk boundary fails. The last chunk may hold 0 to 64 KiB.
//
// The plaintext is a record stream: a manifest record first (inside the first chunk), then directory and file
// records, then an end record. A file with a newer version is refused (`team_backup_too_new`) before any
// password work; anything else that does not open — a wrong password, a truncated, altered or foreign file — is
// `team_backup_password_wrong` and the reader has handed nothing on, because every chunk is checked before its
// plaintext is used and the caller writes only into a folder it throws away on failure. The password and the
// derived key are held only for the call and zeroed; nothing here logs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAGIC = Buffer.from('JENNYTEAMBAK', 'ascii');
const VERSION = 1;
const HEADER_BYTES = 42;
const CHUNK = 64 * 1024;
const TAG = 16;
const KDF = Object.freeze({ logN: 17, r: 8, p: 1 });
// What the reader accepts. The floor stops a file from asking for a weak derivation; the ceiling stops one from
// asking for more memory than a PC can give.
const KDF_LIMITS = Object.freeze({ minLogN: 17, maxLogN: 18, r: 8, minP: 1, maxP: 2 });
const MAX_MEMORY = 320 * 1024 * 1024;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 1024;
const MAX_MANIFEST = 48 * 1024;
const MAX_PATH = 1024;
const RECORD = Object.freeze({ END: 0, FILE: 1, DIR: 2, MANIFEST: 3 });

class BackupError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'BackupError';
    this.reason = reason;
  }
}

/** True for a password the backup accepts: 10 to 1024 characters, no other rule. */
function isBackupPassword(value) {
  return typeof value === 'string' && [...value].length >= MIN_PASSWORD && value.length <= MAX_PASSWORD;
}

function deriveKey(password, salt, { logN, r, p }) {
  const secret = Buffer.from(password.normalize('NFC'), 'utf8');
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, salt, 32, { N: 2 ** logN, r, p, maxmem: MAX_MEMORY }, (error, key) => {
      secret.fill(0);
      if (error) reject(new BackupError('team_backup_unavailable')); else resolve(key);
    });
  });
}

function buildHeader({ logN, r, p }, salt, prefix) {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt16BE(VERSION, 12);
  header.writeUInt8(1, 14);
  header.writeUInt8(logN, 15);
  header.writeUInt8(r, 16);
  header.writeUInt8(p, 17);
  salt.copy(header, 18);
  prefix.copy(header, 34);
  return header;
}

// The header's parts, or a refusal. Version first: a newer file is refused before its parameters are judged.
function readHeader(header, limits) {
  if (header.length < HEADER_BYTES || !header.subarray(0, 12).equals(MAGIC)) throw new BackupError('team_backup_password_wrong');
  const version = header.readUInt16BE(12);
  if (version > VERSION) throw new BackupError('team_backup_too_new');
  const params = { logN: header.readUInt8(15), r: header.readUInt8(16), p: header.readUInt8(17) };
  if (version !== VERSION || header.readUInt8(14) !== 1 || params.logN < limits.minLogN || params.logN > limits.maxLogN
    || params.r !== limits.r || params.p < limits.minP || params.p > limits.maxP) {
    throw new BackupError('team_backup_password_wrong');
  }
  return { params, salt: header.subarray(18, 34), prefix: header.subarray(34, 42) };
}

// A handle's `read` and `write` may answer less than asked (SMB and NAS shares do), so each loops to the full length.
// `readFully` answers the bytes read: fewer than `length` only at the end of the file.
async function readFully(handle, buffer, length, position) {
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(buffer, got, length - got, position + got);
    if (!(bytesRead > 0)) break;
    got += bytesRead;
  }
  return got;
}

async function writeFully(handle, buffer) {
  for (let at = 0; at < buffer.length;) {
    const { bytesWritten } = await handle.write(buffer, at, buffer.length - at);
    if (!(bytesWritten > 0)) throw new BackupError('team_backup_write_failed');
    at += bytesWritten;
  }
}

// A source file opened without following a link, as the walk saw it. Where the platform has no O_NOFOLLOW the path
// is checked by lstat and the opened handle must be the same file.
async function openSource(abs) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const changed = () => new BackupError('team_backup_source_changed');
  const before = noFollow ? null : await fs.promises.lstat(abs, { bigint: true });
  if (before && !before.isFile()) throw changed();
  let source;
  try {
    source = await fs.promises.open(abs, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    throw error?.code === 'ELOOP' ? changed() : error;
  }
  try {
    const stat = await source.stat({ bigint: true });
    if (!stat.isFile() || (before && (stat.ino !== before.ino || stat.dev !== before.dev))) throw changed();
    return { source, size: Number(stat.size) };
  } catch (error) {
    await source.close().catch(() => {});
    throw error;
  }
}

function nonceOf(prefix, index) {
  const nonce = Buffer.alloc(12);
  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(index, 8);
  return nonce;
}

const aadOf = (header, final) => Buffer.concat([header, Buffer.from([final ? 1 : 0])]);

// ------------------------------------------------------------------ writing

// Seals plaintext into chunks as it comes; `emit(buffer)` writes each sealed chunk.
function createSealer(key, header, prefix, emit) {
  let pending = [];
  let pendingBytes = 0;
  let index = 0;
  const seal = (plain, final) => {
    if (index >= 0xffffffff) throw new BackupError('team_backup_too_large');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceOf(prefix, index));
    cipher.setAAD(aadOf(header, final));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    emit(Buffer.concat([body, cipher.getAuthTag()]));
    index += 1;
  };
  return {
    push(data) {
      if (!data.length) return;
      pending.push(data);
      pendingBytes += data.length;
      // A full chunk is sealed only once more bytes follow it, so the last chunk is always marked final.
      while (pendingBytes > CHUNK) {
        const all = Buffer.concat(pending);
        seal(all.subarray(0, CHUNK), false);
        pending = [all.subarray(CHUNK)];
        pendingBytes = pending[0].length;
      }
    },
    finish() { seal(Buffer.concat(pending), true); pending = []; pendingBytes = 0; },
  };
}

function recordHead(type, rel, size) {
  const name = Buffer.from(rel, 'utf8');
  const head = Buffer.alloc(1 + 2 + name.length + 8);
  head.writeUInt8(type, 0);
  head.writeUInt16BE(name.length, 1);
  name.copy(head, 3);
  head.writeBigUInt64BE(BigInt(size), 3 + name.length);
  return head;
}

/**
 * Writes the backup to `target` through a temporary file beside it (created 0600), renamed into place last; a
 * failure leaves no file. `entries`: [{ rel, abs, dir? }] with `/`-separated relative paths. Answers { bytes }.
 */
async function writeBackup({ target, password, manifest, entries, kdf = KDF, randomBytes = crypto.randomBytes }) {
  if (!isBackupPassword(password)) throw new BackupError('team_backup_password_short');
  const salt = randomBytes(16);
  const prefix = randomBytes(8);
  const header = buildHeader(kdf, salt, prefix);
  const key = await deriveKey(password, salt, kdf);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let handle = null;
  try {
    // 0600 for every caller (slice 3-14): the file holds the team's key, sealed by the password.
    handle = await fs.promises.open(temp, 'wx', 0o600);
    const queue = [];
    const sealer = createSealer(key, header, prefix, (chunk) => queue.push(chunk));
    const flush = async () => { while (queue.length) await writeFully(handle, queue.shift()); };
    await writeFully(handle, header);
    const manifestBytes = Buffer.from(JSON.stringify(manifest), 'utf8');
    if (manifestBytes.length > MAX_MANIFEST) throw new BackupError('team_backup_unavailable');
    const manifestHead = Buffer.alloc(5);
    manifestHead.writeUInt8(RECORD.MANIFEST, 0);
    manifestHead.writeUInt32BE(manifestBytes.length, 1);
    sealer.push(manifestHead);
    sealer.push(manifestBytes);
    for (const entry of entries) {
      if (entry.dir) { sealer.push(recordHead(RECORD.DIR, entry.rel, 0)); continue; }
      const { source, size } = await openSource(entry.abs);
      try {
        sealer.push(recordHead(RECORD.FILE, entry.rel, size));
        let left = size;
        const piece = Buffer.alloc(CHUNK);
        while (left > 0) {
          const { bytesRead } = await source.read(piece, 0, Math.min(CHUNK, left), null);
          if (bytesRead === 0) throw new BackupError('team_backup_source_changed');
          sealer.push(Buffer.from(piece.subarray(0, bytesRead)));
          left -= bytesRead;
          await flush();
        }
        // A file that grew (or changed size) while it was read is not the file the record says: fail, never truncate.
        if (Number((await source.stat({ bigint: true })).size) !== size) throw new BackupError('team_backup_source_changed');
      } finally {
        await source.close();
      }
    }
    sealer.push(Buffer.from([RECORD.END]));
    sealer.finish();
    await flush();
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temp, target);
    return { bytes: (await fs.promises.stat(target)).size };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temp).catch(() => {});
    throw error instanceof BackupError ? error : new BackupError('team_backup_write_failed');
  } finally {
    key.fill(0);
  }
}

// ------------------------------------------------------------------ reading

// An incremental parser of the record stream. `handlers`: onManifest(object), onDir(rel), onFileStart(rel, size),
// onFileData(buffer), onFileEnd(). A record that does not parse is `team_backup_password_wrong` (it can only
// come from a file that is not one this format wrote).
function createParser(handlers) {
  let buffer = Buffer.alloc(0);
  let fileLeft = null;
  let sawManifest = false;
  let ended = false;
  const bad = () => new BackupError('team_backup_password_wrong');
  async function feed(data) {
    buffer = buffer.length ? Buffer.concat([buffer, data]) : data;
    for (;;) {
      if (ended) { if (buffer.length) throw bad(); return; }
      if (fileLeft !== null) {
        if (!buffer.length) return;
        const take = Number(fileLeft < BigInt(buffer.length) ? fileLeft : BigInt(buffer.length));
        await handlers.onFileData(buffer.subarray(0, take));
        buffer = buffer.subarray(take);
        fileLeft -= BigInt(take);
        if (fileLeft === 0n) { fileLeft = null; await handlers.onFileEnd(); }
        continue;
      }
      if (!buffer.length) return;
      const type = buffer.readUInt8(0);
      if (!sawManifest) {
        if (type !== RECORD.MANIFEST) throw bad();
        if (buffer.length < 5) return;
        const length = buffer.readUInt32BE(1);
        if (length > MAX_MANIFEST) throw bad();
        if (buffer.length < 5 + length) return;
        let manifest;
        try { manifest = JSON.parse(buffer.subarray(5, 5 + length).toString('utf8')); } catch { throw bad(); }
        buffer = buffer.subarray(5 + length);
        sawManifest = true;
        await handlers.onManifest(manifest);
        continue;
      }
      if (type === RECORD.END) { ended = true; buffer = buffer.subarray(1); continue; }
      if (type !== RECORD.FILE && type !== RECORD.DIR) throw bad();
      if (buffer.length < 3) return;
      const nameLength = buffer.readUInt16BE(1);
      if (nameLength < 1 || nameLength > MAX_PATH) throw bad();
      if (buffer.length < 3 + nameLength + 8) return;
      const rel = buffer.subarray(3, 3 + nameLength).toString('utf8');
      const size = buffer.readBigUInt64BE(3 + nameLength);
      buffer = buffer.subarray(3 + nameLength + 8);
      if (type === RECORD.DIR) { await handlers.onDir(rel); continue; }
      await handlers.onFileStart(rel, size);
      if (size === 0n) await handlers.onFileEnd(); else fileLeft = size;
    }
  }
  return { feed, done: () => ended && fileLeft === null && sawManifest };
}

/**
 * Reads and checks the header only: { size } (the file's bytes) or a refusal; for showing a picked file before the
 * password. `handle`: an open FileHandle to read instead of opening `file` (the caller keeps and closes it).
 */
async function peekBackup(file, { handle: given = null } = {}) {
  const handle = given ?? await fs.promises.open(file, 'r');
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const bytesRead = await readFully(handle, header, HEADER_BYTES, 0);
    readHeader(header.subarray(0, bytesRead), KDF_LIMITS);
    return { size: (await handle.stat()).size };
  } finally {
    if (!given) await handle.close();
  }
}

/**
 * Opens `file` with `password` and hands every record to `handlers` (see createParser), each chunk checked
 * before its plaintext is used. The first chunk, holding the manifest, is checked before any handler runs.
 * Throws a BackupError; answers once the end record and the last chunk's tag were both read. `handle`: an open
 * FileHandle to read instead of opening `file` (the caller keeps and closes it; the headless restore opens the
 * file once without following a link).
 */
async function readBackup({ file, password, handlers, limits = KDF_LIMITS, handle: given = null }) {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD) throw new BackupError('team_backup_password_wrong');
  const handle = given ?? await fs.promises.open(file, 'r').catch(() => { throw new BackupError('team_backup_unreadable'); });
  let key = null;
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(HEADER_BYTES);
    const bytesRead = await readFully(handle, header, HEADER_BYTES, 0);
    const { params, salt, prefix } = readHeader(header.subarray(0, bytesRead), limits);
    const body = size - HEADER_BYTES;
    if (body < TAG) throw new BackupError('team_backup_password_wrong');
    key = await deriveKey(password, salt, params);
    const parser = createParser(handlers);
    const full = CHUNK + TAG;
    const count = Math.ceil(body / full);
    let offset = HEADER_BYTES;
    const sealed = Buffer.alloc(full);
    for (let index = 0; index < count; index += 1) {
      const length = Math.min(full, size - offset);
      if (length < TAG) throw new BackupError('team_backup_password_wrong');
      const got = await readFully(handle, sealed, length, offset);
      if (got !== length) throw new BackupError('team_backup_password_wrong');
      offset += length;
      let plain;
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceOf(prefix, index));
        decipher.setAAD(aadOf(header, index === count - 1));
        decipher.setAuthTag(sealed.subarray(length - TAG, length));
        plain = Buffer.concat([decipher.update(sealed.subarray(0, length - TAG)), decipher.final()]);
      } catch {
        throw new BackupError('team_backup_password_wrong');
      }
      await parser.feed(plain);
    }
    if (!parser.done()) throw new BackupError('team_backup_password_wrong');
  } finally {
    key?.fill(0);
    if (!given) await handle.close().catch(() => {});
  }
}

module.exports = {
  BackupError, HEADER_BYTES, KDF, VERSION, isBackupPassword, peekBackup, readBackup, writeBackup,
};
