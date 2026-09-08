'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  extractTarZst,
  ARCHIVE_ERROR_CODES,
  normalizeArchivePath,
} = require('../services/ollama-linux-archive');

const zstdAvailable = typeof zlib.createZstdDecompress === 'function'
  && typeof zlib.zstdCompressSync === 'function';
const archiveTest = zstdAvailable
  ? test
  : (name, fn) => test.skip(`${name} (Zstandard unavailable on Node ${process.version})`, fn);

function writeString(block, value, offset, length) {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
  bytes.copy(block, offset);
}

function writeOctal(block, value, offset, length) {
  writeString(block, `${value.toString(8).padStart(length - 1, '0')}\0`, offset, length);
}

function tarHeader({
  name, mode = 0o644, size = 0, type = '0', linkname = '', prefix = '', gnu = false,
}) {
  const block = Buffer.alloc(512);
  writeString(block, name, 0, 100);
  writeOctal(block, mode, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeOctal(block, size, 124, 12);
  writeOctal(block, 0, 136, 12);
  block.fill(0x20, 148, 156);
  block[156] = type === '\0' ? 0 : type.charCodeAt(0);
  writeString(block, linkname, 157, 100);
  writeString(block, 'ustar\0', 257, 6);
  writeString(block, '00', 263, 2);
  writeString(block, prefix, 345, 155);
  if (gnu) {
    writeString(block, 'ustar  \0', 257, 8);
    writeOctal(block, 1700000000, 345, 12); // GNU headers keep atime where ustar keeps the prefix
  }
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeString(block, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return block;
}

function useBase256Size(block, value) {
  block.fill(0, 124, 136);
  for (let index = 135; value > 0; index -= 1) {
    block[index] = value & 0xff;
    value = Math.floor(value / 256);
  }
  block[124] |= 0x80;
  block.fill(0x20, 148, 156);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  writeString(block, `${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
}

function rawTar(entries, { endBlocks = true } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const payload = Buffer.isBuffer(entry.content)
      ? entry.content
      : Buffer.from(entry.content || '');
    const header = tarHeader({ ...entry, size: entry.size ?? payload.length });
    if (entry.base256Size) useBase256Size(header, payload.length);
    chunks.push(header);
    chunks.push(payload);
    const padding = (512 - (payload.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  if (endBlocks) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function compressedTar(entries, options) {
  return zlib.zstdCompressSync(rawTar(entries, options));
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length)) + Buffer.byteLength(body) !== length) {
    length = Buffer.byteLength(String(length)) + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}

function tempFixture(archive) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-ollama-archive-'));
  const archivePath = path.join(root, 'ollama.tar.zst');
  const destinationDir = path.join(root, 'out');
  fs.writeFileSync(archivePath, archive);
  return { root, archivePath, destinationDir };
}

async function withFixture(archive, callback) {
  const fixture = tempFixture(archive);
  try {
    return await callback(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

async function rejectsCode(archive, code, options = {}) {
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    await assert.rejects(
      extractTarZst({ archivePath, destinationDir, ...options }),
      (error) => error instanceof Error && error.code === code,
    );
  });
}

archiveTest('exports the frozen error-code contract and fail-closed path normalizer', () => {
  assert.equal(Object.isFrozen(ARCHIVE_ERROR_CODES), true);
  assert.deepEqual(ARCHIVE_ERROR_CODES, [
    'zstd_unavailable', 'archive_corrupt', 'archive_unsupported_entry', 'archive_unsafe_path',
    'archive_unsafe_link', 'archive_too_large', 'archive_too_many_entries', 'cancelled',
  ]);
  assert.throws(
    () => extractTarZst({ archivePath: 'archive', destinationDir: 'out', zlibImpl: {} }),
    (error) => error.code === 'zstd_unavailable',
  );
  assert.equal(normalizeArchivePath('./bin/ollama'), 'bin/ollama');
  assert.equal(normalizeArchivePath('lib/ollama/'), 'lib/ollama');
  for (const unsafe of ['', '../escape', '/abs/file', 'a\\b', 'a//b', 'a/./b']) {
    assert.equal(normalizeArchivePath(unsafe), null);
  }
});

archiveTest('extracts regular files, nested directories, and executable mode', async () => {
  const archive = compressedTar([
    { name: 'bin/', type: '5', mode: 0o755 },
    { name: 'bin/ollama', mode: 0o755, content: 'ELF' },
    { name: 'lib/ollama/', type: '5', mode: 0o755 },
    { name: 'lib/ollama/libggml.so', mode: 0o644, content: 'shared' },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const chmodCalls = [];
    const fsImpl = {
      ...fs,
      chmodSync: (...args) => {
        chmodCalls.push(args);
        if (process.platform !== 'win32') fs.chmodSync(...args);
      },
    };
    const result = await extractTarZst({ archivePath, destinationDir, fsImpl });
    assert.deepEqual(result, {
      entries: 4,
      extractedBytes: 9,
      files: ['bin/ollama', 'lib/ollama/libggml.so'],
    });
    assert.equal(fs.readFileSync(path.join(destinationDir, 'bin', 'ollama'), 'utf8'), 'ELF');
    assert.equal(fs.readFileSync(path.join(destinationDir, 'lib', 'ollama', 'libggml.so'), 'utf8'), 'shared');
    assert.deepEqual(chmodCalls.map(([, mode]) => mode), [0o755, 0o644]);
    if (process.platform !== 'win32') {
      assert.notEqual(fs.statSync(path.join(destinationDir, 'bin', 'ollama')).mode & 0o111, 0);
    }
  });
});

archiveTest('creates in-tree symbolic and prior-file hard links through injected fs', async () => {
  const archive = compressedTar([
    { name: 'lib/ollama/libcudart.so.12.8.90', content: 'cuda' },
    {
      name: 'lib/ollama/libcudart.so.12',
      type: '2',
      linkname: 'libcudart.so.12.8.90',
    },
    {
      name: 'lib/ollama/libcudart-copy.so',
      type: '1',
      linkname: 'lib/ollama/libcudart.so.12.8.90',
    },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const calls = { symlink: [], link: [] };
    const fsImpl = {
      ...fs,
      chmodSync: () => {},
      symlinkSync: (...args) => calls.symlink.push(args),
      linkSync: (...args) => calls.link.push(args),
    };
    await extractTarZst({ archivePath, destinationDir, fsImpl });
    assert.deepEqual(calls.symlink, [[
      'libcudart.so.12.8.90',
      path.join(destinationDir, 'lib', 'ollama', 'libcudart.so.12'),
    ]]);
    assert.deepEqual(calls.link, [[
      path.join(destinationDir, 'lib', 'ollama', 'libcudart.so.12.8.90'),
      path.join(destinationDir, 'lib', 'ollama', 'libcudart-copy.so'),
    ]]);
  });
});

archiveTest('reads GNU-format headers without treating the atime field as a path prefix', async () => {
  const archive = compressedTar([{ name: 'bin/ollama', mode: 0o755, content: 'ELF', gnu: true }]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const result = await extractTarZst({ archivePath, destinationDir, fsImpl: { ...fs, chmodSync: () => {} } });
    assert.deepEqual(result.files, ['bin/ollama']);
    assert.equal(fs.readFileSync(path.join(destinationDir, 'bin', 'ollama'), 'utf8'), 'ELF');
  });
});

archiveTest('streams a multi-megabyte entry without accumulating write-stream listeners', async () => {
  const size = 2 * 1024 * 1024;
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.name);
  process.on('warning', onWarning);
  try {
    const archive = compressedTar([{ name: 'bin/ollama', content: Buffer.alloc(size, 0x41) }]);
    await withFixture(archive, async ({ archivePath, destinationDir }) => {
      const result = await extractTarZst({ archivePath, destinationDir, fsImpl: { ...fs, chmodSync: () => {} } });
      assert.equal(result.extractedBytes, size);
      assert.equal(fs.statSync(path.join(destinationDir, 'bin', 'ollama')).size, size);
    });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', onWarning);
  }
  assert.deepEqual(warnings.filter((name) => name === 'MaxListenersExceededWarning'), []);
});

archiveTest('reads GNU base-256 file sizes', async () => {
  const archive = compressedTar([{ name: 'base256', content: 'data', base256Size: true }]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const result = await extractTarZst({ archivePath, destinationDir });
    assert.equal(result.extractedBytes, 4);
    assert.equal(fs.readFileSync(path.join(destinationDir, 'base256'), 'utf8'), 'data');
  });
});

archiveTest('rejects escaping and absolute symlinks and unresolved hard links', async () => {
  const cases = [
    [{ name: 'bin/bad.so', type: '2', linkname: '../../etc/passwd' }],
    [{ name: 'lib/ollama/bad.so', type: '2', linkname: '/etc/passwd' }],
    [{ name: 'lib/ollama/bad.so', type: '1', linkname: 'lib/ollama/missing.so' }],
  ];
  for (const entries of cases) {
    await withFixture(compressedTar(entries), async ({ archivePath, destinationDir }) => {
      const calls = [];
      const fsImpl = {
        ...fs,
        symlinkSync: (...args) => calls.push(args),
        linkSync: (...args) => calls.push(args),
      };
      await assert.rejects(
        extractTarZst({ archivePath, destinationDir, fsImpl }),
        (error) => error.code === 'archive_unsafe_link' && error.entry === entries[0].name,
      );
      assert.deepEqual(calls, []);
    });
  }
});

archiveTest('applies PAX and GNU long names and ignores a leading global PAX header', async () => {
  const paxPath = `lib/ollama/${'p'.repeat(110)}.so`;
  const gnuPath = `lib/ollama/${'g'.repeat(110)}.so`;
  const archive = compressedTar([
    { name: 'pax_global_header', type: 'g', content: paxRecord('comment', 'ignored') },
    { name: 'PaxHeader', type: 'x', content: `${paxRecord('path', paxPath)}${paxRecord('size', '3')}` },
    { name: 'pax-placeholder', size: 0, content: 'pax' },
    { name: '././@LongLink', type: 'L', content: `${gnuPath}\0` },
    { name: 'gnu-placeholder', content: 'gnu' },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const result = await extractTarZst({ archivePath, destinationDir });
    assert.equal(fs.readFileSync(path.join(destinationDir, ...paxPath.split('/')), 'utf8'), 'pax');
    assert.equal(fs.readFileSync(path.join(destinationDir, ...gnuPath.split('/')), 'utf8'), 'gnu');
    assert.deepEqual(result.files, [gnuPath, paxPath].sort());
  });
});

archiveTest('rejects unsafe paths', async () => {
  for (const name of ['../escape', '/abs/file', 'a\\b']) {
    await rejectsCode(compressedTar([{ name, content: 'bad' }]), 'archive_unsafe_path');
  }
});

archiveTest('rejects unsupported entry types and resource-limit violations', async () => {
  await rejectsCode(compressedTar([{ name: 'pipe', type: '6' }]), 'archive_unsupported_entry');
  await rejectsCode(compressedTar([
    { name: 'one', content: '1' },
    { name: 'two', content: '2' },
    { name: 'three', content: '3' },
  ]), 'archive_too_many_entries', { maxEntries: 2 });
  await withFixture(compressedTar([{ name: 'large', content: 'four' }]), async ({ archivePath, destinationDir }) => {
    await assert.rejects(
      extractTarZst({ archivePath, destinationDir, maxBytes: 3 }),
      (error) => error.code === 'archive_too_large',
    );
    assert.equal(fs.existsSync(path.join(destinationDir, 'large')), false);
  });
});

archiveTest('rejects a corrupt checksum and truncated tar payload', async () => {
  const corrupt = rawTar([{ name: 'file', content: 'data' }]);
  corrupt[0] ^= 1;
  await rejectsCode(zlib.zstdCompressSync(corrupt), 'archive_corrupt');

  const complete = rawTar([{ name: 'file', content: 'data' }]);
  const truncated = complete.subarray(0, complete.length - 700);
  await rejectsCode(zlib.zstdCompressSync(truncated), 'archive_corrupt');
});

archiveTest('cancels before the second entry without creating it', async () => {
  const archive = compressedTar([
    { name: 'first', content: 'one' },
    { name: 'second', content: 'two' },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    let checks = 0;
    await assert.rejects(
      extractTarZst({
        archivePath,
        destinationDir,
        // 1: the first header; 2: its written chunk; 3: the second header.
        isCancelled: () => { checks += 1; return checks === 3; },
      }),
      (error) => error.code === 'cancelled',
    );
    assert.equal(fs.readFileSync(path.join(destinationDir, 'first'), 'utf8'), 'one');
    assert.equal(fs.existsSync(path.join(destinationDir, 'second')), false);
  });
});

archiveTest('cancels inside a large entry instead of finishing it', async () => {
  const big = 'x'.repeat(4 * 1024 * 1024);
  const archive = compressedTar([
    { name: 'big', content: big },
    { name: 'after', content: 'z' },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    let checks = 0;
    await assert.rejects(
      extractTarZst({
        archivePath,
        destinationDir,
        // 1: the header check; 2: the first written chunk; 3: cancel during the second chunk.
        isCancelled: () => { checks += 1; return checks === 3; },
      }),
      (error) => error.code === 'cancelled',
    );
    const bigPath = path.join(destinationDir, 'big');
    const written = fs.existsSync(bigPath) ? fs.statSync(bigPath).size : 0;
    assert.ok(written < big.length, `expected a cut-short entry, wrote ${written} of ${big.length}`);
    assert.equal(fs.existsSync(path.join(destinationDir, 'after')), false);
  });
});

archiveTest('reports monotonic progress once per entry', async () => {
  const archive = compressedTar([
    { name: 'first', content: '1' },
    { name: 'second', content: '22' },
  ]);
  await withFixture(archive, async ({ archivePath, destinationDir }) => {
    const progress = [];
    await extractTarZst({ archivePath, destinationDir, onProgress: (value) => progress.push(value) });
    assert.equal(progress.length, 2);
    assert.deepEqual(progress.map(({ entries }) => entries), [1, 2]);
    assert.deepEqual(progress.map(({ extractedBytes }) => extractedBytes), [1, 3]);
    assert.ok(progress[1].compressedBytes >= progress[0].compressedBytes);
  });
});
