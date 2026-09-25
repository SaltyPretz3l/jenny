'use strict';

// services/pdf-addon-wheel.js: defence-in-depth checks while streaming a
// verified PyMuPDF wheel into the add-on staging directory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractWheel } = require('../services/pdf-addon-wheel');
const { assembleZip } = require('./helpers/plugins/hostile-archive-builder');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const CENTRAL_SIGNATURE = 0x02014b50;
const UNIX_SYMLINK_MODE = 0o120777;

function writeWheel(entries, { unixHost = false } = {}) {
  const { bytes } = assembleZip(entries);
  if (unixHost) {
    // assembleZip always writes "version made by" 20 (MS-DOS); mark every
    // central header as made on Unix so the mode bits are interpreted.
    for (let offset = 0; offset + 4 <= bytes.length; offset += 1) {
      if (bytes.readUInt32LE(offset) === CENTRAL_SIGNATURE) bytes.writeUInt16LE((3 << 8) | 20, offset + 4);
    }
  }
  const folder = createTrackedTempDir('jenny-pdf-wheel-');
  const wheelPath = path.join(folder, 'test.whl');
  fs.writeFileSync(wheelPath, bytes);
  const destDir = path.join(folder, 'site');
  fs.mkdirSync(destDir);
  return { wheelPath, destDir };
}

test('extracts files and directory entries inside the destination', async () => {
  const { wheelPath, destDir } = writeWheel([
    { name: 'pymupdf/', externalAttributes: 0x10 },
    { name: 'pymupdf/__init__.py', data: Buffer.from('x = 1\n') },
    { name: 'pymupdf/mupdf-devel/include/fitz.h', data: Buffer.from('/* h */\n') },
    { name: 'fitz/__init__.py', data: Buffer.from('y = 2\n') },
  ]);
  const result = await extractWheel({ wheelPath, destDir });
  assert.deepEqual(result, { fileCount: 3, totalBytes: 20 });
  assert.equal(fs.readFileSync(path.join(destDir, 'pymupdf', 'mupdf-devel', 'include', 'fitz.h'), 'utf8'), '/* h */\n');
});

test('refuses unsafe names, links, reparse points and duplicates', async () => {
  const cases = [
    [[{ name: '../escape.py', data: Buffer.from('x') }]],
    [[{ name: '/abs.py', data: Buffer.from('x') }]],
    [[{ name: 'C:/drive.py', data: Buffer.from('x') }]],
    [[{ name: 'pymupdf\\back.py', data: Buffer.from('x') }]],
    [[{ name: 'pymupdf/con.py', data: Buffer.from('x') }]],
    [[{ name: 'pymupdf/trailing.', data: Buffer.from('x') }]],
    [[{ name: 'pymupdf/./a.py', data: Buffer.from('x') }]],
    [[{ name: 'pymupdf/link', data: Buffer.from('/etc/passwd'), externalAttributes: (UNIX_SYMLINK_MODE << 16) >>> 0 }], { unixHost: true }],
    [[{ name: 'pymupdf/junction', data: Buffer.from('x'), externalAttributes: 0x0400 }]],
    [[{ name: 'pymupdf/a.py', data: Buffer.from('1') }, { name: 'pymupdf/a.py', data: Buffer.from('2') }]],
  ];
  for (const [entries, options] of cases) {
    const { wheelPath, destDir } = writeWheel(entries, options);
    await assert.rejects(extractWheel({ wheelPath, destDir }), entries.map((entry) => entry.name).join(','));
    assert.equal(fs.existsSync(path.join(path.dirname(destDir), 'escape.py')), false);
  }
});

test('enforces the entry-count, per-entry and total size caps', async () => {
  const entries = [
    { name: 'pymupdf/a.bin', data: Buffer.alloc(40) },
    { name: 'pymupdf/b.bin', data: Buffer.alloc(40) },
  ];
  const limits = { maxEntries: 10, maxEntryUncompressedBytes: 100, maxTotalUncompressedBytes: 1000 };
  for (const [override, message] of [
    [{ maxEntries: 1 }, /too many entries/],
    [{ maxEntryUncompressedBytes: 39 }, /larger than allowed/],
    [{ maxTotalUncompressedBytes: 79 }, /more than allowed/],
  ]) {
    const { wheelPath, destDir } = writeWheel(entries);
    await assert.rejects(extractWheel({ wheelPath, destDir, limits: { ...limits, ...override } }), message);
  }
});
