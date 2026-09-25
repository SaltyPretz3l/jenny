'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

const {
  ZIP_LIMITS,
  crc32,
  readEntryBytes,
  readEntryText,
  readZip,
  writeZip,
} = require('../renderer/features/renderer-ide-docx-zip');

const fixtures = path.join(__dirname, 'fixtures', 'documents');

function fixture(name) {
  return new Uint8Array(fs.readFileSync(path.join(fixtures, name)));
}

function assertCode(code) {
  return (error) => error?.code === code;
}

function yauzlEntries(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true }, (openError, archive) => {
      if (openError) {
        reject(openError);
        return;
      }
      const entries = new Map();
      archive.on('error', reject);
      archive.on('end', () => resolve(entries));
      archive.on('entry', (entry) => {
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError) {
            reject(streamError);
            return;
          }
          const chunks = [];
          stream.on('error', reject);
          stream.on('data', (chunk) => chunks.push(chunk));
          stream.on('end', () => {
            entries.set(entry.fileName, new Uint8Array(Buffer.concat(chunks)));
            archive.readEntry();
          });
        });
      });
      archive.readEntry();
    });
  });
}

function findSignature(bytes, signature, start = 0) {
  for (let offset = start; offset <= bytes.length - 4; offset += 1) {
    if (new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) === signature) {
      return offset;
    }
  }
  return -1;
}

function patchCentralField(bytes, fieldOffset, value) {
  const copy = bytes.slice();
  const centralOffset = findSignature(copy, 0x02014b50);
  assert.notEqual(centralOffset, -1);
  new DataView(copy.buffer).setUint32(centralOffset + fieldOffset, value, true);
  return copy;
}

async function assertYauzlMatches(bytes, zip) {
  const independent = await yauzlEntries(bytes);
  assert.deepEqual([...independent.keys()], zip.order);
  for (const name of zip.order) {
    assert.deepEqual(independent.get(name), await readEntryBytes(zip, name));
  }
}

test('reads paragraphs.docx in central-directory order', async () => {
  const zip = await readZip(fixture('paragraphs.docx'));
  assert.deepEqual(zip.order, [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/_rels/document.xml.rels',
  ]);
  assert.match(await readEntryText(zip, 'word/document.xml'), /Quarterly summary/);
});

test('reads and verifies a binary image entry', async () => {
  const zip = await readZip(fixture('images-headers.docx'));
  const image = await readEntryBytes(zip, 'word/media/image1.png');
  assert.deepEqual(image.subarray(0, 4), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.equal(crc32(image), zip.entries.get('word/media/image1.png').crc32);
});

test('round trips untouched compressed data and opens with yauzl', async () => {
  const source = await readZip(fixture('images-headers.docx'));
  const out = await writeZip(source, new Map());
  const roundTrip = await readZip(out);
  assert.deepEqual(roundTrip.order, source.order);
  for (const name of source.order) {
    const before = source.entries.get(name);
    const after = roundTrip.entries.get(name);
    assert.deepEqual(after.raw, before.raw);
    assert.equal(after.method, before.method);
    assert.equal(after.crc32, before.crc32);
    assert.equal(after.compressedSize, before.compressedSize);
    assert.equal(after.uncompressedSize, before.uncompressedSize);
  }
  await assertYauzlMatches(out, roundTrip);
});

test('replaces one entry while preserving every other compressed payload', async () => {
  const source = await readZip(fixture('paragraphs.docx'));
  const originalText = await readEntryText(source, 'word/document.xml');
  const replacement = originalText.replace('Quarterly summary', 'Updated summary');
  const out = await writeZip(source, new Map([['word/document.xml', replacement]]));
  const roundTrip = await readZip(out);
  assert.match(await readEntryText(roundTrip, 'word/document.xml'), /Updated summary/);
  for (const name of source.order.filter((entryName) => entryName !== 'word/document.xml')) {
    assert.deepEqual(roundTrip.entries.get(name).raw, source.entries.get(name).raw);
  }
  await assertYauzlMatches(out, roundTrip);
});

test('deletes entries and appends new entries in replacement insertion order', async () => {
  const source = await readZip(fixture('paragraphs.docx'));
  const replacements = new Map([
    ['_rels/.rels', null],
    ['word/numbering.xml', '<numbering/>'],
  ]);
  const roundTrip = await readZip(await writeZip(source, replacements));
  assert.deepEqual(roundTrip.order, [
    '[Content_Types].xml',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'word/numbering.xml',
  ]);
  assert.equal(await readEntryText(roundTrip, 'word/numbering.xml'), '<numbering/>');
  await assert.rejects(readEntryBytes(roundTrip, '_rels/.rels'), assertCode('zip_missing_entry'));
});

test('keeps DOCX validation outside the ZIP container layer', async () => {
  const zip = await readZip(fixture('not-a-docx.docx'));
  assert.equal(zip.entries.has('readme.txt'), true);
});

test('reports a truncated fixture as zip_invalid', async () => {
  await assert.rejects(readZip(fixture('malformed.docx')), assertCode('zip_invalid'));
});

test('stops inflated output beyond the declaration and detects a bad crc', async () => {
  const source = await readZip(fixture('not-a-docx.docx'));
  const zeros = new Uint8Array(1024 * 1024);
  const out = await writeZip(source, new Map([['readme.txt', zeros]]));
  const tooSmall = await readZip(patchCentralField(out, 24, 10));
  await assert.rejects(readEntryBytes(tooSmall, 'readme.txt'), assertCode('zip_too_large'));

  const badCrc = await readZip(patchCentralField(out, 16, 0));
  await assert.rejects(readEntryBytes(badCrc, 'readme.txt'), assertCode('zip_corrupt'));
});

test('enforces caller limits and rejects unsafe names', async () => {
  await assert.rejects(
    readZip(fixture('lists-tables.docx'), { maxEntries: 2 }),
    assertCode('zip_too_large')
  );
  const source = await readZip(fixture('not-a-docx.docx'));
  await assert.rejects(
    writeZip(source, new Map([['../evil.xml', 'bad']])),
    assertCode('zip_unsupported')
  );
  assert.equal(ZIP_LIMITS.maxEntries, 4096);
});

test('stores incompressible bytes and deflates compressible bytes', async () => {
  const source = await readZip(fixture('not-a-docx.docx'));
  const random = new Uint8Array(randomBytes(64));
  const repeated = new Uint8Array(1024).fill(65);
  const replacements = new Map([
    ['random.bin', random],
    ['repeated.bin', repeated],
  ]);
  const roundTrip = await readZip(await writeZip(source, replacements));
  assert.equal(roundTrip.entries.get('random.bin').method, 0);
  assert.equal(roundTrip.entries.get('repeated.bin').method, 8);
});
