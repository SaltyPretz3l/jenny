'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WORKSPACE_FS_ERROR_CODES: CODES } = require('../services/backend/error-codes');
const { decodeOutsideText, encodeOutsideText } = require('../services/main/outside-files/outside-file-encoding');
const { readOutsideSnapshot, writeOutsideFileInPlace } = require('../services/main/outside-files/outside-file-io');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-outside-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function utf16be(text) {
  const bytes = Buffer.from(text, 'utf16le');
  bytes.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), bytes]);
}

test('UTF-8, UTF-8 BOM and UTF-16 LE/BE decode editable and re-encode byte for byte', () => {
  const samples = [
    Buffer.from('héllo\r\nworld', 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom ✓\n', 'utf8')]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('PowerShell > out 𝄞\r\n', 'utf16le')]),
    utf16be('big endian ✓\n'),
  ];
  for (const bytes of samples) {
    const decoded = decodeOutsideText(bytes);
    assert.equal(decoded.editable, true, decoded.encoding);
    assert.deepEqual(encodeOutsideText(decoded.content, decoded.encoding), bytes, decoded.encoding);
  }
  assert.equal(decodeOutsideText(samples[0]).eol, 'crlf');
});

test('ANSI text opens read-only and is never re-encoded; NUL bytes and UTF-32 are refused', () => {
  const ansi = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a]); // "café\r\n" in Windows-1252
  const decoded = decodeOutsideText(ansi);
  assert.deepEqual([decoded.content, decoded.editable, decoded.encoding], ['café\r\n', false, 'windows-1252']);
  assert.throws(() => encodeOutsideText('café', 'windows-1252'), (error) => error.code === CODES.UNSUPPORTED_ENCODING && error.details.reason === 'read_only_encoding');
  assert.throws(() => decodeOutsideText(Buffer.from([0x61, 0x00, 0x62, 0x00])), (error) => error.code === CODES.BINARY);
  assert.throws(() => decodeOutsideText(Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x61, 0, 0, 0])), (error) => error.code === CODES.BINARY);
  assert.throws(() => encodeOutsideText('﻿x', 'utf-8'), (error) => error.code === CODES.UNSUPPORTED_ENCODING);
});

test('an in-place save keeps the same file, keeps the encoding and leaves nothing beside it', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\r\ntwo\r\n', 'utf16le')]));
  const before = fs.statSync(file);
  const snapshot = await readOutsideSnapshot(file);
  assert.equal(snapshot.decoded.encoding, 'utf-16le');
  const saved = await writeOutsideFileInPlace(file, { content: 'one\r\n', expectedFileVersion: snapshot.fileVersion });
  assert.equal(saved.encoding, 'utf-16le');
  assert.notEqual(saved.fileVersion, snapshot.fileVersion);
  assert.deepEqual(fs.readFileSync(file), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('one\r\n', 'utf16le')]), 'shorter content truncates');
  assert.equal(String(fs.statSync(file).ino), String(before.ino), 'written in place, not replaced');
  assert.deepEqual(fs.readdirSync(dir), ['notes.txt'], 'no temp or backup file next to it');
});

test('a stale version is a conflict that leaves the file untouched; read-only encodings refuse to save', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'a.md');
  fs.writeFileSync(file, 'original');
  const snapshot = await readOutsideSnapshot(file);
  fs.writeFileSync(file, 'changed elsewhere');
  await assert.rejects(
    writeOutsideFileInPlace(file, { content: 'mine', expectedFileVersion: snapshot.fileVersion }),
    (error) => error.code === CODES.WRITE_CONFLICT && typeof error.details.current_file_version === 'string',
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'changed elsewhere');
  const ansiFile = path.join(dir, 'legacy.txt');
  fs.writeFileSync(ansiFile, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
  const ansi = await readOutsideSnapshot(ansiFile);
  await assert.rejects(writeOutsideFileInPlace(ansiFile, { content: 'x', expectedFileVersion: ansi.fileVersion }), (error) => error.code === CODES.UNSUPPORTED_ENCODING);
});

test('missing, oversized and redirected files fail with bounded, path-free errors', async (t) => {
  const dir = tempDir(t);
  await assert.rejects(readOutsideSnapshot(path.join(dir, 'gone.md')), (error) => error.code === CODES.NOT_FOUND && !JSON.stringify(error.details).includes(dir));
  const big = path.join(dir, 'big.log');
  fs.writeFileSync(big, 'x'.repeat(64));
  await assert.rejects(readOutsideSnapshot(big, { maxBytes: 16 }), (error) => error.code === CODES.TOO_LARGE && error.details.max_bytes === 16);
  const real = path.join(dir, 'real.md');
  fs.writeFileSync(real, 'x');
  const fakeFs = { ...fs.promises, realpath: async () => path.join(dir, 'elsewhere.md') };
  await assert.rejects(readOutsideSnapshot(real, { fs: fakeFs }), (error) => error.code === CODES.NOT_FOUND && error.details.reason === 'path_redirected');
});

test('saving keeps the Zone.Identifier stream (Mark of the Web) on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'downloaded.ps1');
  fs.writeFileSync(file, 'Write-Host hi');
  fs.writeFileSync(`${file}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n');
  const snapshot = await readOutsideSnapshot(file);
  await writeOutsideFileInPlace(file, { content: 'Write-Host bye', expectedFileVersion: snapshot.fileVersion });
  assert.equal(fs.readFileSync(file, 'utf8'), 'Write-Host bye');
  assert.match(fs.readFileSync(`${file}:Zone.Identifier`, 'utf8'), /ZoneId=3/);
});

test('a write that fails after bytes landed puts the original bytes back', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'grow.txt');
  fs.writeFileSync(file, 'short\n');
  const snapshot = await readOutsideSnapshot(file);
  let writes = 0;
  const failingFs = {
    ...fs.promises,
    open: async (...args) => {
      const handle = await fs.promises.open(...args);
      if (args[1] !== 'r+') return handle;
      return {
        stat: () => handle.stat(),
        truncate: (n) => handle.truncate(n),
        sync: () => handle.sync(),
        close: () => handle.close(),
        // The new content: half lands, then the disk is full. The restore writes go through.
        write: async (buffer, offset, length, position) => {
          writes += 1;
          if (writes === 1) return handle.write(buffer, offset, Math.ceil(length / 2), position);
          if (writes === 2) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
          return handle.write(buffer, offset, length, position);
        },
      };
    },
  };
  await assert.rejects(
    writeOutsideFileInPlace(file, { content: 'a much longer replacement line\n', expectedFileVersion: snapshot.fileVersion, fs: failingFs }),
    (error) => error.code === CODES.IO_FAILED,
  );
  assert.equal(fs.readFileSync(file, 'utf8'), 'short\n', 'the original bytes are back');
  assert.equal((await readOutsideSnapshot(file)).fileVersion, snapshot.fileVersion, 'the editor version still matches');
});
